/**
 * Verified Solana wallet bindings and single-use ownership challenges.
 * Entitlement quotas live on user_entitlements / user_scan_months and are
 * never reset by wallet connect, replace or disconnect.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Db } from "./client";
import { sessions, users, userWallets, walletChallenges } from "./schema";
import { ensureUserEntitlement } from "./entitlements";

class WalletTakenError extends Error {
  constructor() {
    super("wallet_taken");
    this.name = "WalletTakenError";
  }
}

export const WALLET_CHALLENGE_TTL_MS = 5 * 60_000;

export type ActiveWallet = {
  id: string;
  userId: string;
  walletPubkey: string;
  verifiedAt: Date;
};

export type WalletChallenge = {
  id: string;
  userId: string;
  sessionId: string;
  walletPubkey: string;
  nonce: string;
  message: string;
  expiresAt: Date;
};

export type BindWalletResult =
  | { ok: true; wallet: ActiveWallet }
  | {
      ok: false;
      reason:
        | "challenge_not_found"
        | "challenge_expired"
        | "challenge_consumed"
        | "session_mismatch"
        | "user_mismatch"
        | "wallet_mismatch"
        | "wallet_taken"
        | "conflict";
    };

/** Returns the user's currently active verified wallet, if any. */
export async function getActiveWallet(database: Db, userId: string): Promise<ActiveWallet | null> {
  const row = await database.query.userWallets.findFirst({
    where: and(eq(userWallets.userId, userId), eq(userWallets.active, true)),
  });
  if (!row?.verifiedAt) return null;
  return { id: row.id, userId: row.userId, walletPubkey: row.walletPubkey, verifiedAt: row.verifiedAt };
}

/** Resolves a live Better Auth session id for the given raw session token. */
export async function sessionIdForToken(database: Db, token: string): Promise<string | null> {
  const [row] = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.token, token), sql`${sessions.expiresAt} > now()`))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Creates a single-use challenge bound to the authenticated user, session and
 * intended wallet. `message` must be signed exactly as returned.
 */
