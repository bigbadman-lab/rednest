/**
 * Billing (SPEC §12) against a real Postgres, with GitHub and Autumn faked:
 * the paywall before recon, the credit gate on every scan, neutral Checks
 * when a PR is not reviewed, credits held and given back, Dig, the sweep and
 * auto top-up. The scan engine itself is not run here; m2 runs it end to end
 * with billing on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acceptOrgSponsorship,
  createDb,
  orgBillingRow,
  scanById,
  schema,
  upsertInstallation,
  type Db,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { GitHubApp } from "@sandchest/github";
import { GET as sweep } from "@/app/api/cron/sweep/route";
import { applyAutoTopUp, hasPlan, reserveScan, setAutumn, settleScan, startPendingRecon, syncBilling } from "@/server/billing";
import { requestDeepScan, requestOperatorDeepScan } from "@/server/dig";
import {
  authorizeChargeableScan,
  EntitlementError,
  orgLifecycleAllowed,
  releaseUnusedScanEntitlement,
  requireOrgSponsorUserId,
  setHolderEligibilityProvider,
} from "@/server/entitlements";
import { beginScan, failScan, publishScan } from "@/server/scans";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";
import { setRunStatus, setScanStarter } from "@/server/start";
import { handleWebhook } from "@/server/webhooks";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_m4_test_${process.pid}`;

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

const checks: Array<{ repo: string; title: string; conclusion?: string; summary?: string }> = [];
const repoList = [
  { id: 41, full_name: "acme/api", private: true, default_branch: "main" },
  { id: 42, full_name: "acme/web", private: true, default_branch: "main" },
];
const fakeGithub = {
  installation: () => ({
    repositories: async () => repoList,
    // 12 changed lines in one security-relevant file, plus docs and a lockfile that cost nothing: 1 credit.
    pullFiles: async () => [
      { filename: "src/app.js", status: "modified", additions: 8, deletions: 4, patch: "@@ -1 +1 @@\n-a\n+b" },
      { filename: "README.md", status: "modified", additions: 400, deletions: 0 },
      { filename: "package-lock.json", status: "modified", additions: 900, deletions: 900 },
    ],
    createCheckRun: async (repo: string, input: { output: { title: string } }) => {
      checks.push({ repo, title: input.output.title });
      return checks.length;
    },
    completeCheckRun: async (repo: string, id: number, conclusion: string, output: { title: string; summary: string }) => {
      Object.assign(checks[id - 1]!, { conclusion, title: output.title, summary: output.summary });
    },
    createReview: async () => {},
    branchSha: async () => "deadbeef",
  }),
} as unknown as GitHubApp;

const autumn = new FakeAutumn();
const started: string[] = [];
// The workflow runs the sweep can see, by run id. Any other id is a run that does not exist.
const runs = new Map<string, string>();
/** Hosted scan gate: RedNest sponsor + entitlements (not Autumn fail-open). */
const deps = () => ({
  db: database,
  github: fakeGithub,
  startScan: async (id: string) => void started.push(id),
  canScan: async (org: { id: string }) => orgLifecycleAllowed(org.id),
  authorizePrReview: async ({ scanId, orgId }: { scanId: string; orgId: string }) => {
    try {
      const sponsorUserId = await requireOrgSponsorUserId(orgId);
      await authorizeChargeableScan({ scanId, ownerUserId: sponsorUserId });
      return { ok: true as const };
    } catch (error) {
      await releaseUnusedScanEntitlement(scanId).catch(() => {});
      return { ok: false as const, detail: error instanceof EntitlementError ? error.message : "PR review was not authorized." };
    }
  },
});
let acme: { id: string; githubLogin: string };
let repoIds: string[];
let digUserId: string;

