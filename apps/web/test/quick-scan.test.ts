/**
 * Public URL Quick Scan against disposable Postgres: URL validation outcomes,
 * entitlement reservation, access control, and no Checks/PR publishing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  createDb,
  findingForUser,
  getScanEntitlement,
  getUserEntitlement,
  scanForUser,
  schema,
  upsertInstallation,
  type Db,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { GitHubError, type GitHubApp, type PublicRepository } from "@sandchest/github";
import { authorizeChargeableScan, setHolderEligibilityProvider } from "@/server/entitlements";
import { requestQuickScan, resolvePublicGithubRepo } from "@/server/quick-scan";
import { beginScan, publishScan } from "@/server/scans";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_quick_scan_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

const publicRepos = new Map<string, PublicRepository & { sha: string }>();
const checks: Array<{ repo: string; title: string }> = [];

const fakeGithub = {
  publicRepository: async (owner: string, repo: string) => {
    if (repo === "jwt-401") throw new GitHubError("GitHub 401: Bad credentials", 401, false);
    if (repo === "forbidden") throw new GitHubError("GitHub 403: Resource not accessible by integration", 403, false);
    if (repo === "rate") throw new GitHubError("GitHub 403: API rate limit exceeded", 403, true);
    if (repo === "throttle") throw new GitHubError("GitHub 429: rate limit", 429, true);
    const row = publicRepos.get(`${owner}/${repo}`);
    if (!row) throw new GitHubError("Not Found", 404, false);
    const { sha: _sha, ...meta } = row;
    return meta;
  },
  publicBranchSha: async (owner: string, repo: string) => {
    const row = publicRepos.get(`${owner}/${repo}`);
    if (!row) throw new GitHubError("Not Found", 404, false);
    return row.sha;
  },
  installation: () => ({
    cloneToken: async () => "install-token",
    createCheckRun: async (repo: string, input: { output: { title: string } }) => {
      checks.push({ repo, title: input.output.title });
      return checks.length;
    },
    completeCheckRun: async () => {},
    createReview: async () => {},
    branchSha: async () => "deadbeef",
    pullFiles: async () => [],
  }),
} as unknown as GitHubApp;

function seedPublic(owner: string, repo: string, overrides: Partial<PublicRepository & { sha: string }> = {}) {
  publicRepos.set(`${owner}/${repo}`, {
    id: overrides.id ?? 9_001,
    full_name: `${owner}/${repo}`,
    private: overrides.private ?? false,
    default_branch: overrides.default_branch ?? "main",
    size: overrides.size ?? 120,
    archived: overrides.archived ?? false,
    disabled: overrides.disabled ?? false,
    fork: false,
    owner: { login: owner, id: 1, type: "Organization" },
    sha: overrides.sha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
}

async function seedUser(login: string, githubUserId: number) {
  const [user] = await database
    .insert(schema.users)
    .values({ name: login, email: `${login}@example.com`, emailVerified: true, githubUserId, login })
    .returning();
  return user!;
}

beforeAll(async () => {
  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists ${NAME}`);
    await admin.unsafe(`create database ${NAME}`);
  } catch (error) {
    available = false;
    console.warn(`quick-scan tests skipped: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_WEBHOOK_SECRET: "unused",
    SANDCHEST_APP_URL: "https://sandchest.test",
  });
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub });
  setScanStarter(async () => {});
  setHolderEligibilityProvider(undefined);
});

afterAll(async () => {
  setScanStarter(undefined);
  setHolderEligibilityProvider(undefined);
  if (!available) return;
  await database.$client.end({ timeout: 1 }).catch(() => {});
  // Avoid FORCE: the test role may lack rights to terminate other backends.
  await admin!.unsafe(`drop database if exists ${NAME}`).catch(() => {});
  await admin!.end({ timeout: 1 });
});

describe.skipIf(!available)("Quick Scan URL and metadata", () => {
  test("resolves default branch and SHA for a public repo", async () => {
    seedPublic("acme", "widget", { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const result = await resolvePublicGithubRepo("https://github.com/acme/widget");
    expect(result).toMatchObject({
      ok: true,
      meta: { owner: "acme", repo: "widget", commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", private: false },
    });
  });

  test("refuses private repositories before entitlement", async () => {
    seedPublic("acme", "secret", { private: true });
    const alice = await seedUser("alice-priv", 501);
    expect(await requestQuickScan("https://github.com/acme/secret", alice.id)).toMatchObject({ ok: false, reason: "private_repo" });
    expect((await getUserEntitlement(database, alice.id))?.freeScanStatus ?? "available").toBe("available");
  });

  test("refuses missing repositories without burning quota", async () => {
    const alice = await seedUser("alice-miss", 502);
    expect(await requestQuickScan("https://github.com/acme/missing", alice.id)).toMatchObject({ ok: false, reason: "not_found" });
    expect((await getUserEntitlement(database, alice.id))?.freeScanStatus ?? "available").toBe("available");
  });

  test("refuses oversized repositories", async () => {
    seedPublic("acme", "huge", { size: 600_000 });
    const alice = await seedUser("alice-huge", 503);
    expect(await requestQuickScan("https://github.com/acme/huge", alice.id)).toMatchObject({ ok: false, reason: "too_large" });
  });

  test("maps GitHub auth and rate-limit failures without burning free scan", async () => {
    const alice = await seedUser("alice-map", 511);
    expect(await resolvePublicGithubRepo("https://github.com/acme/jwt-401")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: expect.stringContaining("rejected the metadata request"),
    });
    expect(await resolvePublicGithubRepo("https://github.com/acme/forbidden")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: "GitHub refused access to this repository.",
    });
    expect(await resolvePublicGithubRepo("https://github.com/acme/rate")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: expect.stringContaining("rate limit"),
    });
    expect(await resolvePublicGithubRepo("https://github.com/acme/throttle")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: expect.stringContaining("rate limit"),
    });
    expect(await requestQuickScan("https://github.com/acme/jwt-401", alice.id)).toMatchObject({ ok: false, reason: "unavailable" });
    expect((await getUserEntitlement(database, alice.id))?.freeScanStatus ?? "available").toBe("available");
  });
});

describe.skipIf(!available)("Quick Scan entitlements and access", () => {
  test("reserves free entitlement and records quick_scans row", async () => {
    seedPublic("acme", "api");
    const alice = await seedUser("alice-qs", 504);
    const result = await requestQuickScan("https://github.com/acme/api.git", alice.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await getScanEntitlement(database, result.scanId)).toMatchObject({ ownerUserId: alice.id, source: "free", state: "reserved" });
    const qs = await database.query.quickScans.findFirst({ where: (q, { eq }) => eq(q.scanId, result.scanId) });
    expect(qs).toMatchObject({
      ownerUserId: alice.id,
      githubOwner: "acme",
      githubRepo: "api",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect((await getUserEntitlement(database, alice.id))?.freeScanStatus).toBe("reserved");
  });

  test("concurrent submissions cannot double-charge", async () => {
    seedPublic("acme", "race", { id: 9_100 });
    const alice = await seedUser("alice-race", 505);
    const [a, b] = await Promise.all([requestQuickScan("https://github.com/acme/race", alice.id), requestQuickScan("https://github.com/acme/race", alice.id)]);
    const oks = [a, b].filter((r) => r.ok);
    const blocked = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ ok: false, reason: "running" });
    const reserved = (await database.query.scanEntitlements.findMany({ where: (row, { eq }) => eq(row.ownerUserId, alice.id) })).filter(
      (row) => row.state === "reserved" || row.state === "consumed",
    );
    expect(reserved).toHaveLength(1);
  });

  test("scan retry is idempotent for the same active deep scan", async () => {
    seedPublic("acme", "again", { id: 9_101 });
    const alice = await seedUser("alice-again", 506);
    const first = await requestQuickScan("https://github.com/acme/again", alice.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await requestQuickScan("https://github.com/acme/again", alice.id);
    expect(second).toMatchObject({ ok: false, reason: "running", scanId: first.scanId });
    expect(await database.query.scanEntitlements.findMany({ where: (row, { eq }) => eq(row.ownerUserId, alice.id) })).toHaveLength(1);
  });

  test("requester-only scan and findings access", async () => {
    seedPublic("acme", "private-view", { id: 9_102 });
    const alice = await seedUser("alice-view", 507);
    const bob = await seedUser("bob-view", 508);
    const started = await requestQuickScan("https://github.com/acme/private-view", alice.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(await scanForUser(database, alice.id, started.scanId)).toBeTruthy();
    expect(await scanForUser(database, bob.id, started.scanId)).toBeUndefined();

    const scan = await database.query.scans.findFirst({ where: (s, { eq }) => eq(s.id, started.scanId) });
    const [finding] = await database
      .insert(schema.findings)
      .values({
        repoId: scan!.repoId,
        fingerprint: "qs-1",
        severity: "high",
        confidence: "high",
        category: "test",
        title: "Test finding",
        impact: "impact",
        entryPoint: { file: "a.ts", line: 1 },
        attackPath: [],
        attacker: "remote",
        preconditions: "none",
        proofOfConcept: "n/a",
        fixGuidance: "n/a",
        guarantees: [],
        mustNotBreak: [],
        regressionTest: "n/a",
        fixPrompt: "n/a",
        sourceScanId: started.scanId,
        sourceKind: "deep",
      })
      .returning();

    expect(await findingForUser(database, alice.id, finding!.id)).toBeTruthy();
    expect(await findingForUser(database, bob.id, finding!.id)).toBeUndefined();
  });

  test("Quick Scan begin/publish never creates GitHub Checks", async () => {
    seedPublic("acme", "nocheck", { id: 9_103 });
    const alice = await seedUser("alice-check", 509);
    checks.length = 0;
    const started = await requestQuickScan("https://github.com/acme/nocheck", alice.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const begin = await beginScan(started.scanId);
    expect(begin.state).toBe("running");
    expect(checks).toHaveLength(0);
    await publishScan(started.scanId);
    expect(checks).toHaveLength(0);
  });

  test("installed-repository Dig path still requires installation (regression)", async () => {
    const alice = await seedUser("alice-install", 510);
    const { org, repos } = await upsertInstallation(database, 88001, { githubAccountId: 88001, githubLogin: "initech", type: "Organization" }, [
      { githubRepoId: 77, fullName: "initech/api", private: true, defaultBranch: "main" },
    ]);
    expect(org.installationId).toBe(88001);
    expect(repos[0]?.source ?? "installed").toBe("installed");
    const [scan] = await database
      .insert(schema.scans)
      .values({ repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "c".repeat(40) })
      .returning();
    await authorizeChargeableScan({ scanId: scan!.id, ownerUserId: alice.id });
    expect(await getScanEntitlement(database, scan!.id)).toMatchObject({ source: "free" });
  });
});
