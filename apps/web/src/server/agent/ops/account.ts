/** Who the agent is acting as, what's left to set up, and the person's API keys. */
import {
  dashboardRepos,
  ensureUserEntitlement,
  getActiveWallet,
  getUserEntitlement,
  getUserScanMonth,
  MONTHLY_SCAN_ALLOWANCE,
  revokeUserToken,
  userAgentAccess,
} from "@sandchest/db";
import { z } from "zod";
import { FREE_CREDITS } from "@sandchest/billing/plans";
import { track } from "../../analytics";
import { billingEnabled } from "../../billing";
import { db } from "../../db";
import { checkHolderEligibility } from "../../entitlements";
import { readHolderLaunchConfig } from "../../holder-eligibility";
import { ApiError } from "../errors";
import { operation, type Context } from "../operation";
import { visibleAccounts } from "../resolve";
import { cleanName, issueKey } from "../tokens";
import { accountView, installUrl, iso } from "../views";

type Step = { step: string; account?: string; repo?: string; do: string; url?: string | null };

/**
 * Legacy Autumn credits next_steps (claim_free_credits / buy_credits). Off by
 * default for RedNest hosted entitlements; only enable for a separately
 * supported credits deployment.
 */
export function legacyCreditsNextStepsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SANDCHEST_LEGACY_CREDITS_NEXT_STEPS?.trim().toLowerCase() === "true";
}

/**
 * What the person still has to do, in order, as the agent should relay it.
 * Steps only a person can take (installing on GitHub, verifying a wallet)
 * carry the URL to give them.
 */
async function nextSteps(context: Context): Promise<{
  steps: Step[];
  accounts: Awaited<ReturnType<typeof visibleAccounts>>;
  access: AccessSnapshot;
}> {
  const [accounts, repos] = await Promise.all([visibleAccounts(context), dashboardRepos(db(), context.principal.userId)]);
  const access = await accessSnapshot(context.principal.userId);
  const steps: Step[] = [];
  if (accounts.length === 0) {
    steps.push({
      step: "install_github_app",
      do: "Ask the person to open this URL, pick their GitHub account and the repositories RedNest may read. Then call list_accounts with wait=50: it returns as soon as the account shows.",
      url: installUrl(),
    });
    return { steps, accounts, access };
  }

  if (legacyCreditsNextStepsEnabled() && billingEnabled()) {
    await appendLegacyCreditSteps(context, accounts, steps);
    const unscanned = repos.filter((repo) => repo.billing?.planId && !repo.lastDeepScanAt && !repo.activeDeepScanId && (repo.billing.credits > 0 || repo.freeDig));
    appendUnscannedDeepScan(unscanned, steps, true);
  } else {
    const unscanned = repos.filter((repo) => !repo.lastDeepScanAt && !repo.activeDeepScanId);
    if (access.free_scan === "available") {
      if (unscanned.length > 0) {
        appendUnscannedDeepScan(unscanned, steps, false, " This GitHub account still has its one lifetime free chargeable scan—no payment required.");
      } else {
        steps.push({
          step: "lifetime_free_scan_available",
          do: "This GitHub account still has its one lifetime free chargeable scan. When the person picks a repository, call start_deep_scan; no payment or credits are required for that free scan.",
        });
      }
    } else {
      appendRedNestAccessSteps(access, context.appUrl, steps);
      if (access.canStartChargeableScan) appendUnscannedDeepScan(unscanned, steps, false);
    }
  }

  const open = repos.reduce((sum, repo) => sum + repo.open.critical + repo.open.high, 0);
  if (open > 0) steps.push({ step: "fix_findings", do: `${open} open critical or high findings. Call list_findings, then get_finding for the attack path and fix prompt.` });
  return { steps, accounts, access };
}

type AccessSnapshot = {
  free_scan: "available" | "reserved" | "consumed";
  wallet_connected: boolean;
  wallet_pubkey: string | null;
  holder_status: Awaited<ReturnType<typeof checkHolderEligibility>>;
  holder_access_active: boolean;
  monthly_allowance: number;
  monthly_used: number;
  monthly_remaining: number | null;
  canStartChargeableScan: boolean;
};

