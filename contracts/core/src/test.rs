// The crate is `#![no_std]`, but tests run natively and link the standard
// library (needed for `std::vec::Vec` in the auth-tree assertions).
extern crate std;

use super::{vested_amount, DataKey, StreamingContract, StreamingContractClient};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec,
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger as _},
    token, Address, Env, IntoVal, Symbol,
};
use soroban_sdk::xdr::{Limits, ScVal, WriteXdr};
use soroban_sdk::testutils::storage::Persistent as _;
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
    assert_eq!(client.version(), 1_u32);
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
    let contract_id = env.register(StreamingContract, ());
    let client = StreamingContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    FeeTokenClient::new(&env, &fee_token).mint(&admin, &sender, &FUNDING);
    env.ledger().set_timestamp(START);

    // The fee token credits the contract with `amount - fee`, so the balance
    // delta check in `create_stream` must detect the mismatch and revert.
    client.create_stream(&sender, &receiver, &fee_token, &1_000_i128, &100_u64);
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
