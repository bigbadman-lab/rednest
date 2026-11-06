import { canonicalSolanaPubkey } from "../../src/server/solana/pubkey";
import {
  ENV_HOLDER,
  ENV_MINT,
  ENV_MINT_PUBLIC,
  PRODUCTION_URL,
} from "./config";
import { flagPresence, rpcPresence } from "./sanitize";
import { requireVerifiedPumpMint } from "./solana";
import {
  homepageHolderActive,
  homepageHolderInactive,
  homepageHidesMint,
  homepageShowsMint,
  homepageSolscanFor,
} from "./site";
import { writeVerifyReceipt } from "./state";
import type { CommandResult, EnvKey, EnvMap, LaunchDeps, VerifyReceipt } from "./types";

function envValue(env: EnvMap, key: EnvKey): string | null | undefined {
  if (env._unknown?.[key] || env._protected?.[key]) return undefined;
  return env[key] as string | null | undefined;
}

function envKeyState(env: EnvMap, key: EnvKey): "absent" | "unknown" | "protected" | "present" {
  if (env._unknown?.[key]) return "unknown";
  if (env._protected?.[key]) return "protected";
  const value = env[key];
  if (value === undefined) return "unknown";
  if (value === null || String(value).trim() === "") return "absent";
  return "present";
}

