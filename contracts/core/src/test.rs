// The crate is `#![no_std]`, but tests run natively and link the standard
// library (needed for `std::vec::Vec` in the auth-tree assertions).
extern crate std;

use super::{vested_amount, DataKey, SplitEvent, StreamEvent, StreamingContract, StreamingContractClient, STREAM_CORE_API_VERSION, MAX_BUMP_BATCH, MAX_SPLIT_MEMBERS};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec, Event,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Events, Ledger as _},
    token, Address, Env, IntoVal, Symbol, Vec,
};
use soroban_sdk::xdr::{Limits, ScVal, WriteXdr};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use proptest::prelude::*;

// ---- Mock SEP-41 token --------------------------------------------------
//
// A minimal SEP-41 token backed by plain persistent storage. It is a
// self-contained stand-in for any SEP-41 token (SAC-wrapped native assets
// or custom tokens) and exercises the identical code path the streaming
// contract uses (`token::Client` pull in `create_stream`, push in
// `withdraw`/`cancel`).

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
        env.storage()
            .persistent()
            .set(&to_key, &(to_balance + amount));
    }
}

// ---- Fee-on-transfer mock token ------------------------------------------
//
// Like `MockToken`, but every `transfer` deducts a flat fee from the credited
// amount. Used to prove that `create_stream` rejects tokens whose transfer
// doesn't credit the contract with the exact requested amount.

const TRANSFER_FEE: i128 = 100;

#[contract]
pub struct FeeToken;

#[contracttype]
#[derive(Clone)]
enum FeeTokenKey {
    Balance(Address),
}

#[contractimpl]
impl FeeToken {
    pub fn mint(env: Env, admin: Address, to: Address, amount: i128) {
        admin.require_auth();
        let key = FeeTokenKey::Balance(to);
        let b: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(b + amount));
    }

    pub fn balance(env: Env, addr: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&FeeTokenKey::Balance(addr))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            return;
        }
        // Charge a flat fee: the recipient only receives `amount - fee`.
        let credited = amount - TRANSFER_FEE;
        let from_key = FeeTokenKey::Balance(from);
        let to_key = FeeTokenKey::Balance(to);
        let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        assert!(from_balance >= amount, "insufficient balance");
        let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&from_key, &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&to_key, &(to_balance + credited));
    }
}

// ---- Sender-fee (over-debit) mock token ----------------------------------
//
// Like `MockToken`, but `transfer` credits the recipient the full `amount`
// while debiting the *sender* by `amount + fee`. This is the inverse of the
// recipient-shorted `FeeToken`: the recipient's balance looks correct, but the
// paying contract is silently over-charged. Used to prove `transfer_out_exact`
// (Finding 6) rejects outbound transfers that over-debit the `from` side,
// which would otherwise drain the contract's shared token pool.

#[contract]
pub struct SenderFeeToken;

#[contracttype]
#[derive(Clone)]
enum SenderFeeTokenKey {
    Balance(Address),
}

#[contractimpl]
impl SenderFeeToken {
    pub fn mint(env: Env, admin: Address, to: Address, amount: i128) {
        admin.require_auth();
        let key = SenderFeeTokenKey::Balance(to);
        let b: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(b + amount));
    }

    pub fn balance(env: Env, addr: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&SenderFeeTokenKey::Balance(addr))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            return;
        }
        // The recipient is credited in full; the sender is debited extra.
        let debited = amount + TRANSFER_FEE;
        let from_key = SenderFeeTokenKey::Balance(from);
        let to_key = SenderFeeTokenKey::Balance(to);
        let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        assert!(from_balance >= debited, "insufficient balance");
        let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&from_key, &(from_balance - debited));
        env.storage()
            .persistent()
            .set(&to_key, &(to_balance + amount));
    }
}

// ---- Pure vesting math (no Env) ------------------------------------------

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

