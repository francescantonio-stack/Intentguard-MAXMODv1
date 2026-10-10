#!/usr/bin/env bash
# Runs every test and read-only live check in this folder. No keys, no funds, no transactions on public networks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"

FV="$(forge --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
case "$FV" in 0.*|1.[0-7].*) echo "Foundry $FV is too old: network = \"monad\" needs >= 1.8 (foundryup --install v1.8.1)"; exit 1;; esac
echo "== 1/5 Foundry unit + fuzz tests"
(cd "$ROOT/contracts/evm" && forge test)
echo "== 2/5 Foundry integration test on a LOCAL fork of Monad testnet (real USDC/WMON, nothing is broadcast)"
(cd "$ROOT/contracts/evm" && FORK=1 forge test --match-contract MonadFork -vv)
echo "== 3/5 NEAR policy contract: unit tests"
(cd "$ROOT/contracts/near-policy" && cargo test --lib)
echo "== 4/5 NEAR local sandbox: policy -> mock MPC cross-contract round trip"
(cd "$ROOT/contracts/mock-mpc" && cargo near build non-reproducible-wasm >/dev/null)
(cd "$ROOT/contracts/near-policy" && cargo near build non-reproducible-wasm >/dev/null && cargo test --test sandbox -- --ignored --nocapture)
echo "== 5/5 Live read-only checks (public RPCs)"
(cd "$ROOT/scripts" && { [ -d node_modules ] || npm i --silent; })
(cd "$ROOT/scripts" && node live-checks/near_derivation.mjs && python3 live-checks/evm_checks.py \
  && python3 live-checks/p256_vector.py live-checks/p256_vector.json && ./live-checks/webauthn_live_probe.sh)