export async function createWalletChallenge(
  database: Db,
  input: {
    userId: string;
    sessionId: string;
    walletPubkey: string;
    domain: string;
    githubLogin: string | null;
    at?: Date;
  },
): Promise<WalletChallenge> {
  const at = input.at ?? new Date();
  const expiresAt = new Date(at.getTime() + WALLET_CHALLENGE_TTL_MS);
  const nonce = randomBytes(32).toString("base64url");
  const message = [
    "RedNest wallet verification",
    "",
    `Domain: ${input.domain}`,
    `GitHub: ${input.githubLogin ?? input.userId}`,
    `Wallet: ${input.walletPubkey}`,
    `Nonce: ${nonce}`,
    `Issued: ${at.toISOString()}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");

  const [row] = await database
    .insert(walletChallenges)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      walletPubkey: input.walletPubkey,
      nonce,
      message,
      expiresAt,
      createdAt: at,
    })
    .returning();
  if (!row) throw new Error("Failed to create wallet challenge");
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    walletPubkey: row.walletPubkey,
    nonce: row.nonce,
    message: row.message,
    expiresAt: row.expiresAt,
  };
}

/**
 * After signature verification succeeds off-transaction, bind the wallet:
 * lock the user row (always present), ensure entitlements exist without using
 * them as the only lock, consume the challenge, deactivate any prior active
 * wallet, insert the new active verified wallet. Global uniqueness is enforced
 * by the partial unique index on wallet_pubkey.
 */
export async function bindVerifiedWallet(
  database: Db,
  input: {
    challengeId: string;
    userId: string;
    sessionId: string;
    walletPubkey: string;
    at?: Date;
  },
): Promise<BindWalletResult> {
  const at = input.at ?? new Date();

  try {
    return await database.transaction(async (tx) => {
      // Serialize wallet mutations per user even when no entitlement row exists yet.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 4))`);
      const lockedUser = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("update")
        .limit(1);
      if (!lockedUser[0]) return { ok: false as const, reason: "conflict" as const };

      // Best-effort entitlement row for quota continuity; never reset by wallet ops.
      await ensureUserEntitlement(tx as unknown as Db, input.userId);

      const [challenge] = await tx
        .select()
        .from(walletChallenges)
        .where(eq(walletChallenges.id, input.challengeId))
        .limit(1);
      if (!challenge) return { ok: false as const, reason: "challenge_not_found" as const };
      if (challenge.userId !== input.userId) return { ok: false as const, reason: "user_mismatch" as const };
      if (challenge.sessionId !== input.sessionId) return { ok: false as const, reason: "session_mismatch" as const };
      if (challenge.walletPubkey !== input.walletPubkey) return { ok: false as const, reason: "wallet_mismatch" as const };
      if (challenge.consumedAt) return { ok: false as const, reason: "challenge_consumed" as const };
      if (challenge.expiresAt.getTime() <= at.getTime()) return { ok: false as const, reason: "challenge_expired" as const };

      const taken = await tx.query.userWallets.findFirst({
        where: and(eq(userWallets.walletPubkey, input.walletPubkey), eq(userWallets.active, true)),
      });
      // Reject without mutating this user's existing wallet or consuming the challenge.
      if (taken && taken.userId !== input.userId) return { ok: false as const, reason: "wallet_taken" as const };

      const consumed = await tx
        .update(walletChallenges)
        .set({ consumedAt: at })
        .where(and(eq(walletChallenges.id, challenge.id), isNull(walletChallenges.consumedAt)))
        .returning({ id: walletChallenges.id });
      if (consumed.length !== 1) return { ok: false as const, reason: "challenge_consumed" as const };

      // Deactivate prior active wallet first so one-active-per-user uniqueness holds
      // when inserting a replacement pubkey.
      if (!(taken && taken.userId === input.userId)) {
        await tx
          .update(userWallets)
          .set({ active: false, deactivatedAt: at, updatedAt: at })
          .where(and(eq(userWallets.userId, input.userId), eq(userWallets.active, true)));
      }

      let walletRow: typeof userWallets.$inferSelect | undefined;
      if (taken && taken.userId === input.userId) {
        const [updated] = await tx
          .update(userWallets)
          .set({ active: true, verifiedAt: at, deactivatedAt: null, updatedAt: at })
          .where(eq(userWallets.id, taken.id))
          .returning();
        walletRow = updated;
        // Keep history: deactivate any other active wallet for this user.
        await tx
          .update(userWallets)
          .set({ active: false, deactivatedAt: at, updatedAt: at })
          .where(and(eq(userWallets.userId, input.userId), eq(userWallets.active, true), ne(userWallets.id, taken.id)));
      } else {
        try {
          const [inserted] = await tx
            .insert(userWallets)
            .values({
              userId: input.userId,
              walletPubkey: input.walletPubkey,
              active: true,
              verifiedAt: at,
              createdAt: at,
              updatedAt: at,
            })
            .returning();
          walletRow = inserted;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/user_wallets_one_active_per_pubkey|unique/i.test(message)) throw new WalletTakenError();
          throw error;
        }
      }
      if (!walletRow?.verifiedAt) return { ok: false as const, reason: "conflict" as const };

      return {
        ok: true as const,
        wallet: {
          id: walletRow.id,
          userId: walletRow.userId,
          walletPubkey: walletRow.walletPubkey,
          verifiedAt: walletRow.verifiedAt,
        },
      };
    });
  } catch (error) {
    if (error instanceof WalletTakenError) return { ok: false, reason: "wallet_taken" };
    const message = error instanceof Error ? error.message : String(error);
    if (/user_wallets_one_active_per_pubkey|unique/i.test(message)) return { ok: false, reason: "wallet_taken" };
    throw error;
  }
}

/** Deactivates the user's active wallet. Entitlements are untouched. */
export async function disconnectActiveWallet(database: Db, userId: string, at = new Date()): Promise<ActiveWallet | null> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 4))`);
    const lockedUser = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);
    if (!lockedUser[0]) return null;
    await ensureUserEntitlement(tx as unknown as Db, userId);

    const current = await tx.query.userWallets.findFirst({
      where: and(eq(userWallets.userId, userId), eq(userWallets.active, true)),
    });
    if (!current?.verifiedAt) return null;
    await tx
      .update(userWallets)
      .set({ active: false, deactivatedAt: at, updatedAt: at })
      .where(eq(userWallets.id, current.id));
    return { id: current.id, userId: current.userId, walletPubkey: current.walletPubkey, verifiedAt: current.verifiedAt };
  });
}

/** Confirms the session still belongs to the user (defence in depth). */
export async function sessionBelongsToUser(database: Db, sessionId: string, userId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), sql`${sessions.expiresAt} > now()`))
    .limit(1);
  return !!row;
}

/** Loads a challenge by id (for signature verification before bind). */
export async function getWalletChallenge(database: Db, challengeId: string) {
  return database.query.walletChallenges.findFirst({ where: eq(walletChallenges.id, challengeId) });
}

/** True when the user row exists (for tests / guards). */
export async function userExists(database: Db, userId: string): Promise<boolean> {
  const row = await database.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true } });
  return !!row;
}