// ---- Property-based tests (proptest) --------------------------------------
//
// `vested_amount` is a pure function, so its correctness can be checked with
// randomized inputs across thousands of cases — no `Env`, so no snapshot churn.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2048))]

    #[test]
    fn vested_amount_is_bounded(
        total in 0i128..10_000_000i128,
        start in 0u64..10_000u64,
        len in 1u64..10_000u64,
        now in 0u64..30_000u64,
    ) {
        let end = start + len;
        let v = vested_amount(total, start, end, now);
        prop_assert!(v >= 0);
        prop_assert!(v <= total);
    }

    #[test]
    fn vested_amount_is_monotonic_in_time(
        total in 1i128..10_000_000i128,
        start in 0u64..10_000u64,
        len in 1u64..10_000u64,
        now in 0u64..20_000u64,
        delta in 0u64..10_000u64,
    ) {
        let end = start + len;
        let now2 = now.saturating_add(delta);
        prop_assert!(
            vested_amount(total, start, end, now2) >= vested_amount(total, start, end, now)
        );
    }

    #[test]
    fn vested_amount_is_exact_floor_division(
        total in 1i128..10_000_000i128,
        start in 0u64..10_000u64,
        len in 1u64..10_000u64,
        now in 0u64..30_000u64,
    ) {
        let end = start + len;
        let v = vested_amount(total, start, end, now);
        let t = if now < end { now } else { end };
        let elapsed = t.saturating_sub(start) as i128;
        let duration = (end - start) as i128;
        // v == floor(total * elapsed / duration)  ⇔
        //   v * duration <= total * elapsed < (v + 1) * duration
        prop_assert!(v * duration <= total * elapsed);
        prop_assert!((v + 1) * duration > total * elapsed);
    }

    #[test]
    fn vested_amount_endpoints_are_exact(
        total in 1i128..10_000_000i128,
        start in 0u64..10_000u64,
        len in 1u64..10_000u64,
    ) {
        let end = start + len;
        prop_assert_eq!(vested_amount(total, start, end, start), 0);
        prop_assert_eq!(vested_amount(total, start, end, end), total);
        // Past the end it clamps to the full amount.
        prop_assert_eq!(vested_amount(total, start, end, end + len), total);
    }

    #[test]
    fn vested_amount_distributes_across_split(
        a in 1i128..1_000_000i128,
        b in 1i128..1_000_000i128,
        start in 0u64..10_000u64,
        len in 1u64..10_000u64,
        now in 0u64..30_000u64,
    ) {
        let end = start + len;
        let v_ab = vested_amount(a + b, start, end, now);
        let v_a = vested_amount(a, start, end, now);
        let v_b = vested_amount(b, start, end, now);
        // Flooring can lose at most one base unit across the split.
        prop_assert!(v_ab >= v_a + v_b);
        prop_assert!(v_ab <= v_a + v_b + 1);
    }
}

