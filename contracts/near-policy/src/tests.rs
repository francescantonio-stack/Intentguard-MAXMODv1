use super::*;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};

const USDC_MONAD: &str = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const USDC_BASE: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TOKEN_MESSENGER: &str = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const MESSAGE_TRANSMITTER: &str = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const PLAN_EXECUTOR: &str = "0x9D3DA37d36BB0B825CD319ed129c2872b893f538";
const DERIVED: &str = "0x99C0a0818d8aDBED43ae2EC6ea1F2B539B249E5B";
const ATTACKER: &str = "0x000000000000000000000000000000000000abc0";
const PLAN: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

fn owner() -> AccountId { "owner.testnet".parse().unwrap() }
fn user() -> AccountId { "maxz-demo.testnet".parse().unwrap() }
fn policy_id() -> AccountId { "intentguard-policy.testnet".parse().unwrap() }

fn ctx(predecessor: AccountId, deposit_yocto: u128, ts_ns: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(policy_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .block_timestamp(ts_ns)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn set(predecessor: AccountId, deposit: u128, ts: u64) {
    testing_env!(ctx(predecessor, deposit, ts).build());
}

const T0: u64 = 1_790_000_000_000_000_000;

fn word_addr(a: &str) -> String { format!("{:0>64}", a.trim_start_matches("0x").to_lowercase()) }
fn word_u(x: u128) -> String { format!("{:064x}", x) }
fn approve_data(spender: &str, amount: u128) -> String { format!("0x095ea7b3{}{}", word_addr(spender), word_u(amount)) }
fn transfer_data(to: &str, amount: u128) -> String { format!("0xa9059cbb{}{}", word_addr(to), word_u(amount)) }
fn burn_data(amount: u128, domain: u32, recipient: &str, token: &str) -> String {
    burn_data_fee(amount, domain, recipient, token, 500)
}
fn burn_data_fee(amount: u128, domain: u32, recipient: &str, token: &str, max_fee: u128) -> String {
    format!(
        "0x8e0250ee{}{}{}{}{}{}{}",
        word_u(amount), word_u(domain as u128), word_addr(recipient), word_addr(token), word_u(0), word_u(max_fee), word_u(1000)
    )
}
fn execute_data(account: &str, amount_in: u128) -> String {
    // static Plan tuple inline (7 words) + offset to auth (dynamic, content irrelevant for the policy)
    format!(
        "0xf44f5b31{}{}{}{}{}{}{}{}",
        word_addr(account), word_u(amount_in), word_u(amount_in / 2), word_u(1), word_u(1), word_u(0), word_u(9_999_999_999), word_u(0x100)
    )
}

fn tx(chain_id: u64, to: &str, data: String) -> TxRequest {
    TxRequest {
        chain_id,
        nonce: 0,
        max_priority_fee_per_gas: U128(2_000_000_000),
        max_fee_per_gas: U128(204_000_000_000),
        gas_limit: 200_000,
        to: to.into(),
        value: U128(0),
        data,
    }
}

/// Fully configured policy: rules, a registered user with 5 USDC/week, own derived address as recipient.
fn setup() -> Policy {
    set(owner(), 0, T0);
    let mut p = Policy::new(owner(), "v1.signer-prod.testnet".parse().unwrap(), U128(1_000_000_000));
    p.add_rule(Rule { chain_id: BASE_SEPOLIA, to: USDC_BASE.into(), kind: RuleKind::UsdcApprove { spender: TOKEN_MESSENGER.into() } });
    p.add_rule(Rule {
        chain_id: BASE_SEPOLIA,
        to: TOKEN_MESSENGER.into(),
        kind: RuleKind::CctpDepositForBurn { destination_domain: 15, burn_token: USDC_BASE.into() },
    });
    p.add_rule(Rule { chain_id: MONAD_TESTNET, to: MESSAGE_TRANSMITTER.into(), kind: RuleKind::CctpReceiveMessage });
    p.add_rule(Rule { chain_id: MONAD_TESTNET, to: USDC_MONAD.into(), kind: RuleKind::UsdcApprove { spender: PLAN_EXECUTOR.into() } });
    p.add_rule(Rule { chain_id: MONAD_TESTNET, to: USDC_MONAD.into(), kind: RuleKind::UsdcTransfer });
    p.add_rule(Rule { chain_id: MONAD_TESTNET, to: PLAN_EXECUTOR.into(), kind: RuleKind::PlanExecute });
    p.add_rule(Rule { chain_id: MONAD_TESTNET, to: PLAN_EXECUTOR.into(), kind: RuleKind::PasskeyRegister });
    set(user(), 1, T0);
    p.set_weekly_cap(U128(5_000_000));
    p.add_recipient(DERIVED.into());
    p
}

fn commit(p: &mut Policy, budget: u128, ts: u64) {
    set(user(), 0, ts);
    p.commit_plan(PLAN.into(), U128(budget), 1800, 8);
}

// ------------------------------------------------------------ EVM encoding

#[test]
fn eip1559_hash_matches_viem_vectors() {
    let v: Value = serde_json::from_str(include_str!("eip1559_vectors.json")).unwrap();
    for c in v.as_array().unwrap() {
        let t = Eip1559Tx {
            chain_id: c["chainId"].as_u64().unwrap(),
            nonce: c["nonce"].as_u64().unwrap(),
            max_priority_fee_per_gas: c["maxPriorityFeePerGas"].as_str().unwrap().parse().unwrap(),
            max_fee_per_gas: c["maxFeePerGas"].as_str().unwrap().parse().unwrap(),
            gas_limit: c["gas"].as_str().unwrap().parse().unwrap(),
            to: parse_address(c["to"].as_str().unwrap()).unwrap(),
            value: c["value"].as_str().unwrap().parse().unwrap(),
            data: parse_hex(c["data"].as_str().unwrap()).unwrap(),
        };
        assert_eq!(to_hex(&t.signing_payload()), c["payload"].as_str().unwrap(), "payload {}", c["name"]);
        assert_eq!(to_hex(&t.signing_hash()), c["hash"].as_str().unwrap(), "hash {}", c["name"]);
    }
}

#[test]
fn rlp_basics() {
    assert_eq!(rlp_uint(0), vec![0x80]);
    assert_eq!(rlp_uint(0x7f), vec![0x7f]);
    assert_eq!(rlp_uint(0x80), vec![0x81, 0x80]);
    assert_eq!(rlp_bytes(&[]), vec![0x80]);
    assert_eq!(rlp_list(&[]), vec![0xc0]);
    let long = vec![0xaa; 56];
    assert_eq!(&rlp_bytes(&long)[..2], &[0xb8, 56]);
}

#[test]
fn abi_word_decoding_rejects_dirty_high_bits() {
    let mut d = parse_hex(&approve_data(TOKEN_MESSENGER, 5)).unwrap();
    assert_eq!(word_u128(&d, 1), Some(5));
    d[4 + 32] = 1; // set a high byte of the amount word
    assert_eq!(word_u128(&d, 1), None);
    d[4] = 1; // dirty address padding
    assert_eq!(word_address(&d, 0), None);
}

// ------------------------------------------------------------- happy path

#[test]
fn demo_flow_all_steps_pass_and_request_mpc() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    set(user(), 0, T0 + 2);
    let steps = vec![
        tx(BASE_SEPOLIA, USDC_BASE, approve_data(TOKEN_MESSENGER, 2_000_000)),
        tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data(2_000_000, 15, DERIVED, USDC_BASE)),
        tx(MONAD_TESTNET, MESSAGE_TRANSMITTER, "0x57ecfd28".to_string() + &"00".repeat(64)),
        tx(MONAD_TESTNET, USDC_MONAD, approve_data(PLAN_EXECUTOR, 2_000_000)),
        tx(MONAD_TESTNET, PLAN_EXECUTOR, execute_data(DERIVED, 2_000_000)),
    ];
    for (i, s) in steps.into_iter().enumerate() {
        set(user(), 0, T0 + 10 + i as u64); // each step is a separate NEAR tx (own gas budget)
        assert!(p.dry_run(&user(), PLAN, &s.clone()).is_ok(), "check failed for {:?}", s.data);
        let _promise = p.request_signature(PLAN.into(), s);
    }
    assert_eq!(p.get_plan(user()).unwrap().signatures_used, 5);
    let logs = near_sdk::test_utils::get_logs();
    assert!(logs.iter().any(|l| l.contains("\"event\":\"signature_requested\"")));
    let u = p.get_user(user()).unwrap();
    assert_eq!(u.remaining.0, 3_000_000);
    assert_eq!(u.derivation_path, "maxz-demo.testnet,evm,1");
}

