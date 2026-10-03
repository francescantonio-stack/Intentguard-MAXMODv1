//! IntentGuard policy contract (NEAR testnet).
//!
//! Sits in front of the NEAR MPC signer (`v1.signer-prod.testnet`). The EVM addresses are derived from
//! THIS contract's account id + a per-user path (`"<user>,evm,1"`), so the only way to get a signature
//! for a user's EVM address is through the checks below:
//!   1. the target (chain, contract, selector) is on the allowlist and its arguments pass the rule;
//!   2. the tx belongs to an active plan commitment (plan hash approved by the user in the PWA),
//!      and moves at most the plan's USDC budget per step;
//!   3. committing a plan consumes the user's rolling 7-day USDC cap;
//!   4. gas limit and fee caps protect against fee draining (Monad charges the gas LIMIT).
//! Settings that loosen security (cap, recipients) require a 1-yoctoNEAR deposit, i.e. the user's
//! full-access key / wallet confirmation: a function-call key held by the PWA cannot attach deposits.
//!
//! TESTNET DEMO. Not audited.

mod evm;

use evm::*;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

pub use evm::Eip1559Tx;

const WEEK_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
const MAX_PLAN_TTL_NS: u64 = 60 * 60 * 1_000_000_000; // 1 hour
const GAS_FOR_MPC_SIGN: Gas = Gas::from_tgas(50);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);
const MPC_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
pub const MONAD_TESTNET: u64 = 10143;
/// Pseudo-selector used as rule key for native transfers (empty calldata).
const SEL_NATIVE: [u8; 4] = [0, 0, 0, 0];
pub const BASE_SEPOLIA: u64 = 84532;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Rules,
    Users,
    Plans,
    Recipients(AccountId),
}