async function requireTarget(deps: LaunchDeps): Promise<CommandResult | null> {
  try {
    const target = await deps.vercel.assertTarget();
    deps.io.log(`Target: team=${target.team} project=${target.project} env=production`);
    return null;
  } catch (error) {
    return { ok: false, code: 2, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Must run before any production env write so a dirty tree cannot cause partial mutations. */
async function requireCleanSource(deps: LaunchDeps): Promise<CommandResult | null> {
  try {
    const { gitSha } = await deps.vercel.assertDeployableSource();
    deps.io.log(`Source revision ${gitSha.slice(0, 7)} is clean and deployable.`);
    return null;
  } catch (error) {
    return { ok: false, code: 2, error: error instanceof Error ? error.message : String(error) };
  }
}

async function confirmOrAbort(deps: LaunchDeps, prompt: string, yes: boolean, dryRun: boolean): Promise<CommandResult | null> {
  if (dryRun) {
    deps.io.log(`[dry-run] Would ask confirmation: ${prompt}`);
    return null;
  }
  if (yes) {
    deps.io.log(`Confirmed via --yes: ${prompt}`);
    return null;
  }
  const ok = await deps.io.confirm(`${prompt} Type "yes" to continue: `);
  if (!ok) return { ok: false, code: 1, error: "Aborted by operator." };
  return null;
}

/** Deploy clean HEAD, wait for Ready, then verify the production alias. */
async function deployAndVerifyAlias(deps: LaunchDeps) {
  const deployment = await deps.vercel.deployProduction();
  if (deployment.gitSha) deps.io.log(`Deploying approved revision ${deployment.gitSha.slice(0, 7)}.`);
  await deps.vercel.waitUntilReady(deployment);
  await deps.vercel.verifyProductionAlias(deployment);
  deps.io.log(`Deployment Ready: ${deployment.url}; production alias ${PRODUCTION_URL} verified.`);
  return deployment;
}

export async function cmdStatus(deps: LaunchDeps): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;

  const env = await deps.vercel.readProductionEnv();
  const mintState = envKeyState(env, "RED_TOKEN_MINT");
  const mintRaw = mintState === "present" ? env.RED_TOKEN_MINT : null;
  const mintCanon = mintRaw ? canonicalSolanaPubkey(mintRaw) : null;
  let mintLabel: string;
  if (mintState === "absent") mintLabel = "absent";
  else if (mintState === "unknown") mintLabel = "unknown";
  else if (mintState === "protected") mintLabel = "configured (protected — value not readable via CLI)";
  else if (mintCanon) mintLabel = `configured (${mintCanon})`;
  else mintLabel = "configured (invalid pubkey)";

  deps.io.log("Production $NEST launch status");
  deps.io.log(`  RED_TOKEN_MINT: ${mintLabel}`);
  deps.io.log(`  RED_MINT_PUBLIC: ${describeFlag(env, "RED_MINT_PUBLIC")}`);
  deps.io.log(`  RED_HOLDER_SCANS_ENABLED: ${describeFlag(env, "RED_HOLDER_SCANS_ENABLED")}`);
  deps.io.log(`  SOLANA_RPC_URL: ${describeRpc(env)}`);

  const deployment = await deps.vercel.latestProductionDeployment();
  if (!deployment) deps.io.log("  Latest production deployment: unknown");
  else deps.io.log(`  Latest production deployment: ${deployment.readyState} (${deployment.url})`);

  const health = await deps.site.health();
  deps.io.log(`  /api/health: ${health.ok ? "ok" : "unhealthy"}`);
  return { ok: true, code: 0 };
}

function describeFlag(env: EnvMap, key: "RED_MINT_PUBLIC" | "RED_HOLDER_SCANS_ENABLED"): string {
  const state = envKeyState(env, key);
  if (state === "protected") return "protected";
  if (state === "unknown") return "unknown";
  return flagPresence(env[key]);
}

function describeRpc(env: EnvMap): string {
  const state = envKeyState(env, "SOLANA_RPC_URL");
  if (state === "protected") return "configured (protected)";
  if (state === "unknown") return "unknown";
  return rpcPresence(env.SOLANA_RPC_URL);
}

/**
 * Prelaunch reserved-mint registration. Accepts an address with no on-chain mint
 * account yet. Never enables holders or publishes. Configuring the address never
 * claims the token is live.
 */
export async function cmdPrepare(
  deps: LaunchDeps,
  input: { mint: string; dryRun: boolean; yes: boolean },
): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;
  // Cleanliness before any env write — avoids partial state if deploy would refuse later.
  const dirty = await requireCleanSource(deps);
  if (dirty) return dirty;

  const env = await deps.vercel.readProductionEnv();
  const rpcState = envKeyState(env, "SOLANA_RPC_URL");
  if (rpcState === "unknown" || rpcState === "protected") {
    return { ok: false, code: 2, error: "SOLANA_RPC_URL is unknown or protected; refuse to prepare." };
  }
  const rpc = env.SOLANA_RPC_URL;
  if (!rpc) return { ok: false, code: 2, error: "SOLANA_RPC_URL is not configured in production." };

  // Fail closed on publish/holder flags before any mint mutation. Prepare never flips these.
  const mintPublicState = envKeyState(env, "RED_MINT_PUBLIC");
  const holdersState = envKeyState(env, "RED_HOLDER_SCANS_ENABLED");
  if (mintPublicState === "unknown" || mintPublicState === "protected") {
    return { ok: false, code: 2, error: "RED_MINT_PUBLIC is unknown or protected; refuse to prepare." };
  }
  if (holdersState === "unknown" || holdersState === "protected") {
    return { ok: false, code: 2, error: "RED_HOLDER_SCANS_ENABLED is unknown or protected; refuse to prepare." };
  }
  const mintPublic = flagPresence(env.RED_MINT_PUBLIC);
  const holders = flagPresence(env.RED_HOLDER_SCANS_ENABLED);
  if (mintPublic === "true") {
    return {
      ok: false,
      code: 2,
      error: "RED_MINT_PUBLIC is true. Prepare refuses to run while the mint is published — unpublish / reset publication first, or use a separate approved publish flow later.",
    };
  }
  if (holders === "true") {
    return {
      ok: false,
      code: 2,
      error: "RED_HOLDER_SCANS_ENABLED is true. Prepare refuses to run while holder access is enabled — disable holders first.",
    };
  }

  const mintState = envKeyState(env, "RED_TOKEN_MINT");
  if (mintState === "protected") {
    return {
      ok: false,
      code: 2,
      error:
        "Existing RED_TOKEN_MINT is protected (not readable via CLI). Refuse to overwrite — verify the value in the Vercel dashboard; re-enter as Config (--no-sensitive) only under separate approval if replacement is required.",
    };
  }
  if (mintState === "unknown") {
    return { ok: false, code: 2, error: "Existing RED_TOKEN_MINT is unknown; refuse to mutate." };
  }
  const existing = mintState === "present" ? env.RED_TOKEN_MINT : null;
  const existingCanon = existing ? canonicalSolanaPubkey(existing) : null;
  const nextCanon = canonicalSolanaPubkey(input.mint);
  if (!nextCanon) return { ok: false, code: 2, error: "Invalid reserved mint: not a Solana public key." };

  if (existingCanon && existingCanon !== nextCanon) {
    return {
      ok: false,
      code: 3,
      error: `Conflicting mint already registered (${existingCanon}). Refusing to replace without separate operator approval.`,
    };
  }

  const onChain = await deps.solana.inspectMint(nextCanon, rpc);
  if ("error" in onChain) {
    if (onChain.error === "rpc_error") {
      return { ok: false, code: 2, error: "RPC failed while checking the reserved mint. Refuse to prepare." };
    }
    if (onChain.error === "not_a_mint") {
      return {
        ok: false,
        code: 2,
        error: "Reserved address exists on-chain but is not a mint account. Refuse to prepare.",
      };
    }
    if (onChain.error !== "account_absent") {
      return { ok: false, code: 2, error: `Reserved mint check failed: ${onChain.error}` };
    }
    deps.io.log("On-chain: account absent (prelaunch reserved mint).");
  } else {
    return {
      ok: false,
      code: 2,
      error:
        "On-chain mint account already exists at this address. Use `register` for a live Pump.fun mint; prepare is reserved-address / prelaunch only.",
    };
  }

  if (existingCanon === nextCanon) {
    deps.io.log("RED_TOKEN_MINT already set to this reserved mint (idempotent).");
  }

  deps.io.log("Prelaunch prepare will NOT enable holder scans and will NOT publish the mint.");
  deps.io.log("Configuring this address does not mean the token is live.");

  const confirm = await confirmOrAbort(
    deps,
    `Confirm you control or have independently verified reserved mint ${nextCanon}. Set RED_TOKEN_MINT in production (holders disabled, mint unpublished) and deploy?`,
    input.yes,
    input.dryRun,
  );
  if (confirm) return confirm;

  if (input.dryRun) {
    deps.io.log("[dry-run] Would set RED_TOKEN_MINT to reserved address, deploy production, verify health; holders remain off; mint remains unpublished.");
    return { ok: true, code: 0, message: "dry-run" };
  }

  try {
    if (existingCanon !== nextCanon) {
      // Only RED_TOKEN_MINT — never RED_MINT_PUBLIC or RED_HOLDER_SCANS_ENABLED.
      await deps.vercel.setProductionEnv(ENV_MINT, nextCanon);
      deps.io.log("Set RED_TOKEN_MINT (reserved / prelaunch).");
    }
    await deployAndVerifyAlias(deps);

    const health = await deps.site.health();
    if (!health.ok) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: reserved mint may be registered but /api/health failed after deploy.",
      };
    }

    const after = await deps.vercel.readProductionEnv();
    if (flagPresence(envValue(after, "RED_HOLDER_SCANS_ENABLED")) === "true") {
      return {
        ok: false,
        code: 4,
        error: "Partial state: holder access appears enabled after prepare. Unexpected — investigate before publish.",
      };
    }
    if (flagPresence(envValue(after, "RED_MINT_PUBLIC")) === "true") {
      return {
        ok: false,
        code: 4,
        error: "Partial state: mint appears published after prepare. Prepare must not publish.",
      };
    }
    if (flagPresence(envValue(after, "RED_MINT_PUBLIC")) === "unknown" || flagPresence(envValue(after, "RED_HOLDER_SCANS_ENABLED")) === "unknown") {
      return {
        ok: false,
        code: 4,
        error: "Partial state: could not re-read RED_MINT_PUBLIC / RED_HOLDER_SCANS_ENABLED after prepare.",
      };
    }

    const html = await deps.site.homepageHtml();
    if (!homepageHidesMint(html)) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: mint may be visible before publish. Check RED_MINT_PUBLIC before continuing.",
      };
    }
    if (!homepageHolderInactive(html)) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: homepage does not show prelaunch holder-inactive wording after prepare.",
      };
    }

    deps.io.log("Prepare complete. Reserved mint configured. Token is NOT live. Holder access remains disabled. Mint remains unpublished.");
    return { ok: true, code: 0 };
  } catch (error) {
    return {
      ok: false,
      code: 4,
      error: `Prepare failed: ${error instanceof Error ? error.message : String(error)}. Inspect production env before retrying.`,
    };
  }
}

