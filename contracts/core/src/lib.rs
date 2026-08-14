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
//! * FIX (Findings 4 & 5) token trust boundary: this contract accepts
//!   arbitrary SEP-41 tokens. The balance-delta check in `create_stream`
//!   rejects honest-but-different tokens (fees, rounding), but a token that
//!   *lies* about its `balance()` — or charges fees only on *outgoing*
//!   transfers — cannot be fully defended against. Real deployments should
//!   stream SAC assets or an allowlist of trusted tokens.
//! * Admin pause: the deploy-time constructor (`__constructor`) binds a single
//!   immutable admin address that can `pause`/`unpause` new stream creation.
//!   The pause NEVER affects
//!   `withdraw`/`cancel` of existing streams — receivers keep unconditional
//!   access to funds already owed to them.
//! * Split streams: `create_split_stream` allocates one ordinary [`Stream`]
//!   per receiver plus a [`SplitGroup`] index, so multi-receiver payments
//!   reuse the exact same vesting/withdraw/cancel logic as single streams.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, Env, Map, Symbol, Vec,
};

/// The public API version of the stream core.
///
/// FIX (Finding 2): v1 was the original create/withdraw/cancel/views surface.
/// v2 adds the deploy-time `admin` constructor argument, `pause`/`unpause`,
/// `bump`, the `get_split` view, and the split-stream entrypoints. Any further
/// breaking change to the function signatures below is a migration event
/// (redeploy + reindex) and requires another version bump.
pub const STREAM_CORE_API_VERSION: u32 = 2;

/// Upper bound on the number of receivers in a single split stream.
/// FIX (Finding 4): one storage entry + one event are written per member, so
/// an unbounded `receivers` vector could otherwise exceed Soroban's
/// per-transaction ledger-entry/event/gas limits. Also bounds the O(n·dust)
/// dust pass in `split_by_weights` (Finding 5) to negligible cost.
pub const MAX_SPLIT_MEMBERS: u32 = 32;

/// Persistent-storage keys.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Monotonic stream-id counter (`u64`), also the id assigned to the next stream.
    Counter,
    /// Metadata for the stream with the given id (`Stream`).
    Stream(u64),
    /// The single immutable admin address, set once at construction by
    /// [`StreamingContract::__constructor`]; not re-settable.
    Admin,
    /// Whether new stream creation is paused (`bool`).
    Paused,
    /// Split-group metadata for the group rooted at the given stream id
    /// (`SplitGroup`).
    Split(u64),
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

/// A group of per-receiver [`Stream`]s created atomically by
/// `create_split_stream`. Members are ordinary streams — each individually
/// withdrawable and cancellable — while this record (keyed by the root stream
/// id) lets the sender settle the whole group in one `cancel_split` call.
#[contracttype]
#[derive(Clone)]
pub struct SplitGroup {
    pub sender: Address,
    pub token: Address,
    /// Stream ids of every member, in allocation order.
    pub member_ids: Vec<u64>,
}

/// Lifecycle event published for off-chain indexers.
///
/// Topics (filterable): `kind` ∈ {"created" | "withdraw" | "cancelled"},
/// `stream_id`, `sender`, `receiver`.
///
/// Data: `token`, `amount`, `receiver_amount`, `start_time`, `end_time`.
/// * `amount` is the sender-side amount: total locked (`created`), withdrawn
///   (`withdraw`), or the unvested refund returned to the sender (`cancelled`).
/// * `receiver_amount` is the receiver-side amount paid out by this event: `0`
///   (`created`), the withdrawn amount (`withdraw`), or the vested-but-not-yet-
///   withdrawn remainder paid out on `cancelled`. For `withdraw` it equals
///   `amount`.
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
    pub receiver_amount: i128,
    pub start_time: u64,
    pub end_time: u64,
}

/// Group-lifecycle event published for off-chain indexers.
///
/// Published once per split group at creation so indexers can reconstruct
/// group membership (root id -> members) from events alone, without a storage
/// read.
///
/// Topics (filterable): `kind` ∈ {"split_created"}, `root_id`, `sender`.
/// Data: `token`, `member_ids` (allocation order), `total_amount`.
#[contractevent]
#[derive(Clone)]
pub struct SplitEvent {
    #[topic]
    pub kind: Symbol,
    #[topic]
    pub root_id: u64,
    #[topic]
    pub sender: Address,
    pub token: Address,
    pub member_ids: Vec<u64>,
    pub total_amount: i128,
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
    StreamIdOverflow = 9,
    Paused = 10,
    NotInitialized = 11,
    // 12 was `AlreadyInitialized`, removed when `initialize` became a
    // deploy-time constructor. The gap is intentional so the remaining codes
    // stay stable for existing deployments/indexers.
    EmptySplit = 13,
    SplitLengthMismatch = 14,
    DuplicateReceiver = 15,
    SplitNotFound = 16,
    SplitAmountOverflow = 17,
    InvalidAllocation = 18,
    SplitTooManyReceivers = 19,
}

