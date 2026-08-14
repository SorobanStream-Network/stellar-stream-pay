#![no_std]

//! StellarStream-Pay — continuous streaming payments on Stellar (Soroban).
//!
//! A "stream" is a linearly-vesting payment: a sender locks a SEP-41 token
//! amount (which includes Stellar Asset Contract "SAC" wrapped native assets)
//! for a fixed duration, and the receiver may withdraw the pro-rata amount
//! that has accrued so far, on demand.
//!
//! Storage is keyed through the [`DataKey`] enum: the stream counter lives at
//! `DataKey::Counter` and each stream's metadata at `DataKey::Stream(id)`.
//!
//! Lifecycle events (`created` / `withdraw` / `cancelled`) are published via
//! the [`StreamEvent`] contract event so off-chain indexers can track streams
//! without polling storage.
//!
//! Design notes:
//! * Amounts are expressed in the token's base units (stroops for SAC assets)
//!   as `i128`, matching the SEP-41 token interface.
//! * Time is measured with `env.ledger().timestamp()` (ledger close time in
//!   unix seconds).
//! * Transfers use [`token::Client`], which speaks the standard SEP-41 token
//!   interface. This works identically for SAC-wrapped native assets and for
//!   custom tokens. [`token::StellarAssetClient`] is reserved for *admin*
//!   operations (mint/clawback/set_admin), which this contract never performs.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, Env, Symbol,
};

/// The frozen public API version of the stream core.
///
/// The core is intentionally small and immutable: its interface is pinned at
/// v1 and must not change. Any breaking change to the function signatures
/// below is a migration event (redeploy + reindex) and requires a version
/// bump. New capabilities belong in *extension* contracts that compose this
/// core, never inside it.
pub const STREAM_CORE_API_VERSION: u32 = 1;

/// Persistent-storage keys.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Monotonic stream-id counter (`u64`), also the id assigned to the next stream.
    Counter,
    /// Metadata for the stream with the given id (`Stream`).
    Stream(u64),
}

/// A single continuous, time-release payment stream.
#[contracttype]
#[derive(Clone)]
pub struct Stream {
    pub sender: Address,
    pub receiver: Address,
    pub token: Address,
    pub total_amount: i128,
    pub start_time: u64, // ledger timestamp (unix seconds)
    pub end_time: u64,   // ledger timestamp (unix seconds)
    pub withdrawn: i128, // cumulative amount the receiver has received
    pub cancelled: bool,
    pub cancelled_at: u64, // vesting freeze time; 0 while the stream is active
}

/// Lifecycle event published for off-chain indexers.
///
/// Topics (filterable): `kind` ∈ {"created" | "withdraw" | "cancelled"},
/// `stream_id`, `sender`, `receiver`.
///
/// Data: `token`, `amount`, `start_time`, `end_time`. The meaning of `amount`
/// depends on `kind`: total locked (`created`), withdrawn (`withdraw`), or the
/// unvested refund returned to the sender (`cancelled`).
#[contractevent]
#[derive(Clone)]
pub struct StreamEvent {
    #[topic]
    pub kind: Symbol,
    #[topic]
    pub stream_id: u64,
    #[topic]
    pub sender: Address,
    #[topic]
    pub receiver: Address,
    pub token: Address,
    pub amount: i128,
    pub start_time: u64,
    pub end_time: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Unauthorized = 1,
    StreamNotFound = 2,
    StreamCancelled = 3,
    NothingToWithdraw = 4,
    InvalidAmount = 5,
    InvalidDuration = 6,
    InvalidParties = 7,
    TokenTransferMismatch = 8,
}

#[contract]
pub struct StreamingContract;

#[contractimpl]
impl StreamingContract {
    /// Create a stream. `sender` must sign this call and, in the same
    /// transaction, authorize the token pull from their balance into the
    /// contract's own balance. Returns the new stream id.
    pub fn create_stream(
        env: Env,
        sender: Address,
        receiver: Address,
        token: Address,
        amount: i128,
        duration_seconds: u64,
    ) -> u64 {
        // Strict authorization: only the sender may commit their own funds.
        sender.require_auth();

        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if duration_seconds == 0 {
            panic_with_error!(&env, Error::InvalidDuration);
        }
        if sender == receiver {
            panic_with_error!(&env, Error::InvalidParties);
        }

        let now = env.ledger().timestamp();
        let end_time = match now.checked_add(duration_seconds) {
            Some(t) => t,
            None => panic_with_error!(&env, Error::InvalidDuration),
        };

        // FIX: write state BEFORE the external token call (check-effects-
        // interactions). Soroban transactions are atomic, so if the pull below
        // reverts, this state is rolled back too — but a reentrant call can
        // only ever observe finalized state.
        let stream_id = Self::next_id(&env);
        env.storage().persistent().set(
            &DataKey::Stream(stream_id),
            &Stream {
                sender: sender.clone(),
                receiver: receiver.clone(),
                token: token.clone(),
                total_amount: amount,
                start_time: now,
                end_time,
                withdrawn: 0,
                cancelled: false,
                cancelled_at: 0,
            },
        );
        // Bump the counter so stream ids remain unique across calls.
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &(stream_id + 1));