/**
 * One-time recovery: replace an unreadable (Secret / [SENSITIVE]) Production
 * RED_TOKEN_MINT with a readable Config value. Never publishes or enables holders.
 */
export async function cmdRecoverMint(
  deps: LaunchDeps,
  input: { mint: string; dryRun: boolean; yes: boolean },
): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;
  const dirty = await requireCleanSource(deps);
  if (dirty) return dirty;

  const env = await deps.vercel.readProductionEnv();

  const nextCanon = canonicalSolanaPubkey(input.mint);
  if (!nextCanon) return { ok: false, code: 2, error: "Invalid mint: not a Solana public key." };

  const rpcState = envKeyState(env, "SOLANA_RPC_URL");
  if (rpcState === "unknown" || rpcState === "protected") {
    return { ok: false, code: 2, error: "SOLANA_RPC_URL is unknown or protected; refuse to recover-mint." };
  }
  const rpc = env.SOLANA_RPC_URL;
  if (!rpc) return { ok: false, code: 2, error: "SOLANA_RPC_URL is not configured in production." };

  // Publication + holder must be readable and disabled before mutation.
  const mintPublicState = envKeyState(env, "RED_MINT_PUBLIC");
  const holdersState = envKeyState(env, "RED_HOLDER_SCANS_ENABLED");
  if (mintPublicState === "unknown" || mintPublicState === "protected") {
    return { ok: false, code: 2, error: "RED_MINT_PUBLIC is unknown or protected; refuse to recover-mint." };
  }
  if (holdersState === "unknown" || holdersState === "protected") {
    return { ok: false, code: 2, error: "RED_HOLDER_SCANS_ENABLED is unknown or protected; refuse to recover-mint." };
  }
  if (flagPresence(env.RED_MINT_PUBLIC) === "true") {
    return { ok: false, code: 2, error: "RED_MINT_PUBLIC is true. Refuse recover-mint while the mint is published." };
  }
  if (flagPresence(env.RED_HOLDER_SCANS_ENABLED) === "true") {
    return { ok: false, code: 2, error: "RED_HOLDER_SCANS_ENABLED is true. Refuse recover-mint while holder access is enabled." };
  }

  const mintState = envKeyState(env, "RED_TOKEN_MINT");
  if (mintState === "unknown") {
    return { ok: false, code: 2, error: "Existing RED_TOKEN_MINT is unknown (env pull failed); refuse to recover-mint." };
  }
  if (mintState === "absent") {
    return { ok: false, code: 2, error: "RED_TOKEN_MINT is absent. Use prepare for first-time reserved registration, not recover-mint." };
  }
  if (mintState === "present") {
    const existingCanon = canonicalSolanaPubkey(env.RED_TOKEN_MINT ?? "");
    if (existingCanon && existingCanon !== nextCanon) {
      return {
        ok: false,
        code: 3,
        error: `Readable RED_TOKEN_MINT already set to a different mint (${existingCanon}). Refuse recover-mint conflict.`,
      };
    }
    if (existingCanon === nextCanon) {
      deps.io.log("RED_TOKEN_MINT is already readable and matches the recovery mint (idempotent Config path).");
    }
  } else if (mintState === "protected") {
    deps.io.log("Existing RED_TOKEN_MINT is protected (Secret / [SENSITIVE] on pull) — recovery will replace it as Config.");
  }

  const onChain = await deps.solana.inspectMint(nextCanon, rpc);
  if ("error" in onChain) {
    if (onChain.error === "rpc_error") {
      return { ok: false, code: 2, error: "RPC failed while inspecting the recovery mint. Refuse to recover-mint." };
    }
    if (onChain.error === "not_a_mint") {
      return { ok: false, code: 2, error: "Recovery address exists on-chain but is not a mint account." };
    }
    if (onChain.error === "account_absent") {
      deps.io.log("On-chain: account absent (prelaunch reserved mint recovery).");
    } else {
      return { ok: false, code: 2, error: `Mint inspection failed: ${onChain.error}` };
    }
  } else {
    const inspected = await requireVerifiedPumpMint(deps.solana, deps.pump, nextCanon, rpc);
    if ("error" in inspected) {
      return { ok: false, code: 2, error: `Live mint recovery requires Pump.fun verification: ${inspected.error}` };
    }
    deps.io.log(
      `On-chain mint verified: decimals=${inspected.decimals} program=${inspected.tokenProgram}; pump.fun OK.`,
    );
  }

  deps.io.log("recover-mint will ONLY replace RED_TOKEN_MINT as a readable Config value.");
  deps.io.log("It will NOT set RED_MINT_PUBLIC or RED_HOLDER_SCANS_ENABLED.");

  const confirm = await confirmOrAbort(
    deps,
    `AUTHORIZE recovery: replace the unreadable Production RED_TOKEN_MINT with Config value ${nextCanon}, then deploy (holders off, mint unpublished)?`,
    input.yes,
    input.dryRun,
  );
  if (confirm) return confirm;

  if (input.dryRun) {
    deps.io.log(
      "[dry-run] Would remove protected/existing RED_TOKEN_MINT, add it as Config (--type config), read back exact match, deploy; leave publish/holder untouched.",
    );
    return { ok: true, code: 0, message: "dry-run" };
  }

  try {
    const alreadyReadableMatch =
      mintState === "present" && canonicalSolanaPubkey(env.RED_TOKEN_MINT ?? "") === nextCanon;
    if (!alreadyReadableMatch) {
      try {
        await deps.vercel.replaceProductionEnvAsConfig(ENV_MINT, nextCanon);
      } catch (error) {
        const partial = error && typeof error === "object" && "partialRecovery" in error && (error as { partialRecovery?: boolean }).partialRecovery;
        if (partial) {
          return {
            ok: false,
            code: 4,
            error:
              error instanceof Error
                ? error.message
                : `PARTIAL RECOVERY: RED_TOKEN_MINT may be absent after env rm. Do not deploy. Re-run recover-mint --mint ${nextCanon} or restore Config in the Vercel dashboard.`,
          };
        }
        throw error;
      }
      deps.io.log("Replaced RED_TOKEN_MINT as Config.");
    }

    const afterWrite = await deps.vercel.readProductionEnv();
    if (afterWrite._protected?.RED_TOKEN_MINT || afterWrite._unknown?.RED_TOKEN_MINT) {
      return {
        ok: false,
        code: 4,
        error:
          "Readback failed: RED_TOKEN_MINT is still protected or unreadable after Config write. Do not deploy. Do not publish/activate. Re-check Vercel Production env for cope2/rednest.",
      };
    }
    const readback = afterWrite.RED_TOKEN_MINT ?? null;
    const readbackCanon = readback ? canonicalSolanaPubkey(readback) : null;
    if (!readback || !readbackCanon || readbackCanon !== nextCanon || readback !== nextCanon) {
      return {
        ok: false,
        code: 4,
        error: `Readback mismatch or missing mint after write (expected exact ${nextCanon}). Refuse to deploy. Do not publish/activate. Re-run recover-mint or set Config RED_TOKEN_MINT in the Vercel dashboard.`,
      };
    }
    deps.io.log("Readback OK: RED_TOKEN_MINT matches recovery mint exactly.");

    if (flagPresence(afterWrite.RED_MINT_PUBLIC) === "true" || flagPresence(afterWrite.RED_HOLDER_SCANS_ENABLED) === "true") {
      return {
        ok: false,
        code: 4,
        error: "Unexpected: publish or holder flag is true after mint recovery. Abort before deploy.",
      };
    }

    // Exact Config readback succeeded — only then deploy.
    await deployAndVerifyAlias(deps);

    const health = await deps.site.health();
    if (!health.ok) {
      return { ok: false, code: 4, error: "Partial state: mint recovered but /api/health failed after deploy." };
    }

    const html = await deps.site.homepageHtml();
    if (!homepageHidesMint(html)) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: homepage may expose the mint while publication is disabled.",
      };
    }
    if (!homepageHolderInactive(html) || homepageHolderActive(html)) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: homepage missing private/prelaunch holder-inactive wording after recover-mint.",
      };
    }

    const finalEnv = await deps.vercel.readProductionEnv();
    if (flagPresence(finalEnv.RED_MINT_PUBLIC) === "true" || flagPresence(finalEnv.RED_HOLDER_SCANS_ENABLED) === "true") {
      return { ok: false, code: 4, error: "Partial state: publish/holder flags changed during recover-mint." };
    }

    deps.io.log("recover-mint complete. RED_TOKEN_MINT is readable Config. Token not published. Holder access remains disabled.");
    return { ok: true, code: 0 };
  } catch (error) {
    return {
      ok: false,
      code: 4,
      error: `recover-mint failed: ${error instanceof Error ? error.message : String(error)}. Inspect Production RED_TOKEN_MINT before retrying.`,
    };
  }
}