#[contract]
pub struct StreamingContract;

#[contractimpl]
impl StreamingContract {
    /// Bind the contract's single immutable admin address (the pauser) at
    /// deploy time.
    ///
    /// FIX (Finding 2): the admin is set by the constructor, which runs in the
    /// same transaction that instantiates the contract, so there is no separate
    /// `initialize` step for an attacker to front-run. The admin is never
    /// re-settable (there is no `set_admin` entrypoint). Deploy with
    /// `env.register(StreamingContract, (admin,))`.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().persistent().set(&DataKey::Admin, &admin);
        // FIX (Finding 7): keep Admin at max TTL, not the 30-day bump. Once
        // `Admin` is archived there is no path to re-arm it (`pause`/`unpause`
        // panic `NotInitialized` first and the constructor can't be re-run), so
        // a fully idle contract would otherwise lose the admin role forever.
        Self::bump_ttl_max(&env, &DataKey::Admin);
        // FIX (Finding 8): initialize the pause flag explicitly instead of
        // relying on `is_paused()`'s absent->false default.
        env.storage().persistent().set(&DataKey::Paused, &false);
        Self::bump_ttl_max(&env, &DataKey::Paused);
    }

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
        // FIX (Stage 3): circuit breaker — a paused contract rejects NEW
        // streams only. Existing streams keep vesting, withdrawing, and
        // cancelling normally (`withdraw`/`cancel` never consult the flag),
        // so receivers retain unconditional access to funds already owed.
        if Self::is_paused(&env) {
            panic_with_error!(&env, Error::Paused);
        }
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
        let stream_id = Self::allocate_id(&env);
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
            receiver_amount: 0,
            start_time: now,
            end_time,
        }
        .publish(&env);

        stream_id
    }

    /// Create a split stream: one sender streams a total amount to `N`
    /// receivers with fixed per-receiver amounts, all over the same duration.
    ///
    /// Every receiver gets an ordinary [`Stream`] record (reusing the exact
    /// struct, accrual math, `withdraw`/`cancel`, views, and `StreamEvent`s),
    /// plus one [`SplitGroup`] record keyed by the returned root id (the first
    /// member's stream id). The full total is pulled from the sender in ONE
    /// token transfer; the contract then holds the aggregate and pays each
    /// receiver out of it as their own stream accrues.
    ///
    /// Use [`create_split_stream_bps`] for percentage-based allocations.
    ///
    /// Returns the root stream id.
    pub fn create_split_stream(
        env: Env,
        sender: Address,
        receivers: Vec<Address>,
        token: Address,
        amounts: Vec<i128>,
        duration_seconds: u64,
    ) -> u64 {
        // Allocation validation only; the pause check, authorization, receiver
        // validation, and all writes happen in the shared core.
        if amounts.len() != receivers.len() {
            panic_with_error!(&env, Error::SplitLengthMismatch);
        }
        for i in 0..amounts.len() {
            if amounts.get(i).unwrap() <= 0 {
                panic_with_error!(&env, Error::InvalidAmount);
            }
        }
        Self::create_split_core(&env, &sender, &receivers, &token, &amounts, duration_seconds)
    }

    /// Create a split stream with basis-point allocations: each receiver gets
    /// `bps[i]` basis points of `total_amount` (1 bp = 0.01%, so `bps` must
    /// sum to exactly `10_000`). Shares use the largest-remainder method, so
    /// they always sum to exactly `total_amount` — no rounding dust lost.
    ///
    /// Returns the root stream id.
    pub fn create_split_stream_bps(
        env: Env,
        sender: Address,
        receivers: Vec<Address>,
        token: Address,
        total_amount: i128,
        bps: Vec<u32>,
        duration_seconds: u64,
    ) -> u64 {
        Self::create_split_weighted(
            env, sender, receivers, token, total_amount, bps, 10_000, duration_seconds,
        )
    }

    /// Create a split stream with integer-percentage allocations: each
    /// receiver gets `pcts[i]` percent of `total_amount` (so `pcts` must sum
    /// to exactly `100`). Shares use the largest-remainder method, so they
    /// always sum to exactly `total_amount` even when it doesn't divide
    /// evenly — no rounding dust is lost or minted.
    ///
    /// Returns the root stream id.
    pub fn create_split_stream_pct(
        env: Env,
        sender: Address,
        receivers: Vec<Address>,
        token: Address,
        total_amount: i128,
        pcts: Vec<u32>,
        duration_seconds: u64,
    ) -> u64 {
        Self::create_split_weighted(
            env, sender, receivers, token, total_amount, pcts, 100, duration_seconds,
        )
    }

    /// Shared implementation for weighted (percentage / basis-point) splits.
    /// `weights` must sum to exactly `scale` with every weight > 0. Computes
    /// per-receiver shares with the largest-remainder method, rejects any
    /// zero share, and delegates to `create_split_core`.
    fn create_split_weighted(
        env: Env,
        sender: Address,
        receivers: Vec<Address>,
        token: Address,
        total_amount: i128,
        weights: Vec<u32>,
        scale: u32,
        duration_seconds: u64,
    ) -> u64 {
        if total_amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if weights.len() != receivers.len() {
            panic_with_error!(&env, Error::SplitLengthMismatch);
        }

        // Every weight must be positive and the set must total exactly `scale`.
        let mut weight_total: u64 = 0;
        for i in 0..weights.len() {
            let w = weights.get(i).unwrap();
            if w == 0 {
                panic_with_error!(&env, Error::InvalidAllocation);
            }
            weight_total += w as u64;
        }
        if weight_total != scale as u64 {
            panic_with_error!(&env, Error::InvalidAllocation);
        }

        let shares = Self::split_by_weights(&env, total_amount, &weights, scale as i128);
        // Reject a total too small to give every receiver ≥ 1 base unit;
        // otherwise a zero-amount member stream would be created.
        for i in 0..shares.len() {
            if shares.get(i).unwrap() <= 0 {
                panic_with_error!(&env, Error::InvalidAllocation);
            }
        }
        Self::create_split_core(&env, &sender, &receivers, &token, &shares, duration_seconds)
    }

    /// Shared implementation of both split-stream creators. `shares` is already
    /// validated by the caller (non-empty, same length as `receivers`, every
    /// share > 0). Handles the pause check, authorization, receiver
    /// validation, member writes, the single aggregate pull, and per-member
    /// `created` events.
    fn create_split_core(
        env: &Env,
        sender: &Address,
        receivers: &Vec<Address>,
        token: &Address,
        shares: &Vec<i128>,
        duration_seconds: u64,
    ) -> u64 {
        // FIX (Stage 3): same circuit breaker as `create_stream` — a paused
        // contract rejects new streams only, never touching existing ones.
        if Self::is_paused(env) {
            panic_with_error!(env, Error::Paused);
        }
        sender.require_auth();

        let n = shares.len();
        if n == 0 {
            panic_with_error!(env, Error::EmptySplit);
        }
        // FIX (Finding 4): cap the member count so a single call can't write
        // an unbounded number of storage entries/events and exceed Soroban's
        // per-transaction ledger-entry/event/gas limits (the tx would revert,
        // but this rejects the bad input cheaply and up front). Also bounds
        // the O(n·dust) dust pass in `split_by_weights` (Finding 5).
        if n > MAX_SPLIT_MEMBERS {
            panic_with_error!(env, Error::SplitTooManyReceivers);
        }
        if receivers.len() != n {
            panic_with_error!(env, Error::SplitLengthMismatch);
        }
        if duration_seconds == 0 {
            panic_with_error!(env, Error::InvalidDuration);
        }

        let now = env.ledger().timestamp();
        let end_time = match now.checked_add(duration_seconds) {
            Some(t) => t,
            None => panic_with_error!(env, Error::InvalidDuration),
        };

        // Validate receivers and sum the total (checked) so the single pull
        // below is exact.
        let mut total: i128 = 0;
        // FIX (Finding 3): a map-backed "seen" set makes duplicate detection
        // O(n) instead of O(n^2) (the previous `Vec::contains` inner loop was
        // itself a linear scan, so a large `receivers` vector inflated gas/CPU).
        let mut seen = Map::new(env);
        for i in 0..n {
            let receiver = receivers.get(i).unwrap();
            if receiver == sender.clone() {
                panic_with_error!(env, Error::InvalidParties);
            }
            // A duplicate receiver is almost always a caller mistake; reject it
            // rather than silently granting one address two independent shares.
            if seen.contains_key(receiver.clone()) {
                panic_with_error!(env, Error::DuplicateReceiver);
            }
            seen.set(receiver.clone(), true);
            total = match total.checked_add(shares.get(i).unwrap()) {
                Some(t) => t,
                None => panic_with_error!(env, Error::SplitAmountOverflow),
            };
        }

        // Write all member streams and the group BEFORE the token pull
        // (check-effects-interactions). Every member is a plain `Stream`, so
        // `withdraw`, `cancel`, and all views work on it unchanged.
        let mut member_ids = Vec::new(env);
        for i in 0..n {
            let stream_id = Self::allocate_id(env);
            env.storage().persistent().set(
                &DataKey::Stream(stream_id),
                &Stream {
                    sender: sender.clone(),
                    receiver: receivers.get(i).unwrap().clone(),
                    token: token.clone(),
                    total_amount: shares.get(i).unwrap(),
                    start_time: now,
                    end_time,
                    withdrawn: 0,
                    cancelled: false,
                    cancelled_at: 0,
                },
            );
            Self::bump_ttl(env, &DataKey::Stream(stream_id));
            member_ids.push_back(stream_id);
        }
        Self::bump_ttl(env, &DataKey::Counter);
        let root_id = member_ids.first().unwrap();

        env.storage().persistent().set(
            &DataKey::Split(root_id),
            &SplitGroup {
                sender: sender.clone(),
                token: token.clone(),
                member_ids: member_ids.clone(),
            },
        );
        Self::bump_ttl(env, &DataKey::Split(root_id));

        // Lock the aggregate once. `token::Client` requires the sender's auth,
        // which flows through the sender's transaction. The balance-delta check
        // rejects fee-on-transfer / lying tokens exactly as `create_stream` does.
        let contract = env.current_contract_address();
        let token_client = token::Client::new(env, token);
        let bal_before = token_client.balance(&contract);
        token_client.transfer(sender, &contract, &total);
        let bal_after = token_client.balance(&contract);
        if bal_after - bal_before != total {
            panic_with_error!(env, Error::TokenTransferMismatch);
        }

        // Publish one `created` event per member so indexers track each stream
        // with the same event shape as `create_stream`.
        for i in 0..n {
            StreamEvent {
                kind: symbol_short!("created"),
                stream_id: member_ids.get(i).unwrap(),
                sender: sender.clone(),
                receiver: receivers.get(i).unwrap().clone(),
                token: token.clone(),
                amount: shares.get(i).unwrap(),
                receiver_amount: 0,
                start_time: now,
                end_time,
            }
            .publish(env);
        }

        // FIX (Info #10): publish one group event so indexers can reconstruct
        // split membership (root -> members) from events alone, without a
        // storage read.
        SplitEvent {
            kind: Symbol::new(env, "split_created"),
            root_id,
            sender: sender.clone(),
            token: token.clone(),
            member_ids: member_ids.clone(),
            total_amount: total,
        }
        .publish(env);

        root_id
    }

    /// Withdraw everything that has accrued up to the current ledger time.
    /// Requires the receiver's signature. Returns the amount transferred.
    pub fn withdraw(env: Env, receiver: Address, stream_id: u64) -> i128 {
        receiver.require_auth();

        let mut stream = Self::load(&env, stream_id);
        if stream.receiver != receiver {
            panic_with_error!(&env, Error::Unauthorized);
        }
        // FIX (Finding 6): surface a clear error for cancelled streams rather
        // than falling through to `NothingToWithdraw` (post-cancel the
        // withdrawable amount is always 0).
        if stream.cancelled {
            panic_with_error!(&env, Error::StreamCancelled);
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
        // FIX (Finding 1): keep the id counter alive alongside the stream so a
        // long-idle contract can never reuse stream ids.
        Self::bump_ttl(&env, &DataKey::Counter);

        // Pay out. The contract is the `from`; the token contract's own
        // `require_auth` for the contract address is satisfied because this
        // contract is the currently-executing contract in the call chain.
        // FIX (Finding 3): verify the receiver actually receives the full
        // amount (a token charging a fee on outbound transfers would otherwise
        // short the receiver while we mark them fully withdrawn).
        Self::transfer_out_exact(&env, &stream.token, &receiver, withdrawable);

        StreamEvent {
            kind: symbol_short!("withdraw"),
            stream_id,
            sender: stream.sender,
            receiver,
            token: stream.token,
            amount: withdrawable,
            receiver_amount: withdrawable,
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
        // FIX (Finding 1): keep the id counter alive alongside the stream.
        Self::bump_ttl(&env, &DataKey::Counter);

        // FIX (Finding 3): verify each outbound transfer delivers the exact
        // amount, so a fee-on-transfer token can't short the receiver or the
        // sender's refund.
        if unwithdrawn > 0 {
            Self::transfer_out_exact(&env, &stream.token, &stream.receiver, unwithdrawn);
        }
        if refund > 0 {
            Self::transfer_out_exact(&env, &stream.token, &stream.sender, refund);
        }

        StreamEvent {
            kind: symbol_short!("cancelled"),
            stream_id,
            sender: stream.sender,
            receiver: stream.receiver,
            token: stream.token,
            amount: refund,
            receiver_amount: unwithdrawn,
            start_time: stream.start_time,
            end_time: stream.end_time,
        }
        .publish(&env);

        refund
    }

    /// Cancel an entire split group. Only the sender may do this — letting a
    /// single receiver cancel every other receiver's future accrual would be
    /// over-reaching (each receiver can still `cancel` their own stream).
    ///
    /// Settles every member in one call: each receiver is paid their vested-
    /// but-unwithdrawn remainder, and the sender receives ONE refund equal to
    /// the sum of every member's unvested remainder. Returns that total refund.
    pub fn cancel_split(env: Env, sender: Address, root_id: u64) -> i128 {
        sender.require_auth();

        let group = Self::load_split(&env, root_id);
        if group.sender != sender {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let now = env.ledger().timestamp();
        let mut total_refund: i128 = 0;
        // FIX (Finding 6): settle in two passes — freeze every member (all
        // effects) before any external token call (interactions), so the
        // contract is never observable in a half-settled state during a payout.
        let mut payout_receivers = Vec::new(&env);
        let mut payout_amounts = Vec::new(&env);

        // Pass 1: freeze all members and accumulate the payout/refund totals.
        for i in 0..group.member_ids.len() {
            let stream_id = group.member_ids.get(i).unwrap();
            let mut stream = Self::load(&env, stream_id);
            if stream.cancelled {
                continue; // already settled by an individual `cancel`
            }
            // Invariant of `create_split_stream`: every member belongs to this
            // sender. Defensive in case storage was written by other means.
            if stream.sender != sender {
                panic_with_error!(&env, Error::Unauthorized);
            }

            let accrued = vested_so_far(&stream, now);
            let unwithdrawn = accrued - stream.withdrawn;
            let refund = stream.total_amount - accrued;

            // Freeze vesting and record the payout before the external calls
            // (check-effects-interactions).
            stream.cancelled = true;
            stream.cancelled_at = now;
            stream.withdrawn = accrued;
            env.storage()
                .persistent()
                .set(&DataKey::Stream(stream_id), &stream);
            Self::bump_ttl(&env, &DataKey::Stream(stream_id));
            // FIX (Finding 1): keep the id counter alive alongside the stream.
            Self::bump_ttl(&env, &DataKey::Counter);

            if unwithdrawn > 0 {
                payout_receivers.push_back(stream.receiver.clone());
                payout_amounts.push_back(unwithdrawn);
            }
            total_refund += refund;

            StreamEvent {
                kind: symbol_short!("cancelled"),
                stream_id,
                sender: stream.sender.clone(),
                receiver: stream.receiver.clone(),
                token: stream.token.clone(),
                amount: refund,
                receiver_amount: unwithdrawn,
                start_time: stream.start_time,
                end_time: stream.end_time,
            }
            .publish(&env);
        }

        // Pass 2: all effects are committed; now perform every external call.
        // All members share `group.token` (invariant of `create_split_stream`).
        // FIX (Finding 3): verify each outbound transfer delivers the exact
        // amount so a fee-on-transfer token can't short a receiver.
        for i in 0..payout_receivers.len() {
            Self::transfer_out_exact(
                &env,
                &group.token,
                &payout_receivers.get(i).unwrap(),
                payout_amounts.get(i).unwrap(),
            );
        }
        // One aggregate refund to the sender, after every receiver is settled.
        if total_refund > 0 {
            Self::transfer_out_exact(&env, &group.token, &sender, total_refund);
        }
        Self::bump_ttl(&env, &DataKey::Split(root_id));

        total_refund
    }

    /// Pause new stream creation. Only the admin may call this; their
    /// signature is verified via `require_auth`. `withdraw` and `cancel` of
    /// existing streams are NEVER affected.
    pub fn pause(env: Env) {
        Self::admin(&env).require_auth();
        env.storage().persistent().set(&DataKey::Paused, &true);
        Self::bump_ttl(&env, &DataKey::Paused);
        Self::bump_ttl(&env, &DataKey::Admin);
    }

    /// Resume new stream creation. Only the admin may call this.
    pub fn unpause(env: Env) {
        Self::admin(&env).require_auth();
        env.storage().persistent().set(&DataKey::Paused, &false);
        Self::bump_ttl(&env, &DataKey::Paused);
        Self::bump_ttl(&env, &DataKey::Admin);
    }

    /// Whether new stream creation is currently paused (view).
    pub fn paused(env: Env) -> bool {
        Self::is_paused(&env)
    }

    /// Keep a stream's storage entry alive so long-running streams don't get
    /// archived mid-term. Permissionless: it changes nothing but the entry's
    /// TTL, so any keeper/relayer bot may call it on any stream.
    ///
    /// FIX (Finding 1): TTL was previously only extended on create/withdraw/
    /// cancel, so an idle stream whose duration exceeded `max_ttl` would be
    /// archived and its funds stranded. This lets anyone re-arm TTL without
    /// performing a mutating action. (`DataKey::Counter` is kept alive by
    /// `create_stream` itself, which bumps it on every creation.)
    pub fn bump(env: Env, stream_id: u64) {
        Self::load(&env, stream_id); // validates existence (StreamNotFound otherwise)
        Self::bump_ttl(&env, &DataKey::Stream(stream_id));
        // FIX (Finding 1): keep the id counter alive alongside streams so a
        // long-idle contract can never wrap `next_id` back to 0 and overwrite
        // a live stream. (Counter exists whenever at least one stream exists.)
        Self::bump_ttl(&env, &DataKey::Counter);
        // FIX (Stage 3): also re-arm the admin config so the pause feature
        // can't silently expire while keepers are active. Guarded because
        // `extend_ttl` on a missing key panics (contract not initialized).
        if env.storage().persistent().has(&DataKey::Admin) {
            Self::bump_ttl(&env, &DataKey::Admin);
        }
        // FIX (Finding 1): also re-arm the pause flag. Without this, an
        // emergency pause that outlasts the TTL window would be archived and
        // `is_paused()` would silently return false, lifting the circuit
        // breaker. Guarded: `extend_ttl` on a missing key panics.
        if env.storage().persistent().has(&DataKey::Paused) {
            Self::bump_ttl(&env, &DataKey::Paused);
        }
        // FIX (Stage 5): if this stream is the root of a split group, also
        // re-arm the group entry so `cancel_split` can't silently expire while
        // members are kept alive. Guarded: `extend_ttl` on a missing key panics.
        if env.storage().persistent().has(&DataKey::Split(stream_id)) {
            Self::bump_ttl(&env, &DataKey::Split(stream_id));
        }
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

    /// View the split group rooted at `root_id` (panics `SplitNotFound` if the
    /// id is not a split-group root).
    pub fn get_split(env: Env, root_id: u64) -> SplitGroup {
        Self::load_split(&env, root_id)
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

    /// Allocate the next stream id and bump the counter so ids stay unique
    /// across calls. Shared by `create_stream` and `create_split_stream`.
    /// FIX (Finding 3): guard the increment against u64 overflow.
    fn allocate_id(env: &Env) -> u64 {
        let stream_id = Self::next_id(env);
        let next_id = match stream_id.checked_add(1) {
            Some(id) => id,
            None => panic_with_error!(env, Error::StreamIdOverflow),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Counter, &next_id);
        stream_id
    }

    /// Compute per-receiver shares of `total` from integer weights that sum to
    /// `scale` (e.g. `100` for percentages, `10_000` for basis points) using
    /// the largest-remainder method: floor every share first, then hand the
    /// leftover units to the receivers with the largest fractional
    /// remainders. The result always sums to `total` exactly, with no lost or
    /// minted rounding dust.
    fn split_by_weights(env: &Env, total: i128, weights: &Vec<u32>, scale: i128) -> Vec<i128> {
        let n = weights.len();
        let mut shares = Vec::new(env);
        let mut remainders = Vec::new(env);
        let mut allocated: i128 = 0;

        for i in 0..n {
            let w = weights.get(i).unwrap() as i128;
            // floor(total * w / scale) without a wide multiply: (total/scale)*w
            // is bounded by `total` (since w <= scale), and (total%scale)*w is
            // bounded by scale^2, so neither term overflows.
            let base = (total / scale) * w;
            let rem_numer = (total % scale) * w;
            let share = base + rem_numer / scale;
            shares.push_back(share);
            remainders.push_back(rem_numer % scale);
            allocated += share;
        }

        // Distribute the rounding dust (total - allocated) one unit at a time
        // to the receivers with the largest fractional remainders, at most one
        // unit each. Deterministic; ties resolve to the lowest index.
        let mut dust = total - allocated;
        while dust > 0 {
            let mut best_idx: u32 = 0;
            let mut best_rem: i128 = -1;
            for i in 0..n {
                let r = remainders.get(i).unwrap();
                if r > best_rem {
                    best_rem = r;
                    best_idx = i;
                }
            }
            shares.set(best_idx, shares.get(best_idx).unwrap() + 1);
            remainders.set(best_idx, -1); // exclude this receiver from more dust
            dust -= 1;
        }

        shares
    }

    /// FIX (Finding 7): extend a persistent entry's TTL all the way to the
    /// network maximum. Used for one-shot config entries (`Admin`, `Paused`)
    /// that have no natural re-arm path and must survive a fully idle contract.
    fn bump_ttl_max(env: &Env, key: &DataKey) {
        let max = env.storage().max_ttl();
        env.storage().persistent().extend_ttl(key, max, max);
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

    /// FIX (Finding 3): transfer `amount` from the contract to `to` and verify
    /// the recipient's balance actually increased by exactly `amount`. A token
    /// that charges a fee on outbound transfers (or otherwise under-credits)
    /// would otherwise let us mark funds withdrawn while shorting the
    /// recipient. (A token that lies about `balance()` is still undefeatable;
    /// streaming SAC assets or an allowlist remains the only complete defense.)
    fn transfer_out_exact(env: &Env, token: &Address, to: &Address, amount: i128) {
        let client = token::Client::new(env, token);
        let contract = env.current_contract_address();
        // FIX (Finding 6): verify BOTH sides of the transfer. The previous
        // recipient-delta check let a token that over-debits the sender (e.g. a
        // fee taken from the `from` side) pass while silently draining the
        // shared pool, which could strand other streams using the same token.
        let from_before = client.balance(&contract);
        let to_before = client.balance(to);
        client.transfer(&contract, to, &amount);
        let from_after = client.balance(&contract);
        let to_after = client.balance(to);
        if from_before - from_after != amount || to_after - to_before != amount {
            panic_with_error!(env, Error::TokenTransferMismatch);
        }
    }

    fn load(env: &Env, stream_id: u64) -> Stream {
        env.storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::StreamNotFound))
    }

    fn load_split(env: &Env, root_id: u64) -> SplitGroup {
        env.storage()
            .persistent()
            .get(&DataKey::Split(root_id))
            .unwrap_or_else(|| panic_with_error!(env, Error::SplitNotFound))
    }

    /// The immutable admin address (set by the constructor). The `NotInitialized`
    /// panic is purely defensive — the constructor always writes the key.
    fn admin(env: &Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    /// Whether new stream creation is paused. An absent flag means un-paused.
    fn is_paused(env: &Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false)
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
    // FIX (Finding 2): `total * elapsed` overflows i128 for near-max amounts.
    // Decompose into a floored per-second rate + remainder term so the first
    // product is bounded by `total` and the second by `duration`; checked ops
    // trap (rather than wrap) on the remaining pathological-duration case.
    let per_sec = total / duration;
    let rem = total % duration;
    let base = per_sec
        .checked_mul(elapsed)
        .expect("vested_amount: rate overflow");
    // FIX (Finding 4): compute the remainder term in u128 so `rem * elapsed`
    // cannot overflow i128 for pathological durations (`rem < duration < 2^64`
    // and `elapsed <= duration`, so the product fits in u128).
    let frac = ((rem as u128) * (elapsed as u128) / (duration as u128)) as i128;
    base + frac
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
