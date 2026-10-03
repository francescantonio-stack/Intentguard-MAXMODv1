# Generates a fresh valid P-256 (secp256r1) vector and checks it against the 0x0100 precompile via eth_call.
import json, hashlib, sys, urllib.request
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
# Deterministic key for reproducibility (test-only, not a secret of anyone)
priv = ec.derive_private_key(0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF, ec.SECP256R1())
msg = b"IntentGuard live check"
h = hashlib.sha256(msg).digest()
der = priv.sign(msg, ec.ECDSA(hashes.SHA256()))
r, s = decode_dss_signature(der)
if s > N // 2: s = N - s  # low-S normalization (precompile accepts both; keep canonical)
pub = priv.public_key().public_numbers()
w = lambda x: x.to_bytes(32, "big").hex()
valid = h.hex() + w(r) + w(s) + w(pub.x) + w(pub.y)
bad_s = (s + 1) % N
invalid = h.hex() + w(r) + w(bad_s) + w(pub.x) + w(pub.y)
vec = {"hash": "0x"+h.hex(), "r": "0x"+w(r), "s": "0x"+w(s), "x": "0x"+w(pub.x), "y": "0x"+w(pub.y)}

def call(rpc, data):
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x0000000000000000000000000000000000000100","data":"0x"+data,"gas":hex(100000)},"latest"]}).encode()
    req = urllib.request.Request(rpc, body, {"content-type":"application/json","user-agent":"intentguard-live-check"})
    return json.load(urllib.request.urlopen(req, timeout=20))

out = {"vector": vec}
for name, rpc in [("monad-testnet","https://testnet-rpc.monad.xyz"),("base-sepolia","https://sepolia.base.org")]:
    out[name] = {"valid": call(rpc, valid), "invalid_s_plus_1": call(rpc, invalid)}
print(json.dumps(out, indent=1))
json.dump(vec, open(sys.argv[1] if len(sys.argv)>1 else "p256_vector.json","w"), indent=1)
