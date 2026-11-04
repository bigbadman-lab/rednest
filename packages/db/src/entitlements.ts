/**
 * RedNest scan entitlements: atomic free-scan and monthly-holder reservations.
 * Holder eligibility is decided by the caller; this module only stores and
 * locks quota rows.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { orgSponsors, scanAuthorizations, scanEntitlements, userEntitlements, users, userScanMonths } from "./schema";

export const MONTHLY_SCAN_ALLOWANCE = 50;

export type EntitlementSource = "free" | "monthly";
export type EntitlementState = "reserved" | "consumed" | "released";

export type ReserveOutcome =
  | { ok: true; source: EntitlementSource; existing: boolean }
  | {
      ok: false;
      reason:
        | "user_not_found"
        | "free_used"
        | "holder_required"
        | "quota_exhausted"
        | "conflict";
    };

export function utcMonth(at = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Ensures a user_entitlements row exists for the durable GitHub id. */
export async function ensureUserEntitlement(database: Db, userId: string): Promise<{ userId: string; githubUserId: number } | null> {
  const user = await database.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, githubUserId: true } });
  if (!user?.githubUserId) return null;

  // Prefer an existing row keyed by GitHub id (survives user row recreation).
  const byGithub = await database.query.userEntitlements.findFirst({ where: eq(userEntitlements.githubUserId, user.githubUserId) });
  if (byGithub) {
    if (byGithub.userId !== userId) {
      await database.update(userEntitlements).set({ userId }).where(eq(userEntitlements.githubUserId, user.githubUserId));
    }
    return { userId, githubUserId: user.githubUserId };
  }

  await database
    .insert(userEntitlements)
    .values({ userId, githubUserId: user.githubUserId })
    .onConflictDoNothing({ target: userEntitlements.userId });
  return { userId, githubUserId: user.githubUserId };
}

/**
 * Atomically reserves one scan for `ownerUserId` under `scanId`.
 * If `holderEligible` is false, only the lifetime free scan may succeed.
 */
