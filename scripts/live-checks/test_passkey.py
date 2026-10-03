# TEST-ONLY software passkey (P-256) for the headless Monad testnet E2E (no browser available).
# Max's real passkey (WebAuthn in the PWA) replaces this later. Private key lives only in
# ~/.intentguard/test-passkey.pem on the box (never in the repo).
# Usage: test_passkey.py pubkey
#        test_passkey.py assert <challenge_hex32>   -> JSON WebAuthnAuth tuple for PlanExecutor
import json, hashlib, base64, sys, os
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
P = os.path.expanduser("~/.intentguard/test-passkey.pem")
if not os.path.exists(P):
    k = ec.generate_private_key(ec.SECP256R1())
    open(P, "wb").write(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    os.chmod(P, 0o600)
k = serialization.load_pem_private_key(open(P, "rb").read(), None)
pub = k.public_key().public_numbers()
h = lambda v: "0x" + v.to_bytes(32, "big").hex()
if sys.argv[1] == "pubkey":
    print(json.dumps({"x": h(pub.x), "y": h(pub.y)}))
else:
    ch = bytes.fromhex(sys.argv[2].removeprefix("0x"))
    b64u = base64.urlsafe_b64encode(ch).rstrip(b"=").decode()
    client = json.dumps({"type": "webauthn.get", "challenge": b64u, "origin": "https://intentguard.test", "crossOrigin": False}, separators=(",", ":"))
    auth = hashlib.sha256(b"intentguard.test").digest() + bytes([0x05]) + (1).to_bytes(4, "big")  # UP+UV
    r, s = decode_dss_signature(k.sign(auth + hashlib.sha256(client.encode()).digest(), ec.ECDSA(hashes.SHA256())))
    if s > N // 2: s = N - s
    print(json.dumps({"authenticatorData": "0x" + auth.hex(), "clientDataJSON": client,
                      "challengeIndex": client.index('"challenge":"'), "typeIndex": client.index('"type":"'), "r": h(r), "s": h(s)}))
