//! Minimal EVM helpers: EIP-1559 signing hash (RLP) and static ABI word decoding.
//! Kept dependency-free on purpose (small wasm, easy to audit). Cross-checked against viem in tests.

use near_sdk::env;

/// Fields of an EIP-1559 (type 0x02) transaction. Access list is always empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Eip1559Tx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: u128,
    pub data: Vec<u8>,
}

fn be_trimmed(x: u128) -> Vec<u8> {
    let b = x.to_be_bytes();
    let first = b.iter().position(|&v| v != 0).unwrap_or(b.len());
    b[first..].to_vec()
}

fn rlp_len_prefix(len: usize, short_base: u8, long_base: u8) -> Vec<u8> {
    if len <= 55 {
        vec![short_base + len as u8]
    } else {
        let l = be_trimmed(len as u128);
        let mut out = vec![long_base + l.len() as u8];
        out.extend(l);
        out
    }
}

pub fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_len_prefix(b.len(), 0x80, 0xb7);
    out.extend_from_slice(b);
    out
}

pub fn rlp_uint(x: u128) -> Vec<u8> {
    rlp_bytes(&be_trimmed(x))
}

pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    let mut out = rlp_len_prefix(payload.len(), 0xc0, 0xf7);
    out.extend(payload);
    out
}

impl Eip1559Tx {
    /// 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList])
    pub fn signing_payload(&self) -> Vec<u8> {
        let list = rlp_list(&[
            rlp_uint(self.chain_id as u128),
            rlp_uint(self.nonce as u128),
            rlp_uint(self.max_priority_fee_per_gas),
            rlp_uint(self.max_fee_per_gas),
            rlp_uint(self.gas_limit as u128),
            rlp_bytes(&self.to),
            rlp_uint(self.value),
            rlp_bytes(&self.data),
            rlp_list(&[]),
        ]);
        let mut out = vec![0x02];
        out.extend(list);
        out
    }

    /// keccak256 of the signing payload: the 32 bytes the MPC network signs.
    pub fn signing_hash(&self) -> [u8; 32] {
        env::keccak256_array(&self.signing_payload())
    }
}

/// Returns the 4-byte function selector of calldata, if present.
pub fn selector(data: &[u8]) -> Option<[u8; 4]> {
    data.get(0..4).map(|s| s.try_into().unwrap())
}

/// Static ABI word `i` (0-based) after the selector.
pub fn word(data: &[u8], i: usize) -> Option<[u8; 32]> {
    let start = 4 + i * 32;
    data.get(start..start + 32).map(|s| s.try_into().unwrap())
}

/// Decodes word `i` as uint256 that must fit in u128 (USDC amounts always do).
pub fn word_u128(data: &[u8], i: usize) -> Option<u128> {
    let w = word(data, i)?;
    if w[..16].iter().any(|&b| b != 0) {
        return None;
    }
    Some(u128::from_be_bytes(w[16..].try_into().unwrap()))
}

/// Decodes word `i` as an address (left-padded to 32 bytes; upper 12 bytes must be zero).
pub fn word_address(data: &[u8], i: usize) -> Option<[u8; 20]> {
    let w = word(data, i)?;
    if w[..12].iter().any(|&b| b != 0) {
        return None;
    }
    Some(w[12..].try_into().unwrap())
}

pub fn parse_address(s: &str) -> Result<[u8; 20], String> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    let v = hex::decode(h).map_err(|_| format!("invalid hex address {s}"))?;
    v.try_into().map_err(|_| format!("address must be 20 bytes: {s}"))
}

pub fn parse_hex(s: &str) -> Result<Vec<u8>, String> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).map_err(|_| "invalid hex".to_string())
}

pub fn to_hex(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

// Selectors (keccak256(signature)[0..4]); verified in tests against `cast sig`.
pub const SEL_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3]; // approve(address,uint256)
pub const SEL_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb]; // transfer(address,uint256)
// depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)  (CCTP V2 TokenMessengerV2)
pub const SEL_DEPOSIT_FOR_BURN: [u8; 4] = [0x8e, 0x02, 0x50, 0xee];
// receiveMessage(bytes,bytes)  (CCTP V2 MessageTransmitterV2)
pub const SEL_RECEIVE_MESSAGE: [u8; 4] = [0x57, 0xec, 0xfd, 0x28];
// registerPasskey(bytes32,bytes32,uint256)  (PlanExecutor)
pub const SEL_REGISTER_PASSKEY: [u8; 4] = [0x0f, 0x4e, 0x51, 0x5a];
// execute((address,uint256,uint256,uint256,bool,uint256,uint256),(bytes,string,uint256,uint256,bytes32,bytes32))
pub const SEL_PLAN_EXECUTE: [u8; 4] = [0xf4, 0x4f, 0x5b, 0x31];