#[test]
fn check_returns_the_exact_hash_the_mpc_will_sign() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    let v: Value = serde_json::from_str(include_str!("eip1559_vectors.json")).unwrap();
    let c = &v[0]; // monad_approve (to = USDC Monad, spender = TokenMessenger -> not allowed on Monad!)
    let mut t = tx(MONAD_TESTNET, USDC_MONAD, approve_data(PLAN_EXECUTOR, 2_000_000));
    t.gas_limit = 60_000;
    let h = p.dry_run(&user(), PLAN, &t.clone()).unwrap();
    let mut expected = Eip1559Tx {
        chain_id: MONAD_TESTNET,
        nonce: 0,
        max_priority_fee_per_gas: 2_000_000_000,
        max_fee_per_gas: 204_000_000_000,
        gas_limit: 60_000,
        to: parse_address(USDC_MONAD).unwrap(),
        value: 0,
        data: parse_hex(&t.data).unwrap(),
    };
    assert_eq!(h, to_hex(&expected.signing_hash()));
    // and the vector's spender (TokenMessenger) is rejected on Monad
    expected.data = parse_hex(c["data"].as_str().unwrap()).unwrap();
    let mut t2 = t.clone();
    t2.data = c["data"].as_str().unwrap().into();
    assert!(p.dry_run(&user(), PLAN, &t2).unwrap_err().contains("spender"));
}