        // Lock funds: pull `amount` from the sender into the contract's own
        // balance. `token::Client` requires the sender's auth for the transfer,
        // which flows through because we are invoked in the sender's
        // transaction. Works for SAC assets and any SEP-41 token.
        //
        // FIX: verify the contract actually received exactly `amount`. A
        // fee-on-transfer or otherwise non-conforming token would otherwise
        // leave the stream under-collateralized relative to `total_amount`.
        let contract = env.current_contract_address();
        let token_client = token::Client::new(&env, &token);
        let bal_before = token_client.balance(&contract);
        token_client.transfer(&sender, &contract, &amount);
        let bal_after = token_client.balance(&contract);
        if bal_after - bal_before != amount {
            panic_with_error!(&env, Error::TokenTransferMismatch);
        }

        // FIX: extend the new entries' TTL so long-running streams don't get
        // archived mid-term (persistent entries expire after `max_ttl`).
        Self::bump_ttl(&env, &DataKey::Stream(stream_id));
        Self::bump_ttl(&env, &DataKey::Counter);

        StreamEvent {
            kind: symbol_short!("created"),
            stream_id,
            sender,
            receiver,
            token,
            amount,
            start_time: now,
            end_time,
        }
        .publish(&env);

        stream_id
    }

    /// Withdraw everything that has accrued up to the current ledger time.
    /// Requires the receiver's signature. Returns the amount transferred.
    pub fn withdraw(env: Env, receiver: Address, stream_id: u64) -> i128 {
        receiver.require_auth();

        let mut stream = Self::load(&env, stream_id);
        if stream.receiver != receiver {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let now = env.ledger().timestamp();
        let accrued = vested_so_far(&stream, now);
        let withdrawable = accrued - stream.withdrawn;
        if withdrawable <= 0 {
            panic_with_error!(&env, Error::NothingToWithdraw);
        }

        // Update state *before* the external token call (check-effects-
        // interactions style) to avoid re-entrancy surprises.
        stream.withdrawn = accrued;
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
        // FIX: extend TTL so the stream entry survives until fully withdrawn.
        Self::bump_ttl(&env, &DataKey::Stream(stream_id));

        // Pay out. The contract is the `from`; the token contract's own
        // `require_auth` for the contract address is satisfied because this
        // contract is the currently-executing contract in the call chain.
        token::Client::new(&env, &stream.token).transfer(
            &env.current_contract_address(),
            &receiver,
            &withdrawable,
        );

        StreamEvent {
            kind: symbol_short!("withdraw"),
            stream_id,
            sender: stream.sender,
            receiver,
            token: stream.token,
            amount: withdrawable,
            start_time: stream.start_time,
            end_time: stream.end_time,
        }
        .publish(&env);

        withdrawable
    }

    /// Cancel an active stream. Either the sender or the receiver may cancel.
    ///
    /// Cancellation settles the stream in a single call: the vested-but-not-yet
    /// withdrawn remainder is paid to the receiver immediately, and the
    /// unvested remainder is refunded to the sender. Returns the refund amount.
    pub fn cancel(env: Env, caller: Address, stream_id: u64) -> i128 {
        caller.require_auth();

        let mut stream = Self::load(&env, stream_id);
        if stream.cancelled {
            panic_with_error!(&env, Error::StreamCancelled);
        }
        // Either the sender or the receiver may cancel; anyone else is rejected.
        if caller != stream.sender && caller != stream.receiver {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let now = env.ledger().timestamp();
        let accrued = vested_so_far(&stream, now);
        let unwithdrawn = accrued - stream.withdrawn; // still owed to the receiver
        let refund = stream.total_amount - accrued; // unvested, returned to the sender

        // Freeze vesting and record that the vested portion is paid out now,
        // so a later `withdraw` cannot double-spend it.
        stream.cancelled = true;
        stream.cancelled_at = now;
        stream.withdrawn = accrued;
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
        // FIX: extend TTL so the now-frozen stream entry remains readable.
        Self::bump_ttl(&env, &DataKey::Stream(stream_id));

        if unwithdrawn > 0 {
            token::Client::new(&env, &stream.token).transfer(
                &env.current_contract_address(),
                &stream.receiver,
                &unwithdrawn,
            );
        }
        if refund > 0 {
            token::Client::new(&env, &stream.token).transfer(
                &env.current_contract_address(),
                &stream.sender,
                &refund,
            );
        }

        StreamEvent {
            kind: symbol_short!("cancelled"),
            stream_id,
            sender: stream.sender,
            receiver: stream.receiver,
            token: stream.token,
            amount: refund,
            start_time: stream.start_time,
            end_time: stream.end_time,
        }
        .publish(&env);

        refund
    }

    // ---- Views (read-only) ------------------------------------------------

    /// The pinned API version of this contract. SDKs and indexers use it to
    /// detect the interface they are talking to.
    pub fn version(_env: Env) -> u32 {
        STREAM_CORE_API_VERSION
    }

    /// Pro-rata linearly-vested amount as of the current ledger time.
    /// For a cancelled stream, vesting is frozen at `cancelled_at`.
    pub fn streamed_amount(env: Env, stream_id: u64) -> i128 {
        let s = Self::load(&env, stream_id);
        vested_so_far(&s, env.ledger().timestamp())
    }

    pub fn get_stream(env: Env, stream_id: u64) -> Stream {
        Self::load(&env, stream_id)
    }

    /// Amount currently available to withdraw (accrued minus already-withdrawn).
    pub fn get_withdrawable(env: Env, stream_id: u64) -> i128 {
        let s = Self::load(&env, stream_id);
        vested_so_far(&s, env.ledger().timestamp()) - s.withdrawn
    }

    pub fn get_stream_count(env: Env) -> u64 {
        env.storage().persistent().get(&DataKey::Counter).unwrap_or(0)
    }

    // ---- Internals --------------------------------------------------------

    fn next_id(env: &Env) -> u64 {
        env.storage().persistent().get(&DataKey::Counter).unwrap_or(0)
    }

    /// FIX: extend a persistent entry's TTL so long-running streams don't get
    /// archived while still active. `set` resets TTL on write, but a stream
    /// that is only *read* (via views) for longer than `max_ttl` would expire;
    /// bumping here keeps it alive. (Ledgers ≈ 5s; 30 days ≈ 518_400 ledgers.)
    fn bump_ttl(env: &Env, key: &DataKey) {
        const THIRTY_DAYS_LEDGERS: u32 = 30 * 24 * 60 * 12;
        env.storage().persistent().extend_ttl(
            key,
            THIRTY_DAYS_LEDGERS,
            env.storage().max_ttl(),
        );
    }

    fn load(env: &Env, stream_id: u64) -> Stream {
        env.storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::StreamNotFound))
    }
}

/// Pro-rata linear accrual: `total * elapsed / duration`, floored.
///
/// Pure function (no `Env`) so it is trivially unit-testable and reused by
/// every mutating path and view. Overflow is impossible for realistic token
/// amounts; the release profile keeps `overflow-checks = true`, so any
/// pathological overflow traps the transaction rather than wrapping.
fn vested_amount(total: i128, start: u64, end: u64, now: u64) -> i128 {
    if now <= start {
        return 0;
    }
    let t = if now < end { now } else { end };
    let elapsed = (t - start) as i128;
    let duration = (end - start) as i128;
    if duration == 0 {
        return total; // degenerate stream: everything vested immediately
    }
    total * elapsed / duration
}

/// Amount that has vested as of `now`, respecting the cancellation freeze.
///
/// For an active stream this is the pro-rata accrual at `now`. For a cancelled
/// stream vesting stopped at `cancelled_at`, so the accrual is frozen there
/// regardless of how much later `now` is.
fn vested_so_far(stream: &Stream, now: u64) -> i128 {
    let effective_now = if stream.cancelled { stream.cancelled_at } else { now };
    vested_amount(
        stream.total_amount,
        stream.start_time,
        stream.end_time,
        effective_now,
    )
}

#[cfg(test)]
mod test;
