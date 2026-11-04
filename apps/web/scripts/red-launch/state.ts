import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { VerifyReceipt } from "./types";

export function readVerifyReceipt(path: string): VerifyReceipt | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as VerifyReceipt;
    if (!raw?.mint || !raw.eligibleWallet || !raw.ineligibleWallet || !raw.verifiedAt) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeVerifyReceipt(path: string, receipt: VerifyReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  // Never persist RPC URLs or API keys.
  const safe: VerifyReceipt = {
    mint: receipt.mint,
    verifiedAt: receipt.verifiedAt,
    eligibleWallet: receipt.eligibleWallet,
    ineligibleWallet: receipt.ineligibleWallet,
    eligibleWholeTokens: receipt.eligibleWholeTokens,
    ineligibleWholeTokens: receipt.ineligibleWholeTokens,
    decimals: receipt.decimals,
    tokenProgram: receipt.tokenProgram,
    rpcConfigured: true,
    ...(receipt.deploymentId ? { deploymentId: receipt.deploymentId } : {}),
  };
  writeFileSync(path, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

/** Activation requires a receipt for the same mint (freshness rechecked by re-running balances). */
export function receiptMatchesMint(receipt: VerifyReceipt | null, mint: string): boolean {
  return !!receipt && receipt.mint === mint;
}