/// How the arguments of an allowlisted call are checked and how much USDC it moves.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum RuleKind {
    /// ERC-20 approve(spender, amount) on USDC: spender must be `spender`; amount <= plan step budget.
    UsdcApprove { spender: String },
    /// ERC-20 transfer(to, amount) on USDC: `to` must be in the user's recipient allowlist.
    UsdcTransfer,
    /// CCTP V2 depositForBurn: destination domain fixed, burnToken = USDC, mintRecipient in user's recipients.
    CctpDepositForBurn { destination_domain: u32, burn_token: String },
    /// CCTP V2 receiveMessage(message, attestation): moves no funds of the user.
    CctpReceiveMessage,
    /// PlanExecutor.registerPasskey(x, y, weeklyCap): weeklyCap <= user's NEAR cap.
    PasskeyRegister,
    /// PlanExecutor.execute(plan, auth): plan.account must be a user recipient; plan.amountIn <= step budget.
    PlanExecute,
    /// Native-coin transfer (empty calldata) to exactly `to`, value <= max_value. Meant to be TEMPORARY
    /// (e.g. funding a deployer from the derived address); applies to every user, so remove it after use.
    NativeTransfer { max_value: U128 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Rule {
    pub chain_id: u64,
    pub to: String,
    pub kind: RuleKind,
}

#[near(serializers = [borsh])]
pub struct UserState {
    pub weekly_cap: u128,
    pub spent_in_period: u128,
    pub period_start_ns: u64,
    pub recipients: IterableSet<String>, // lowercase 0x-addresses (e.g. the user's own derived EVM address)
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PlanCommitment {
    pub plan_hash: String,
    pub usdc_budget: U128,
    pub expires_at_ns: u64,
    pub max_signatures: u32,
    pub signatures_used: u32,
}

#[near(serializers = [json])]
pub struct UserView {
    pub weekly_cap: U128,
    pub spent_in_period: U128,
    pub remaining: U128,
    pub period_start_ns: u64,
    pub recipients: Vec<String>,
    pub derivation_path: String,
}

#[near(serializers = [json])]
pub struct CheckView {
    pub ok: bool,
    pub payload: Option<String>,
    pub reason: Option<String>,
}

/// EIP-1559 fields as sent by the PWA (all decimal strings / hex for JSON safety).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TxRequest {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: u64,
    pub to: String,
    pub value: U128,
    pub data: String,
}

// ---------------------------------------------------------------- MPC interface

#[near(serializers = [json])]
pub enum Payload {
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct SignRequestArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Scalar {
    pub scalar: String,
}

/// Secp256k1 signature as returned by the MPC contract.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignatureResponse {
    pub big_r: AffinePoint,
    pub s: Scalar,
    pub recovery_id: u8,
}

#[ext_contract(ext_mpc)]
pub trait MpcSigner {
    fn sign(&mut self, request: SignRequestArgs) -> SignatureResponse;
}

// --------------------------------------------------------------------- contract

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Policy {
    owner: AccountId,
    mpc_contract: AccountId,
    rules: LookupMap<String, Rule>,
    users: LookupMap<AccountId, UserState>,
    plans: LookupMap<AccountId, PlanCommitment>,
    usdc: LookupMap<u64, String>,
    max_gas_limit: u64,
    max_fee_per_gas: u128,
    max_user_weekly_cap: u128,
}

fn rule_key(chain_id: u64, to: &str, sel: &[u8; 4]) -> String {
    format!("{}:{}:{}", chain_id, to.to_lowercase(), hex::encode(sel))
}

fn norm(addr: &str) -> String {
    to_hex(&parse_address(addr).unwrap_or_else(|e| env::panic_str(&e)))
}

fn kind_selector(kind: &RuleKind) -> [u8; 4] {
    match kind {
        RuleKind::UsdcApprove { .. } => SEL_APPROVE,
        RuleKind::UsdcTransfer => SEL_TRANSFER,
        RuleKind::CctpDepositForBurn { .. } => SEL_DEPOSIT_FOR_BURN,
        RuleKind::CctpReceiveMessage => SEL_RECEIVE_MESSAGE,
        RuleKind::PasskeyRegister => SEL_REGISTER_PASSKEY,
        RuleKind::PlanExecute => SEL_PLAN_EXECUTE,
        RuleKind::NativeTransfer { .. } => SEL_NATIVE,
    }
}

#[near]
impl Policy {
    #[init]
    pub fn new(owner: AccountId, mpc_contract: AccountId, max_user_weekly_cap: U128) -> Self {
        let mut usdc = LookupMap::new(b"u".to_vec());
        usdc.insert(MONAD_TESTNET, "0x534b2f3a21130d7a60830c2df862319e593943a3".to_string());
        usdc.insert(BASE_SEPOLIA, "0x036cbd53842c5426634e7929541ec2318f3dcf7e".to_string());
        Self {
            owner,
            mpc_contract,
            rules: LookupMap::new(StorageKey::Rules),
            users: LookupMap::new(StorageKey::Users),
            plans: LookupMap::new(StorageKey::Plans),
            usdc,
            max_gas_limit: 2_000_000,
            max_fee_per_gas: 1_000_000_000_000, // 1000 gwei
            max_user_weekly_cap: max_user_weekly_cap.0,
        }
    }

    // ----------------------------------------------------------------- owner

    pub fn add_rule(&mut self, rule: Rule) {
        self.assert_owner();
        require!(rule.chain_id == MONAD_TESTNET || rule.chain_id == BASE_SEPOLIA, "testnet chains only");
        let to = norm(&rule.to);
        let key = rule_key(rule.chain_id, &to, &kind_selector(&rule.kind));
        log!("rule added {}", key);
        self.rules.insert(key, Rule { to, ..rule });
    }

    pub fn remove_rule(&mut self, chain_id: u64, to: String, kind: RuleKind) {
        self.assert_owner();
        self.rules.remove(&rule_key(chain_id, &norm(&to), &kind_selector(&kind)));
    }

    pub fn set_fee_limits(&mut self, max_gas_limit: u64, max_fee_per_gas: U128) {
        self.assert_owner();
        self.max_gas_limit = max_gas_limit;
        self.max_fee_per_gas = max_fee_per_gas.0;
    }

    // ------------------------------------------------- user settings (full key)

    /// Registers the caller (or updates its cap). Requires 1 yoctoNEAR => full-access key / wallet.
    #[payable]
    pub fn set_weekly_cap(&mut self, weekly_cap: U128) {
        self.assert_one_yocto();
        require!(weekly_cap.0 > 0 && weekly_cap.0 <= self.max_user_weekly_cap, "invalid weekly cap");
        let user = env::predecessor_account_id();
        let now = env::block_timestamp();
        match self.users.get_mut(&user) {
            Some(u) => u.weekly_cap = weekly_cap.0,
            None => {
                let recipients = IterableSet::new(StorageKey::Recipients(user.clone()));
                self.users.insert(
                    user.clone(),
                    UserState { weekly_cap: weekly_cap.0, spent_in_period: 0, period_start_ns: now, recipients },
                );
            }
        }
        self.emit("cap_set", &format!(r#"{{"user":"{}","weekly_cap":"{}"}}"#, user, weekly_cap.0));
    }

    /// Adds an EVM address that may receive funds (CCTP mintRecipient, USDC transfer, PlanExecutor account).
    /// Requires 1 yoctoNEAR => cannot be done by the PWA's function-call key.
    #[payable]
    pub fn add_recipient(&mut self, address: String) {
        self.assert_one_yocto();
        let user = env::predecessor_account_id();
        let a = norm(&address);
        let u = self.users.get_mut(&user).unwrap_or_else(|| env::panic_str("user not registered"));
        u.recipients.insert(a.clone());
        self.emit("recipient_added", &format!(r#"{{"user":"{}","address":"{}"}}"#, user, a));
    }

    #[payable]
    pub fn remove_recipient(&mut self, address: String) {
        self.assert_one_yocto();
        let user = env::predecessor_account_id();
        let a = norm(&address);
        if let Some(u) = self.users.get_mut(&user) {
            u.recipients.remove(&a);
        }
    }

    // --------------------------------------------- plan + signing (PWA key ok)

    /// Commits a passkey-approved plan: reserves `usdc_budget` from the rolling weekly cap.
    /// Callable with the PWA's function-call key (no deposit).
    pub fn commit_plan(&mut self, plan_hash: String, usdc_budget: U128, ttl_seconds: u64, max_signatures: u32) {
        let user = env::predecessor_account_id();
        let h = parse_hex(&plan_hash).unwrap_or_else(|e| env::panic_str(&e));
        require!(h.len() == 32, "plan_hash must be 32 bytes");
        require!(ttl_seconds > 0 && ttl_seconds * 1_000_000_000 <= MAX_PLAN_TTL_NS, "ttl must be 1..3600 s");
        require!(max_signatures > 0 && max_signatures <= 16, "max_signatures must be 1..16");
        let now = env::block_timestamp();
        if let Some(p) = self.plans.get(&user) {
            require!(
                p.expires_at_ns < now || p.signatures_used >= p.max_signatures,
                "another plan is still active"
            );
        }
        let u = self.users.get_mut(&user).unwrap_or_else(|| env::panic_str("user not registered"));
        if now >= u.period_start_ns + WEEK_NS {
            u.period_start_ns = now;
            u.spent_in_period = 0;
        }
        let remaining = u.weekly_cap.saturating_sub(u.spent_in_period);
        if usdc_budget.0 > remaining {
            env::panic_str(&format!(
                "policy: weekly cap exceeded (requested {} > remaining {} USDC base units)",
                usdc_budget.0, remaining
            ));
        }
        u.spent_in_period += usdc_budget.0;
        let c = PlanCommitment {
            plan_hash: to_hex(&h),
            usdc_budget,
            expires_at_ns: now + ttl_seconds * 1_000_000_000,
            max_signatures,
            signatures_used: 0,
        };
        self.emit(
            "plan_committed",
            &format!(r#"{{"user":"{}","plan_hash":"{}","usdc_budget":"{}"}}"#, user, c.plan_hash, usdc_budget.0),
        );
        self.plans.insert(user, c);
    }

    /// Cancels the active plan (does not refund the cap: conservative).
    pub fn cancel_plan(&mut self) {
        self.plans.remove(&env::predecessor_account_id());
    }

    /// Validates `tx` against the policy and the active plan, then asks the MPC network to sign its
    /// EIP-1559 hash for path "<predecessor>,evm,1". Returns the MPC signature (big_r, s, recovery_id).
    pub fn request_signature(&mut self, plan_hash: String, tx: TxRequest) -> Promise {
        let user = env::predecessor_account_id();
        let parsed = self.check_tx(&user, &plan_hash, &tx).unwrap_or_else(|e| env::panic_str(&format!("policy: {e}")));
        let plan_hash_norm = {
            let p = self.plans.get_mut(&user).unwrap();
            p.signatures_used += 1;
            p.plan_hash.clone()
        };
        let hash = parsed.signing_hash();
        let path = Self::derivation_path(&user);
        self.emit(
            "signature_requested",
            &format!(
                r#"{{"user":"{}","plan_hash":"{}","chain_id":{},"to":"{}","selector":"{}","payload":"{}"}}"#,
                user,
                plan_hash_norm,
                tx.chain_id,
                to_hex(&parsed.to),
                to_hex(&parsed.data[..parsed.data.len().min(4)]),
                to_hex(&hash)
            ),
        );
        ext_mpc::ext(self.mpc_contract.clone())
            .with_attached_deposit(MPC_DEPOSIT)
            .with_static_gas(GAS_FOR_MPC_SIGN)
            .sign(SignRequestArgs { path, payload_v2: Payload::Ecdsa(hex::encode(hash)), domain_id: 0 })
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_signed(user))
    }

    #[private]
    pub fn on_signed(
        &mut self,
        user: AccountId,
        #[callback_result] result: Result<SignatureResponse, PromiseError>,
    ) -> Option<SignatureResponse> {
        match result {
            Ok(sig) => Some(sig),
            Err(_) => {
                // MPC failed: give the signature slot back so the plan can retry.
                if let Some(p) = self.plans.get_mut(&user) {
                    p.signatures_used = p.signatures_used.saturating_sub(1);
                }
                self.emit("signature_failed", &format!(r#"{{"user":"{}"}}"#, user));
                None
            }
        }
    }

    // ------------------------------------------------------------------ views

    /// Dry-run of the policy (for the PWA to show "would be rejected because ...").
    /// On success `payload` is the exact 32-byte hash the MPC network would sign.
    pub fn check(&self, user: AccountId, plan_hash: String, tx: TxRequest) -> CheckView {
        match self.dry_run(&user, &plan_hash, &tx) {
            Ok(h) => CheckView { ok: true, payload: Some(h), reason: None },
            Err(e) => CheckView { ok: false, payload: None, reason: Some(e) },
        }
    }

    pub fn derivation_path(user: &AccountId) -> String {
        format!("{},evm,1", user)
    }

    pub fn get_user(&self, user: AccountId) -> Option<UserView> {
        self.users.get(&user).map(|u| {
            let now = env::block_timestamp();
            let (spent, start) =
                if now >= u.period_start_ns + WEEK_NS { (0, now) } else { (u.spent_in_period, u.period_start_ns) };
            UserView {
                weekly_cap: U128(u.weekly_cap),
                spent_in_period: U128(spent),
                remaining: U128(u.weekly_cap.saturating_sub(spent)),
                period_start_ns: start,
                recipients: u.recipients.iter().cloned().collect(),
                derivation_path: Self::derivation_path(&user),
            }
        })
    }

    pub fn get_plan(&self, user: AccountId) -> Option<PlanCommitment> {
        self.plans.get(&user).cloned()
    }

    pub fn get_rule(&self, chain_id: u64, to: String, kind: RuleKind) -> Option<Rule> {
        self.rules.get(&rule_key(chain_id, &norm(&to), &kind_selector(&kind))).cloned()
    }

    pub fn get_config(&self) -> (AccountId, AccountId, u64, U128, U128) {
        (
            self.owner.clone(),
            self.mpc_contract.clone(),
            self.max_gas_limit,
            U128(self.max_fee_per_gas),
            U128(self.max_user_weekly_cap),
        )
    }
}

// ---------------------------------------------------------------- internals

impl Policy {
    pub fn dry_run(&self, user: &AccountId, plan_hash: &str, tx: &TxRequest) -> Result<String, String> {
        self.check_tx(user, plan_hash, tx).map(|t| to_hex(&t.signing_hash()))
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_one_yocto(&self) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "requires exactly 1 yoctoNEAR (full-access key confirmation)"
        );
    }

    fn emit(&self, event: &str, data: &str) {
        env::log_str(&format!(
            r#"EVENT_JSON:{{"standard":"intentguard","version":"1.0.0","event":"{}","data":[{}]}}"#,
            event, data
        ));
    }

    fn check_tx(&self, user: &AccountId, plan_hash: &str, tx: &TxRequest) -> Result<Eip1559Tx, String> {
        let u = self.users.get(user).ok_or("user not registered")?;
        let p = self.plans.get(user).ok_or("no committed plan")?;
        let ph = to_hex(&parse_hex(plan_hash)?);
        if ph != p.plan_hash {
            return Err("tx does not belong to the committed plan".into());
        }
        if env::block_timestamp() > p.expires_at_ns {
            return Err("plan expired".into());
        }
        if p.signatures_used >= p.max_signatures {
            return Err("plan signature budget exhausted".into());
        }
        if tx.chain_id != MONAD_TESTNET && tx.chain_id != BASE_SEPOLIA {
            return Err(format!("chain {} not allowed (testnet only)", tx.chain_id));
        }
        if tx.gas_limit == 0 || tx.gas_limit > self.max_gas_limit {
            return Err(format!("gas limit {} outside 1..={}", tx.gas_limit, self.max_gas_limit));
        }
        if tx.max_fee_per_gas.0 > self.max_fee_per_gas || tx.max_priority_fee_per_gas.0 > tx.max_fee_per_gas.0 {
            return Err("fee caps violated".into());
        }
        let to = parse_address(&tx.to)?;
        let data = parse_hex(&tx.data)?;
        let sel = if data.is_empty() { SEL_NATIVE } else { selector(&data).ok_or("missing selector")? };
        if sel == SEL_NATIVE && !data.is_empty() {
            return Err("zero selector not allowed".into());
        }
        let to_s = to_hex(&to);
        let rule = self.rules.get(&rule_key(tx.chain_id, &to_s, &sel)).ok_or_else(|| {
            format!("target {} selector {} not allowlisted on chain {}", to_s, to_hex(&sel), tx.chain_id)
        })?;
        let budget = p.usdc_budget.0;
        let usdc = self.usdc.get(&tx.chain_id).cloned().unwrap_or_default();
        let bad = |what: &str| format!("malformed calldata ({what})");
        let is_recipient = |a: &[u8; 20]| u.recipients.contains(&to_hex(a));
        let native = matches!(rule.kind, RuleKind::NativeTransfer { .. });
        if tx.value.0 != 0 && !native {
            return Err("native value transfers are not allowed".into());
        }

        match &rule.kind {
            RuleKind::UsdcApprove { spender } => {
                if to_s != usdc {
                    return Err("approve allowed only on USDC".into());
                }
                let s = word_address(&data, 0).ok_or_else(|| bad("spender"))?;
                if to_hex(&s) != norm(spender) {
                    return Err(format!("spender {} not allowed", to_hex(&s)));
                }
                let amount = word_u128(&data, 1).ok_or("unlimited/huge approvals are rejected")?;
                if amount > budget {
                    return Err(format!("approve {} exceeds plan budget {}", amount, budget));
                }
            }
            RuleKind::UsdcTransfer => {
                if to_s != usdc {
                    return Err("transfer allowed only on USDC".into());
                }
                let r = word_address(&data, 0).ok_or_else(|| bad("to"))?;
                if !is_recipient(&r) {
                    return Err(format!("recipient {} not in your allowlist", to_hex(&r)));
                }
                let amount = word_u128(&data, 1).ok_or_else(|| bad("amount"))?;
                if amount > budget {
                    return Err(format!("transfer {} exceeds plan budget {}", amount, budget));
                }
            }
            RuleKind::CctpDepositForBurn { destination_domain, burn_token } => {
                let amount = word_u128(&data, 0).ok_or_else(|| bad("amount"))?;
                let domain = word_u128(&data, 1).ok_or_else(|| bad("domain"))?;
                let recipient = word_address(&data, 2).ok_or_else(|| bad("mintRecipient"))?;
                let token = word_address(&data, 3).ok_or_else(|| bad("burnToken"))?;
                if domain != *destination_domain as u128 {
                    return Err(format!("CCTP destination domain {} not allowed", domain));
                }
                if to_hex(&token) != norm(burn_token) {
                    return Err("CCTP burn token must be USDC".into());
                }
                if !is_recipient(&recipient) {
                    return Err(format!("CCTP mintRecipient {} not in your allowlist", to_hex(&recipient)));
                }
                if amount > budget {
                    return Err(format!("CCTP amount {} exceeds plan budget {}", amount, budget));
                }
            }
            RuleKind::CctpReceiveMessage => {}
            RuleKind::PasskeyRegister => {
                let cap = word_u128(&data, 2).ok_or_else(|| bad("weeklyCap"))?;
                if cap > u.weekly_cap {
                    return Err("on-chain passkey cap cannot exceed your NEAR policy cap".into());
                }
            }
            RuleKind::PlanExecute => {
                // Plan is a static tuple encoded inline: word0 = account, word1 = amountIn.
                let account = word_address(&data, 0).ok_or_else(|| bad("plan.account"))?;
                let amount_in = word_u128(&data, 1).ok_or_else(|| bad("plan.amountIn"))?;
                if !is_recipient(&account) {
                    return Err("plan.account is not one of your addresses".into());
                }
                if amount_in > budget {
                    return Err(format!("plan amount {} exceeds plan budget {}", amount_in, budget));
                }
            }
            RuleKind::NativeTransfer { max_value } => {
                if tx.value.0 == 0 || tx.value.0 > max_value.0 {
                    return Err(format!("native value {} outside 1..={}", tx.value.0, max_value.0));
                }
            }
        }

        Ok(Eip1559Tx {
            chain_id: tx.chain_id,
            nonce: tx.nonce,
            max_priority_fee_per_gas: tx.max_priority_fee_per_gas.0,
            max_fee_per_gas: tx.max_fee_per_gas.0,
            gas_limit: tx.gas_limit,
            to,
            value: tx.value.0,
            data,
        })
    }
}

#[cfg(test)]
mod tests;
