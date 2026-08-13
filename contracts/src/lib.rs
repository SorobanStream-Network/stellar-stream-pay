#![no_std]

//! StellarStream-Pay — multi-tier continuous streaming payments on Stellar.
//!
//! A "stream" is a linearly-vesting payment: a sender locks a SEP-41 token
//! amount (which includes Stellar Asset Contract "SAC" wrapped native assets)
//! for a fixed duration, and the receiver may withdraw the pro-rata amount
//! that has accrued so far, on demand.
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

/// Persistent-storage key holding the monotonic stream-id counter.
const COUNTER: Symbol = symbol_short!("count");

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
    pub withdrawn: i128,  // cumulative amount the receiver has pulled out
    pub cancelled: bool,
    pub cancelled_at: u64, // vesting freeze time; 0 while the stream is active
}

/// Lifecycle event published so off-chain indexers can track streams without
/// polling storage. `kind` is one of "created" | "withdrawn" | "cancelled".
#[contractevent]
#[derive(Clone)]
pub struct StreamEvent {
    #[topic]
    pub stream_id: u64,
    #[topic]
    pub sender: Address,
    #[topic]
    pub receiver: Address,
    pub token: Address,
    pub amount: i128,
    pub kind: Symbol,
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

        // Lock funds: pull `amount` from the sender into the contract's own
        // balance. `token::Client` requires the sender's auth for the transfer,
        // which flows through because we are invoked in the sender's
        // transaction. Works for SAC assets and any SEP-41 token.
        token::Client::new(&env, &token).transfer(
            &sender,
            &env.current_contract_address(),
            &amount,
        );

        let stream_id = Self::next_id(&env);
        env.storage().persistent().set(
            &stream_id,
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
        env.storage().persistent().set(&COUNTER, &(stream_id + 1));

        StreamEvent {
            stream_id,
            sender,
            receiver,
            token,
            amount,
            kind: symbol_short!("created"),
        }
        .publish(&env);

        stream_id
    }

    /// Withdraw everything that has accrued up to the current ledger time.
    /// Requires the receiver's signature. Returns the amount transferred.
    pub fn withdraw(env: Env, receiver: Address, stream_id: u64) -> i128 {
        receiver.require_auth();

        let mut stream = Self::load(&env, stream_id);
        // A cancelled stream stays claimable: the receiver may still pull the
        // portion that vested before cancellation (vesting was frozen by
        // `cancel_stream` recording `cancelled_at`).
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
        env.storage().persistent().set(&stream_id, &stream);

        // Pay out. The contract is the `from`; the token contract's own
        // `require_auth` for the contract address is satisfied because this
        // contract is the currently-executing contract in the call chain.
        token::Client::new(&env, &stream.token).transfer(
            &env.current_contract_address(),
            &receiver,
            &withdrawable,
        );

        StreamEvent {
            stream_id,
            sender: stream.sender,
            receiver,
            token: stream.token,
            amount: withdrawable,
            kind: symbol_short!("withdrawn"),
        }
        .publish(&env);

        withdrawable
    }