// ---- Integration: mock token + create/withdraw/cancel round-trips -------

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

    let contract_id = env.register(StreamingContract, (admin.clone(),));
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
    assert_eq!(client.streamed_amount(&stream_id), 500_i128);

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
fn cancel_settles_both_parties() {
    let (env, client, _contract_id, token, sender, receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // 25% vested, then the SENDER cancels: 250 is paid to the receiver and
    // 750 refunded to the sender — all in a single settlement call.
    env.ledger().set_timestamp(START + 25);
    let refund = client.cancel(&sender, &stream_id);
    assert_eq!(refund, 750_i128);
    assert_eq!(token_client.balance(&sender), FUNDING - 250);
    assert_eq!(token_client.balance(&receiver), 250);

    // Fully settled: nothing left to withdraw, and `withdrawn` reflects the
    // vested amount that was paid out during cancellation.
    assert_eq!(client.get_withdrawable(&stream_id), 0_i128);
    let s = client.get_stream(&stream_id);
    assert!(s.cancelled);
    assert_eq!(s.withdrawn, 250_i128);
}

#[test]
fn receiver_can_cancel() {
    let (env, client, _contract_id, token, sender, receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // The RECEIVER may also cancel: same full settlement, initiated by the
    // other party.
    env.ledger().set_timestamp(START + 50);
    let refund = client.cancel(&receiver, &stream_id);
    assert_eq!(refund, 500_i128);
    assert_eq!(token_client.balance(&sender), FUNDING - 500);
    assert_eq!(token_client.balance(&receiver), 500);
}

#[test]
fn cancel_after_full_vest_refunds_zero() {
    let (env, client, _contract_id, token, sender, receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // Past the term the entire amount has vested: nothing left to refund,
    // and the receiver is paid out in full.
    env.ledger().set_timestamp(START + 200);
    let refund = client.cancel(&sender, &stream_id);
    assert_eq!(refund, 0_i128);
    assert_eq!(token_client.balance(&sender), FUNDING - 1_000);
    assert_eq!(token_client.balance(&receiver), 1_000);
}

#[test]
fn multiple_streams_are_independent() {
    let (env, client, _contract_id, token, sender, receiver) = setup();

    let id0 = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    let id1 = client.create_stream(&sender, &receiver, &token, &2_000_i128, &200_u64);
    assert_eq!(id0, 0);
    assert_eq!(id1, 1);
    assert_eq!(client.get_stream_count(), 2_u64);

    let s0 = client.get_stream(&id0);
    let s1 = client.get_stream(&id1);
    assert_eq!(s0.total_amount, 1_000);
    assert_eq!(s1.total_amount, 2_000);

    // At t=100s: stream #0 (100s) is fully vested, stream #1 (200s) half vested.
    env.ledger().set_timestamp(START + 100);
    assert_eq!(client.streamed_amount(&id0), 1_000_i128);
    assert_eq!(client.streamed_amount(&id1), 1_000_i128);

    // Withdrawing one stream leaves the other untouched.
    let w0 = client.withdraw(&receiver, &id0);
    assert_eq!(w0, 1_000_i128);
    assert_eq!(client.get_withdrawable(&id1), 1_000_i128);
}

// ---- Settlement invariant --------------------------------------------------
//
// The core's safety property: at every point in a stream's life the vested,
// withdrawn, and unvested portions partition the locked total, and after a
// cancel the vested remainder goes to the receiver while the unvested
// remainder returns to the sender — no tokens created or destroyed.

#[test]
fn settlement_invariant_holds_across_scenarios() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    // (amount, duration, withdraw_offset, cancel_offset) — a grid spanning
    // partial/full withdrawals, cancellation with/without a prior withdrawal,
    // tiny amounts (flooring), and large/long streams.
    let scenarios: &[(i128, u64, Option<u64>, Option<u64>)] = &[
        (1_000, 100, Some(50), None),               // partial withdraw, active
        (1_000, 100, Some(200), None),              // withdraw after end (full)
        (1_000, 100, Some(25), Some(75)),           // partial then cancel
        (1_000, 100, None, Some(50)),               // cancel, no prior withdraw
        (1_000, 100, Some(50), Some(50)),           // withdraw + cancel same instant
        (1, 100, Some(100), None),                  // tiny amount, full vest
        (3, 2, Some(1), None),                      // fractional floors down
        (10_000_000, 10_000, Some(9_999), None),    // large, long-running
        (1_000, 100, None, None),                   // active, no action
    ];

    for (i, (amount, duration, w_off, c_off)) in scenarios.iter().enumerate() {
        let t0 = START + (i as u64) * 100_000;
        env.ledger().set_timestamp(t0);
        let id = client.create_stream(&sender, &receiver, &token, amount, duration);

        if let Some(off) = w_off {
            env.ledger().set_timestamp(t0 + off);
            client.withdraw(&receiver, &id);
        }

        if let Some(off) = c_off {
            env.ledger().set_timestamp(t0 + off);
            let refund = client.cancel(&sender, &id);
            let s = client.get_stream(&id);
            // Vested → receiver (recorded as `withdrawn`), unvested → sender
            // (returned as `refund`). Nothing is created or lost.
            assert_eq!(
                s.total_amount,
                s.withdrawn + refund,
                "scenario {i}: total != withdrawn + refund"
            );
            assert_eq!(
                client.get_withdrawable(&id),
                0_i128,
                "scenario {i}: withdrawable != 0 after cancel"
            );
        } else {
            let s = client.get_stream(&id);
            let accrued = client.streamed_amount(&id);
            let withdrawable = client.get_withdrawable(&id);
            assert!(
                s.withdrawn <= accrued && accrued <= s.total_amount,
                "scenario {i}: withdrawn/accrued out of order"
            );
            assert_eq!(
                withdrawable,
                accrued - s.withdrawn,
                "scenario {i}: withdrawable != accrued - withdrawn"
            );
        }
    }

    // Conservation of tokens across every scenario: nothing minted or burned.
    let sender_bal = token_client.balance(&sender);
    let receiver_bal = token_client.balance(&receiver);
    let contract_bal = token_client.balance(&contract_id);
    assert_eq!(
        sender_bal + receiver_bal + contract_bal,
        FUNDING,
        "tokens created or destroyed across scenarios"
    );
}

#[test]
fn version_reports_pinned_api_version() {
    let (_env, client, _contract_id, _token, _sender, _receiver) = setup();
    assert_eq!(client.version(), STREAM_CORE_API_VERSION);
}

// ---- Event ABI assertions -------------------------------------------------
//
// Pin the event shape indexers rely on: a split group emits a `split_created`
// event carrying its members, and `cancelled` events carry the receiver's
// payout (`receiver_amount`) in addition to the sender's refund (`amount`).

#[test]
fn split_creation_emits_group_membership_event() {
    let (env, client, contract_id, token, sender, _receiver) = setup();

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let amounts = vec![&env, 300_i128, 700_i128];

    client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);

    let expected = SplitEvent {
        kind: Symbol::new(&env, "split_created"),
        root_id: 0,
        sender: sender.clone(),
        token: token.clone(),
        member_ids: vec![&env, 0_u64, 1_u64],
        total_amount: 1_000_i128,
    }
    .to_xdr(&env, &contract_id);

    assert!(
        env.events().all().events().contains(&expected),
        "split_created group event missing or malformed"
    );
}

#[test]
fn cancel_event_carries_receiver_payout() {
    let (env, client, contract_id, token, sender, receiver) = setup();

    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    // 25% vested, nothing withdrawn: receiver is owed 250, sender refunded 750.
    env.ledger().set_timestamp(START + 25);
    client.cancel(&sender, &stream_id);

    let expected = StreamEvent {
        kind: symbol_short!("cancelled"),
        stream_id,
        sender: sender.clone(),
        receiver: receiver.clone(),
        token: token.clone(),
        amount: 750,
        receiver_amount: 250,
        start_time: START,
        end_time: START + 100,
    }
    .to_xdr(&env, &contract_id);

    assert!(
        env.events().all().events().contains(&expected),
        "cancelled event missing receiver_amount or malformed"
    );
}

// ---- Authorization-tree assertions ----------------------------------------

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

#[test]
fn cancel_records_caller_auth() {
    let (env, client, contract_id, token, sender, receiver) = setup();

    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    env.ledger().set_timestamp(START + 50);
    client.cancel(&receiver, &stream_id);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    let (authed, invocation) = auths.into_iter().next().unwrap();
    // Either party may cancel; here the receiver is the signer.
    assert_eq!(authed, receiver.clone());

    assert_eq!(
        invocation,
        AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                contract_id.clone(),
                symbol_short!("cancel"),
                vec![&env, receiver.into_val(&env), stream_id.into_val(&env)],
            )),
            sub_invocations: std::vec![],
        }
    );
}

// ---- Negative tests ----------------------------------------------------
//
// Each mutating path aborts with `panic_with_error!`, which the generated
// client surfaces as a panic whose message encodes the contract error
// code as `HostError: Error(Contract, #<code>)`.