async function accessSnapshot(userId: string): Promise<AccessSnapshot> {
  await ensureUserEntitlement(db(), userId);
  const [entitlement, wallet, holder, month] = await Promise.all([
    getUserEntitlement(db(), userId),
    getActiveWallet(db(), userId),
    checkHolderEligibility(userId),
    getUserScanMonth(db(), userId),
  ]);
  const launch = readHolderLaunchConfig();
  const holderAccessActive = launch.enabled && !!launch.mint && !!launch.rpcUrl;
  const freeScan = entitlement?.freeScanStatus ?? "available";
  const monthlyUsed = month ? month.reserved + month.consumed : 0;
  const monthlyAllowance = month?.allowance ?? MONTHLY_SCAN_ALLOWANCE;
  const monthlyRemaining = holder === "eligible" ? Math.max(0, monthlyAllowance - monthlyUsed) : null;
  const canStartChargeableScan =
    freeScan === "available" || (holder === "eligible" && (monthlyRemaining === null || monthlyRemaining > 0));
  return {
    free_scan: freeScan,
    wallet_connected: !!wallet,
    wallet_pubkey: wallet?.walletPubkey ?? null,
    holder_status: holder,
    holder_access_active: holderAccessActive,
    monthly_allowance: monthlyAllowance,
    monthly_used: monthlyUsed,
    monthly_remaining: monthlyRemaining,
    canStartChargeableScan,
  };
}

function appendRedNestAccessSteps(access: AccessSnapshot, appUrl: string, steps: Step[]): void {
  const walletUrl = `${appUrl}/dashboard/settings#wallet`;
  const pricingUrl = `${appUrl}/docs/pricing`;

  if (access.free_scan === "reserved") {
    steps.push({
      step: "lifetime_free_scan_reserved",
      do: "The lifetime free scan is reserved for a scan that has not finished starting. Call get_scan / list_scans; do not start another chargeable scan until that settles.",
    });
    return;
  }

  // Free scan consumed.
  if (!access.holder_access_active || access.holder_status === "not_activated" || access.holder_status === "unavailable") {
    steps.push({
      step: "holder_access_inactive",
      do: "The lifetime free scan is used. $RED holder scanning is not active yet, so further chargeable scans are not available. Do not ask for payment or credits. Optional: the person can verify a Solana wallet in Settings ahead of launch.",
      url: walletUrl,
    });
    return;
  }

  if (access.holder_status === "no_wallet") {
    steps.push({
      step: "connect_wallet",
      do: "The lifetime free scan is used. Ask the person to connect and verify a Solana wallet holding at least 50,000 $RED under Settings, then call get_me again.",
      url: walletUrl,
    });
    return;
  }

  if (access.holder_status === "insufficient_balance") {
    steps.push({
      step: "insufficient_red",
      do: "A verified wallet is connected but needs at least 50,000 $RED for more scans this month. Tell the person; do not start chargeable scans until get_me shows holder eligibility.",
      url: pricingUrl,
    });
    return;
  }

  if (access.holder_status === "eligible" && access.monthly_remaining === 0) {
    steps.push({
      step: "monthly_quota_exhausted",
      do: `Holder access is active, but all ${access.monthly_allowance} holder scans for this UTC month are used. Wait for next month's reset; do not invent additional allowance.`,
      url: pricingUrl,
    });
  }
}

function appendUnscannedDeepScan(
  unscanned: Array<{ fullName: string; freeDig?: boolean }>,
  steps: Step[],
  legacyFreeNote: boolean,
  freeNote = "",
): void {
  if (unscanned.length === 0) return;
  const names = unscanned.slice(0, 3).map((repo) => repo.fullName);
  const more = unscanned.length > names.length ? ` and ${unscanned.length - names.length} more` : "";
  const free =
    freeNote || (legacyFreeNote && unscanned.some((repo) => repo.freeDig) ? " An account's first deep scan is free." : "");
  steps.push({
    step: "start_deep_scan",
    repo: names[0],
    do: `Never deep scanned: ${names.join(", ")}${more}. Call start_deep_scan for the ones the person cares about most.${free}`,
  });
}

async function appendLegacyCreditSteps(
  context: Context,
  accounts: Awaited<ReturnType<typeof visibleAccounts>>,
  steps: Step[],
): Promise<void> {
  const offers = accounts.some((org) => org.admin && !org.billing?.planId) ? await claimOffersFor(context) : {};
  for (const org of accounts) {
    const planId = org.billing?.planId ?? null;
    if (!planId) {
      if (!org.admin) {
        steps.push({ step: "ask_admin_to_join", account: org.login, do: `${org.login} has no plan yet, and only its admins can join. Ask one of them to set it up.` });
        continue;
      }
      const offer = offers[org.id];
      steps.push(
        offer?.open
          ? { step: "claim_free_credits", account: org.login, do: `Call claim_free_credits for ${org.login}: ${offer.credits} free credits, no card. Or buy_credits to join the plan with a card.` }
          : { step: "join_plan", account: org.login, do: `Call buy_credits for ${org.login} (quote_credits first to see the price). The first purchase returns a Stripe Checkout link for the person to pay (then get_billing with wait=50); after that the saved card is charged directly.` },
      );
    } else if ((org.billing?.credits ?? 0) <= 0) {
      steps.push({ step: "buy_credits", account: org.login, do: `${org.login} is out of credits, so every scan is paused. Call buy_credits, or set_auto_top_up so it never runs out.` });
    }
  }
}