    /// Sender cancels the stream and reclaims the *unvested* remainder. The
    /// already-vested portion stays in the contract and remains withdrawable
    /// by the receiver. Returns the amount refunded to the sender.
    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) -> i128 {
        sender.require_auth();

        let mut stream = Self::load(&env, stream_id);
        if stream.cancelled {
            panic_with_error!(&env, Error::StreamCancelled);
        }
        if stream.sender != sender {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let now = env.ledger().timestamp();
        let accrued = vested_so_far(&stream, now);
        let refund = stream.total_amount - accrued;

        // Freeze vesting at the cancellation time so a later `withdraw` can
        // only claim what had vested up to this point. `end_time` keeps the
        // original schedule; `cancelled_at` records when vesting stopped.
        stream.cancelled = true;
        stream.cancelled_at = now;
        env.storage().persistent().set(&stream_id, &stream);

        if refund > 0 {
            token::Client::new(&env, &stream.token).transfer(
                &env.current_contract_address(),
                &sender,
                &refund,
            );
        }

        StreamEvent {
            stream_id,
            sender,
            receiver: stream.receiver,
            token: stream.token,
            amount: refund,
            kind: symbol_short!("cancelled"),
        }
        .publish(&env);

        refund
    }

    // ---- Views (read-only) ------------------------------------------------

    pub fn get_stream(env: Env, stream_id: u64) -> Stream {
        Self::load(&env, stream_id)
    }

    pub fn get_accrued(env: Env, stream_id: u64) -> i128 {
        let s = Self::load(&env, stream_id);
        vested_so_far(&s, env.ledger().timestamp())
    }

    pub fn get_withdrawable(env: Env, stream_id: u64) -> i128 {
        let s = Self::load(&env, stream_id);
        // For a cancelled stream vesting is frozen at `cancelled_at`, so this
        // is exactly the still-claimable vested remainder.
        vested_so_far(&s, env.ledger().timestamp()) - s.withdrawn
    }

    pub fn get_stream_count(env: Env) -> u64 {
        env.storage().persistent().get(&COUNTER).unwrap_or(0)
    }

    // ---- Internals --------------------------------------------------------

    fn next_id(env: &Env) -> u64 {
        env.storage().persistent().get(&COUNTER).unwrap_or(0)
    }

    fn load(env: &Env, stream_id: u64) -> Stream {
        env.storage()
            .persistent()
            .get(&stream_id)
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
mod test {
    // The crate is `#![no_std]`, but tests run natively and link the standard
    // library (needed for `std::vec::Vec` in the auth-tree assertions).
    extern crate std;

    use super::{vested_amount, StreamingContract, StreamingContractClient};
    use soroban_sdk::{
        contract, contractimpl, contracttype, symbol_short, vec,
        testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger as _},
        token, Address, Env, IntoVal, Symbol,
    };

    // ---- Mock SEP-41 token --------------------------------------------------
    //
    // A minimal SEP-41 token backed by plain persistent storage. It is a
    // self-contained stand-in for any SEP-41 token (SAC-wrapped native assets
    // or custom tokens) and exercises the identical code path the streaming
    // contract uses (`token::Client` pull in `create_stream`, push in
    // `withdraw`/`cancel_stream`).

    #[contract]
    pub struct MockToken;

    #[contracttype]
    #[derive(Clone)]
    enum MockTokenKey {
        Balance(Address),
    }

    #[contractimpl]
    impl MockToken {
        pub fn mint(env: Env, admin: Address, to: Address, amount: i128) {
            admin.require_auth();
            let key = MockTokenKey::Balance(to);
            let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage().persistent().set(&key, &(balance + amount));
        }

        pub fn balance(env: Env, addr: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&MockTokenKey::Balance(addr))
                .unwrap_or(0)
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            if amount <= 0 {
                return;
            }
            let from_key = MockTokenKey::Balance(from);
            let to_key = MockTokenKey::Balance(to);
            let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
            assert!(from_balance >= amount, "insufficient balance");
            let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&from_key, &(from_balance - amount));
            env.storage().persistent().set(&to_key, &(to_balance + amount));
        }
    }

    // ---- Pure vesting math (no Env) --------------------------------------

    #[test]
    fn halfway_is_half() {
        // 100 units over 100 seconds; at t=50 exactly half has vested.
        assert_eq!(vested_amount(100, 0, 100, 50), 50);
    }

    #[test]
    fn caps_at_end() {
        assert_eq!(vested_amount(100, 0, 100, 100), 100);
        assert_eq!(vested_amount(100, 0, 100, 999_999), 100);
    }

    #[test]
    fn nothing_before_start() {
        assert_eq!(vested_amount(100, 10, 110, 5), 0);
    }

    #[test]
    fn floors_fractional_amounts() {
        // 100 / 3 ≈ 33.3 per second; after 1s the floored accrual is 33.
        assert_eq!(vested_amount(100, 0, 3, 1), 33);
    }

    // ---- Integration: mock token + create/withdraw round-trip -------------

    const START: u64 = 1_000_000;
    const FUNDING: i128 = 1_000_000_000;

    /// Deploy a mock SEP-41 token (minted to `sender`), deploy the streaming
    /// contract, mock every `require_auth`, and fix the ledger timestamp.
    /// Returns (env, client, contract_id, token, sender, receiver).
    fn setup() -> (
        Env,
        StreamingContractClient<'static>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let receiver = Address::generate(&env);

        // Deploy the mock token and our streaming contract.
        let token = env.register(MockToken, ());

        let contract_id = env.register(StreamingContract, ());
        let client = StreamingContractClient::new(&env, &contract_id);

        // Auto-authorize every `require_auth` for the test. The contract's own
        // token pull/push are self-auth (the contract is the direct caller of
        // the token), so plain `mock_all_auths` suffices.
        env.mock_all_auths();

        // Fund the sender.
        MockTokenClient::new(&env, &token).mint(&admin, &sender, &FUNDING);

        env.ledger().set_timestamp(START);

        (env, client, contract_id, token, sender, receiver)
    }

    #[test]
    fn create_and_withdraw_round_trip() {
        let (env, client, contract_id, token, sender, receiver) = setup();
        let token_client = token::Client::new(&env, &token);

        // Create: 1,000 base units streamed over 100 seconds.
        let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
        assert_eq!(stream_id, 0);

        // Funds moved from the sender into the contract's own balance.
        assert_eq!(token_client.balance(&sender), FUNDING - 1_000);
        assert_eq!(token_client.balance(&contract_id), 1_000);

        // Stored stream reflects the inputs.
        let s = client.get_stream(&stream_id);
        assert_eq!(s.sender, sender);
        assert_eq!(s.receiver, receiver);
        assert_eq!(s.total_amount, 1_000);
        assert_eq!(s.start_time, START);
        assert_eq!(s.end_time, START + 100);
        assert_eq!(s.withdrawn, 0);

        // Halfway through the term: exactly half (500) has vested.
        env.ledger().set_timestamp(START + 50);
        assert_eq!(client.get_accrued(&stream_id), 500_i128);

        let withdrawn = client.withdraw(&receiver, &stream_id);
        assert_eq!(withdrawn, 500_i128);
        assert_eq!(token_client.balance(&receiver), 500);
        // Everything accrued so far has now been withdrawn, so nothing is
        // immediately withdrawable again until more vests.
        assert_eq!(client.get_withdrawable(&stream_id), 0_i128);

        // Past the end: the remaining 500 becomes fully vested and payable.
        env.ledger().set_timestamp(START + 200);
        let withdrawn2 = client.withdraw(&receiver, &stream_id);
        assert_eq!(withdrawn2, 500_i128);
        assert_eq!(token_client.balance(&receiver), 1_000);
        assert_eq!(client.get_withdrawable(&stream_id), 0_i128);
    }

    #[test]
    fn cancel_refunds_unvested_remainder() {
        let (env, client, _contract_id, token, sender, receiver) = setup();
        let token_client = token::Client::new(&env, &token);

        let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

        // 25% vested, then the sender cancels: 750 is refunded, 250 stays
        // locked in the contract and remains claimable by the receiver.
        env.ledger().set_timestamp(START + 25);
        let refund = client.cancel_stream(&sender, &stream_id);
        assert_eq!(refund, 750_i128);
        assert_eq!(token_client.balance(&sender), FUNDING - 250);
        assert_eq!(client.get_withdrawable(&stream_id), 250_i128);

        // The receiver can still claim the vested 250 after cancellation.
        let withdrawn = client.withdraw(&receiver, &stream_id);
        assert_eq!(withdrawn, 250_i128);
        assert_eq!(token_client.balance(&receiver), 250);
    }

    // ---- Authorization-tree assertions ------------------------------------

    #[test]
    fn withdraw_records_receiver_auth() {
        let (env, client, contract_id, token, sender, receiver) = setup();

        let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
        env.ledger().set_timestamp(START + 50);
        // `auths()` reflects only the most recent invocation: `withdraw`.
        client.withdraw(&receiver, &stream_id);

        let auths = env.auths();
        assert_eq!(auths.len(), 1);
        let (authed, invocation) = auths.into_iter().next().unwrap();
        // The receiver is the only party whose signature is required.
        assert_eq!(authed, receiver.clone());

        // `require_auth()` records the full function invocation. The payout is
        // pulled from the contract's own balance, so the token's `require_auth`
        // is satisfied by the contract itself (self-auth) and never appears as
        // a sub-invocation the receiver must sign.
        assert_eq!(
            invocation,
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    contract_id.clone(),
                    symbol_short!("withdraw"),
                    vec![&env, receiver.into_val(&env), stream_id.into_val(&env)],
                )),
                sub_invocations: std::vec![],
            }
        );
    }

    #[test]
    fn create_stream_records_sender_auth() {
        let (env, client, contract_id, token, sender, receiver) = setup();

        client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

        let auths = env.auths();
        assert_eq!(auths.len(), 1);
        let (authed, invocation) = auths.into_iter().next().unwrap();
        // The sender authorizes both the stream creation and the token pull.
        assert_eq!(authed, sender.clone());

        assert_eq!(
            invocation,
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    contract_id.clone(),
                    Symbol::new(&env, "create_stream"),
                    vec![
                        &env,
                        sender.into_val(&env),
                        receiver.into_val(&env),
                        token.into_val(&env),
                        1_000_i128.into_val(&env),
                        100_u64.into_val(&env),
                    ],
                )),
                // The token `transfer` from the sender into the contract is
                // authorized by the sender as a sub-invocation of `create_stream`.
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        token.clone(),
                        symbol_short!("transfer"),
                        vec![
                            &env,
                            sender.into_val(&env),
                            contract_id.into_val(&env),
                            1_000_i128.into_val(&env),
                        ],
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        );
    }

    // ---- Negative tests ----------------------------------------------------
    //
    // Each mutating path aborts with `panic_with_error!`, which the generated
    // client surfaces as a panic whose message encodes the contract error
    // code as `HostError: Error(Contract, #<code>)` (see the official
    // `errors` example's `test_panic` for the canonical format).

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #1)")] // Error::Unauthorized
    fn withdraw_rejects_non_receiver() {
        let (env, client, _contract_id, token, sender, receiver) = setup();
        let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

        // Advance the clock so funds *are* vested — we want to exercise the
        // receiver-ownership check specifically, not the zero-balance path.
        env.ledger().set_timestamp(START + 50);

        // An unrelated third party tries to drain the receiver's stream.
        let attacker = Address::generate(&env);
        client.withdraw(&attacker, &stream_id);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #4)")] // Error::NothingToWithdraw
    fn withdraw_rejects_when_nothing_vested() {
        let (_env, client, _contract_id, token, sender, receiver) = setup();
        let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

        // Still at the start timestamp: zero has accrued, so there is nothing
        // to withdraw even for the legitimate receiver.
        client.withdraw(&receiver, &stream_id);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #1)")] // Error::Unauthorized
    fn cancel_rejects_non_owner() {
        let (env, client, _contract_id, token, sender, receiver) = setup();
        let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
        env.ledger().set_timestamp(START + 25);

        // A third party tries to cancel and steal the sender's unvested funds.
        let attacker = Address::generate(&env);
        client.cancel_stream(&attacker, &stream_id);
    }

    // ---- Additional edge cases ----------------------------------------------

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #5)")] // Error::InvalidAmount
    fn create_stream_rejects_zero_amount() {
        let (_env, client, _contract_id, token, sender, receiver) = setup();

        // `amount` must be strictly positive; zero is rejected before any
        // token movement or storage write happens.
        client.create_stream(&sender, &receiver, &token, &0_i128, &100_u64);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #6)")] // Error::InvalidDuration
    fn create_stream_rejects_zero_duration() {
        let (_env, client, _contract_id, token, sender, receiver) = setup();

        // A zero-length stream is degenerate (and would divide by zero in the
        // vesting math), so it is rejected outright.
        client.create_stream(&sender, &receiver, &token, &1_000_i128, &0_u64);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Contract, #7)")] // Error::InvalidParties
    fn create_stream_rejects_sender_as_receiver() {
        let (_env, client, _contract_id, token, sender, _receiver) = setup();

        // Streaming to yourself is a no-op that would lock and re-pay your own
        // funds; the contract forbids it.
        client.create_stream(&sender, &sender, &token, &1_000_i128, &100_u64);
    }

    #[test]
    fn cancel_after_full_vest_refunds_zero() {
        let (env, client, _contract_id, token, sender, receiver) = setup();
        let token_client = token::Client::new(&env, &token);

        let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

        // Past the end of the term the entire amount has vested, so there is
        // no unvested remainder left for the sender to claw back.
        env.ledger().set_timestamp(START + 200);
        let refund = client.cancel_stream(&sender, &stream_id);
        assert_eq!(refund, 0_i128);
        assert_eq!(token_client.balance(&sender), FUNDING - 1_000);

        // The receiver can still pull the fully-vested amount after the cancel.
        let withdrawn = client.withdraw(&receiver, &stream_id);
        assert_eq!(withdrawn, 1_000_i128);
        assert_eq!(token_client.balance(&receiver), 1_000);
    }

    #[test]
    fn multiple_streams_are_independent() {
        let (env, client, _contract_id, token, sender, receiver) = setup();

        // Two streams with different amounts/durations get distinct ids and
        // fully independent storage.
        let id0 = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
        let id1 = client.create_stream(&sender, &receiver, &token, &2_000_i128, &200_u64);
        assert_eq!(id0, 0);
        assert_eq!(id1, 1);
        assert_eq!(client.get_stream_count(), 2_u64);

        let s0 = client.get_stream(&id0);
        let s1 = client.get_stream(&id1);
        assert_eq!(s0.total_amount, 1_000);
        assert_eq!(s1.total_amount, 2_000);

        // At t=100s, stream #0 (100s term) is fully vested while stream #1
        // (200s term) is only half vested — accrual is tracked per stream.
        env.ledger().set_timestamp(START + 100);
        assert_eq!(client.get_accrued(&id0), 1_000_i128);
        assert_eq!(client.get_accrued(&id1), 1_000_i128);

        // Withdrawing from one stream leaves the other untouched.
        let w0 = client.withdraw(&receiver, &id0);
        assert_eq!(w0, 1_000_i128);
        assert_eq!(client.get_withdrawable(&id1), 1_000_i128);
    }
}