// --------------------------------------------------------------- negatives

fn expect_reject(p: &Policy, t: TxRequest, needle: &str) {
    let e = p.dry_run(&user(), PLAN, &t).unwrap_err();
    assert!(e.contains(needle), "expected '{needle}' in '{e}'");
}

/// The negative demo: "manda 50 USDC a 0xabc…"
#[test]
fn negative_demo_send_50_usdc_to_stranger() {
    let mut p = setup();
    // the plan itself cannot even be committed: 50 USDC > 5 USDC weekly cap
    set(user(), 0, T0 + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| p.commit_plan(PLAN.into(), U128(50_000_000), 600, 2)));
    assert!(r.is_err());
    // with a small committed plan, a transfer to a non-allowlisted recipient is still rejected
    commit(&mut p, 1_000_000, T0 + 2);
    expect_reject(&p, tx(MONAD_TESTNET, USDC_MONAD, transfer_data(ATTACKER, 1_000_000)), "not in your allowlist");
    // and to the own address above budget too
    expect_reject(&p, tx(MONAD_TESTNET, USDC_MONAD, transfer_data(DERIVED, 50_000_000)), "exceeds plan budget");
}

#[test]
#[should_panic(expected = "policy: weekly cap exceeded")]
fn commit_over_weekly_cap_panics() {
    let mut p = setup();
    commit(&mut p, 5_000_001, T0 + 1);
}

#[test]
fn weekly_cap_is_cumulative_and_rolls_over() {
    let mut p = setup();
    commit(&mut p, 4_000_000, T0 + 1);
    set(user(), 0, T0 + 2);
    p.cancel_plan();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set(user(), 0, T0 + 3);
        p.commit_plan(PLAN.into(), U128(2_000_000), 600, 2)
    }));
    assert!(r.is_err(), "4 + 2 > 5 must fail within the same week");
    commit(&mut p, 2_000_000, T0 + WEEK_NS + 10); // a week later: reset
    assert_eq!(p.get_user(user()).unwrap().remaining.0, 3_000_000);
}

#[test]
fn rejects_non_allowlisted_target_and_selector() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    expect_reject(&p, tx(MONAD_TESTNET, ATTACKER, approve_data(PLAN_EXECUTOR, 1)), "not allowlisted");
    // allowlisted contract, other selector (e.g. transferFrom)
    expect_reject(&p, tx(MONAD_TESTNET, USDC_MONAD, "0x23b872dd".to_string() + &"00".repeat(96)), "not allowlisted");
}

#[test]
fn rejects_mainnet_and_unknown_chains() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    expect_reject(&p, tx(1, USDC_MONAD, approve_data(PLAN_EXECUTOR, 1)), "testnet only");
    expect_reject(&p, tx(143, USDC_MONAD, approve_data(PLAN_EXECUTOR, 1)), "testnet only");
}

#[test]
fn rejects_unlimited_approve_and_wrong_spender() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    expect_reject(&p, tx(MONAD_TESTNET, USDC_MONAD, approve_data(PLAN_EXECUTOR, u128::MAX)), "exceeds plan budget");
    let max_u256 = format!("0x095ea7b3{}{}", word_addr(PLAN_EXECUTOR), "f".repeat(64));
    expect_reject(&p, tx(MONAD_TESTNET, USDC_MONAD, max_u256), "unlimited");
    expect_reject(&p, tx(MONAD_TESTNET, USDC_MONAD, approve_data(ATTACKER, 1)), "spender");
}

#[test]
fn rejects_cctp_to_other_recipient_domain_or_token() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    expect_reject(&p, tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data(1, 15, ATTACKER, USDC_BASE)), "mintRecipient");
    expect_reject(&p, tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data(1, 0, DERIVED, USDC_BASE)), "domain");
    expect_reject(&p, tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data(1, 15, DERIVED, ATTACKER)), "burn token");
    expect_reject(&p, tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data(3_000_000, 15, DERIVED, USDC_BASE)), "exceeds plan budget");
}