export async function reserveScanEntitlement(
  database: Db,
  input: { scanId: string; ownerUserId: string; holderEligible: boolean; at?: Date },
): Promise<ReserveOutcome> {
  const at = input.at ?? new Date();
  const month = utcMonth(at);

  return database.transaction(async (tx) => {
    const existing = await tx.query.scanEntitlements.findFirst({ where: eq(scanEntitlements.scanId, input.scanId) });
    if (existing) {
      if (existing.state === "released") return { ok: false, reason: "conflict" };
      return { ok: true, source: existing.source, existing: true };
    }

    const user = await tx.query.users.findFirst({ where: eq(users.id, input.ownerUserId), columns: { id: true, githubUserId: true } });
    if (!user?.githubUserId) return { ok: false, reason: "user_not_found" };

    const byGithub = await tx.query.userEntitlements.findFirst({ where: eq(userEntitlements.githubUserId, user.githubUserId) });
    if (byGithub && byGithub.userId !== input.ownerUserId) {
      await tx.update(userEntitlements).set({ userId: input.ownerUserId }).where(eq(userEntitlements.githubUserId, user.githubUserId));
    } else if (!byGithub) {
      await tx.insert(userEntitlements).values({ userId: input.ownerUserId, githubUserId: user.githubUserId }).onConflictDoNothing();
    }

    await tx.execute(sql`select 1 from ${userEntitlements} where ${userEntitlements.userId} = ${input.ownerUserId} for update`);
    const [ent] = await tx.select().from(userEntitlements).where(eq(userEntitlements.userId, input.ownerUserId)).limit(1);
    if (!ent) return { ok: false, reason: "user_not_found" };

    // Free lifetime first.
    if (ent.freeScanStatus === "available") {
      await tx
        .update(userEntitlements)
        .set({ freeScanStatus: "reserved", freeScanScanId: input.scanId, freeScanReservedAt: at })
        .where(and(eq(userEntitlements.userId, input.ownerUserId), eq(userEntitlements.freeScanStatus, "available")));
      await tx.insert(scanEntitlements).values({ scanId: input.scanId, ownerUserId: input.ownerUserId, source: "free", state: "reserved", monthUtc: null, reservedAt: at });
      return { ok: true, source: "free", existing: false };
    }

    // A reservation already held by this scan id (retry after crash mid-write).
    if (ent.freeScanStatus === "reserved" && ent.freeScanScanId === input.scanId) {
      await tx.insert(scanEntitlements).values({ scanId: input.scanId, ownerUserId: input.ownerUserId, source: "free", state: "reserved", monthUtc: null, reservedAt: at }).onConflictDoNothing();
      return { ok: true, source: "free", existing: true };
    }

    if (!input.holderEligible) {
      return { ok: false, reason: ent.freeScanStatus === "consumed" || ent.freeScanStatus === "reserved" ? "holder_required" : "free_used" };
    }

    // Monthly holder quota.
    await tx
      .insert(userScanMonths)
      .values({ userId: input.ownerUserId, monthUtc: month, reserved: 0, consumed: 0, allowance: MONTHLY_SCAN_ALLOWANCE })
      .onConflictDoNothing();
    await tx.execute(sql`select 1 from ${userScanMonths} where ${userScanMonths.userId} = ${input.ownerUserId} and ${userScanMonths.monthUtc} = ${month} for update`);
    const [monthRow] = await tx
      .select()
      .from(userScanMonths)
      .where(and(eq(userScanMonths.userId, input.ownerUserId), eq(userScanMonths.monthUtc, month)))
      .limit(1);
    if (!monthRow) return { ok: false, reason: "conflict" };
    if (monthRow.reserved + monthRow.consumed >= monthRow.allowance) return { ok: false, reason: "quota_exhausted" };

    await tx
      .update(userScanMonths)
      .set({ reserved: sql`${userScanMonths.reserved} + 1` })
      .where(and(eq(userScanMonths.userId, input.ownerUserId), eq(userScanMonths.monthUtc, month)));
    await tx.insert(scanEntitlements).values({
      scanId: input.scanId,
      ownerUserId: input.ownerUserId,
      source: "monthly",
      state: "reserved",
      monthUtc: month,
      reservedAt: at,
    });
    return { ok: true, source: "monthly", existing: false };
  });
}

/** Marks a reservation consumed (scan meaningfully started). Idempotent. */
export async function consumeScanEntitlement(database: Db, scanId: string, at = new Date()): Promise<void> {
  await database.transaction(async (tx) => {
    const [row] = await tx.select().from(scanEntitlements).where(eq(scanEntitlements.scanId, scanId)).for("update");
    if (!row || row.state === "consumed") return;
    if (row.state === "released") return;

    if (row.source === "free") {
      await tx
        .update(userEntitlements)
        .set({ freeScanStatus: "consumed", freeScanConsumedAt: at, freeScanScanId: scanId })
        .where(eq(userEntitlements.userId, row.ownerUserId));
    } else if (row.monthUtc) {
      await tx.execute(sql`select 1 from ${userScanMonths} where ${userScanMonths.userId} = ${row.ownerUserId} and ${userScanMonths.monthUtc} = ${row.monthUtc} for update`);
      await tx
        .update(userScanMonths)
        .set({ reserved: sql`greatest(${userScanMonths.reserved} - 1, 0)`, consumed: sql`${userScanMonths.consumed} + 1` })
        .where(and(eq(userScanMonths.userId, row.ownerUserId), eq(userScanMonths.monthUtc, row.monthUtc)));
    }

    await tx.update(scanEntitlements).set({ state: "consumed", settledAt: at }).where(eq(scanEntitlements.scanId, scanId));
  });
}