export async function cmdRegister(
  deps: LaunchDeps,
  input: { mint: string; dryRun: boolean; yes: boolean },
): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;
  const dirty = await requireCleanSource(deps);
  if (dirty) return dirty;

  const env = await deps.vercel.readProductionEnv();
  const rpc = envValue(env, "SOLANA_RPC_URL");
  if (rpc === undefined) return { ok: false, code: 2, error: "SOLANA_RPC_URL is unknown or protected; refuse to register." };
  if (!rpc) return { ok: false, code: 2, error: "SOLANA_RPC_URL is not configured in production." };

  const mintState = envKeyState(env, "RED_TOKEN_MINT");
  if (mintState === "protected") {
    return {
      ok: false,
      code: 2,
      error:
        "Existing RED_TOKEN_MINT is protected (not readable via CLI). Refuse to overwrite — verify in the Vercel dashboard; do not replace automatically.",
    };
  }
  if (mintState === "unknown") return { ok: false, code: 2, error: "Existing RED_TOKEN_MINT is unknown; refuse to mutate." };
  const existing = mintState === "present" ? env.RED_TOKEN_MINT : null;
  const existingCanon = existing ? canonicalSolanaPubkey(existing) : null;
  const nextCanon = canonicalSolanaPubkey(input.mint);
  if (!nextCanon) return { ok: false, code: 2, error: "Invalid mint: not a Solana public key." };

  if (existingCanon && existingCanon !== nextCanon) {
    return {
      ok: false,
      code: 3,
      error: `Conflicting mint already registered (${existingCanon}). Refusing to replace without separate operator approval.`,
    };
  }

  const inspected = await requireVerifiedPumpMint(deps.solana, deps.pump, nextCanon, rpc);
  if ("error" in inspected) {
    return { ok: false, code: 2, error: `Mint validation failed: ${inspected.error}` };
  }

  deps.io.log("Mint inspection");
  deps.io.log(`  mint: ${inspected.mint}`);
  deps.io.log(`  decimals: ${inspected.decimals}`);
  deps.io.log(`  tokenProgram: ${inspected.tokenProgram} (${inspected.tokenProgramId})`);
  deps.io.log(
    `  pump.fun: verified (${inspected.pumpFun.verified ? [inspected.pumpFun.symbol, inspected.pumpFun.name].filter(Boolean).join(" ") : ""})`,
  );

  if (existingCanon === nextCanon) {
    deps.io.log("RED_TOKEN_MINT already set to this mint (idempotent).");
  }

  const confirm = await confirmOrAbort(
    deps,
    `Register RED_TOKEN_MINT=${inspected.mint} in production and deploy?`,
    input.yes,
    input.dryRun,
  );
  if (confirm) return confirm;

  if (input.dryRun) {
    deps.io.log("[dry-run] Would set RED_TOKEN_MINT, deploy production, verify health, holders off, mint hidden.");
    return { ok: true, code: 0, message: "dry-run" };
  }

  try {
    if (existingCanon !== nextCanon) {
      await deps.vercel.setProductionEnv(ENV_MINT, inspected.mint);
      deps.io.log("Set RED_TOKEN_MINT.");
    }
    await deployAndVerifyAlias(deps);

    const health = await deps.site.health();
    if (!health.ok) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: mint may be registered but /api/health failed after deploy. Do not publish until healthy.",
      };
    }

    const after = await deps.vercel.readProductionEnv();
    if (flagPresence(envValue(after, "RED_HOLDER_SCANS_ENABLED")) === "true") {
      return {
        ok: false,
        code: 4,
        error: "Partial state: holder access appears enabled after register. Unexpected — investigate before publish.",
      };
    }

    const html = await deps.site.homepageHtml();
    if (!homepageHidesMint(html)) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: mint may be visible before publish. Check RED_MINT_PUBLIC before continuing.",
      };
    }

    deps.io.log("Register complete. Holder access remains disabled. Mint remains hidden until publish.");
    return { ok: true, code: 0 };
  } catch (error) {
    return {
      ok: false,
      code: 4,
      error: `Register failed: ${error instanceof Error ? error.message : String(error)}. Inspect production env before retrying.`,
    };
  }
}

