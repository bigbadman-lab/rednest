"use server";

import { ensureUserEntitlement, getUserEntitlement } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { viewer } from "./access";
import { track } from "./analytics";
import { db } from "./db";
import { describeError } from "./log";
import { captureException } from "./sentry";

export type QuickScanFormState = {
  error?: string;
  url?: string;
};

export async function quickScanAllowance(userId: string): Promise<{ freeAvailable: boolean; status: string }> {
  await ensureUserEntitlement(db(), userId);
  const row = await getUserEntitlement(db(), userId);
  return { freeAvailable: row?.freeScanStatus === "available", status: row?.freeScanStatus ?? "available" };
}

export async function submitQuickScan(_prev: QuickScanFormState, formData: FormData): Promise<QuickScanFormState> {
  const user = await viewer();
  const url = String(formData.get("url") ?? "").trim();
  if (!url) return { error: "Paste a public GitHub repository URL.", url };

  const { requestQuickScan } = await import("./quick-scan");
  let result: Awaited<ReturnType<typeof requestQuickScan>>;
  try {
    result = await requestQuickScan(url, user.id);
  } catch (error) {
    console.error(`Quick Scan failed: ${describeError(error)}`);
    await captureException(error, { source: "quick_scan", handled: true });
    await track("deep_scan_requested", { userId: user.id, props: { outcome: "error", scan_again: false, repo_id: null, scan_id: null, credits: null } });
    return { error: "The Quick Scan couldn’t start. Nothing was charged; try again in a minute.", url };
  }

  if (!result.ok) {
    await track("deep_scan_requested", {
      userId: user.id,
      props: { outcome: result.reason, scan_again: false, repo_id: null, scan_id: result.scanId ?? null, credits: null },
    });
    revalidatePath("/dashboard/scans");
    if (result.reason === "running" && result.scanId) redirect(`/dashboard/scans/${result.scanId}`);
    return { error: messageFor(result.reason, result.message), url };
  }

  await track("deep_scan_requested", {
    userId: user.id,
    props: { outcome: "ok", scan_again: false, repo_id: null, scan_id: result.scanId, credits: null },
  });
  redirect(`/dashboard/scans/${result.scanId}`);
}

function messageFor(reason: string, detail?: string): string {
  switch (reason) {
    case "invalid_url":
    case "invalid_path":
      return "Enter a URL like https://github.com/owner/repository.";
    case "unsupported_host":
      return "Only public repositories on github.com are supported.";
    case "not_found":
      return detail ?? "Repository not found or not accessible.";
    case "private_repo":
      return "Only public repositories can be Quick Scanned. Install the GitHub App for private repos.";
    case "too_large":
      return detail ?? "This repository is too large for a Quick Scan.";
    case "unavailable":
      return detail ?? "This repository can’t be scanned right now.";
    case "holder_inactive":
      return "Your free scan is used. Additional scans will require an eligible wallet holding 50,000 $RED once holder access launches.";
    case "wallet_required":
      return "Connect a verified wallet holding at least 50,000 $RED to keep scanning.";
    case "insufficient_red":
      return "This wallet needs at least 50,000 $RED for more scans this month.";
    case "quota_exhausted":
      return "You have used all 50 holder scans for this UTC month.";
    case "free_used":
      return "Your free lifetime scan has already been used.";
    case "auth_required":
      return "Sign in with GitHub to Quick Scan.";
    case "running":
      return "A Quick Scan of this repository is already running.";
    default:
      return detail ?? "This Quick Scan was not authorized.";
  }
}
