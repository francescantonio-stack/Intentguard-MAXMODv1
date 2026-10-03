# Independent WebAuthn assertion generator (simulates a platform authenticator with Python `cryptography`),
# used to cross-check our Solidity verification path with an implementation that is NOT Foundry's cheatcode.
import json, hashlib, base64, sys
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
priv = ec.derive_private_key(0xC0FFEE1234567890C0FFEE1234567890C0FFEE1234567890C0FFEE12345678, ec.SECP256R1())
pub = priv.public_key().public_numbers()
challenge = hashlib.sha256(b"IntentGuard plan v1 example").digest()  # 32-byte plan hash stand-in
b64u = base64.urlsafe_b64encode(challenge).rstrip(b"=").decode()
client = json.dumps({"type": "webauthn.get", "challenge": b64u, "origin": "http://localhost:3000", "crossOrigin": False}, separators=(",", ":"))
auth_data = hashlib.sha256(b"localhost").digest() + bytes([0x05]) + (7).to_bytes(4, "big")
msg = auth_data + hashlib.sha256(client.encode()).digest()
r, s = decode_dss_signature(priv.sign(msg, ec.ECDSA(hashes.SHA256())))  # signs sha256(msg)
if s > N // 2: s = N - s
h = lambda v: "0x" + v.to_bytes(32, "big").hex()
vec = {
  "challenge": "0x" + challenge.hex(),
  "authenticatorData": "0x" + auth_data.hex(),
  "clientDataJSON": client,
  "challengeIndex": client.index('"challenge":"'),
  "typeIndex": client.index('"type":"'),
  "r": h(r), "s": h(s), "x": h(pub.x), "y": h(pub.y),
}
out = sys.argv[1] if len(sys.argv) > 1 else "webauthn_vector.json"
json.dump(vec, open(out, "w"), indent=1)
print(json.dumps(vec, indent=1))
