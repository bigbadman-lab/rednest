/** Manual deep scans ("Dig"): one at a time per repo, authorized by RedNest entitlements. */
import { randomUUID } from "node:crypto";
import { activeDeepScan, createScan, deleteUnstartedScan, pendingRecon, type Org, type Repo } from "@sandchest/db";
import { digState } from "@/lib/dig-state";
import {
  authorizeChargeableScan,
  authorizeOperatorScan,
  EntitlementError,
  manualDeepBlockedByUnsponsoredRecon,
  releaseUnusedScanEntitlement,
} from "./entitlements";
import { describeError } from "./log";
import { db, githubApp } from "./services";
import { startScan } from "./start";

export type DigResult =
  | { ok: true; scanId: string }
  | {
      ok: false;
      reason:
        | "not_installed"
        | "running"
        | "too_large"
        | "no_plan"
        | "out_of_credits"
        | "holder_inactive"
        | "wallet_required"
        | "insufficient_red"
        | "quota_exhausted"
        | "free_used"
        | "auth_required"
        | "no_sponsor";
      scanId?: string;
      credits?: number;
    };

/**
 * Starts a deep scan for a signed-in user. Reserves RedNest entitlements before
 * the workflow starts. Does not accept an operator exemption — use
 * {@link requestOperatorDeepScan} after the admin-token check.
 */
export async function requestDeepScan(
  repo: Repo & { org: Org },
  trigger: "manual" = "manual",
  options: { ownerUserId: string },
): Promise<DigResult> {
  if (!repo.enabled || !repo.org.installationId) return { ok: false, reason: "not_installed" };
  const active = await activeDeepScan(db(), repo.id);
  const state = digState({ loc: repo.loc, activeDeepScanId: active?.id ?? null });
  if (state.state === "running") return { ok: false, reason: "running", scanId: state.scanId };
  if (state.state === "too_large") return { ok: false, reason: "too_large" };

  // Before reserving quota: pending recon cannot start without a sponsor.
  if (await manualDeepBlockedByUnsponsoredRecon(repo.id, repo.orgId)) {
    return { ok: false, reason: "no_sponsor" };
  }

  const headSha = await githubApp().installation(repo.org.installationId).branchSha(repo.fullName, repo.defaultBranch);

  const { scan, created } = await createScan(db(), { id: randomUUID(), repoId: repo.id, orgId: repo.orgId, kind: "deep", trigger, headSha });
  if (!created) return { ok: false, reason: "running", scanId: scan.id };

  try {
    await authorizeChargeableScan({ scanId: scan.id, ownerUserId: options.ownerUserId });
  } catch (error) {
    await releaseUnusedScanEntitlement(scan.id).catch(() => {});
    await deleteUnstartedScan(db(), scan.id);
    if (error instanceof EntitlementError) {
      return { ok: false, reason: mapEntitlementReason(error.code) };
    }
    throw error;
  }

  await startScan(scan.id).catch((error: unknown) => console.error(`Starting deep scan ${scan.id} failed: ${describeError(error)}`));
  return { ok: true, scanId: scan.id };
}

/**
 * Operator Dig after `isOperator(request)`. Exempt from user free/monthly quotas.
 * Persists a server-controlled operator authorization row (survives workflow retries).
 * If the repo has pending recon, authorizes and starts that single recon so the deep
 * scan is not stuck waiting for an unsponsored lifecycle path.
 */
export async function requestOperatorDeepScan(repo: Repo & { org: Org }, trigger: "manual" = "manual"): Promise<DigResult> {
  if (!repo.enabled || !repo.org.installationId) return { ok: false, reason: "not_installed" };
  const active = await activeDeepScan(db(), repo.id);
  const state = digState({ loc: repo.loc, activeDeepScanId: active?.id ?? null });
  if (state.state === "running") return { ok: false, reason: "running", scanId: state.scanId };
  if (state.state === "too_large") return { ok: false, reason: "too_large" };

  const headSha = await githubApp().installation(repo.org.installationId).branchSha(repo.fullName, repo.defaultBranch);

  const { scan, created } = await createScan(db(), { id: randomUUID(), repoId: repo.id, orgId: repo.orgId, kind: "deep", trigger, headSha });
  if (!created) return { ok: false, reason: "running", scanId: scan.id };

  try {
    await authorizeOperatorScan(scan.id);
    const reconId = await pendingRecon(db(), repo.id);
    if (reconId) {
      await authorizeOperatorScan(reconId);
      await startScan(reconId).catch((error: unknown) => console.error(`Starting operator recon ${reconId} failed: ${describeError(error)}`));
    }
  } catch (error) {
    await deleteUnstartedScan(db(), scan.id);
    throw error;
  }

  await startScan(scan.id).catch((error: unknown) => console.error(`Starting deep scan ${scan.id} failed: ${describeError(error)}`));
  return { ok: true, scanId: scan.id };
}

function mapEntitlementReason(code: EntitlementError["code"]): Exclude<DigResult & { ok: false }, { ok: true }>["reason"] {
  switch (code) {
    case "holder_inactive":
      return "holder_inactive";
    case "wallet_required":
      return "wallet_required";
    case "insufficient_red":
      return "insufficient_red";
    case "quota_exhausted":
      return "quota_exhausted";
    case "free_used":
      return "free_used";
    case "auth_required":
      return "auth_required";
    case "no_sponsor":
      return "no_sponsor";
    default:
      return "holder_inactive";
  }
}