/// A hijacked client must not turn the CCTP relayer fee into a drain: maxFee <= 0.5% of the amount.
#[test]
fn cctp_max_fee_is_capped() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    let at_cap = 2_000_000 * MAX_CCTP_FEE_BPS / 10_000; // 10_000 units = 0.01 USDC
    let ok = tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data_fee(2_000_000, 15, DERIVED, USDC_BASE, at_cap));
    assert!(p.dry_run(&user(), PLAN, &ok).is_ok());
    expect_reject(&p, tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data_fee(2_000_000, 15, DERIVED, USDC_BASE, at_cap + 1)), "maxFee");
    expect_reject(&p, tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data_fee(2_000_000, 15, DERIVED, USDC_BASE, 2_000_000)), "maxFee");
    expect_reject(&p, tx(BASE_SEPOLIA, TOKEN_MESSENGER, burn_data_fee(2_000_000, 15, DERIVED, USDC_BASE, u128::MAX)), "maxFee");
}

#[test]
fn rejects_plan_execute_for_foreign_account_or_over_budget() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    expect_reject(&p, tx(MONAD_TESTNET, PLAN_EXECUTOR, execute_data(ATTACKER, 1)), "not one of your addresses");
    expect_reject(&p, tx(MONAD_TESTNET, PLAN_EXECUTOR, execute_data(DERIVED, 2_000_001)), "exceeds plan budget");
}

#[test]
fn rejects_fee_drain_value_and_gas() {
    let mut p = setup();
    commit(&mut p, 2_000_000, T0 + 1);
    let mut t = tx(MONAD_TESTNET, USDC_MONAD, approve_data(PLAN_EXECUTOR, 1));
    t.gas_limit = 30_000_000;
    expect_reject(&p, t.clone(), "gas limit");
    t.gas_limit = 60_000;
    t.max_fee_per_gas = U128(10_000_000_000_000);
    expect_reject(&p, t.clone(), "fee caps");
    t.max_fee_per_gas = U128(204_000_000_000);
    t.value = U128(1);
    expect_reject(&p, t, "native value");
}

#[test]
fn rejects_wrong_plan_expired_plan_and_exhausted_budget() {
    let mut p = setup();
    set(user(), 0, T0 + 1);
    p.commit_plan(PLAN.into(), U128(1_000_000), 60, 1);
    let t = tx(MONAD_TESTNET, USDC_MONAD, approve_data(PLAN_EXECUTOR, 1));
    let other = "0x2222222222222222222222222222222222222222222222222222222222222222";
    assert!(p.dry_run(&user(), other, &t.clone()).unwrap_err().contains("committed plan"));
    set(user(), 0, T0 + 2);
    let _ = p.request_signature(PLAN.into(), t.clone());
    expect_reject(&p, t.clone(), "exhausted");
    set(user(), 0, T0 + 61 * 1_000_000_000);
    expect_reject(&p, t, "expired");
}

#[test]
fn rejects_passkey_cap_above_policy_cap() {
    let mut p = setup();
    commit(&mut p, 1, T0 + 1);
    let data = |cap: u128| format!("0x0f4e515a{}{}{}", word_u(1), word_u(2), word_u(cap));
    assert!(p.dry_run(&user(), PLAN, &tx(MONAD_TESTNET, PLAN_EXECUTOR, data(5_000_000))).is_ok());
    expect_reject(&p, tx(MONAD_TESTNET, PLAN_EXECUTOR, data(5_000_001)), "cannot exceed");
}

// ------------------------------------------------- access control (keys)

#[test]
#[should_panic(expected = "requires exactly 1 yoctoNEAR")]
fn add_recipient_requires_full_access_key_deposit() {
    let mut p = setup();
    set(user(), 0, T0 + 1); // function-call key: no deposit
    p.add_recipient(ATTACKER.into());
}

#[test]
#[should_panic(expected = "requires exactly 1 yoctoNEAR")]
fn raising_cap_requires_full_access_key_deposit() {
    let mut p = setup();
    set(user(), 0, T0 + 1);
    p.set_weekly_cap(U128(1_000_000_000));
}

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_adds_rules() {
    let mut p = setup();
    set(user(), 0, T0 + 1);
    p.add_rule(Rule { chain_id: MONAD_TESTNET, to: ATTACKER.into(), kind: RuleKind::UsdcTransfer });
}

