/**
 * RedNest hosted scan authorization. Sole authority for chargeable scans.
 * Holder eligibility is fail-closed until RED-04D activates a verified mint.
 */
import {
  acceptOrgSponsorship,
  authorizeOperatorScan as recordOperatorScanAuthorization,
  consumeScanEntitlement,
  getOrgSponsor,
  getScanEntitlement,
  isOperatorAuthorizedScan,
  orgHasAcceptedSponsor,
  pendingRecon,
  releaseScanEntitlement,
  reserveScanEntitlement,
  type ReserveOutcome,
} from "@sandchest/db";
import { db } from "./db";

export type EntitlementErrorCode =
  | "auth_required"
  | "access_denied"
  | "no_sponsor"
  | "free_used"
  | "wallet_required"
  | "insufficient_red"
  | "quota_exhausted"
  | "holder_inactive"
  | "unavailable"
  | "conflict";

export class EntitlementError extends Error {
  readonly code: EntitlementErrorCode;
  constructor(code: EntitlementErrorCode, message: string) {
    super(message);
    this.name = "EntitlementError";
    this.code = code;
  }
}

/** Holder check for $RED. Production is always inactive until RED-04D. */
export type HolderStatus = "eligible" | "no_wallet" | "insufficient_balance" | "not_activated" | "unavailable";

export type HolderEligibilityProvider = (userId: string) => Promise<HolderStatus> | HolderStatus;

let holderProvider: HolderEligibilityProvider = () => "not_activated";

/** Tests only: inject a holder eligibility provider. Never enable mocks in production. */
export function setHolderEligibilityProvider(provider: HolderEligibilityProvider | undefined): void {
  holderProvider = provider ?? (() => "not_activated");
}

export async function checkHolderEligibility(userId: string): Promise<HolderStatus> {
  try {
    return await holderProvider(userId);
  } catch {
    return "unavailable";
  }
}

function mapReserveFailure(reason: Extract<ReserveOutcome, { ok: false }>["reason"], holder: HolderStatus): EntitlementError {
  switch (reason) {
    case "user_not_found":
      return new EntitlementError("auth_required", "Sign in with GitHub to scan.");
    case "free_used":
    case "holder_required":
      if (holder === "not_activated" || holder === "unavailable") {
        return new EntitlementError("holder_inactive", "Your free scan is used. $RED holder access is not available yet.");
      }
      if (holder === "no_wallet") return new EntitlementError("wallet_required", "Connect and verify a Solana wallet that holds at least 50,000 $RED.");
      if (holder === "insufficient_balance") return new EntitlementError("insufficient_red", "This wallet needs at least 50,000 $RED for more scans this month.");
      return new EntitlementError("free_used", "Your free lifetime scan has already been used.");
    case "quota_exhausted":
      return new EntitlementError("quota_exhausted", "You have used all 50 holder scans for this UTC month.");
    default:
      return new EntitlementError("conflict", "Could not reserve a scan entitlement. Try again.");
  }
}

/**
 * Reserves one chargeable scan for the entitlement owner. Idempotent per scan id.
 * Does not require an organization id (Quick Scan compatible).
 */
export async function authorizeChargeableScan(input: { scanId: string; ownerUserId: string }): Promise<{ source: "free" | "monthly" }> {
  const holder = await checkHolderEligibility(input.ownerUserId);
  const eligible = holder === "eligible";
  const result = await reserveScanEntitlement(db(), { scanId: input.scanId, ownerUserId: input.ownerUserId, holderEligible: eligible });
  if (!result.ok) throw mapReserveFailure(result.reason, holder);
  return { source: result.source };
}

/** Call once the scan has meaningfully started (running). Idempotent. Operator scans have no user quota. */
export async function markScanEntitlementStarted(scanId: string): Promise<void> {
  const row = await getScanEntitlement(db(), scanId);
  if (!row) return;
  await consumeScanEntitlement(db(), scanId);
}

/**
 * Release only if still reserved (never started). Safe on retries.
 * Do not call after a successful start — failures after start stay consumed.
 */
export async function releaseUnusedScanEntitlement(scanId: string): Promise<void> {
  const row = await getScanEntitlement(db(), scanId);
  if (!row || row.state !== "reserved") return;
  await releaseScanEntitlement(db(), scanId);
}

/** Whether beginScan may run this chargeable scan: user entitlement or operator authorization. */
export async function scanMayStart(scanId: string): Promise<boolean> {
  if (await isOperatorAuthorizedScan(db(), scanId)) return true;
  const entitlement = await getScanEntitlement(db(), scanId);
  return !!entitlement && entitlement.state !== "released";
}

/**
 * Persists operator authorization for a scan id. Only call after the admin-token
 * boundary has authenticated the request. Idempotent; does not touch user quotas.
 */
export async function authorizeOperatorScan(scanId: string): Promise<void> {
  await recordOperatorScanAuthorization(db(), scanId);
}

export async function requireOrgSponsorUserId(orgId: string): Promise<string> {
  const sponsor = await getOrgSponsor(db(), orgId);
  if (!sponsor) {
    throw new EntitlementError(
      "no_sponsor",
      "This GitHub account has no scan sponsor yet. An admin must accept scan sponsorship in Settings.",
    );
  }
  return sponsor.sponsorUserId;
}

export async function orgLifecycleAllowed(orgId: string): Promise<boolean> {
  return orgHasAcceptedSponsor(db(), orgId);
}

/**
 * True when a manual deep scan would be stuck waiting for recon that cannot start
 * (no accepted org sponsor). Call before reserving the user's allowance.
 */
export async function manualDeepBlockedByUnsponsoredRecon(repoId: string, orgId: string): Promise<boolean> {
  if (!(await pendingRecon(db(), repoId))) return false;
  return !(await orgHasAcceptedSponsor(db(), orgId));
}

/**
 * Explicit self-accept of sponsorship for an org the caller administers.
 * Returns whether a sponsor row exists for this user afterward.
 */
export async function acceptSponsorshipAsAdmin(
  orgId: string,
  userId: string,
): Promise<{ ok: true; created: boolean } | { ok: false; reason: "exists" | "mismatch" }> {
  return acceptOrgSponsorship(db(), { orgId, sponsorUserId: userId, assignedByUserId: userId });
}

export { getScanEntitlement, getOrgSponsor, isOperatorAuthorizedScan };
