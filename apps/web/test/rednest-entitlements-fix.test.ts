/**
 * RED-04B-F regression: operator Dig authorization, unsponsored recon gate,
 * and Autumn fail-closed canScan. Requires isolated local Postgres — never
 * the hosted/production database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  acceptOrgSponsorship,
  authorizeOperatorScan,
  createDb,
  createScan,
  isOperatorAuthorizedScan,
  schema,
  upsertInstallation,
  type Db,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { canScan } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { setDb } from "@/server/db";
import { requestDeepScan, requestOperatorDeepScan } from "@/server/dig";
import { manualDeepBlockedByUnsponsoredRecon, scanMayStart } from "@/server/entitlements";
import { beginScan } from "@/server/scans";
import { setServices } from "@/server/services";
import { setScanStarter } from "@/server/start";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_rednest_ent_fix_${process.pid}`;
const TOKEN = "operator-token-for-rednest-entitlement-fix";

async function canCreateIsolatedDb(): Promise<boolean> {
  try {
    const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2, onnotice: () => {} });
    await probe`select 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    return false;
  }
}

const available = await canCreateIsolatedDb();
if (!available) {
  console.warn("BLOCKED: apps/web/test/rednest-entitlements-fix.test.ts — isolated PostgreSQL unavailable");
}

let admin: postgres.Sql | undefined;
let database: Db;

const fakeGithub = {
  installation: () => ({
    branchSha: async () => "deadbeef",
    repositories: async () => [],
    createCheckRun: async () => 1,
    completeCheckRun: async () => {},
    createReview: async () => {},
    pullFiles: async () => [],
  }),
} as unknown as GitHubApp;

beforeAll(async () => {
  if (!available) return;
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${NAME}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_WEBHOOK_SECRET: "unused",
    SANDCHEST_APP_URL: "https://sandchest.test",
    SANDCHEST_ADMIN_TOKEN: TOKEN,
  });
  delete process.env.AUTUMN_SECRET_KEY;
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setDb(database);
  setServices({ db: database, github: fakeGithub });
  setScanStarter(async () => {});
});

afterAll(async () => {
  delete process.env.SANDCHEST_ADMIN_TOKEN;
  resetConfig();
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

async function seedUser(githubUserId: number, login: string) {
  const [user] = await database.insert(schema.users).values({ name: login, email: `${login}@example.com`, githubUserId, login }).returning();
  return user!;
}

async function seedRepo(githubAccountId: number, login: string) {
  const { org, repos } = await upsertInstallation(
    database,
    githubAccountId + 2000,
    { githubAccountId, githubLogin: login, type: "Organization" },
    [{ githubRepoId: githubAccountId + 9000, fullName: `${login}/app`, private: true, defaultBranch: "main" }],
  );
  return { org, repo: repos[0]! };
}

describe.skipIf(!available)("operator Dig authorization", () => {
  test("beginScan accepts operator-authorized deep scans without user entitlement", async () => {
    const { org, repo } = await seedRepo(11_001, "ops-org");
    const { scan } = await createScan(database, {
      id: randomUUID(),
      repoId: repo.id,
      orgId: org.id,
      kind: "deep",
      trigger: "manual",
      headSha: "abc",
    });
    expect(await scanMayStart(scan.id)).toBe(false);
    await authorizeOperatorScan(database, scan.id);
    expect(await isOperatorAuthorizedScan(database, scan.id)).toBe(true);
    expect(await scanMayStart(scan.id)).toBe(true);
    expect((await beginScan(scan.id)).state).toBe("running");
  });

  test("requestOperatorDeepScan authorizes without consuming free entitlement", async () => {
    const user = await seedUser(11_010, "ops-alice");
    const { org, repo } = await seedRepo(11_011, "ops-dig");
    const result = await requestOperatorDeepScan({ ...repo, org, loc: 1_000 }, "manual");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await isOperatorAuthorizedScan(database, result.scanId)).toBe(true);
    const other = await seedRepo(11_012, "ops-dig-2");
    const dig = await requestDeepScan({ ...other.repo, org: other.org, loc: 1_000 }, "manual", { ownerUserId: user.id });
    expect(dig.ok).toBe(true);
  });
});

describe.skipIf(!available)("unsponsored organization Dig", () => {
  test("blocks reservation when pending recon cannot start without a sponsor", async () => {
    const user = await seedUser(12_001, "unsponsored-user");
    const { org, repo } = await seedRepo(12_002, "unsponsored");
    await createScan(database, {
      id: randomUUID(),
      repoId: repo.id,
      orgId: org.id,
      kind: "recon",
      trigger: "webhook",
      headSha: "recon1",
    });
    expect(await manualDeepBlockedByUnsponsoredRecon(repo.id, org.id)).toBe(true);
    const dig = await requestDeepScan({ ...repo, org, loc: 500 }, "manual", { ownerUserId: user.id });
    expect(dig).toEqual({ ok: false, reason: "no_sponsor" });
  });

  test("allows Dig after sponsorship when recon is pending", async () => {
    const user = await seedUser(12_010, "sponsor-admin");
    const { org, repo } = await seedRepo(12_011, "sponsored-later");
    await database.insert(schema.orgAdmins).values({ userId: user.id, orgId: org.id });
    await createScan(database, {
      id: randomUUID(),
      repoId: repo.id,
      orgId: org.id,
      kind: "recon",
      trigger: "webhook",
      headSha: "recon2",
    });
    expect(await manualDeepBlockedByUnsponsoredRecon(repo.id, org.id)).toBe(true);
    expect(await acceptOrgSponsorship(database, { orgId: org.id, sponsorUserId: user.id, assignedByUserId: user.id })).toMatchObject({
      ok: true,
      created: true,
    });
    expect(await manualDeepBlockedByUnsponsoredRecon(repo.id, org.id)).toBe(false);
    const dig = await requestDeepScan({ ...repo, org, loc: 500 }, "manual", { ownerUserId: user.id });
    expect(dig.ok).toBe(true);
  });

  test("beginScan refuses a deep scan waiting on unsponsored recon and releases entitlement", async () => {
    const user = await seedUser(12_020, "stuck-user");
    const { org, repo } = await seedRepo(12_021, "stuck-org");
    await createScan(database, {
      id: randomUUID(),
      repoId: repo.id,
      orgId: org.id,
      kind: "recon",
      trigger: "webhook",
      headSha: "recon3",
    });
    const { scan } = await createScan(database, {
      id: randomUUID(),
      repoId: repo.id,
      orgId: org.id,
      kind: "deep",
      trigger: "manual",
      headSha: "deep3",
    });
    const { reserveScanEntitlement } = await import("@sandchest/db");
    expect((await reserveScanEntitlement(database, { scanId: scan.id, ownerUserId: user.id, holderEligible: false })).ok).toBe(true);
    expect((await beginScan(scan.id)).state).toBe("done");
    const row = await database.query.scans.findFirst({ where: (s, { eq }) => eq(s.id, scan.id) });
    expect(row?.status).toBe("refused");
    const next = await seedRepo(12_022, "stuck-reuse");
    const dig = await requestDeepScan({ ...next.repo, org: next.org, loc: 100 }, "manual", { ownerUserId: user.id });
    expect(dig.ok).toBe(true);
  });
});

describe.skipIf(!available)("legacy billing canScan fail-closed", () => {
  test("missing Autumn does not grant scan authorization without a sponsor", async () => {
    delete process.env.AUTUMN_SECRET_KEY;
    resetConfig();
    const { org } = await seedRepo(13_001, "autumn-off");
    expect(await canScan({ id: org.id, githubLogin: org.githubLogin })).toBe(false);
    const adminUser = await seedUser(13_002, "autumn-admin");
    await acceptOrgSponsorship(database, { orgId: org.id, sponsorUserId: adminUser.id, assignedByUserId: adminUser.id });
    expect(await canScan({ id: org.id, githubLogin: org.githubLogin })).toBe(true);
  });
});

test("postgres availability marker (always runs)", () => {
  expect(available).toBe(available);
  if (!available) expect(available).toBe(false);
});