async function claimOffersFor(context: Context) {
  const { claimOffers } = await import("../../free-credits");
  return claimOffers({ id: context.principal.userId, githubUserId: context.principal.githubUserId }).catch(() => ({}) as Awaited<ReturnType<typeof claimOffers>>);
}

export const accountOps = [
  operation({
    name: "get_me",
    title: "Who am I, and what's next",
    description:
      "Start here. Returns the person this agent acts as, the GitHub accounts RedNest is installed on, scan access (lifetime free scan, wallet, $RED holder state), and `next_steps`: what is left to set up or do, in order (install the GitHub App, run a free scan, connect a wallet after launch, fix open findings). Steps only a person can take come with a URL to give them.",
    method: "GET",
    path: "/me",
    input: z.object({}),
    readOnly: true,
    async run(context) {
      const { steps, accounts, access } = await nextSteps(context);
      const legacy = legacyCreditsNextStepsEnabled();
      const { canStartChargeableScan: _can, ...publicAccess } = access;
      return {
        user: { id: context.principal.userId, login: context.principal.login, name: context.principal.name },
        accounts: accounts.map((org) => accountView(org, context.appUrl)),
        next_steps: steps,
        access: publicAccess,
        billing_enabled: billingEnabled(),
        free_credits:
          legacy && billingEnabled()
            ? { credits: FREE_CREDITS.credits, note: "Testers can claim free credits once per GitHub account, with no card (claim_free_credits)." }
            : null,
        links: {
          dashboard: `${context.appUrl}/dashboard`,
          docs: `${context.appUrl}/docs/agents`,
          install_github_app: installUrl(),
          wallet: `${context.appUrl}/dashboard/settings#wallet`,
          pricing: `${context.appUrl}/docs/pricing`,
        },
      };
    },
  }),

  operation({
    name: "list_api_keys",
    title: "List API keys and connected agents",
    description: "Lists the person's API keys and the MCP clients they've connected, with when each was last used. Secrets are never shown again after they're created.",
    method: "GET",
    path: "/keys",
    input: z.object({}),
    readOnly: true,
    async run(context) {
      const rows = await userAgentAccess(db(), context.principal.userId);
      return {
        keys: rows.map((row) => ({
          id: row.id,
          kind: row.kind === "key" ? "api_key" : "mcp_client",
          name: row.name,
          prefix: row.prefix,
          current: row.id === context.principal.tokenId,
          created_at: iso(row.createdAt),
          last_used_at: iso(row.lastUsedAt),
        })),
      };
    },
  }),

  operation({
    name: "create_api_key",
    title: "Create an API key",
    description: "Creates an API key that acts as this person, for another agent, a CI job or a script. The key is returned once: store it (e.g. as SANDCHEST_API_KEY) and send it as `Authorization: Bearer <key>`.",
    method: "POST",
    path: "/keys",
    status: 201,
    input: z.object({ name: z.string().max(80).optional().describe("What the key is for, e.g. \"CI\". Shown in Settings.") }),
    async run(context, input) {
      // An MCP client's day-long token must not turn itself into a key that outlives disconnecting it.
      if (context.principal.tokenKind !== "key") {
        throw new ApiError(403, "key_required", `MCP clients can't create API keys. The person can make one in Settings (${context.appUrl}/dashboard/settings#agents), or an agent connected with the device flow can.`);
      }
      const created = await issueKey(context.principal.userId, cleanName(input.name, "API key"));
      await track("api_key_created", { userId: context.principal.userId, props: { via: context.surface, kind: "key", outcome: "ok" } });
      return { id: created.id, key: created.key, created_at: iso(created.createdAt), note: "This is the only time the key is shown." };
    },
  }),

  operation({
    name: "revoke_api_key",
    title: "Revoke an API key",
    description: 'Revokes an API key, or disconnects an MCP client, by its id from list_api_keys. Use id "current" to revoke the key this request is using (signing the agent out).',
    method: "DELETE",
    path: "/keys/{id}",
    input: z.object({ id: z.union([z.literal("current"), z.uuid()]).describe('The key\'s id, or "current".') }),
    destructive: true,
    idempotent: true,
    async run(context, input) {
      const id = input.id === "current" ? context.principal.tokenId : input.id;
      const revoked = await revokeUserToken(db(), context.principal.userId, id);
      if (!revoked) throw new ApiError(404, "not_found", "No live key with that id. Call list_api_keys to see them.");
      await track("api_key_revoked", { userId: context.principal.userId, props: { via: context.surface, kind: revoked.kind, outcome: "ok" } });
      return { revoked: true, id };
    },
  }),
];
