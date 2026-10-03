import json, urllib.request
def rpc(url, method, params):
    req = urllib.request.Request(url, json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(), {"content-type":"application/json","user-agent":"intentguard-live-check"})
    return json.load(urllib.request.urlopen(req, timeout=20))["result"]
def s(url, to, sel):
    r = rpc(url, "eth_call", [{"to":to,"data":sel},"latest"])
    try:
        b = bytes.fromhex(r[2:]); n = int.from_bytes(b[32:64],"big"); return b[64:64+n].decode()
    except Exception: return r
def u(url,to,sel): return int(rpc(url,"eth_call",[{"to":to,"data":sel},"latest"]),16)
NETS = {"monad-testnet":("https://testnet-rpc.monad.xyz",10143,"0x534b2f3A21130d7a60830c2Df862319e593943A3",15),
        "base-sepolia":("https://sepolia.base.org",84532,"0x036CbD53842c5426634e7929541eC2318f3dCF7e",6)}
CCTP = {"TokenMessengerV2":"0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA","MessageTransmitterV2":"0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
        "TokenMinterV2":"0xb43db544E2c27092c107639Ad201b3dEfAbcF192","MessageV2":"0xbaC0179bB358A8936169a63408C8481D582390C4"}
out = {}
for net,(url,cid,usdc,dom) in NETS.items():
    o = {"chainId": int(rpc(url,"eth_chainId",[]),16), "expected": cid, "block": int(rpc(url,"eth_blockNumber",[]),16)}
    o["usdc"] = {"address":usdc,"codeBytes":(len(rpc(url,"eth_getCode",[usdc,"latest"]))-2)//2,
                 "name":s(url,usdc,"0x06fdde03"),"symbol":s(url,usdc,"0x95d89b41"),"decimals":u(url,usdc,"0x313ce567")}
    o["cctp"] = {k:{"address":a,"codeBytes":(len(rpc(url,"eth_getCode",[a,"latest"]))-2)//2} for k,a in CCTP.items()}
    # MessageTransmitterV2.localDomain() = 0x8d3638f4 ; version() = 0x54fd4d50
    mt = CCTP["MessageTransmitterV2"]
    try: o["cctp"]["MessageTransmitterV2"]["localDomain"] = u(url, mt, "0x8d3638f4")
    except Exception as e: o["cctp"]["MessageTransmitterV2"]["localDomain"] = f"err {e}"
    o["cctp"]["expectedDomain"] = dom
    o["gasPriceGwei"] = int(rpc(url,"eth_gasPrice",[]),16)/1e9
    out[net]=o
# Monad extras
url = NETS["monad-testnet"][0]
for k,a in {"WMON":"0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541","Multicall3":"0xcA11bde05977b3631167028862bE2a173976CA11"}.items():
    out["monad-testnet"][k] = {"address":a,"codeBytes":(len(rpc(url,"eth_getCode",[a,"latest"]))-2)//2}
# CCTP linkage: TokenMinterV2.getLocalToken(remoteDomain, remoteToken) and TokenMessengerV2.remoteTokenMessengers(domain)
def word(x): return x.lower().replace("0x","").rjust(64,"0")
mon, base = NETS["monad-testnet"], NETS["base-sepolia"]
out["cctpLinkage"] = {
  "monad.getLocalToken(6, baseUSDC)": "0x"+rpc(mon[0],"eth_call",[{"to":CCTP["TokenMinterV2"],"data":"0x78a0565e"+word(hex(6))+word(base[2])},"latest"])[-40:],
  "base.getLocalToken(15, monadUSDC)": "0x"+rpc(base[0],"eth_call",[{"to":CCTP["TokenMinterV2"],"data":"0x78a0565e"+word(hex(15))+word(mon[2])},"latest"])[-40:],
  "monad.remoteTokenMessengers(6)": "0x"+rpc(mon[0],"eth_call",[{"to":CCTP["TokenMessengerV2"],"data":"0x82a5e665"+word(hex(6))},"latest"])[-40:],
  "base.remoteTokenMessengers(15)": "0x"+rpc(base[0],"eth_call",[{"to":CCTP["TokenMessengerV2"],"data":"0x82a5e665"+word(hex(15))},"latest"])[-40:],
}
print(json.dumps(out, indent=1))
