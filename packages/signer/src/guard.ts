import { nearTxUrl } from "./config";
import { failureReason, nearRpc } from "./near";

export type GuardEntry = {
  txHash: string;
  time?: string;
  signer: string;
  method: string;
  ok: boolean;
  reason?: string;
  url: string;
};

type NearblocksTxn = {
  transaction_hash?: string;
  signer_account_id?: string;
  predecessor_account_id?: string;
  block_timestamp?: string | number;
  actions?: Array<{ method?: string | null; action?: string }>;
  outcomes?: { status?: boolean | null };
};

/**
 * Recent decisions of the policy contract (accepted and rejected requests), from the public nearblocks
 * testnet API; rejection reasons are read from the NEAR RPC. Best effort: returns what it can read.
 */
export async function guardLog(o: {
  policy: string;
  nearRpc: string;
  limit?: number;
  api?: string;
  fetcher?: typeof fetch;
}): Promise<GuardEntry[]> {
  const fetcher = o.fetcher ?? fetch;
  const api = o.api ?? "https://api-testnet.nearblocks.io";
  const res = await fetcher(`${api}/v1/account/${o.policy}/txns-only?per_page=${o.limit ?? 15}&order=desc`);
  if (!res.ok) throw new Error(`nearblocks ${res.status}`);
  const body = (await res.json()) as { txns?: NearblocksTxn[] };
  const entries = (body.txns ?? [])
    .filter((t) => t.transaction_hash)
    .map((t): GuardEntry => {
      const ts = t.block_timestamp ? Number(BigInt(String(t.block_timestamp).split(".")[0]!) / 1_000_000n) : undefined;
      return {
        txHash: t.transaction_hash!,
        time: ts ? new Date(ts).toISOString() : undefined,
        signer: t.signer_account_id ?? t.predecessor_account_id ?? "?",
        method: t.actions?.find((a) => a.method)?.method ?? t.actions?.[0]?.action ?? "?",
        ok: t.outcomes?.status !== false,
        url: nearTxUrl(t.transaction_hash!),
      };
    });
  await Promise.all(
    entries.filter((e) => !e.ok).map(async (e) => {
      try {
        const st = await nearRpc<{ status: { Failure?: unknown } }>(o.nearRpc, "EXPERIMENTAL_tx_status", {
          tx_hash: e.txHash, sender_account_id: e.signer, wait_until: "NONE",
        });
        if (st.status?.Failure !== undefined) e.reason = failureReason(st.status.Failure);
      } catch {
        /* reason stays unknown; the nearblocks link still shows it */
      }
    }),
  );
  return entries;
}
