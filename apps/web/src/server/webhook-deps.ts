/**
 * Shared GitHub webhook / install deps wired to RedNest entitlements.
 * Hosted scan access is never "unlimited because Autumn is off".
 */
import { authorizeChargeableScan, EntitlementError, orgLifecycleAllowed, releaseUnusedScanEntitlement, requireOrgSponsorUserId } from "./entitlements";
import { db } from "./db";
import { githubApp } from "./services";
import { startScan } from "./start";
import type { WebhookDeps } from "./webhooks";

export function rednestWebhookDeps(): WebhookDeps {
  return {
    db: db(),
    github: githubApp(),
    startScan,
    canScan: async (org) => orgLifecycleAllowed(org.id),
    authorizePrReview: async ({ scanId, orgId }) => {
      try {
        const sponsorUserId = await requireOrgSponsorUserId(orgId);
        await authorizeChargeableScan({ scanId, ownerUserId: sponsorUserId });
        return { ok: true };
      } catch (error) {
        await releaseUnusedScanEntitlement(scanId).catch(() => {});
        const detail = error instanceof EntitlementError ? error.message : "PR review was not authorized.";
        return { ok: false, detail };
      }
    },
  };
}
