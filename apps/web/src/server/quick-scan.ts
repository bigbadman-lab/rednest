/**
 * Public GitHub URL Quick Scan: validate → resolve public metadata → reserve
 * entitlement → start the existing deep-scan workflow with a tokenless clone.
 */
import { randomUUID } from "node:crypto";
import {
  activeDeepScan,
  createScan,
  deleteUnstartedScan,
  ensureQuickScanRepo,
  ensureQuickScanVaultOrg,
  insertQuickScan,
  userById,
} from "@sandchest/db";
import { GitHubError } from "@sandchest/github";
import { digState } from "@/lib/dig-state";
import { parsePublicGithubRepoUrl, publicGithubCloneUrl } from "@/lib/github-repo-url";
import { authorizeChargeableScan, EntitlementError, releaseUnusedScanEntitlement } from "./entitlements";
import { describeError } from "./log";
import { db, githubApp } from "./services";
import { startScan } from "./start";

/** GitHub `size` is KB; refuse before clone when clearly beyond deep-scan budgets. */
export const QUICK_SCAN_MAX_SIZE_KB = 500_000;

export type QuickScanResult =
  | { ok: true; scanId: string }
  | {
      ok: false;
      reason:
        | "invalid_url"
        | "unsupported_host"
        | "invalid_path"
        | "not_found"
        | "private_repo"
        | "unavailable"
        | "too_large"
        | "running"
        | "auth_required"
        | "holder_inactive"
        | "wallet_required"
        | "insufficient_red"
        | "quota_exhausted"
        | "free_used"
        | "error";
      scanId?: string;
      message?: string;
    };

export type PublicRepoMeta = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  sizeKb: number;
  archived: boolean;
  disabled: boolean;
  commitSha: string;
  owner: string;
  repo: string;
  canonicalUrl: string;
};

/** Validate URL and resolve public metadata + pinned SHA. Does not touch entitlements. */
export async function resolvePublicGithubRepo(rawUrl: string): Promise<{ ok: true; meta: PublicRepoMeta } | { ok: false; reason: QuickScanResult & { ok: false } extends never ? never : Extract<QuickScanResult, { ok: false }>["reason"]; message?: string }> {
  const parsed = parsePublicGithubRepoUrl(rawUrl);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  try {
    const repo = await githubApp().publicRepository(parsed.owner, parsed.repo);
    if (repo.private) return { ok: false, reason: "private_repo", message: "Only public repositories can be Quick Scanned." };
    if (repo.archived || repo.disabled) return { ok: false, reason: "unavailable", message: "This repository is archived or disabled." };
    if (!Number.isFinite(repo.size) || repo.size > QUICK_SCAN_MAX_SIZE_KB) {
      return { ok: false, reason: "too_large", message: "This repository is too large for a Quick Scan." };
    }
    const [ownerLogin, repoName] = repo.full_name.split("/");
    if (!ownerLogin || !repoName) return { ok: false, reason: "not_found" };
    // Identity must match the validated URL (case-insensitive owner/repo).
    if (ownerLogin.toLowerCase() !== parsed.owner.toLowerCase() || repoName.toLowerCase() !== parsed.repo.toLowerCase()) {
      return { ok: false, reason: "not_found" };
    }
    const commitSha = await githubApp().publicBranchSha(ownerLogin, repoName, repo.default_branch);
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) return { ok: false, reason: "unavailable", message: "Could not resolve a commit for the default branch." };

    // Ensure clone URL builders accept the canonical identity.
    publicGithubCloneUrl(ownerLogin, repoName);

    return {
      ok: true,
      meta: {
        id: repo.id,
        fullName: `${ownerLogin}/${repoName}`,
        private: false,
        defaultBranch: repo.default_branch,
        sizeKb: repo.size,
        archived: repo.archived,
        disabled: repo.disabled,
        commitSha,
        owner: ownerLogin,
        repo: repoName,
        canonicalUrl: parsed.canonicalUrl.replace(/github\.com\/[^/]+\/[^/]+$/i, `github.com/${ownerLogin}/${repoName}`),
      },
    };
  } catch (error) {
    const correlationId = randomUUID();
    const mapped = mapGithubMetadataError(error);
    logQuickScanGithubFailure({
      operation: "resolve_public_repo",
      correlationId,
      target: `${parsed.owner}/${parsed.repo}`,
      status: error instanceof GitHubError ? error.status : null,
      classification: mapped.classification,
    });
    return { ok: false, reason: mapped.reason, message: mapped.message };
  }
}

