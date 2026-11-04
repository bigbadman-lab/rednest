"use server";

/**
 * Authenticated wallet challenge, verify, disconnect. GitHub session required.
 * Never trusts client ownership claims without an Ed25519 signature over the
 * server-issued message.
 */
import {
  bindVerifiedWallet,
  createWalletChallenge,
  disconnectActiveWallet,
  getActiveWallet,
  getWalletChallenge,
  sessionBelongsToUser,
  sessionIdForToken,
} from "@sandchest/db";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { viewer } from "./access";
import { authConfigured, sessionCookieName, verifiedSessionToken } from "./auth";
import { config } from "./config";
import { db } from "./db";
import { checkHolderEligibility } from "./entitlements";
import { readHolderLaunchConfig } from "./holder-eligibility";
import { canonicalSolanaPubkey } from "./solana/pubkey";
import { verifySolanaMessageSignature } from "./solana/verify-message";

export type WalletActionError =
  | "auth_required"
  | "invalid_wallet"
  | "invalid_signature"
  | "challenge_expired"
  | "challenge_consumed"
  | "challenge_invalid"
  | "wallet_taken"
  | "unavailable";

async function requireSession(): Promise<{ userId: string; sessionId: string; login: string | null; domain: string }> {
  const user = await viewer();
  if (!authConfigured()) throw new Error("auth_required");
  const jar = await cookies();
  const token = verifiedSessionToken(jar.get(sessionCookieName())?.value, config().BETTER_AUTH_SECRET);
  if (!token) throw new Error("auth_required");
  const sessionId = await sessionIdForToken(db(), token);
  if (!sessionId || !(await sessionBelongsToUser(db(), sessionId, user.id))) throw new Error("auth_required");
  const domain = new URL(config().SANDCHEST_APP_URL).hostname;
  return { userId: user.id, sessionId, login: user.login, domain };
}

export async function requestWalletChallenge(walletPubkeyRaw: string): Promise<
  { ok: true; challengeId: string; message: string; expiresAt: string } | { ok: false; error: WalletActionError }
> {
  try {
    const session = await requireSession();
    const walletPubkey = canonicalSolanaPubkey(walletPubkeyRaw);
    if (!walletPubkey) return { ok: false, error: "invalid_wallet" };
    const challenge = await createWalletChallenge(db(), {
      userId: session.userId,
      sessionId: session.sessionId,
      walletPubkey,
      domain: session.domain,
      githubLogin: session.login,
    });
    return {
      ok: true,
      challengeId: challenge.id,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export async function verifyWalletChallenge(input: {
  challengeId: string;
  walletPubkey: string;
  signature: string;
}): Promise<{ ok: true; walletPubkey: string; verifiedAt: string } | { ok: false; error: WalletActionError }> {
  try {
    const session = await requireSession();
    const walletPubkey = canonicalSolanaPubkey(input.walletPubkey);
    if (!walletPubkey) return { ok: false, error: "invalid_wallet" };

    const challenge = await getWalletChallenge(db(), input.challengeId);
    if (!challenge) return { ok: false, error: "challenge_invalid" };
    if (challenge.consumedAt) return { ok: false, error: "challenge_consumed" };
    if (challenge.expiresAt.getTime() <= Date.now()) return { ok: false, error: "challenge_expired" };
    if (challenge.userId !== session.userId || challenge.sessionId !== session.sessionId) {
      return { ok: false, error: "challenge_invalid" };
    }
    if (challenge.walletPubkey !== walletPubkey) return { ok: false, error: "invalid_wallet" };

    const valid = await verifySolanaMessageSignature({
      walletPubkey,
      message: challenge.message,
      signature: input.signature,
    });
    if (!valid) return { ok: false, error: "invalid_signature" };

    const bound = await bindVerifiedWallet(db(), {
      challengeId: challenge.id,
      userId: session.userId,
      sessionId: session.sessionId,
      walletPubkey,
    });
    if (!bound.ok) {
      if (bound.reason === "wallet_taken") return { ok: false, error: "wallet_taken" };
      if (bound.reason === "challenge_expired") return { ok: false, error: "challenge_expired" };
      if (bound.reason === "challenge_consumed") return { ok: false, error: "challenge_consumed" };
      return { ok: false, error: "challenge_invalid" };
    }

    revalidatePath("/dashboard/settings");
    return { ok: true, walletPubkey: bound.wallet.walletPubkey, verifiedAt: bound.wallet.verifiedAt.toISOString() };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export async function disconnectWallet(): Promise<{ ok: true } | { ok: false; error: WalletActionError }> {
  try {
    const session = await requireSession();
    await disconnectActiveWallet(db(), session.userId);
    revalidatePath("/dashboard/settings");
    return { ok: true };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** Settings page props: wallet + launch/eligibility snapshot (never shows a mint placeholder). */
export async function walletSettingsState(userId: string): Promise<{
  wallet: { pubkey: string; verifiedAt: string } | null;
  holderStatus: Awaited<ReturnType<typeof checkHolderEligibility>>;
  holderLaunchActive: boolean;
  monthlyAllowance: number;
}> {
  const wallet = await getActiveWallet(db(), userId);
  const launch = readHolderLaunchConfig();
  const holderStatus = await checkHolderEligibility(userId);
  return {
    wallet: wallet ? { pubkey: wallet.walletPubkey, verifiedAt: wallet.verifiedAt.toISOString() } : null,
    holderStatus,
    holderLaunchActive: launch.enabled && !!launch.mint && !!launch.rpcUrl,
    monthlyAllowance: 50,
  };
}
