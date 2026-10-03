//! Mock of the NEAR MPC signer for LOCAL sandbox tests only. Mirrors the `sign` interface of
//! v1.signer-prod.testnet (requires >= 1 yoctoNEAR, takes {request:{path,payload_v2,domain_id}}).
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, require, NearToken};

#[near(contract_state)]
#[derive(Default)]
pub struct MockMpc {
    last_request: String,
    last_predecessor: String,
}

#[near]
impl MockMpc {
    #[payable]
    pub fn sign(&mut self, request: Value) -> Value {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "Attached deposit is lower than required");
        self.last_request = request.to_string();
        self.last_predecessor = env::predecessor_account_id().to_string();
        json!({
            "scheme": "Secp256k1",
            "big_r": {"affine_point": "02E14D22E30DAD5BDD3E2D1A3B7E4D0C8E5E2F2B8F3A1A9D9C3B2A1F0E9D8C7B6A"},
            "s": {"scalar": "1F2E3D4C5B6A79881726354453627180918273645546372819203948576A6B5C"},
            "recovery_id": 1
        })
    }

    pub fn last(&self) -> (String, String) {
        (self.last_predecessor.clone(), self.last_request.clone())
    }
}