#[test]
#[should_panic(expected = "HostError: Error(Contract, #5)")] // Error::InvalidAmount
fn create_stream_rejects_zero_amount() {
    let (_env, client, _contract_id, token, sender, receiver) = setup();
    client.create_stream(&sender, &receiver, &token, &0_i128, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #6)")] // Error::InvalidDuration
fn create_stream_rejects_zero_duration() {
    let (_env, client, _contract_id, token, sender, receiver) = setup();
    client.create_stream(&sender, &receiver, &token, &1_000_i128, &0_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #7)")] // Error::InvalidParties
fn create_stream_rejects_sender_as_receiver() {
    let (_env, client, _contract_id, token, sender, _receiver) = setup();
    client.create_stream(&sender, &sender, &token, &1_000_i128, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #1)")] // Error::Unauthorized
fn withdraw_rejects_non_receiver() {
    let (env, client, _contract_id, token, sender, receiver) = setup();
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    env.ledger().set_timestamp(START + 50);
    let attacker = Address::generate(&env);
    client.withdraw(&attacker, &stream_id);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #4)")] // Error::NothingToWithdraw
fn withdraw_rejects_when_nothing_vested() {
    let (_env, client, _contract_id, token, sender, receiver) = setup();
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    client.withdraw(&receiver, &stream_id);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #1)")] // Error::Unauthorized
fn cancel_rejects_uninvolved_party() {
    let (env, client, _contract_id, token, sender, receiver) = setup();
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    env.ledger().set_timestamp(START + 25);
    let attacker = Address::generate(&env);
    client.cancel(&attacker, &stream_id);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #3)")] // Error::StreamCancelled
fn cancel_rejects_already_cancelled() {
    let (env, client, _contract_id, token, sender, receiver) = setup();
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    env.ledger().set_timestamp(START + 25);
    client.cancel(&sender, &stream_id);
    client.cancel(&sender, &stream_id);
}

// ---- Storage-key encoding (guards the backend's key construction) ---------

#[test]
fn data_key_encoding_matches_backend_expectations() {
    // `#[contracttype]` enums encode as a Vec with a leading Symbol
    // discriminant. The backend indexer builds these exact keys, so pin the
    // XDR so a future SDK change is caught here rather than silently breaking
    // contract reads.
    let counter: ScVal = DataKey::Counter.try_into().unwrap();
    let stream7: ScVal = DataKey::Stream(7).try_into().unwrap();

    // These XDR strings are also what the backend indexer builds with
    // `xdr.ScVal.scvVec([nativeToScVal("Counter", {type:"symbol"})])` (and the
    // Stream variant). Pin both so a future SDK change is caught here instead
    // of silently breaking contract reads.
    assert_eq!(
        counter.to_xdr_base64(Limits::none()).unwrap(),
        "AAAAEAAAAAEAAAABAAAADwAAAAdDb3VudGVyAA=="
    );
    assert_eq!(
        stream7.to_xdr_base64(Limits::none()).unwrap(),
        "AAAAEAAAAAEAAAACAAAADwAAAAZTdHJlYW0AAAAAAAUAAAAAAAAABw=="
    );
}

// ---- Audit regression tests: fee-on-transfer + TTL -------------------------

#[test]
#[should_panic(expected = "HostError: Error(Contract, #8)")] // Error::TokenTransferMismatch
fn create_stream_rejects_fee_on_transfer_token() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);

    let fee_token = env.register(FeeToken, ());
    let contract_id = env.register(StreamingContract, (admin.clone(),));
    let client = StreamingContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    FeeTokenClient::new(&env, &fee_token).mint(&admin, &sender, &FUNDING);
    env.ledger().set_timestamp(START);

    // The fee token credits the contract with `amount - fee`, so the balance
    // delta check in `create_stream` must detect the mismatch and revert.
    client.create_stream(&sender, &receiver, &fee_token, &1_000_i128, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #8)")] // Error::TokenTransferMismatch
fn withdraw_rejects_sender_over_debit_token() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let receiver = Address::generate(&env);

    let fee_token = env.register(SenderFeeToken, ());
    let contract_id = env.register(StreamingContract, (admin.clone(),));
    let client = StreamingContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    let token_client = SenderFeeTokenClient::new(&env, &fee_token);
    token_client.mint(&admin, &sender, &FUNDING);
    // Give the contract headroom so the over-debit trips the balance-delta
    // check (Finding 6) rather than the token's own "insufficient balance" guard.
    token_client.mint(&admin, &contract_id, &TRANSFER_FEE);
    env.ledger().set_timestamp(START);

    // Creation succeeds: the contract is credited exactly `amount`.
    let stream_id = client.create_stream(&sender, &receiver, &fee_token, &1_000_i128, &100_u64);

    // Halfway vesting => withdraw 500. The token credits the receiver 500 but
    // debits the contract 500 + fee; `transfer_out_exact` must detect the
    // contract-side mismatch and revert.
    env.ledger().set_timestamp(START + 50);
    client.withdraw(&receiver, &stream_id);
}

#[test]
fn create_stream_sets_stream_ttl_to_max() {
    let (env, client, contract_id, token, sender, receiver) = setup();

    client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // TTL reads are contract-scoped, so wrap them in `as_contract`. Newly-
    // created streams must carry the maximum TTL so they don't expire
    // part-way through a long vesting term.
    let ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Stream(0))
    });
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(ttl, max, "stream entry TTL {ttl} != max {max}");
}

#[test]
fn withdraw_bumps_ttl_back_to_max() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // Simulate the stream sitting untouched until its TTL is nearly expired.
    let ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Stream(stream_id))
    });
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    // A mutating op re-writes the entry and bumps its TTL back to max.
    env.ledger().set_timestamp(START + 50);
    client.withdraw(&receiver, &stream_id);

    let after = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Stream(stream_id))
    });
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(after, max, "withdraw should restore TTL to max, got {after}");
}