beforeAll(async () => {
  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${NAME}`);
  } catch {
    available = false;
    return;
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  Object.assign(process.env, { DATABASE_URL: url.toString(), GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "unused", GITHUB_WEBHOOK_SECRET: "unused", SANDCHEST_APP_URL: "https://sandchest.test", CRON_SECRET: "cron-secret" });
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub });
  setAutumn(autumn);
  setScanStarter(async (id) => void started.push(id));
  setRunStatus(async (runId) => runs.get(runId));
  const [user] = await database.insert(schema.users).values({ name: "digger", email: "digger@example.com", login: "digger", githubUserId: 6101 }).returning();
  digUserId = user!.id;
  setHolderEligibilityProvider(() => "eligible");
});

afterAll(async () => {
  setHolderEligibilityProvider(undefined);
  setAutumn(undefined);
  setScanStarter(undefined);
  setRunStatus(undefined);
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const prEvent = (repo: (typeof repoList)[number], number: number, head: string) => ({
  action: "opened",
  number,
  installation: { id: 501 },
  repository: repo,
  sender: { login: "dev" },
  pull_request: { number, draft: false, head: { sha: head, ref: "f", repo: { id: repo.id, full_name: repo.full_name } }, base: { sha: "base", ref: "main", repo: { id: repo.id } }, author_association: "MEMBER" },
});

async function openPr(number: number): Promise<string> {
  const outcome = await handleWebhook(deps(), "pull_request", `pr-${number}`, prEvent(repoList[0]!, number, `head${number}`));
  return outcome.scans![0]!;
}

describe.skipIf(!available)("billing", () => {
  test("install without a sponsor: recon waits; accepting sponsorship starts it once per repo", async () => {
    const outcome = await handleWebhook(deps(), "installation", "install-1", { action: "created", installation: { id: 501, account: { id: 900, login: "acme", type: "Organization" } } });
    expect(outcome).toMatchObject({ status: "handled", scans: [], detail: "recon waits for an accepted scan sponsor" });
    const org = await database.query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.installationId, 501) });
    acme = { id: org!.id, githubLogin: "acme" };
    repoIds = (await database.query.repos.findMany({ where: (repos, { eq }) => eq(repos.orgId, acme.id) })).map((r) => r.id);
    expect((await orgBillingRow(database, acme.id))?.planId ?? null).toBeNull();

    // Autumn plan alone must not unlock recon; sponsorship does.
    await autumn.attach({ customerId: acme.id, planId: "lockbox", successUrl: "" });
    const beforeAutumn = started.length;
    await syncBilling(acme);
    expect(started.length - beforeAutumn).toBe(0);

    expect(await acceptOrgSponsorship(database, { orgId: acme.id, sponsorUserId: digUserId, assignedByUserId: digUserId })).toMatchObject({
      ok: true,
      created: true,
    });
    const before = started.length;
    const startedIds = await startPendingRecon(acme.id);
    expect(startedIds).toHaveLength(2);
    expect(started.length - before).toBe(2);
    const recons = await database.query.scans.findMany({ where: (scans, { eq }) => eq(scans.orgId, acme.id) });
    expect(recons.map((s) => s.kind)).toEqual(["recon", "recon"]);
  });

  test("with a sponsor, a repo added later gets one recon, and a reinstall none twice", async () => {
    repoList.push({ id: 43, full_name: "acme/worker", private: true, default_branch: "main" });
    const added = await handleWebhook(deps(), "installation_repositories", "repos-added", {
      action: "added",
      installation: { id: 501 },
      repositories_added: [{ id: 43, full_name: "acme/worker" }],
      repositories_removed: [],
    });
    expect(added.scans).toHaveLength(1);
    const reinstalled = await handleWebhook(deps(), "installation", "install-2", { action: "created", installation: { id: 501, account: { id: 900, login: "acme", type: "Organization" } } });
    expect(reinstalled).toMatchObject({ status: "handled", scans: [] });
    const recons = await database.query.scans.findMany({ where: (scans, { and, eq }) => and(eq(scans.orgId, acme.id), eq(scans.kind, "recon")) });
    expect(recons).toHaveLength(3);
    repoList.pop();
  });

  test("a PR review starts under the org sponsor's RedNest entitlement", async () => {
    const scanId = await openPr(1);
    expect((await beginScan(scanId)).state).toBe("running");
    expect(await scanById(database, scanId)).toMatchObject({ status: "running" });
    const checkCount = checks.length;
    await beginScan(scanId);
    expect(checks.length).toBe(checkCount);
    await database.$client`update scans set credits = 3, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${scanId}`;
    await publishScan(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed" });
    expect(checks.at(-1)).toMatchObject({ conclusion: "success" });
  });

  test("a scan that fails closes its Check", async () => {
    const scanId = await openPr(2);
    await beginScan(scanId);
    await failScan(scanId, "model provider down");
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed" });
    expect(checks.at(-1)).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });
    await failScan(scanId, "again");
  });

  test("out of credits while Autumn can't be read: still 'out of credits', not 'no plan'", async () => {
    autumn.get(acme.id).credits = 0;
    autumn.failNext.add("customer");
    expect(await reserveScan("00000000-0000-4000-8000-00000000f00d", acme, 1, false)).toEqual({ ok: false, reason: "out_of_credits", credits: 1 });
    expect(autumn.failNext.size).toBe(0);
  });

  test("Dig uses RedNest entitlements, not Autumn credits", async () => {
    setHolderEligibilityProvider(() => "not_activated");
    const [fresh] = await database.insert(schema.users).values({ name: "freeuser", email: "free@example.com", login: "freeuser", githubUserId: 6201 }).returning();
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[0]!), with: { org: true } });
    // Finish any active deep so Dig can start.
    await database.$client`update scans set status = 'completed' where repo_id = ${repo!.id} and kind = 'deep' and status in ('queued', 'running', 'publishing')`;
    const first = await requestDeepScan({ ...repo!, loc: 1_000 }, "manual", { ownerUserId: fresh!.id });
    expect(first.ok).toBe(true);
    await database.$client`update scans set status = 'completed' where id = ${(first as { scanId: string }).scanId}`;
    const second = await requestDeepScan({ ...repo!, loc: 1_000 }, "manual", { ownerUserId: fresh!.id });
    expect(second).toMatchObject({ ok: false, reason: "holder_inactive" });
    setHolderEligibilityProvider(() => "eligible");
  });

  test("operator Dig does not consume a user's free entitlement", async () => {
    const [opsUser] = await database.insert(schema.users).values({ name: "ops", email: "ops@example.com", login: "ops", githubUserId: 6301 }).returning();
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[1]!), with: { org: true } });
    await database.$client`update scans set status = 'completed' where repo_id = ${repo!.id} and kind = 'deep' and status in ('queued', 'running', 'publishing')`;
    const op = await requestOperatorDeepScan({ ...repo!, loc: 50_000, lastDeepScanAt: null }, "manual");
    expect(op.ok).toBe(true);
    await database.$client`update scans set status = 'completed' where id = ${(op as { scanId: string }).scanId}`;
    const userDig = await requestDeepScan({ ...repo!, loc: 1_000 }, "manual", { ownerUserId: opsUser!.id });
    expect(userDig.ok).toBe(true);
  });

  test("two Digs at once start one deep scan", async () => {
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[0]!), with: { org: true } });
    await database.$client`update scans set status = 'completed' where repo_id = ${repo!.id} and kind = 'deep' and status in ('queued', 'running', 'publishing')`;
    started.length = 0;
    const results = await Promise.all([
      requestDeepScan({ ...repo!, loc: 50_000 }, "manual", { ownerUserId: digUserId }),
      requestDeepScan({ ...repo!, loc: 50_000 }, "manual", { ownerUserId: digUserId }),
    ]);
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const winner = (winners[0] as { scanId: string }).scanId;
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "running", scanId: winner });
    expect(started).toEqual([winner]);
  });

  test("the sweep settles what finished scans still hold", async () => {
    await database.$client`update scans set status = 'completed' where org_id = ${acme.id} and kind = 'deep' and status in ('queued', 'running', 'publishing')`;
    autumn.get(acme.id).credits = 40;
    const ids: string[] = [];
    for (const status of ["failed", "completed"] as const) {
      const [scan] = await database.insert(schema.scans).values({ repoId: repoIds[1]!, orgId: acme.id, kind: "deep", trigger: "manual", headSha: status }).returning();
      expect(await reserveScan(scan!.id, acme, 15)).toEqual({ ok: true });
      await database.$client`update scans set status = ${status}, credits = 15 where id = ${scan!.id}`;
      ids.push(scan!.id);
    }
    expect(autumn.get(acme.id).credits).toBe(10);
    const unauthorized = await sweep(new Request("https://sandchest.test/api/cron/sweep"));
    expect(unauthorized.status).toBe(401);
    const response = await sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await response.json()).toMatchObject({ settled: 2, errors: 0 });
    expect(await scanById(database, ids[0]!)).toMatchObject({ billing: "released", credits: 0 });
    expect(await scanById(database, ids[1]!)).toMatchObject({ billing: "charged", credits: 15 });
    expect(autumn.get(acme.id).credits).toBe(25);
  });

  test("the sweep restarts lost starts and fails stuck PR reviews, so no Check spins forever", async () => {
    // A scan whose workflow start was lost 10 minutes ago, and a PR review stuck for an hour with its Check in progress.
    checks.push({ repo: "acme/api", title: "Scanning…" });
    const stuckCheck = checks.length;
    const [lost] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "recon", trigger: "webhook", headSha: "lost", createdAt: new Date(Date.now() - 10 * 60_000) })
      .returning();
    const [stuck] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "pr_review", trigger: "webhook", headSha: "stuck", prNumber: 77, status: "running", checkRunId: stuckCheck, workflowRunId: "run-stuck", startedAt: new Date(Date.now() - 60 * 60_000) })
      .returning();
    started.length = 0;

    const response = await sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await response.json()).toMatchObject({ started: 1, failed: 1, errors: 0 });
    expect(started).toEqual([lost!.id]);
    expect(await scanById(database, stuck!.id)).toMatchObject({ status: "failed", error: "The scan stopped responding." });
    expect(checks[stuckCheck - 1]).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });

    // A second sweep finds nothing new to do.
    await database.$client`update scans set workflow_run_id = 'run-lost' where id = ${lost!.id}`;
    const again = await sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await again.json()).toMatchObject({ started: 0, failed: 0 });
  });

  test("a Dig race loser never touches Autumn auto top-up", async () => {
    await database.$client`update scans set status = 'completed' where repo_id = ${repoIds[1]!} and kind = 'deep'`;
    const customer = autumn.get(acme.id);
    customer.credits = 12;
    customer.autoTopUp = { enabled: true, threshold: 5, quantity: 25, perMonth: 4 };
    customer.topUpsThisMonth = 0;
    const chargesBefore = customer.charges.length;
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[1]!), with: { org: true } });
    const results = await Promise.all([
      requestDeepScan({ ...repo!, loc: 50_000 }, "manual", { ownerUserId: digUserId }),
      requestDeepScan({ ...repo!, loc: 50_000 }, "manual", { ownerUserId: digUserId }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "running" });
    // Dig no longer reserves Autumn credits, so balance and auto top-up stay untouched.
    expect(customer.credits).toBe(12);
    expect(customer.charges.slice(chargesBefore).filter((c) => c.what === "auto_top_up")).toHaveLength(0);
    customer.autoTopUp = null;
  });

  test("auto top-up buys whole packs of the plan, and follows a plan change", async () => {
    const choice = { enabled: true, quantity: 20, monthlyLimitUsd: 30 };
    await database.$client`update orgs set settings = ${JSON.stringify({ checkThreshold: "high", autoTopUp: choice })}::jsonb where id = ${acme.id}`;
    // Lockbox sells 25 credits for $10: 20 rounds up to one pack, and $30 a month is three.
    await applyAutoTopUp(acme.id, "lockbox", choice);
    expect(autumn.get(acme.id).autoTopUp).toEqual({ enabled: true, threshold: 5, quantity: 25, perMonth: 3 });

    await autumn.attach({ customerId: acme.id, planId: "standard", successUrl: "" });
    const row = await syncBilling(acme);
    expect(row.planId).toBe("standard");
    // Standard sells credits at $1: 20 for $20, so $30 a month is one top-up.
    expect(autumn.get(acme.id).autoTopUp).toEqual({ enabled: true, threshold: 5, quantity: 20, perMonth: 1 });
    expect((await orgBillingRow(database, acme.id))?.autoTopUp).toEqual({ enabled: true, threshold: 5, quantity: 20, perMonth: 1 });
  });

  test("a PR on an unsponsored account is not authorized", async () => {
    const { org } = await upsertInstallation(database, 777, { githubAccountId: 3, githubLogin: "solo", type: "User" }, [{ githubRepoId: 77, fullName: "solo/app", private: false, defaultBranch: "main" }]);
    const event = prEvent({ id: 77, full_name: "solo/app", private: false, default_branch: "main" }, 1, "solohead");
    event.installation.id = 777;
    const outcome = await handleWebhook(deps(), "pull_request", "solo-pr", event);
    // authorizePrReview fails before a scan starts, or beginScan refuses without entitlement.
    if (outcome.scans?.length) {
      expect((await beginScan(outcome.scans[0]!)).state).toBe("done");
      expect(await scanById(database, outcome.scans[0]!)).toMatchObject({ status: "refused" });
    } else {
      expect(outcome).toMatchObject({ status: "handled" });
    }
    expect(autumn.get(org.id).locks.size).toBe(0);
  });

  test("Autumn down does not block a RedNest-authorized PR begin", async () => {
    autumn.failNext.add("reserve");
    const scanId = await openPr(4);
    expect((await beginScan(scanId)).state).toBe("running");
    // beginScan no longer calls Autumn.reserve — clear the armed outage so later sweep helpers stay clean.
    autumn.failNext.clear();
  });

  test("Autumn off: sponsored PR still runs; unsponsored lifecycle stays closed", async () => {
    setAutumn(undefined);
    try {
      const scanId = await openPr(5);
      expect((await beginScan(scanId)).state).toBe("running");
      expect(await orgLifecycleAllowed(acme.id)).toBe(true);
    } finally {
      setAutumn(autumn);
    }
  });

  /** A PR review running since `minutesAgo`, holding 15 credits, with its Check in progress. */
  async function runningReview(head: string, minutesAgo: number, runId: string): Promise<{ id: string; check: number }> {
    checks.push({ repo: "acme/api", title: "Scanning…" });
    const check = checks.length;
    const [scan] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "pr_review", trigger: "webhook", headSha: head, prNumber: 90, status: "running", checkRunId: check, workflowRunId: runId, startedAt: new Date(Date.now() - minutesAgo * 60_000) })
      .returning();
    expect(await reserveScan(scan!.id, acme, 15)).toEqual({ ok: true });
    return { id: scan!.id, check };
  }
  const cron = () => sweep(new Request("https://sandchest.test/api/cron/sweep", { headers: { authorization: "Bearer cron-secret" } }));

  test("the sweep leaves a slow scan whose workflow is still running, and it is charged when it finishes", async () => {
    // Settle what earlier tests left behind, so the balance below counts only this test's scans.
    await cron();
    autumn.get(acme.id).credits = 40;
    // Past the half-hour mark (a retried execute step can take it there), but its workflow is alive.
    const slow = await runningReview("slow", 31, "run-slow");
    runs.set("run-slow", "running");
    const response = await cron();
    expect(await response.json()).toMatchObject({ failed: 0, errors: 0 });
    expect(await scanById(database, slow.id)).toMatchObject({ status: "running", billing: "reserved" });
    expect(autumn.get(acme.id).credits).toBe(25);

    // The workflow finishes: the scan is charged what it measured, once.
    await database.$client`update scans set credits = 12, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${slow.id}`;
    await publishScan(slow.id);
    expect(await scanById(database, slow.id)).toMatchObject({ status: "completed", billing: "charged", credits: 12 });
    expect(autumn.get(acme.id).credits).toBe(28);
    await publishScan(slow.id);
    await cron();
    expect(await scanById(database, slow.id)).toMatchObject({ status: "completed", billing: "charged", credits: 12 });
    expect(autumn.get(acme.id).credits).toBe(28);
    runs.delete("run-slow");
  });

  test("the sweep fails a scan whose workflow has ended, or that is running far past any budget", async () => {
    autumn.failNext.clear();
    autumn.get(acme.id).credits = 40;
    const dead = await runningReview("dead", 31, "run-dead");
    runs.set("run-dead", "failed");
    const wedged = await runningReview("wedged", 3 * 60, "run-wedged");
    runs.set("run-wedged", "running");
    expect(autumn.get(acme.id).credits).toBe(10);
    const response = await cron();
    const body = (await response.json()) as { failed: number; errors: number };
    expect(body.errors).toBe(0);
    expect(body.failed).toBeGreaterThanOrEqual(2);
    for (const scan of [dead, wedged]) {
      expect(await scanById(database, scan.id)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
      expect(checks[scan.check - 1]).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });
    }
    expect(autumn.get(acme.id).credits).toBe(40);

    // The wedged workflow turns up after all: the scan stays failed and released, with the Check that says so.
    await database.$client`update scans set credits = 12, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${wedged.id}`;
    await publishScan(wedged.id);
    expect(await scanById(database, wedged.id)).toMatchObject({ status: "failed", billing: "released" });
    expect(checks[wedged.check - 1]).toMatchObject({ conclusion: "neutral", title: "Review could not finish" });
    expect(autumn.get(acme.id).credits).toBe(40);
    runs.delete("run-dead");
    runs.delete("run-wedged");
  });

  test("the sweep gives up on a start that never got its workflow, freeing the repo for Dig", async () => {
    await database.$client`update scans set status = 'completed' where repo_id = ${repoIds[0]!} and kind = 'deep' and status in ('queued', 'running', 'publishing')`;
    await cron();
    autumn.get(acme.id).credits = 40;
    const [scan] = await database
      .insert(schema.scans)
      .values({ repoId: repoIds[0]!, orgId: acme.id, kind: "deep", trigger: "manual", headSha: "wedged", createdAt: new Date(Date.now() - 40 * 60_000) })
      .returning();
    expect(await reserveScan(scan!.id, acme, 15)).toEqual({ ok: true });
    await database.$client`update scans set workflow_run_id = ${"starting:lost"} where id = ${scan!.id}`;
    const repo = await database.query.repos.findFirst({ where: (repos, { eq }) => eq(repos.id, repoIds[0]!), with: { org: true } });
    expect(await requestDeepScan({ ...repo!, loc: 50_000 }, "manual", { ownerUserId: digUserId })).toMatchObject({ ok: false, reason: "running", scanId: scan!.id });

    const response = await cron();
    expect(await response.json()).toMatchObject({ errors: 0 });
    expect(await scanById(database, scan!.id)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(autumn.get(acme.id).credits).toBe(40);
    const again = await requestDeepScan({ ...repo!, loc: 50_000 }, "manual", { ownerUserId: digUserId });
    expect(again.ok).toBe(true);
  });
});