export async function cmdPublish(deps: LaunchDeps, input: { dryRun: boolean; yes: boolean }): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;
  const dirty = await requireCleanSource(deps);
  if (dirty) return dirty;

  const env = await deps.vercel.readProductionEnv();
  const mintState = envKeyState(env, "RED_TOKEN_MINT");
  if (mintState === "protected") {
    return {
      ok: false,
      code: 2,
      error: "RED_TOKEN_MINT is protected (not readable via CLI). Refuse to publish until the mint can be verified as Config, not Secret.",
    };
  }
  if (mintState === "unknown") return { ok: false, code: 2, error: "RED_TOKEN_MINT unknown; refuse to publish." };
  const mintRaw = mintState === "present" ? env.RED_TOKEN_MINT : null;
  const mint = mintRaw ? canonicalSolanaPubkey(mintRaw) : null;
  if (!mint) return { ok: false, code: 2, error: "Canonical mint is not registered. Run prepare/register first." };

  const health = await deps.site.health();
  if (!health.ok) return { ok: false, code: 2, error: "Production /api/health is not ok. Refuse to publish." };

  const rpc = envValue(env, "SOLANA_RPC_URL");
  let prelaunchReserved = false;
  if (rpc) {
    const onChain = await deps.solana.inspectMint(mint, rpc);
    if ("error" in onChain && onChain.error === "account_absent") {
      prelaunchReserved = true;
      deps.io.log("On-chain mint absent — publishing a reserved address. Token has not launched.");
    }
  }

  const pub = flagPresence(envValue(env, "RED_MINT_PUBLIC"));
  if (pub === "true") deps.io.log("RED_MINT_PUBLIC already true (idempotent publish).");

  const confirm = await confirmOrAbort(
    deps,
    prelaunchReserved
      ? `Publish reserved mint ${mint} on the homepage (token has NOT launched; no trading claims; holders stay disabled). Set RED_MINT_PUBLIC=true and deploy?`
      : `Publish official mint ${mint} on the homepage (RED_MINT_PUBLIC=true; holders stay disabled until activate) and deploy?`,
    input.yes,
    input.dryRun,
  );
  if (confirm) return confirm;

  if (input.dryRun) {
    deps.io.log(
      prelaunchReserved
        ? "[dry-run] Would set RED_MINT_PUBLIC=true for reserved mint, deploy, verify mint visible with prelaunch wording; holders still disabled."
        : "[dry-run] Would set RED_MINT_PUBLIC=true, deploy, verify mint visible and holders still disabled.",
    );
    return { ok: true, code: 0, message: "dry-run" };
  }

  try {
    await deps.vercel.setProductionEnv(ENV_MINT_PUBLIC, "true");
    await deployAndVerifyAlias(deps);

    const afterHealth = await deps.site.health();
    if (!afterHealth.ok) {
      return { ok: false, code: 4, error: "Partial state: RED_MINT_PUBLIC may be set but health check failed." };
    }

    const html = await deps.site.homepageHtml();
    if (!homepageShowsMint(html, mint) || !homepageSolscanFor(html, mint)) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: homepage does not show the full official mint / Solscan link yet.",
      };
    }
    if (!homepageHolderInactive(html)) {
      return {
        ok: false,
        code: 4,
        error: "Partial state: homepage missing prelaunch / holder-inactive wording after publish.",
      };
    }
    if (homepageHolderActive(html)) {
      return { ok: false, code: 4, error: "Partial state: holder access appears active after publish. Do not activate further until reviewed." };
    }
    if (flagPresence(envValue(await deps.vercel.readProductionEnv(), "RED_HOLDER_SCANS_ENABLED")) === "true") {
      return { ok: false, code: 4, error: "Partial state: RED_HOLDER_SCANS_ENABLED is true after publish." };
    }

    deps.io.log(
      prelaunchReserved
        ? "Publish complete for reserved mint. Token is not live. Holder access remains disabled."
        : "Publish complete. Holder access remains disabled.",
    );
    return { ok: true, code: 0 };
  } catch (error) {
    return {
      ok: false,
      code: 4,
      error: `Publish failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function cmdVerify(
  deps: LaunchDeps,
  input: { eligible: string; ineligible: string },
): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;

  const env = await deps.vercel.readProductionEnv();
  const mintRaw = envValue(env, "RED_TOKEN_MINT");
  const rpc = envValue(env, "SOLANA_RPC_URL");
  if (mintRaw === undefined || rpc === undefined) {
    return { ok: false, code: 2, error: "Mint or RPC configuration unknown; cannot verify." };
  }
  const mint = mintRaw ? canonicalSolanaPubkey(mintRaw) : null;
  if (!mint) return { ok: false, code: 2, error: "Canonical mint is not registered." };
  if (!rpc) return { ok: false, code: 2, error: "SOLANA_RPC_URL is not configured." };

  const eligibleWallet = canonicalSolanaPubkey(input.eligible);
  const ineligibleWallet = canonicalSolanaPubkey(input.ineligible);
  if (!eligibleWallet || !ineligibleWallet) {
    return { ok: false, code: 2, error: "eligible/ineligible wallets must be valid Solana public keys." };
  }

  const onChain = await deps.solana.inspectMint(mint, rpc);
  if ("error" in onChain) return { ok: false, code: 2, error: `Mint inspect failed: ${onChain.error}` };

  const eligible = await deps.solana.checkBalance({ walletPubkey: eligibleWallet, mint, rpcUrl: rpc });
  const ineligible = await deps.solana.checkBalance({ walletPubkey: ineligibleWallet, mint, rpcUrl: rpc });

  if (!eligible.ok) return { ok: false, code: 2, error: `Eligible wallet check failed: ${eligible.reason}` };
  if (!ineligible.ok) return { ok: false, code: 2, error: `Ineligible wallet check failed: ${ineligible.reason}` };

  const eligiblePass = eligible.eligible === true && eligible.wholeTokens >= 50_000n;
  const ineligiblePass = ineligible.eligible === false && ineligible.wholeTokens < 50_000n;

  deps.io.log(`Mint ${mint} decimals=${onChain.decimals} program=${onChain.tokenProgram}`);
  deps.io.log(`Eligible ${eligibleWallet}: whole=${eligible.wholeTokens} eligible=${eligible.eligible}`);
  deps.io.log(`Ineligible ${ineligibleWallet}: whole=${ineligible.wholeTokens} eligible=${ineligible.eligible}`);

  if (!eligiblePass || !ineligiblePass) {
    return {
      ok: false,
      code: 3,
      error: "Stage C verification failed: both wallets must meet expectations (eligible ≥ 50,000; ineligible below).",
    };
  }

  const deployment = await deps.vercel.latestProductionDeployment();
  const receipt: VerifyReceipt = {
    mint,
    verifiedAt: deps.now().toISOString(),
    eligibleWallet,
    ineligibleWallet,
    eligibleWholeTokens: eligible.wholeTokens.toString(),
    ineligibleWholeTokens: ineligible.wholeTokens.toString(),
    decimals: onChain.decimals,
    tokenProgram: onChain.tokenProgram,
    rpcConfigured: true,
    deploymentId: deployment?.id,
  };
  writeVerifyReceipt(deps.statePath, receipt);
  deps.io.log(`Wrote local verification receipt (no secrets) → ${deps.statePath}`);
  deps.io.log("Optional wallet diagnostic passed. Activation does not require this receipt.");
  return { ok: true, code: 0 };
}

export async function cmdActivate(deps: LaunchDeps, input: { dryRun: boolean; yes: boolean }): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;
  const dirty = await requireCleanSource(deps);
  if (dirty) return dirty;

  const env = await deps.vercel.readProductionEnv();
  const mintState = envKeyState(env, "RED_TOKEN_MINT");
  const rpcState = envKeyState(env, "SOLANA_RPC_URL");
  const publishedState = envKeyState(env, "RED_MINT_PUBLIC");
  if (mintState === "protected" || rpcState === "protected" || publishedState === "protected") {
    return { ok: false, code: 2, error: "Production mint/RPC/publish config is protected; refuse to activate without a readable Config value." };
  }
  const mintRaw = envValue(env, "RED_TOKEN_MINT");
  const rpc = envValue(env, "SOLANA_RPC_URL");
  const published = flagPresence(envValue(env, "RED_MINT_PUBLIC"));
  if (mintRaw === undefined || rpc === undefined || published === "unknown") {
    return { ok: false, code: 2, error: "Production config unknown; refuse to activate." };
  }
  const mint = mintRaw ? canonicalSolanaPubkey(mintRaw) : null;
  if (!mint) return { ok: false, code: 2, error: "Canonical mint is not registered." };
  if (published !== "true") return { ok: false, code: 2, error: "Mint is not published (RED_MINT_PUBLIC≠true)." };
  if (!rpc) return { ok: false, code: 2, error: "SOLANA_RPC_URL is not configured." };

  const health = await deps.site.health();
  if (!health.ok) return { ok: false, code: 2, error: "Production health check failed." };

  const inspected = await requireVerifiedPumpMint(deps.solana, deps.pump, mint, rpc);
  if ("error" in inspected) {
    if (inspected.error === "account_absent") {
      return {
        ok: false,
        code: 2,
        error: "Activation rejected: on-chain mint account does not exist yet (create the Pump.fun token first).",
      };
    }
    if (inspected.error === "not_a_mint") {
      return { ok: false, code: 2, error: "Activation rejected: registered address is not a mint account." };
    }
    return { ok: false, code: 2, error: `Activation prerequisites failed: ${inspected.error}` };
  }

  const probe = await deps.solana.probeHolderInfrastructure(mint, rpc);
  if (!probe.ok) {
    return { ok: false, code: 2, error: `Holder infrastructure check failed: ${probe.error}` };
  }
  deps.io.log(
    `Infrastructure OK: mint=${inspected.mint} decimals=${inspected.decimals} program=${inspected.tokenProgram}; pump.fun verified; RPC balance queries succeed.`,
  );

  if (flagPresence(envValue(env, "RED_HOLDER_SCANS_ENABLED")) === "true") {
    deps.io.log("RED_HOLDER_SCANS_ENABLED already true (idempotent).");
  }

  const confirm = await confirmOrAbort(
    deps,
    `Activate holder scans (RED_HOLDER_SCANS_ENABLED=true) for mint ${mint} and deploy?`,
    input.yes,
    input.dryRun,
  );
  if (confirm) return confirm;

  if (input.dryRun) {
    deps.io.log("[dry-run] Would set RED_HOLDER_SCANS_ENABLED=true, deploy, verify health and config active.");
    deps.io.log("[dry-run] Note: this does not prove end-to-end scan authorization.");
    return { ok: true, code: 0, message: "dry-run" };
  }

  try {
    await deps.vercel.setProductionEnv(ENV_HOLDER, "true");
    await deployAndVerifyAlias(deps);
    const afterHealth = await deps.site.health();
    if (!afterHealth.ok) {
      return { ok: false, code: 4, error: "Partial state: holder flag may be set but health failed." };
    }
    const after = await deps.vercel.readProductionEnv();
    if (flagPresence(envValue(after, "RED_HOLDER_SCANS_ENABLED")) !== "true") {
      return { ok: false, code: 4, error: "Partial state: RED_HOLDER_SCANS_ENABLED is not true after deploy." };
    }
    deps.io.log("Holder access configuration is active.");
    deps.io.log("Note: end-to-end chargeable scan authorization was not tested by this CLI.");
    return { ok: true, code: 0 };
  } catch (error) {
    return { ok: false, code: 4, error: `Activate failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function cmdDisable(deps: LaunchDeps, input: { dryRun: boolean; yes: boolean }): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;
  const dirty = await requireCleanSource(deps);
  if (dirty) return dirty;

  const env = await deps.vercel.readProductionEnv();
  if (envKeyState(env, "RED_HOLDER_SCANS_ENABLED") === "protected") {
    return { ok: false, code: 2, error: "RED_HOLDER_SCANS_ENABLED is protected; refuse to mutate via CLI." };
  }
  const holder = flagPresence(envValue(env, "RED_HOLDER_SCANS_ENABLED"));
  if (holder === "unknown") return { ok: false, code: 2, error: "RED_HOLDER_SCANS_ENABLED unknown; refuse to mutate." };
  if (holder === "false" || holder === "absent") {
    deps.io.log("Holder access already disabled (idempotent).");
  }

  const confirm = await confirmOrAbort(
    deps,
    "Disable holder scans (set RED_HOLDER_SCANS_ENABLED=false) and deploy? Mint registration/publication will be left unchanged.",
    input.yes,
    input.dryRun,
  );
  if (confirm) return confirm;

  if (input.dryRun) {
    deps.io.log("[dry-run] Would set RED_HOLDER_SCANS_ENABLED=false, deploy, leave mint/publish untouched.");
    return { ok: true, code: 0, message: "dry-run" };
  }

  try {
    await deps.vercel.setProductionEnv(ENV_HOLDER, "false");
    await deployAndVerifyAlias(deps);
    const after = await deps.vercel.readProductionEnv();
    const afterFlag = flagPresence(envValue(after, "RED_HOLDER_SCANS_ENABLED"));
    if (afterFlag === "true") {
      return { ok: false, code: 4, error: "Disable deploy finished but RED_HOLDER_SCANS_ENABLED still appears true." };
    }
    const mintStill = envValue(after, "RED_TOKEN_MINT");
    const pubStill = envValue(after, "RED_MINT_PUBLIC");
    deps.io.log(`Disable complete. RED_TOKEN_MINT unchanged (${mintStill ? "present" : "absent"}). RED_MINT_PUBLIC=${flagPresence(pubStill)}.`);
    deps.io.log("New holder authorizations should be denied (not_activated / inactive). Historical entitlements untouched.");
    return { ok: true, code: 0 };
  } catch (error) {
    return {
      ok: false,
      code: 4,
      error: `Disable failed: ${error instanceof Error ? error.message : String(error)}. Deployment may be incomplete — check Vercel dashboard.`,
    };
  }
}

/**
 * Deploy-only recovery: ship the clean approved revision with the current
 * Production environment. Never rewrites RED_TOKEN_MINT, RED_MINT_PUBLIC, or
 * RED_HOLDER_SCANS_ENABLED.
 */
export async function cmdDeploy(deps: LaunchDeps, input: { dryRun: boolean; yes: boolean }): Promise<CommandResult> {
  const blocked = await requireTarget(deps);
  if (blocked) return blocked;
  const dirty = await requireCleanSource(deps);
  if (dirty) return dirty;

  const before = await deps.vercel.readProductionEnv();
  const mintState = envKeyState(before, "RED_TOKEN_MINT");
  if (mintState === "unknown") {
    return { ok: false, code: 2, error: "RED_TOKEN_MINT is unknown; refuse deploy-only until mint is readable." };
  }
  if (mintState === "protected") {
    return {
      ok: false,
      code: 2,
      error: "RED_TOKEN_MINT is still protected. Use recover-mint before deploy-only.",
    };
  }
  if (mintState === "absent") {
    return { ok: false, code: 2, error: "RED_TOKEN_MINT is absent. Register or recover a mint before deploy-only." };
  }
  const mintCanon = canonicalSolanaPubkey(before.RED_TOKEN_MINT ?? "");
  if (!mintCanon) {
    return { ok: false, code: 2, error: "RED_TOKEN_MINT is not a valid Solana public key; refuse deploy-only." };
  }
  if (flagPresence(before.RED_MINT_PUBLIC) === "true") {
    return {
      ok: false,
      code: 2,
      error: "RED_MINT_PUBLIC is true. Deploy-only recovery expects an unpublished mint; use publish flow instead.",
    };
  }
  if (flagPresence(before.RED_HOLDER_SCANS_ENABLED) === "true") {
    return {
      ok: false,
      code: 2,
      error: "RED_HOLDER_SCANS_ENABLED is true. Deploy-only recovery refuses while holders are enabled.",
    };
  }
  if (envKeyState(before, "RED_MINT_PUBLIC") === "unknown" || envKeyState(before, "RED_HOLDER_SCANS_ENABLED") === "unknown") {
    return { ok: false, code: 2, error: "Publish or holder flag is unreadable; refuse deploy-only." };
  }
  if (envKeyState(before, "RED_MINT_PUBLIC") === "protected" || envKeyState(before, "RED_HOLDER_SCANS_ENABLED") === "protected") {
    return { ok: false, code: 2, error: "Publish or holder flag is protected; refuse deploy-only." };
  }

  const confirm = await confirmOrAbort(
    deps,
    `Deploy approved revision with current Production env (mint ${mintCanon} unchanged; publish/holder flags untouched)?`,
    input.yes,
    input.dryRun,
  );
  if (confirm) return confirm;

  if (input.dryRun) {
    deps.io.log(
      "[dry-run] Would deploy from monorepo root (not apps/web), wait for Ready, verify rednest.tech alias and /api/health; leave RED_TOKEN_MINT / RED_MINT_PUBLIC / RED_HOLDER_SCANS_ENABLED untouched.",
    );
    return { ok: true, code: 0, message: "dry-run" };
  }

  try {
    await deployAndVerifyAlias(deps);

    const health = await deps.site.health();
    if (!health.ok) {
      return { ok: false, code: 4, error: "Deploy finished but /api/health failed." };
    }

    const html = await deps.site.homepageHtml();
    if (!homepageHidesMint(html)) {
      return {
        ok: false,
        code: 4,
        error: "Homepage may expose the mint after deploy-only; expected mint hidden while unpublished.",
      };
    }
    if (!homepageHolderInactive(html) || homepageHolderActive(html)) {
      return {
        ok: false,
        code: 4,
        error: "Homepage missing private/prelaunch holder-inactive wording after deploy-only.",
      };
    }

    const after = await deps.vercel.readProductionEnv();
    const afterMint = after.RED_TOKEN_MINT ? canonicalSolanaPubkey(after.RED_TOKEN_MINT) : null;
    if (!afterMint || afterMint !== mintCanon || after.RED_TOKEN_MINT !== mintCanon) {
      return {
        ok: false,
        code: 4,
        error: `Post-deploy mint mismatch: expected exact ${mintCanon}. Env may have changed outside this command.`,
      };
    }
    if (flagPresence(after.RED_MINT_PUBLIC) === "true" || flagPresence(after.RED_HOLDER_SCANS_ENABLED) === "true") {
      return {
        ok: false,
        code: 4,
        error: "Publish or holder flag became true during deploy-only. Investigate Production env.",
      };
    }

    deps.io.log(
      `Deploy-only complete. RED_TOKEN_MINT=${mintCanon} unchanged. RED_MINT_PUBLIC and RED_HOLDER_SCANS_ENABLED untouched. Mint remains unpublished.`,
    );
    return { ok: true, code: 0 };
  } catch (error) {
    return {
      ok: false,
      code: 4,
      error: `Deploy-only failed: ${error instanceof Error ? error.message : String(error)}. Production env was not rewritten by this command.`,
    };
  }
}