#[test]
fn bump_entrypoint_extends_idle_stream_ttl() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // Simulate an idle stream: no withdraw/cancel, so its TTL drifts toward
    // expiry. The permissionless `bump` entrypoint must restore it to max
    // without any authorized caller.
    let ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Stream(stream_id))
    });
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    client.bump(&stream_id);

    let after = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Stream(stream_id))
    });
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(after, max, "bump should restore TTL to max, got {after}");
}

#[test]
fn bump_re_arms_counter_ttl() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // Drift the id counter's TTL toward expiry — simulating a long-idle
    // contract that keeps streams alive via `bump` but creates none. The
    // counter must be re-armed too, or the next create would reuse id 0 and
    // overwrite the live stream.
    let counter_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Counter)
    });
    env.ledger().set_sequence_number(env.ledger().sequence() + counter_ttl - 100);

    client.bump(&0_u64);

    let after = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Counter)
    });
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(after, max, "bump must re-arm the id counter to max, got {after}");
}

// ---- Contract instance + code TTL (rent-bumping the lease) -----------------
//
// The contract instance and its Wasm code are ledger entries SEPARATE from the
// persistent data. If either is archived the contract can no longer be invoked
// at all — every locked stream is stranded. So the constructor, every lifecycle
// write, and the permissionless keepers must re-arm the instance/code TTL.

#[test]
fn constructor_sets_instance_ttl_to_max() {
    let (env, _client, contract_id, _token, _sender, _receiver) = setup();

    // A freshly deployed contract must carry the maximum instance/code TTL so
    // it cannot be archived while idle.
    let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(ttl, max, "instance TTL {ttl} != max {max} after construction");
}

#[test]
fn bump_bumps_contract_instance_ttl() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // Drift the instance entry toward expiry — a contract kept alive only by
    // stream-scoped `bump` calls for longer than one TTL window.
    let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    client.bump(&0_u64);

    let after = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(after, max, "bump must restore instance TTL to max, got {after}");
}

#[test]
fn bump_instance_extends_idle_contract_ttl() {
    // No streams exist, so `bump(stream_id)` cannot be called (StreamNotFound)
    // — but the instance/code entries still need re-arming or a fully idle
    // contract is archived and can never be invoked again. `bump_instance`
    // must work on a fresh deployment with no auth.
    let (env, client, contract_id, _token, _sender, _receiver) = setup();

    let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    client.bump_instance();

    let after = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(after, max, "bump_instance must restore instance TTL to max, got {after}");
}

#[test]
fn lifecycle_ops_bump_contract_instance_ttl() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    // Any mutating op must restore a drifting instance TTL to max.
    let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    env.ledger().set_timestamp(START + 50);
    client.withdraw(&receiver, &stream_id);

    let after = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert_eq!(after, max, "withdraw must restore instance TTL to max, got {after}");
}

// ---- Batched keeper calls (v4: bump_many) ---------------------------------
//
// Large fleets should pay ONE transaction per pass instead of one per stream,
// so `bump_many` re-arms several streams plus the shared entries in a single
// call. It is permissionless (like `bump`), atomic (a missing id reverts the
// whole batch), and bounded by `MAX_BUMP_BATCH`.

#[test]
fn bump_many_re_arms_streams_and_shared_entries_in_one_call() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    let id0 = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    let id1 = client.create_stream(&sender, &receiver, &token, &2_000_i128, &100_u64);
    let id2 = client.create_stream(&sender, &receiver, &token, &3_000_i128, &100_u64);

    // Drift every stream, the counter, and the instance toward expiry.
    let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    client.bump_many(&vec![&env, id0, id1, id2]);

    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    for id in [id0, id1, id2] {
        let stream_ttl = env.as_contract(&contract_id, || {
            env.storage().persistent().get_ttl(&DataKey::Stream(id))
        });
        assert_eq!(stream_ttl, max, "bump_many must restore stream {id} TTL to max");
    }
    let counter_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Counter)
    });
    assert_eq!(counter_ttl, max, "bump_many must restore the counter TTL to max");
    let instance_ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert_eq!(instance_ttl, max, "bump_many must restore the instance TTL to max");
}

#[test]
fn bump_many_reverts_atomically_on_missing_stream() {
    let (env, client, contract_id, token, sender, receiver) = setup();
    let id0 = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);

    let ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Stream(id0))
    });
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    // id 99 does not exist -> the WHOLE batch must revert (StreamNotFound),
    // not silently re-arm the valid ids and leave the caller misinformed.
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.bump_many(&vec![&env, id0, 99_u64]);
    }));
    assert!(res.is_err(), "bump_many with a missing id must panic");

    // Atomicity: stream 0 must NOT have been re-armed by the failed call.
    let after = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Stream(id0))
    });
    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    assert!(
        after < max,
        "failed bump_many must leave stream 0's TTL untouched (atomic revert), got {after}"
    );
}

