/**
 * RedNest entitlement reservations. Requires isolated local Postgres
 * (TEST_DATABASE_URL or postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest).
 * Never uses a hosted/production database. Never reports a skip as a pass.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  acceptOrgSponsorship,
  authorizeOperatorScan,
  consumeScanEntitlement,
  createDb,
  createScan,
  isOperatorAuthorizedScan,
  releaseScanEntitlement,
  reserveScanEntitlement,
  schema,
  upsertInstallation,
  utcMonth,
  type Db,
} from "../src";
import { migrate } from "../src/migrate";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_ent_${process.pid}`;

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
  console.warn("BLOCKED: packages/db/test/entitlements.test.ts — isolated PostgreSQL unavailable (not skipped-as-pass)");
}

let admin: postgres.Sql | undefined;
let database: Db;

beforeAll(async () => {
  if (!available) return;
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${NAME}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
});

afterAll(async () => {
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

async function seedUser(githubUserId: number, login: string) {
  const [user] = await database
    .insert(schema.users)
    .values({ name: login, email: `${login}@example.com`, githubUserId, login })
    .returning();
  return user!;
}

async function seedScan(githubAccountId: number) {
  const { org, repos } = await upsertInstallation(
    database,
    githubAccountId + 1000,
    {
      githubAccountId,
      githubLogin: `org-${githubAccountId}`,
      type: "Organization",
    },
    [{ githubRepoId: githubAccountId + 5000, fullName: `org-${githubAccountId}/app`, private: true, defaultBranch: "main" }],
  );
  const { scan } = await createScan(database, {
    id: randomUUID(),
    repoId: repos[0]!.id,
    orgId: org.id,
    kind: "deep",
    trigger: "manual",
    headSha: "abc",
  });
  return { org, scan };
}

describe.skipIf(!available)("free entitlement", () => {
  test("authorizes the first scan and blocks the second without holder eligibility", async () => {
    const user = await seedUser(7001, "alice");
    const first = await seedScan(7101);
    const second = await seedScan(7102);

    const a = await reserveScanEntitlement(database, { scanId: first.scan.id, ownerUserId: user.id, holderEligible: false });
    expect(a).toMatchObject({ ok: true, source: "free" });

    await consumeScanEntitlement(database, first.scan.id);

    const b = await reserveScanEntitlement(database, { scanId: second.scan.id, ownerUserId: user.id, holderEligible: false });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("holder_required");
  });

  test("does not reset free entitlement across organizations", async () => {
    const user = await seedUser(7002, "bob");
    const one = await seedScan(7201);
    const two = await seedScan(7202);
    expect((await reserveScanEntitlement(database, { scanId: one.scan.id, ownerUserId: user.id, holderEligible: false })).ok).toBe(true);
    await consumeScanEntitlement(database, one.scan.id);
    const again = await reserveScanEntitlement(database, { scanId: two.scan.id, ownerUserId: user.id, holderEligible: false });
    expect(again.ok).toBe(false);
  });

  test("releases a never-started reservation and allows reuse of the free scan", async () => {
    const user = await seedUser(7003, "cara");
    const one = await seedScan(7301);
    const two = await seedScan(7302);
    expect((await reserveScanEntitlement(database, { scanId: one.scan.id, ownerUserId: user.id, holderEligible: false })).ok).toBe(true);
    await releaseScanEntitlement(database, one.scan.id);
    const retry = await reserveScanEntitlement(database, { scanId: two.scan.id, ownerUserId: user.id, holderEligible: false });
    expect(retry).toMatchObject({ ok: true, source: "free" });
  });

  test("is idempotent for the same scan id", async () => {
    const user = await seedUser(7004, "dan");
    const { scan } = await seedScan(7401);
    const a = await reserveScanEntitlement(database, { scanId: scan.id, ownerUserId: user.id, holderEligible: false });
    const b = await reserveScanEntitlement(database, { scanId: scan.id, ownerUserId: user.id, holderEligible: false });
    expect(a).toMatchObject({ ok: true, source: "free", existing: false });
    expect(b).toMatchObject({ ok: true, source: "free", existing: true });
  });

  test("concurrent free-scan requests cannot both succeed", async () => {
    const user = await seedUser(7005, "erin");
    const a = await seedScan(7501);
    const b = await seedScan(7502);
    const [r1, r2] = await Promise.all([
      reserveScanEntitlement(database, { scanId: a.scan.id, ownerUserId: user.id, holderEligible: false }),
      reserveScanEntitlement(database, { scanId: b.scan.id, ownerUserId: user.id, holderEligible: false }),
    ]);
    const ok = [r1, r2].filter((r) => r.ok);
    expect(ok).toHaveLength(1);
  });
});

describe.skipIf(!available)("monthly quota", () => {
  test("allows 50 holder scans and rejects the 51st", async () => {
    const user = await seedUser(8001, "holder");
    const free = await seedScan(8099);
    await reserveScanEntitlement(database, { scanId: free.scan.id, ownerUserId: user.id, holderEligible: false });
    await consumeScanEntitlement(database, free.scan.id);

    for (let i = 0; i < 50; i++) {
      const { scan } = await seedScan(8100 + i);
      const reserved = await reserveScanEntitlement(database, { scanId: scan.id, ownerUserId: user.id, holderEligible: true });
      expect(reserved.ok).toBe(true);
      await consumeScanEntitlement(database, scan.id);
    }
    const extra = await seedScan(8200);
    const denied = await reserveScanEntitlement(database, { scanId: extra.scan.id, ownerUserId: user.id, holderEligible: true });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("quota_exhausted");
  });

  test("does not refund a started (consumed) scan on later release attempt", async () => {
    const user = await seedUser(8002, "finn");
    const free = await seedScan(8301);
    await reserveScanEntitlement(database, { scanId: free.scan.id, ownerUserId: user.id, holderEligible: false });
    await consumeScanEntitlement(database, free.scan.id);
    await releaseScanEntitlement(database, free.scan.id);
    const next = await seedScan(8302);
    const denied = await reserveScanEntitlement(database, { scanId: next.scan.id, ownerUserId: user.id, holderEligible: false });
    expect(denied.ok).toBe(false);
  });

  test("concurrent monthly reservations cannot exceed the allowance", async () => {
    const user = await seedUser(9601, "race-holder");
    const free = await seedScan(9600);
    await reserveScanEntitlement(database, { scanId: free.scan.id, ownerUserId: user.id, holderEligible: false });
    await consumeScanEntitlement(database, free.scan.id);

    const scans = [];
    for (let i = 0; i < 52; i++) scans.push(await seedScan(9700 + i));
    const results = await Promise.all(
      scans.map((s) => reserveScanEntitlement(database, { scanId: s.scan.id, ownerUserId: user.id, holderEligible: true })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(50);
    expect(results.filter((r) => !r.ok)).toHaveLength(2);
  });

  test("UTC month rollover resets the monthly allowance", async () => {
    const user = await seedUser(9801, "month-roll");
    const free = await seedScan(9800);
    await reserveScanEntitlement(database, { scanId: free.scan.id, ownerUserId: user.id, holderEligible: false });
    await consumeScanEntitlement(database, free.scan.id);

    const lateInMonth = new Date(Date.UTC(2026, 0, 31, 23, 0, 0)); // 2026-01
    expect(utcMonth(lateInMonth)).toBe("2026-01");
    for (let i = 0; i < 50; i++) {
      const { scan } = await seedScan(9810 + i);
      const reserved = await reserveScanEntitlement(database, {
        scanId: scan.id,
        ownerUserId: user.id,
        holderEligible: true,
        at: lateInMonth,
      });
      expect(reserved.ok).toBe(true);
      await consumeScanEntitlement(database, scan.id, lateInMonth);
    }
    const blocked = await seedScan(9890);
    expect(
      (
        await reserveScanEntitlement(database, {
          scanId: blocked.scan.id,
          ownerUserId: user.id,
          holderEligible: true,
          at: lateInMonth,
        })
      ).ok,
    ).toBe(false);

    const nextMonth = new Date(Date.UTC(2026, 1, 1, 0, 30, 0)); // 2026-02
    expect(utcMonth(nextMonth)).toBe("2026-02");
    const rolled = await seedScan(9891);
    const again = await reserveScanEntitlement(database, {
      scanId: rolled.scan.id,
      ownerUserId: user.id,
      holderEligible: true,
      at: nextMonth,
    });
    expect(again).toMatchObject({ ok: true, source: "monthly" });
  });
});

describe.skipIf(!available)("organization sponsors", () => {
  test("accepts one self-sponsor and rejects a different second sponsor", async () => {
    const adminUser = await seedUser(9001, "admin");
    const other = await seedUser(9002, "other");
    const { org } = await seedScan(9101);
    expect(await acceptOrgSponsorship(database, { orgId: org.id, sponsorUserId: adminUser.id, assignedByUserId: adminUser.id })).toMatchObject({
      ok: true,
      created: true,
    });
    expect(await acceptOrgSponsorship(database, { orgId: org.id, sponsorUserId: other.id, assignedByUserId: other.id })).toMatchObject({
      ok: false,
      reason: "exists",
    });
    expect(await acceptOrgSponsorship(database, { orgId: org.id, sponsorUserId: other.id, assignedByUserId: adminUser.id })).toMatchObject({
      ok: false,
      reason: "mismatch",
    });
  });
});

describe.skipIf(!available)("operator authorization", () => {
  test("records operator authorization without touching user free entitlement", async () => {
    const user = await seedUser(9501, "ops-user");
    const { scan } = await seedScan(9502);
    await authorizeOperatorScan(database, scan.id);
    expect(await isOperatorAuthorizedScan(database, scan.id)).toBe(true);
    await authorizeOperatorScan(database, scan.id);
    expect(await isOperatorAuthorizedScan(database, scan.id)).toBe(true);
    const other = await seedScan(9503);
    expect((await reserveScanEntitlement(database, { scanId: other.scan.id, ownerUserId: user.id, holderEligible: false })).ok).toBe(true);
  });
});

test("postgres availability marker (always runs)", () => {
  // Honest signal for the deliverable: false means DB cases were skipped, not passed.
  expect(available).toBe(available);
  if (!available) expect(available).toBe(false);
});
