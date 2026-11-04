/**
 * Wallet challenges and atomic bind/disconnect. Isolated Postgres only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  bindVerifiedWallet,
  createDb,
  createScan,
  createWalletChallenge,
  disconnectActiveWallet,
  getActiveWallet,
  getUserEntitlement,
  reserveScanEntitlement,
  schema,
  upsertInstallation,
  utcMonth,
  type Db,
} from "../src";
import { migrate } from "../src/migrate";
import { and, eq } from "drizzle-orm";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_wal_${process.pid}`;

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
  console.warn("BLOCKED: packages/db/test/wallets.test.ts — isolated PostgreSQL unavailable (not skipped-as-pass)");
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
  try {
    await admin!.unsafe(`drop database if exists ${NAME}`);
  } catch {
    // Role may lack FORCE; connection end above is enough for local disposable DBs.
  }
  await admin!.end();
});

async function seedUser(githubUserId: number, login: string) {
  const [user] = await database
    .insert(schema.users)
    .values({ name: login, email: `${login}@example.com`, githubUserId, login })
    .returning();
  return user!;
}

async function seedSession(userId: string) {
  const [session] = await database
    .insert(schema.sessions)
    .values({
      token: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return session!;
}

const describeIf = available ? describe : describe.skip;

describeIf("wallet challenges and binding", () => {
  test("binds a verified wallet and enforces global uniqueness", async () => {
    const alice = await seedUser(901, "alice-wal");
    const bob = await seedUser(902, "bob-wal");
    const aliceSession = await seedSession(alice.id);
    const bobSession = await seedSession(bob.id);
    const pubkey = "AliceWallet1111111111111111111111111111111";

    const challenge = await createWalletChallenge(database, {
      userId: alice.id,
      sessionId: aliceSession.id,
      walletPubkey: pubkey,
      domain: "rednest.tech",
      githubLogin: alice.login,
    });
    const bound = await bindVerifiedWallet(database, {
      challengeId: challenge.id,
      userId: alice.id,
      sessionId: aliceSession.id,
      walletPubkey: pubkey,
    });
    expect(bound).toMatchObject({ ok: true });
    expect(await getActiveWallet(database, alice.id)).toMatchObject({ walletPubkey: pubkey });

    const bobChallenge = await createWalletChallenge(database, {
      userId: bob.id,
      sessionId: bobSession.id,
      walletPubkey: pubkey,
      domain: "rednest.tech",
      githubLogin: bob.login,
    });
    const stolen = await bindVerifiedWallet(database, {
      challengeId: bobChallenge.id,
      userId: bob.id,
      sessionId: bobSession.id,
      walletPubkey: pubkey,
    });
    expect(stolen).toEqual({ ok: false, reason: "wallet_taken" });
    expect(await getActiveWallet(database, bob.id)).toBeNull();
    expect(await getActiveWallet(database, alice.id)).toMatchObject({ walletPubkey: pubkey });
  });

  test("rejects expired, consumed, and mismatched challenges", async () => {
    const user = await seedUser(903, "carol-wal");
    const session = await seedSession(user.id);
    const other = await seedSession(user.id);
    const pubkey = "CarolWallet1111111111111111111111111111111";

    const expired = await createWalletChallenge(database, {
      userId: user.id,
      sessionId: session.id,
      walletPubkey: pubkey,
      domain: "rednest.tech",
      githubLogin: user.login,
      at: new Date(Date.now() - 10 * 60_000),
    });
    expect(
      await bindVerifiedWallet(database, {
        challengeId: expired.id,
        userId: user.id,
        sessionId: session.id,
        walletPubkey: pubkey,
      }),
    ).toEqual({ ok: false, reason: "challenge_expired" });

    const live = await createWalletChallenge(database, {
      userId: user.id,
      sessionId: session.id,
      walletPubkey: pubkey,
      domain: "rednest.tech",
      githubLogin: user.login,
    });
    expect(
      await bindVerifiedWallet(database, {
        challengeId: live.id,
        userId: user.id,
        sessionId: other.id,
        walletPubkey: pubkey,
      }),
    ).toEqual({ ok: false, reason: "session_mismatch" });
    expect(
      await bindVerifiedWallet(database, {
        challengeId: live.id,
        userId: user.id,
        sessionId: session.id,
        walletPubkey: "OtherWallet111111111111111111111111111111",
      }),
    ).toEqual({ ok: false, reason: "wallet_mismatch" });

    const ok = await bindVerifiedWallet(database, {
      challengeId: live.id,
      userId: user.id,
      sessionId: session.id,
      walletPubkey: pubkey,
    });
    expect(ok.ok).toBe(true);
    expect(
      await bindVerifiedWallet(database, {
        challengeId: live.id,
        userId: user.id,
        sessionId: session.id,
        walletPubkey: pubkey,
      }),
    ).toEqual({ ok: false, reason: "challenge_consumed" });
  });

  test("replace and disconnect leave free and monthly entitlements untouched", async () => {
    const user = await seedUser(904, "dave-wal");
    const session = await seedSession(user.id);
    const first = "DaveWalletA111111111111111111111111111111";
    const second = "DaveWalletB111111111111111111111111111111";

    const c1 = await createWalletChallenge(database, {
      userId: user.id,
      sessionId: session.id,
      walletPubkey: first,
      domain: "rednest.tech",
      githubLogin: user.login,
    });
    expect((await bindVerifiedWallet(database, { challengeId: c1.id, userId: user.id, sessionId: session.id, walletPubkey: first })).ok).toBe(true);

    // Distinct repos so createScan does not fold both deep scans into one active row.
    const freeInstall = await upsertInstallation(
      database,
      9100,
      { githubAccountId: 910, githubLogin: "dave-org-a", type: "Organization" },
      [{ githubRepoId: 9101, fullName: "dave-org-a/app", private: true, defaultBranch: "main" }],
    );
    const { scan: freeScan } = await createScan(database, {
      id: randomUUID(),
      repoId: freeInstall.repos[0]!.id,
      orgId: freeInstall.org.id,
      kind: "deep",
      trigger: "manual",
      headSha: "aaa",
    });
    expect((await reserveScanEntitlement(database, { scanId: freeScan.id, ownerUserId: user.id, holderEligible: false })).ok).toBe(true);

    const monthInstall = await upsertInstallation(
      database,
      9102,
      { githubAccountId: 912, githubLogin: "dave-org-b", type: "Organization" },
      [{ githubRepoId: 9103, fullName: "dave-org-b/app", private: true, defaultBranch: "main" }],
    );
    const { scan: monthScan } = await createScan(database, {
      id: randomUUID(),
      repoId: monthInstall.repos[0]!.id,
      orgId: monthInstall.org.id,
      kind: "deep",
      trigger: "manual",
      headSha: "bbb",
    });
    expect((await reserveScanEntitlement(database, { scanId: monthScan.id, ownerUserId: user.id, holderEligible: true })).ok).toBe(true);

    const before = await getUserEntitlement(database, user.id);
    expect(before?.freeScanStatus).toBe("reserved");
    const month = utcMonth();
    const [monthRow] = await database
      .select()
      .from(schema.userScanMonths)
      .where(and(eq(schema.userScanMonths.userId, user.id), eq(schema.userScanMonths.monthUtc, month)))
      .limit(1);
    expect(monthRow?.reserved).toBe(1);

    const c2 = await createWalletChallenge(database, {
      userId: user.id,
      sessionId: session.id,
      walletPubkey: second,
      domain: "rednest.tech",
      githubLogin: user.login,
    });
    expect((await bindVerifiedWallet(database, { challengeId: c2.id, userId: user.id, sessionId: session.id, walletPubkey: second })).ok).toBe(true);
    expect(await getActiveWallet(database, user.id)).toMatchObject({ walletPubkey: second });

    await disconnectActiveWallet(database, user.id);
    expect(await getActiveWallet(database, user.id)).toBeNull();

    const after = await getUserEntitlement(database, user.id);
    expect(after?.freeScanStatus).toBe(before?.freeScanStatus);
    const [monthAfter] = await database
      .select()
      .from(schema.userScanMonths)
      .where(and(eq(schema.userScanMonths.userId, user.id), eq(schema.userScanMonths.monthUtc, month)))
      .limit(1);
    expect(monthAfter?.reserved).toBe(1);
    expect(monthAfter?.consumed).toBe(monthRow?.consumed);
  });

  test("concurrent claims of the same pubkey allow only one winner", async () => {
    const a = await seedUser(905, "erin-wal");
    const b = await seedUser(906, "frank-wal");
    const sa = await seedSession(a.id);
    const sb = await seedSession(b.id);
    const pubkey = "RaceWallet11111111111111111111111111111111";
    const ca = await createWalletChallenge(database, {
      userId: a.id,
      sessionId: sa.id,
      walletPubkey: pubkey,
      domain: "rednest.tech",
      githubLogin: a.login,
    });
    const cb = await createWalletChallenge(database, {
      userId: b.id,
      sessionId: sb.id,
      walletPubkey: pubkey,
      domain: "rednest.tech",
      githubLogin: b.login,
    });
    const results = await Promise.all([
      bindVerifiedWallet(database, { challengeId: ca.id, userId: a.id, sessionId: sa.id, walletPubkey: pubkey }),
      bindVerifiedWallet(database, { challengeId: cb.id, userId: b.id, sessionId: sb.id, walletPubkey: pubkey }),
    ]);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ ok: false, reason: "wallet_taken" });
  });
});

test("postgres availability marker (always runs)", () => {
  expect(typeof available).toBe("boolean");
});