#[test]
fn bump_many_re_arms_split_group_entries_for_roots() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let root = client.create_split_stream(
        &sender,
        &vec![&env, r1, r2],
        &token,
        &vec![&env, 400_i128, 600_i128],
        &100_u64,
    );

    let ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Split(root))
    });
    env.ledger().set_sequence_number(env.ledger().sequence() + ttl - 100);

    client.bump_many(&vec![&env, root]);

    let max = env.as_contract(&contract_id, || env.storage().max_ttl());
    let split_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&DataKey::Split(root))
    });
    assert_eq!(split_ttl, max, "bump_many must re-arm split-group entries for roots");
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #20)")] // Error::BatchTooLarge
fn bump_many_rejects_too_large_batch() {
    let (env, client, _contract_id, _token, _sender, _receiver) = setup();
    // Duplicate ids are fine for the size check — it fires before any load,
    // so no stream needs to exist.
    let mut ids: Vec<u64> = Vec::new(&env);
    for _ in 0..(MAX_BUMP_BATCH + 1) {
        ids.push_back(0_u64);
    }
    client.bump_many(&ids);
}

// ---- Admin pause (Stage 3) ------------------------------------------------


#[test]
fn pause_blocks_create_but_not_withdraw() {
    let (env, client, _contract_id, token, sender, receiver) = setup();

    // A stream that already exists and has accrued value.
    let stream_id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    env.ledger().set_timestamp(START + 50);
    client.pause();

    // Paused → new streams are rejected with Error::Paused (#10).
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    }));
    assert!(res.is_err(), "paused contract must reject new streams");

    // ...but the receiver can still withdraw what has already vested — the
    // pause must never gate access to funds already owed.
    let withdrew = client.withdraw(&receiver, &stream_id);
    assert!(withdrew > 0, "withdraw must work while paused");
}

#[test]
fn pause_requires_admin_auth() {
    // No `mock_all_auths`: an arbitrary caller lacks the admin's signature,
    // so `admin.require_auth()` inside `pause` must fail.
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(StreamingContract, (admin.clone(),));
    let client = StreamingContractClient::new(&env, &contract_id);

    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pause();
    }));
    assert!(res.is_err(), "non-admin must not be able to pause");
}

#[test]
fn pause_unpause_round_trip() {
    let (_env, client, _contract_id, token, sender, receiver) = setup();

    assert!(!client.paused(), "fresh contract is un-paused");
    client.pause();
    assert!(client.paused(), "paused() view must report paused");
    client.unpause();
    assert!(!client.paused(), "paused() view must report un-paused");

    // After unpausing, new stream creation works again (id restarts at 0
    // because the paused-era create was rejected before the counter moved).
    let id = client.create_stream(&sender, &receiver, &token, &1_000_i128, &100_u64);
    assert_eq!(id, 0, "create_stream must work after unpause");
}

// ---- Split / multi-tier streams (Stage 5) ---------------------------------

#[test]
fn create_split_stream_uneven_splits() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let r3 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone(), r3.clone()];
    let amounts = vec![&env, 100_i128, 200_i128, 300_i128];

    let root = client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
    assert_eq!(root, 0);
    assert_eq!(client.get_stream_count(), 3_u64);

    // Members are ordinary streams at ids 0..2, each with its own share.
    let s0 = client.get_stream(&0_u64);
    let s1 = client.get_stream(&1_u64);
    let s2 = client.get_stream(&2_u64);
    assert_eq!(s0.receiver, r1);
    assert_eq!(s1.receiver, r2);
    assert_eq!(s2.receiver, r3);
    assert_eq!(s0.total_amount, 100);
    assert_eq!(s1.total_amount, 200);
    assert_eq!(s2.total_amount, 300);
    assert_eq!(s0.sender, sender);
    assert_eq!(s1.sender, sender);
    assert_eq!(s2.sender, sender);

    // The group index records the members in allocation order.
    let group = client.get_split(&root);
    assert_eq!(group.sender, sender);
    assert_eq!(group.token, token);
    assert_eq!(group.member_ids.len(), 3);
    assert_eq!(group.member_ids.get(0).unwrap(), 0_u64);
    assert_eq!(group.member_ids.get(1).unwrap(), 1_u64);
    assert_eq!(group.member_ids.get(2).unwrap(), 2_u64);

    // One aggregate pull: the contract holds the sum, the sender is debited
    // exactly once for it.
    assert_eq!(token_client.balance(&contract_id), 600);
    assert_eq!(token_client.balance(&sender), FUNDING - 600);

    // Halfway through the term each receiver has vested half of their share.
    env.ledger().set_timestamp(START + 50);
    assert_eq!(client.streamed_amount(&0_u64), 50_i128);
    assert_eq!(client.streamed_amount(&1_u64), 100_i128);
    assert_eq!(client.streamed_amount(&2_u64), 150_i128);
}

