/**
 * Production holder eligibility for $NEST. Fail-closed until launch config is
 * complete and a verified wallet holds enough tokens. Never trusts the client.
 */
import { getActiveWallet } from "@sandchest/db";
import { db } from "./db";
import { checkRedHolderBalance } from "./solana/red-balance";
import { canonicalSolanaPubkey } from "./solana/pubkey";

/** Mirrors entitlements.HolderStatus — kept local to avoid an import cycle. */
export type HolderStatus = "eligible" | "no_wallet" | "insufficient_balance" | "not_activated" | "unavailable";
export type HolderEligibilityProvider = (userId: string) => Promise<HolderStatus> | HolderStatus;

export type HolderLaunchConfig = {
  enabled: boolean;
  mint: string | null;
  rpcUrl: string | null;
};

/** Reads launch gates from the environment. Missing/invalid mint keeps holders inactive. */
export function readHolderLaunchConfig(env: Record<string, string | undefined> = process.env): HolderLaunchConfig {
  const enabled = env.RED_HOLDER_SCANS_ENABLED?.trim().toLowerCase() === "true";
  const mintRaw = env.RED_TOKEN_MINT?.trim() || null;
  const mint = mintRaw ? canonicalSolanaPubkey(mintRaw) : null;
  const rpcUrl = env.SOLANA_RPC_URL?.trim() || null;
  return { enabled, mint, rpcUrl };
}

export function createHolderEligibilityProvider(options?: {
  config?: () => HolderLaunchConfig;
  balance?: typeof checkRedHolderBalance;
  activeWallet?: (userId: string) => Promise<{ walletPubkey: string } | null> | { walletPubkey: string } | null;
}): HolderEligibilityProvider {
  const configOf = options?.config ?? readHolderLaunchConfig;
  const balanceOf = options?.balance ?? checkRedHolderBalance;
  const walletOf = options?.activeWallet ?? ((userId: string) => getActiveWallet(db(), userId));

  return async (userId: string): Promise<HolderStatus> => {
    const cfg = configOf();
    if (!cfg.enabled || !cfg.mint || !cfg.rpcUrl) return "not_activated";

    const wallet = await walletOf(userId);
    if (!wallet) return "no_wallet";

    try {
      const result = await balanceOf({ walletPubkey: wallet.walletPubkey, mint: cfg.mint, rpcUrl: cfg.rpcUrl });
      if (!result.ok) {
        if (result.reason === "invalid_wallet" || result.reason === "invalid_mint") return "not_activated";
        return "unavailable";
      }
      return result.eligible ? "eligible" : "insufficient_balance";
    } catch {
      return "unavailable";
    }
  };
}

/** Default production provider (still fail-closed without launch env). */
export const resolveHolderEligibility = createHolderEligibilityProvider();