type GithubMetadataClass = "not_found" | "forbidden" | "unauthorized" | "rate_limited" | "network" | "upstream";

function mapGithubMetadataError(error: unknown): {
  reason: Extract<QuickScanResult, { ok: false }>["reason"];
  message: string;
  classification: GithubMetadataClass;
} {
  if (!(error instanceof GitHubError)) {
    return { reason: "error", message: "Could not read this repository from GitHub.", classification: "network" };
  }
  if (error.status === 404) {
    return { reason: "not_found", message: "Repository not found or not accessible.", classification: "not_found" };
  }
  if (error.status === 429 || (error.status === 403 && /rate limit/i.test(error.message))) {
    return { reason: "unavailable", message: "GitHub rate limit reached. Try again in a few minutes.", classification: "rate_limited" };
  }
  if (error.status === 401) {
    return { reason: "unavailable", message: "GitHub rejected the metadata request. Try again shortly.", classification: "unauthorized" };
  }
  if (error.status === 403) {
    return { reason: "unavailable", message: "GitHub refused access to this repository.", classification: "forbidden" };
  }
  if (error.status === 0) {
    return { reason: "error", message: "Could not reach GitHub. Try again in a minute.", classification: "network" };
  }
  return { reason: "error", message: "Could not read this repository from GitHub.", classification: "upstream" };
}

/** Safe structured log for Quick Scan GitHub failures — never tokens or headers. */
function logQuickScanGithubFailure(fields: {
  operation: string;
  correlationId: string;
  target: string;
  status: number | null;
  classification: GithubMetadataClass;
}): void {
  console.error(
    JSON.stringify({
      source: "quick_scan",
      event: "github_metadata_failed",
      operation: fields.operation,
      correlationId: fields.correlationId,
      target: fields.target,
      httpStatus: fields.status,
      classification: fields.classification,
    }),
  );
}

/**
 * Starts a Quick Scan for the signed-in user. Validation failures never
 * reserve entitlement. Retries against an active deep scan on the same
 * target repo return `running` with the existing scan id (no double charge).
 */
export async function requestQuickScan(rawUrl: string, ownerUserId: string): Promise<QuickScanResult> {
  const user = await userById(db(), ownerUserId);
  if (!user?.githubUserId) return { ok: false, reason: "auth_required", message: "Sign in with GitHub to Quick Scan." };

  const resolved = await resolvePublicGithubRepo(rawUrl);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, message: resolved.message };

  const { meta } = resolved;
  const org = await ensureQuickScanVaultOrg(db(), ownerUserId);
  const repo = await ensureQuickScanRepo(db(), {
    orgId: org.id,
    ownerUserId,
    fullName: meta.fullName,
    private: false,
    defaultBranch: meta.defaultBranch,
  });

  const active = await activeDeepScan(db(), repo.id);
  const state = digState({ loc: repo.loc, activeDeepScanId: active?.id ?? null });
  if (state.state === "running") return { ok: false, reason: "running", scanId: state.scanId };
  if (state.state === "too_large") return { ok: false, reason: "too_large" };

  const { scan, created } = await createScan(db(), {
    id: randomUUID(),
    repoId: repo.id,
    orgId: org.id,
    kind: "deep",
    trigger: "manual",
    headSha: meta.commitSha,
  });
  if (!created) return { ok: false, reason: "running", scanId: scan.id };

  try {
    await authorizeChargeableScan({ scanId: scan.id, ownerUserId });
  } catch (error) {
    await releaseUnusedScanEntitlement(scan.id).catch(() => {});
    await deleteUnstartedScan(db(), scan.id);
    if (error instanceof EntitlementError) {
      return { ok: false, reason: mapEntitlement(error.code), message: error.message };
    }
    throw error;
  }

  await insertQuickScan(db(), {
    scanId: scan.id,
    ownerUserId,
    repoId: repo.id,
    githubOwner: meta.owner,
    githubRepo: meta.repo,
    githubRepoId: meta.id,
    commitSha: meta.commitSha,
    canonicalUrl: meta.canonicalUrl,
  });

  await startScan(scan.id).catch((error: unknown) => console.error(`Starting Quick Scan ${scan.id} failed: ${describeError(error)}`));
  return { ok: true, scanId: scan.id };
}

function mapEntitlement(code: EntitlementError["code"]): Extract<QuickScanResult, { ok: false }>["reason"] {
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
    default:
      return "holder_inactive";
  }
}