#[test]
fn split_withdraw_is_independent_per_receiver() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let amounts = vec![&env, 300_i128, 700_i128];

    let root = client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
    assert_eq!(root, 0);

    // Halfway: r1 (300) has 150 vested, r2 (700) has 350 vested.
    env.ledger().set_timestamp(START + 50);
    let w = client.withdraw(&r1, &0_u64);
    assert_eq!(w, 150_i128);
    assert_eq!(token_client.balance(&r1), 150);

    // r1's withdrawal must not touch r2's accrual or withdrawable balance.
    assert_eq!(client.streamed_amount(&1_u64), 350_i128);
    assert_eq!(client.get_withdrawable(&1_u64), 350_i128);
    // And r1 has nothing further withdrawable right now.
    assert_eq!(client.get_withdrawable(&0_u64), 0_i128);
}

#[test]
fn cancel_split_refunds_across_all_receivers() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let r3 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone(), r3.clone()];
    let amounts = vec![&env, 200_i128, 300_i128, 500_i128];

    let root = client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
    assert_eq!(root, 0);

    // 25% vested when the sender cancels the whole group.
    env.ledger().set_timestamp(START + 25);
    let refund = client.cancel_split(&sender, &root);
    // Unvested 75% of 200+300+500 = 150+225+375 = 750 refunded in ONE call.
    assert_eq!(refund, 750_i128);

    // Each receiver is paid their vested quarter.
    assert_eq!(token_client.balance(&r1), 50);
    assert_eq!(token_client.balance(&r2), 75);
    assert_eq!(token_client.balance(&r3), 125);
    // The contract holds nothing; the sender got the aggregate refund back.
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(token_client.balance(&sender), FUNDING - 250);

    // Every member is frozen and fully settled.
    for id in 0_u64..3_u64 {
        let s = client.get_stream(&id);
        assert!(s.cancelled, "member {id} must be cancelled");
        assert_eq!(client.get_withdrawable(&id), 0_i128);
    }
}

#[test]
fn cancel_split_skips_already_cancelled_members() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let amounts = vec![&env, 400_i128, 600_i128];

    let root = client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);

    // r1 individually cancels their own 400-share stream at 50% vested.
    env.ledger().set_timestamp(START + 50);
    let refund1 = client.cancel(&r1, &0_u64);
    assert_eq!(refund1, 200_i128); // 200 unvested back to the sender

    // The sender then cancels the whole group: member 0 is skipped (already
    // settled), member 1 is settled at the same timestamp.
    let refund2 = client.cancel_split(&sender, &root);
    assert_eq!(refund2, 300_i128); // 300 unvested from member 1 only

    assert_eq!(token_client.balance(&r1), 200);
    assert_eq!(token_client.balance(&r2), 300);
    assert_eq!(token_client.balance(&sender), FUNDING - 500);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #1)")] // Error::Unauthorized
fn cancel_split_rejects_non_sender() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();

    let r1 = Address::generate(&env);
    let receivers = vec![&env, r1.clone()];
    let amounts = vec![&env, 1_000_i128];
    let root = client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
    env.ledger().set_timestamp(START + 25);

    // A receiver may cancel their own stream but NOT the whole group.
    client.cancel_split(&r1, &root);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #13)")] // Error::EmptySplit
fn split_rejects_empty_receivers() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let receivers: Vec<Address> = vec![&env];
    let amounts: Vec<i128> = vec![&env];
    client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #14)")] // Error::SplitLengthMismatch
fn split_rejects_length_mismatch() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let receivers = vec![&env, r1.clone()];
    let amounts = vec![&env, 100_i128, 200_i128];
    client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #15)")] // Error::DuplicateReceiver
fn split_rejects_duplicate_receiver() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r1.clone()];
    let amounts = vec![&env, 100_i128, 200_i128];
    client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #19)")] // Error::SplitTooManyReceivers
fn split_rejects_too_many_receivers() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();

    let mut receivers: Vec<Address> = Vec::new(&env);
    let mut amounts: Vec<i128> = Vec::new(&env);
    for _ in 0..(MAX_SPLIT_MEMBERS + 1) {
        receivers.push_back(Address::generate(&env));
        amounts.push_back(1_i128);
    }

    client.create_split_stream(&sender, &receivers, &token, &amounts, &100_u64);
}

// ---- Percentage (basis-point) splits (Stage 5 follow-up) -------------------

#[test]
fn create_split_stream_bps_allocates_exact_shares() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let bps = vec![&env, 3_000_u32, 7_000_u32];

    let root = client.create_split_stream_bps(
        &sender, &receivers, &token, &10_000_i128, &bps, &100_u64,
    );
    assert_eq!(root, 0);
    assert_eq!(client.get_stream_count(), 2_u64);

    // 30% / 70% of 10,000 → 3,000 and 7,000 exactly.
    assert_eq!(client.get_stream(&0_u64).total_amount, 3_000_i128);
    assert_eq!(client.get_stream(&1_u64).total_amount, 7_000_i128);
    // One aggregate pull of the full total.
    assert_eq!(token_client.balance(&contract_id), 10_000);
    assert_eq!(token_client.balance(&sender), FUNDING - 10_000);
}