/**
 * Releases a reservation that never started. Idempotent. Does not refund a
 * consumed entitlement (started scans stay charged on later failure).
 */
export async function releaseScanEntitlement(database: Db, scanId: string, at = new Date()): Promise<void> {
  await database.transaction(async (tx) => {
    const [row] = await tx.select().from(scanEntitlements).where(eq(scanEntitlements.scanId, scanId)).for("update");
    if (!row || row.state !== "reserved") return;

    if (row.source === "free") {
      await tx
        .update(userEntitlements)
        .set({ freeScanStatus: "available", freeScanScanId: null, freeScanReservedAt: null })
        .where(and(eq(userEntitlements.userId, row.ownerUserId), eq(userEntitlements.freeScanScanId, scanId), eq(userEntitlements.freeScanStatus, "reserved")));
    } else if (row.monthUtc) {
      await tx.execute(sql`select 1 from ${userScanMonths} where ${userScanMonths.userId} = ${row.ownerUserId} and ${userScanMonths.monthUtc} = ${row.monthUtc} for update`);
      await tx
        .update(userScanMonths)
        .set({ reserved: sql`greatest(${userScanMonths.reserved} - 1, 0)` })
        .where(and(eq(userScanMonths.userId, row.ownerUserId), eq(userScanMonths.monthUtc, row.monthUtc)));
    }

    await tx.update(scanEntitlements).set({ state: "released", settledAt: at }).where(eq(scanEntitlements.scanId, scanId));
  });
}

export async function getScanEntitlement(database: Db, scanId: string) {
  return database.query.scanEntitlements.findFirst({ where: eq(scanEntitlements.scanId, scanId) });
}

export async function getUserEntitlement(database: Db, userId: string) {
  return database.query.userEntitlements.findFirst({ where: eq(userEntitlements.userId, userId) });
}

export async function getOrgSponsor(database: Db, orgId: string) {
  return database.query.orgSponsors.findFirst({ where: eq(orgSponsors.orgId, orgId) });
}

/**
 * Accepts sponsorship when the assignee is the same authenticated user (self-accept)
 * and the org has no sponsor yet. Requires caller to have verified admin rights.
 */
export async function acceptOrgSponsorship(
  database: Db,
  input: { orgId: string; sponsorUserId: string; assignedByUserId: string },
): Promise<{ ok: true; created: boolean } | { ok: false; reason: "exists" | "mismatch" }> {
  if (input.sponsorUserId !== input.assignedByUserId) return { ok: false, reason: "mismatch" };
  const existing = await getOrgSponsor(database, input.orgId);
  if (existing) return existing.sponsorUserId === input.sponsorUserId ? { ok: true, created: false } : { ok: false, reason: "exists" };
  try {
    await database.insert(orgSponsors).values({
      orgId: input.orgId,
      sponsorUserId: input.sponsorUserId,
      assignedByUserId: input.assignedByUserId,
    });
    return { ok: true, created: true };
  } catch {
    const again = await getOrgSponsor(database, input.orgId);
    if (again?.sponsorUserId === input.sponsorUserId) return { ok: true, created: false };
    return { ok: false, reason: "exists" };
  }
}

export async function orgHasAcceptedSponsor(database: Db, orgId: string): Promise<boolean> {
  return !!(await getOrgSponsor(database, orgId));
}

/**
 * Records that a scan may run without a user entitlement (operator Dig).
 * Idempotent per scan id. Never touches free/monthly quota tables.
 */
export async function authorizeOperatorScan(database: Db, scanId: string): Promise<void> {
  await database.insert(scanAuthorizations).values({ scanId, kind: "operator" }).onConflictDoNothing();
}

export async function isOperatorAuthorizedScan(database: Db, scanId: string): Promise<boolean> {
  const row = await database.query.scanAuthorizations.findFirst({
    where: eq(scanAuthorizations.scanId, scanId),
    columns: { kind: true },
  });
  return row?.kind === "operator";
}
