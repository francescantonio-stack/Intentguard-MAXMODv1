#!/usr/bin/env bash
# Runs Solady WebAuthn.verify ON THE REAL Monad testnet node (and Base Sepolia for comparison) via eth_call of
# WebAuthnProbe's creation code. Nothing is deployed, no account, no funds.
set -euo pipefail
cd "$(dirname "$0")/../../contracts/evm"
export PATH="$HOME/.foundry/bin:$PATH"
forge build --silent
V=test/fixtures/webauthn_vector.json
j() { python3 -c "import json,sys;print(json.load(open('$V'))['$1'])"; }
ARGS=$(cast abi-encode "f(bytes,(bytes,string,uint256,uint256,bytes32,bytes32),bytes32,bytes32)" \
  "$(j challenge)" "($(j authenticatorData),'$(j clientDataJSON)',$(j challengeIndex),$(j typeIndex),$(j r),$(j s))" "$(j x)" "$(j y)")
CODE=$(python3 -c "import json;print(json.load(open('out/WebAuthnProbe.sol/WebAuthnProbe.json'))['bytecode']['object'])")
DATA="${CODE}${ARGS#0x}"
for NET in "monad-testnet https://testnet-rpc.monad.xyz" "base-sepolia https://sepolia.base.org"; do
  set -- $NET
  RES=$(curl -s -X POST "$2" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"data\":\"$DATA\",\"gas\":\"0x1c9c380\"},\"latest\"]}")
  OUT=$(python3 -c "import json,sys;r=json.loads(sys.argv[1]);print(r.get('result') or r)" "$RES")
  echo "$1: raw=$OUT"
  [[ "$OUT" == 0x* ]] && echo "$1: (hasPrecompile, webauthnValid, tamperedValid) = $(cast abi-decode 'f()(bool,bool,bool)' "$OUT" | tr '\n' ' ')"
done
