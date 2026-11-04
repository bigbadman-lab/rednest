/**
 * Public $RED mint display rules.
 *
 * Canonical mint remains `RED_TOKEN_MINT` (also used by holder eligibility).
 * Publication to the marketing surface is a separate flag so registering a mint
 * never implies it is safe to show, and showing it never implies holder scans
 * are active (`RED_HOLDER_SCANS_ENABLED`).
 */
import { canonicalSolanaPubkey } from "./solana/pubkey";

export type RedMintDisplay =
  | { published: false; reason: "missing_mint" | "not_approved" | "invalid_mint" }
  | { published: true; mint: string; solscanUrl: string };

/** Reads mint + publication approval from env. Never enables holder scanning. */
export function readRedMintDisplay(env: Record<string, string | undefined> = process.env): RedMintDisplay {
  const mintRaw = env.RED_TOKEN_MINT?.trim() || "";
  if (!mintRaw) return { published: false, reason: "missing_mint" };

  const mint = canonicalSolanaPubkey(mintRaw);
  if (!mint) return { published: false, reason: "invalid_mint" };

  const approved = env.RED_MINT_PUBLIC?.trim().toLowerCase() === "true";
  if (!approved) return { published: false, reason: "not_approved" };

  return {
    published: true,
    mint,
    solscanUrl: `https://solscan.io/token/${mint}`,
  };
}

/** True only when holder scanning is explicitly enabled — independent of mint display. */
export function holderScansEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RED_HOLDER_SCANS_ENABLED?.trim().toLowerCase() === "true";
}
