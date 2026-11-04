/**
 * Persistence helpers for public URL Quick Scans. Vault orgs and synthetic
 * repo ids keep existing scan/findings FKs without fake installations.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import type { Org, Repo } from "./queries";
import { orgs, quickScans, repos, users } from "./schema";

export type QuickScan = typeof quickScans.$inferSelect;

/** Negative GitHub account id reserved for a user's Quick Scan vault org. */
export function quickScanVaultAccountId(githubUserId: number): number {
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) throw new Error("githubUserId must be a positive safe integer");
  return -githubUserId;
}

/** Next synthetic (negative) github_repo_id for a Quick Scan target row. */
export async function nextQuickScanRepoGithubId(database: Db): Promise<number> {
  const result = await database.execute(sql`select nextval('quick_scan_repo_id_seq') as nextval`);
  const row = (result as unknown as Array<{ nextval: string | number }>)[0];
  const value = Number(row?.nextval);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("quick_scan_repo_id_seq returned an invalid value");
  return -value;
}

/**
 * Ensures the per-user Quick Scan vault org exists (no installation id).
 * Justified synthetic org: repos/scans require org_id; this never receives
 * App webhooks or installation tokens.
 */
export async function ensureQuickScanVaultOrg(database: Db, userId: string): Promise<Org> {
  const user = await database.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true, githubUserId: true, login: true } });
  if (!user?.githubUserId) throw new Error("Quick Scan requires a GitHub-linked user");
  const githubAccountId = quickScanVaultAccountId(user.githubUserId);
  const githubLogin = `quickscan:${user.login ?? user.githubUserId}`;

  const [org] = await database
    .insert(orgs)
    .values({ githubAccountId, githubLogin, type: "User", installationId: null })
    .onConflictDoUpdate({
      target: orgs.githubAccountId,
      set: { githubLogin, type: "User", installationId: null },
    })
    .returning();
  return org!;
}

/**
 * Finds or creates the caller's Quick Scan target for `fullName` under their
 * vault org. Concurrent submissions of the same public repo share one row so
 * the active-deep unique index prevents double reservation.
 */
export async function ensureQuickScanRepo(
  database: Db,
  input: {
    orgId: string;
    ownerUserId: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
  },
): Promise<Repo> {
  const existing = await database.query.repos.findFirst({
    where: and(eq(repos.ownerUserId, input.ownerUserId), eq(repos.fullName, input.fullName), eq(repos.source, "quick_scan")),
  });
  if (existing) {
    const [updated] = await database
      .update(repos)
      .set({ defaultBranch: input.defaultBranch, private: input.private, enabled: true })
      .where(eq(repos.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const githubRepoId = await nextQuickScanRepoGithubId(database);
  try {
    const [repo] = await database
      .insert(repos)
      .values({
        orgId: input.orgId,
        githubRepoId,
        fullName: input.fullName,
        private: input.private,
        defaultBranch: input.defaultBranch,
        enabled: true,
        source: "quick_scan",
        ownerUserId: input.ownerUserId,
      })
      .returning();
    return repo!;
  } catch {
    // Unique race: another request created the same owner/full_name target.
    const raced = await database.query.repos.findFirst({
      where: and(eq(repos.ownerUserId, input.ownerUserId), eq(repos.fullName, input.fullName), eq(repos.source, "quick_scan")),
    });
    if (!raced) throw new Error("Quick Scan repo insert raced but no row was found");
    return raced;
  }
}

export async function insertQuickScan(
  database: Db,
  input: {
    scanId: string;
    ownerUserId: string;
    repoId: string;
    githubOwner: string;
    githubRepo: string;
    githubRepoId: number;
    commitSha: string;
    canonicalUrl: string;
  },
): Promise<QuickScan> {
  const [row] = await database.insert(quickScans).values(input).returning();
  return row!;
}

export async function quickScanByScanId(database: Db, scanId: string): Promise<QuickScan | undefined> {
  return database.query.quickScans.findFirst({ where: eq(quickScans.scanId, scanId) });
}

export async function isQuickScanRepo(database: Db, repoId: string): Promise<boolean> {
  const row = await database.query.repos.findFirst({ where: and(eq(repos.id, repoId), eq(repos.source, "quick_scan")), columns: { id: true } });
  return !!row;
}
