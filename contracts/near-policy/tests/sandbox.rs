//! Local NEAR sandbox integration test (no testnet, no funds): deploys the policy contract and a
//! MOCK MPC signer, then runs the real cross-contract flow request_signature -> sign -> on_signed.
//! Requires the wasm files built with `cargo near build non-reproducible-wasm` in both crates.
//! Run:  cargo test --test sandbox -- --ignored --nocapture
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const POLICY_WASM: &str = "target/near/intentguard_policy.wasm";
const MOCK_MPC_WASM: &str = "../mock-mpc/target/near/mock_mpc.wasm";
const USDC_MONAD: &str = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const PLAN_EXECUTOR: &str = "0x9D3DA37d36BB0B825CD319ed129c2872b893f538";
const DERIVED: &str = "0x99C0a0818d8aDBED43ae2EC6ea1F2B539B249E5B";
const PLAN: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

fn approve(spender: &str, amount: u128) -> String {
    format!("0x095ea7b3{:0>64}{:064x}", spender.trim_start_matches("0x").to_lowercase(), amount)
}

#[tokio::test]
#[ignore]
async fn sandbox_policy_to_mpc_roundtrip() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let mpc = worker.dev_deploy(&std::fs::read(MOCK_MPC_WASM)?).await?;
    let policy = worker.dev_deploy(&std::fs::read(POLICY_WASM)?).await?;
    let owner = worker.dev_create_account().await?;
    let user = worker.dev_create_account().await?;

    policy
        .call("new")
        .args_json(json!({"owner": owner.id(), "mpc_contract": mpc.id(), "max_user_weekly_cap": "1000000000"}))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(policy.id(), "add_rule")
        .args_json(json!({"rule": {"chain_id": 10143, "to": USDC_MONAD, "kind": {"UsdcApprove": {"spender": PLAN_EXECUTOR}}}}))
        .transact()
        .await?
        .into_result()?;
    user.call(policy.id(), "set_weekly_cap")
        .args_json(json!({"weekly_cap": "5000000"}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    user.call(policy.id(), "add_recipient")
        .args_json(json!({"address": DERIVED}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    user.call(policy.id(), "commit_plan")
        .args_json(json!({"plan_hash": PLAN, "usdc_budget": "2000000", "ttl_seconds": 600, "max_signatures": 4}))
        .transact()
        .await?
        .into_result()?;

    let tx = json!({"chain_id": 10143, "nonce": 0, "max_priority_fee_per_gas": "2000000000",
        "max_fee_per_gas": "204000000000", "gas_limit": 60000, "to": USDC_MONAD, "value": "0",
        "data": approve(PLAN_EXECUTOR, 2_000_000)});

    // dry run (view)
    let check: Value = policy
        .view("check")
        .args_json(json!({"user": user.id(), "plan_hash": PLAN, "tx": tx}))
        .await?
        .json()?;
    assert_eq!(check["ok"], true, "{check}");
    let payload = check["payload"].as_str().unwrap().trim_start_matches("0x").to_string();

    // real cross-contract call to the (mock) MPC signer, as the PWA's function-call key would do
    let res = user
        .call(policy.id(), "request_signature")
        .args_json(json!({"plan_hash": PLAN, "tx": tx}))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?;
    let sig: Value = res.clone().into_result()?.json()?;
    println!("signature returned to the PWA: {sig}");
    assert_eq!(sig["recovery_id"], 1);
    assert!(res.logs().iter().any(|l| l.contains("signature_requested")));

    // what the MPC received: predecessor = policy contract, path = "<user>,evm,1", payload = EIP-1559 hash
    let (pred, req): (String, String) = mpc.view("last").await?.json()?;
    let req: Value = serde_json::from_str(&req)?;
    println!("mock MPC saw predecessor={pred} request={req}");
    assert_eq!(pred, policy.id().to_string());
    assert_eq!(req["path"], format!("{},evm,1", user.id()));
    assert_eq!(req["payload_v2"]["Ecdsa"], payload);
    assert_eq!(req["domain_id"], 0);

    // negative: transfer-like call to a non-allowlisted target is rejected on-chain
    let bad = json!({"chain_id": 10143, "nonce": 1, "max_priority_fee_per_gas": "1", "max_fee_per_gas": "2",
        "gas_limit": 60000, "to": "0x000000000000000000000000000000000000abc0", "value": "0",
        "data": approve(PLAN_EXECUTOR, 1)});
    let r = user
        .call(policy.id(), "request_signature")
        .args_json(json!({"plan_hash": PLAN, "tx": bad}))
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(r.is_failure());
    println!("rejected as expected: {:?}", r.into_result().err().map(|e| e.to_string()));

    // negative: function-call-style call without deposit cannot add a recipient
    let r = user.call(policy.id(), "add_recipient").args_json(json!({"address": "0x000000000000000000000000000000000000abc0"})).transact().await?;
    assert!(r.is_failure());
    Ok(())
}