#[test]
fn split_bps_rounds_dust_without_loss_or_gain() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let r3 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone(), r3.clone()];
    // 33.34% / 33.33% / 33.33% of 100 base units.
    let bps = vec![&env, 3_334_u32, 3_333_u32, 3_333_u32];

    let root = client.create_split_stream_bps(
        &sender, &receivers, &token, &100_i128, &bps, &100_u64,
    );
    assert_eq!(root, 0);

    // floor gives 33/33/33 (=99) with 1 leftover unit; the largest remainder
    // (33.34%) earns it, so shares are 34/33/33 and sum to exactly 100.
    assert_eq!(client.get_stream(&0_u64).total_amount, 34_i128);
    assert_eq!(client.get_stream(&1_u64).total_amount, 33_i128);
    assert_eq!(client.get_stream(&2_u64).total_amount, 33_i128);
    assert_eq!(token_client.balance(&contract_id), 100);
    assert_eq!(token_client.balance(&sender), FUNDING - 100);
}

#[test]
fn cancel_split_bps_refunds_correctly() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let bps = vec![&env, 2_500_u32, 7_500_u32];

    let root = client.create_split_stream_bps(
        &sender, &receivers, &token, &10_000_i128, &bps, &100_u64,
    );
    env.ledger().set_timestamp(START + 50);

    // 50% vested → refund 50% of 10,000 = 5,000; receivers keep 2,500 / 7,500.
    let refund = client.cancel_split(&sender, &root);
    assert_eq!(refund, 5_000_i128);
    assert_eq!(token_client.balance(&r1), 1_250);
    assert_eq!(token_client.balance(&r2), 3_750);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert_eq!(token_client.balance(&sender), FUNDING - 5_000);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")] // Error::InvalidAllocation
fn split_bps_rejects_non_100_percent() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let bps = vec![&env, 5_000_u32, 4_999_u32]; // sums to 9,999
    client.create_split_stream_bps(&sender, &receivers, &token, &1_000_i128, &bps, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")] // Error::InvalidAllocation
fn split_bps_rejects_zero_weight() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let bps = vec![&env, 10_000_u32, 0_u32];
    client.create_split_stream_bps(&sender, &receivers, &token, &1_000_i128, &bps, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")] // Error::InvalidAllocation
fn split_bps_rejects_total_too_small() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    // 0.01% of 2 base units rounds to 0 for the first receiver.
    let bps = vec![&env, 1_u32, 9_999_u32];
    client.create_split_stream_bps(&sender, &receivers, &token, &2_i128, &bps, &100_u64);
}

// ---- Integer-percentage splits (sums to 100) -------------------------------

#[test]
fn create_split_stream_pct_allocates_exact_shares() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let pcts = vec![&env, 30_u32, 70_u32];

    let root = client.create_split_stream_pct(
        &sender, &receivers, &token, &1_000_i128, &pcts, &100_u64,
    );
    assert_eq!(root, 0);

    // 30% / 70% of 1,000 → 300 and 700 exactly.
    assert_eq!(client.get_stream(&0_u64).total_amount, 300_i128);
    assert_eq!(client.get_stream(&1_u64).total_amount, 700_i128);
    assert_eq!(token_client.balance(&contract_id), 1_000);
    assert_eq!(token_client.balance(&sender), FUNDING - 1_000);
}

#[test]
fn split_pct_rounds_dust_without_loss_or_gain() {
    let (env, client, contract_id, token, sender, _receiver) = setup();
    let token_client = token::Client::new(&env, &token);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let r3 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone(), r3.clone()];
    let pcts = vec![&env, 33_u32, 33_u32, 34_u32];

    let root = client.create_split_stream_pct(
        &sender, &receivers, &token, &10_i128, &pcts, &100_u64,
    );
    assert_eq!(root, 0);

    // floor(3.3/3.3/3.4) = 3/3/3 (=9); the 1 leftover unit goes to the 34%
    // receiver (largest remainder), so shares are 3/3/4 and sum to 10.
    assert_eq!(client.get_stream(&0_u64).total_amount, 3_i128);
    assert_eq!(client.get_stream(&1_u64).total_amount, 3_i128);
    assert_eq!(client.get_stream(&2_u64).total_amount, 4_i128);
    assert_eq!(token_client.balance(&contract_id), 10);
    assert_eq!(token_client.balance(&sender), FUNDING - 10);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")] // Error::InvalidAllocation
fn split_pct_rejects_non_100() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let pcts = vec![&env, 50_u32, 49_u32]; // sums to 99
    client.create_split_stream_pct(&sender, &receivers, &token, &1_000_i128, &pcts, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")] // Error::InvalidAllocation
fn split_pct_rejects_zero_weight() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    let pcts = vec![&env, 100_u32, 0_u32];
    client.create_split_stream_pct(&sender, &receivers, &token, &1_000_i128, &pcts, &100_u64);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #18)")] // Error::InvalidAllocation
fn split_pct_rejects_total_too_small() {
    let (env, client, _contract_id, token, sender, _receiver) = setup();
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    let receivers = vec![&env, r1.clone(), r2.clone()];
    // 1% of 2 base units rounds to 0 for the first receiver.
    let pcts = vec![&env, 1_u32, 99_u32];
    client.create_split_stream_pct(&sender, &receivers, &token, &2_i128, &pcts, &100_u64);
}
