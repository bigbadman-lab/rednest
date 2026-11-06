"use server";
/**
 * The Dig button's action, in its own module so pages that only show
 * findings or settings never trace the workflow runtime it needs.
 */
import { repoForUser } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewer } from "./access";
import { track } from "./analytics";
import { db } from "./db";
import { describeError } from "./log";
import { captureException } from "./sentry";

export type DigOutcome = { error?: string; topUp?: boolean };

export async function dig(repoId: string): Promise<DigOutcome> {
  const user = await viewer();
  const row = z.uuid().safeParse(repoId).success ? await repoForUser(db(), user.id, repoId) : undefined;
  if (!row) {
    await track("deep_scan_requested", { userId: user.id, props: { outcome: "no_access" } });
    return { error: "You don’t have access to this repository." };
  }
  const record = (outcome: string, extra: { credits?: number; scanId?: string } = {}) =>
    track("deep_scan_requested", {
      userId: user.id,
      orgId: row.org.id,
      props: { repo_id: row.repo.id, scan_again: !!row.repo.lastDeepScanAt, outcome, credits: extra.credits ?? null, scan_id: extra.scanId ?? null },
    });
  // Loaded on demand: the workflow runtime stays out of every page that merely shows a Dig button.
  const { requestDeepScan } = await import("./dig");
  let result: Awaited<ReturnType<typeof requestDeepScan>>;
  try {
    result = await requestDeepScan({ ...row.repo, org: row.org }, "manual", { ownerUserId: user.id });
  } catch (error) {
    // GitHub or entitlement service unreachable. Unused reservations are released with the scan row.
    console.error(`Dig failed: ${describeError(error)}`);
    await captureException(error, { source: "dig", handled: true });
    await record("error");
    return { error: "The deep scan couldn’t start. Nothing was charged; try again in a minute." };
  }
  if (!result.ok) {
    await record(result.reason, { credits: result.credits, scanId: result.scanId });
    revalidatePath("/dashboard");
    const messages: Record<string, string> = {
      not_installed: "RedNest is no longer installed on this repository.",
      running: "A deep scan is already running.",
      too_large: "This repository is over a million lines. Get in touch to scan it.",
      no_plan: `${row.org.githubLogin} needs a plan before RedNest can scan.`,
      out_of_credits: result.credits ? `Out of credits: this deep scan needs ${result.credits}.` : `${row.org.githubLogin} is out of credits. Top up to keep scanning.`,
      holder_inactive: "Your free scan is used. $NEST holder access is not available yet.",
      wallet_required: "Connect a verified wallet holding at least 50,000 $NEST to keep scanning.",
      insufficient_red: "This wallet needs at least 50,000 $NEST for more scans this month.",
      quota_exhausted: "You have used all 50 holder scans for this UTC month.",
      free_used: "Your free lifetime scan has already been used.",
      auth_required: "Sign in with GitHub to scan.",
      no_sponsor: `${row.org.githubLogin} has no scan sponsor yet. An admin must accept sponsorship in Settings before the first dig can run.`,
    };
    return { error: messages[result.reason] ?? "This scan was not authorized.", topUp: false };
  }
  await record("ok", { scanId: result.scanId });
  redirect(`/dashboard/scans/${result.scanId}`);
}