#[test]
#[should_panic(expected = "testnet chains only")]
fn owner_cannot_allowlist_mainnet() {
    let mut p = setup();
    set(owner(), 0, T0 + 1);
    p.add_rule(Rule { chain_id: 1, to: USDC_MONAD.into(), kind: RuleKind::UsdcTransfer });
}

#[test]
#[should_panic(expected = "user not registered")]
fn unregistered_user_cannot_commit() {
    let mut p = setup();
    set("stranger.testnet".parse().unwrap(), 0, T0 + 1);
    p.commit_plan(PLAN.into(), U128(1), 60, 1);
}

#[test]
#[should_panic(expected = "another plan is still active")]
fn one_active_plan_at_a_time() {
    let mut p = setup();
    commit(&mut p, 1_000_000, T0 + 1);
    commit(&mut p, 1_000_000, T0 + 2);
}

// ---------------------------------------------------------- MPC callback

#[test]
fn callback_failure_gives_signature_slot_back() {
    let mut p = setup();
    commit(&mut p, 1_000_000, T0 + 1);
    set(user(), 0, T0 + 2);
    let _ = p.request_signature(PLAN.into(), tx(MONAD_TESTNET, USDC_MONAD, approve_data(PLAN_EXECUTOR, 1)));
    assert_eq!(p.get_plan(user()).unwrap().signatures_used, 1);
    testing_env!(
        ctx(policy_id(), 0, T0 + 3).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    let r = p.on_signed(user(), Err(PromiseError::Failed));
    assert!(r.is_none());
    assert_eq!(p.get_plan(user()).unwrap().signatures_used, 0);
}

#[test]
fn callback_success_returns_signature() {
    let mut p = setup();
    set(policy_id(), 0, T0 + 3);
    let sig: SignatureResponse = serde_json::from_str(
        r#"{"big_r":{"affine_point":"02AA"},"s":{"scalar":"BB"},"recovery_id":1}"#,
    )
    .unwrap();
    let r = p.on_signed(user(), Ok(sig)).unwrap();
    assert_eq!(r.recovery_id, 1);
    assert_eq!(r.big_r.affine_point, "02AA");
}

#[test]
fn selectors_match_solidity() {
    // keccak256("approve(address,uint256)")[..4] etc. computed with near's keccak
    let sel = |s: &str| -> [u8; 4] { env::keccak256_array(s.as_bytes())[..4].try_into().unwrap() };
    set(owner(), 0, T0);
    assert_eq!(sel("approve(address,uint256)"), SEL_APPROVE);
    assert_eq!(sel("transfer(address,uint256)"), SEL_TRANSFER);
    assert_eq!(sel("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)"), SEL_DEPOSIT_FOR_BURN);
    assert_eq!(sel("receiveMessage(bytes,bytes)"), SEL_RECEIVE_MESSAGE);
    assert_eq!(sel("registerPasskey(bytes32,bytes32,uint256)"), SEL_REGISTER_PASSKEY);
    assert_eq!(
        sel("execute((address,uint256,uint256,uint256,bool,uint256,uint256),(bytes,string,uint256,uint256,bytes32,bytes32))"),
        SEL_PLAN_EXECUTE
    );
}

#[test]
fn native_transfer_only_with_explicit_temporary_rule() {
    let mut p = setup();
    commit(&mut p, 0, T0 + 1);
    const DEPLOYER: &str = "0x00000000000000000000000000000000000d3b10";
    let mut t = tx(MONAD_TESTNET, DEPLOYER, "0x".into());
    t.value = U128(1_200_000_000_000_000_000);
    expect_reject(&p, t.clone(), "not allowlisted");
    set(owner(), 0, T0 + 2);
    let kind = RuleKind::NativeTransfer { max_value: U128(1_200_000_000_000_000_000) };
    p.add_rule(Rule { chain_id: MONAD_TESTNET, to: DEPLOYER.into(), kind: kind.clone() });
    assert!(p.dry_run(&user(), PLAN, &t).is_ok());
    set(user(), 0, T0 + 3);
    let _ = p.request_signature(PLAN.into(), t.clone()); // empty calldata must not panic in the event log
    t.value = U128(1_200_000_000_000_000_001);
    expect_reject(&p, t.clone(), "native value");
    t.value = U128(1);
    t.data = "0x00000000".into();
    expect_reject(&p, t.clone(), "zero selector");
    t.data = "0x".into();
    t.to = USDC_MONAD.into();
    expect_reject(&p, t.clone(), "not allowlisted");
    t.to = DEPLOYER.into();
    set(owner(), 0, T0 + 4);
    p.remove_rule(MONAD_TESTNET, DEPLOYER.into(), kind);
    expect_reject(&p, t, "not allowlisted");
}
