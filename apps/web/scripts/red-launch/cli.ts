#!/usr/bin/env bun
/**
 * Operator CLI for $RED production launch configuration.
 * Does not create tokens. Pump.fun remains the token creation platform.
 *
 *   bun run red:launch status
 *   bun run red:launch prepare --mint <RESERVED_MINT> [--dry-run] [--yes]
 *   bun run red:launch recover-mint --mint <MINT> [--dry-run] [--yes]
 *   bun run red:launch register --mint <MINT> [--dry-run] [--yes]
 *   bun run red:launch publish [--dry-run] [--yes]
 *   bun run red:launch verify --eligible <W> --ineligible <W>
 *   bun run red:launch activate [--dry-run] [--yes]
 *   bun run red:launch disable [--dry-run] [--yes]
 *   bun run red:launch deploy [--dry-run] [--yes]
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { parseArgs, usage } from "./args";
import {
  cmdActivate,
  cmdDeploy,
  cmdDisable,
  cmdPrepare,
  cmdPublish,
  cmdRecoverMint,
  cmdRegister,
  cmdStatus,
  cmdVerify,
} from "./commands";
import { VERIFY_STATE_RELATIVE } from "./config";
import { createPumpClient, createSolanaClient } from "./solana";
import { createSiteClient } from "./site";
import type { LaunchDeps } from "./types";
import { createVercelClient } from "./vercel";

export function createDefaultDeps(overrides: Partial<LaunchDeps> = {}): LaunchDeps {
  const root = process.cwd();
  return {
    vercel: createVercelClient(),
    solana: createSolanaClient(),
    pump: createPumpClient(),
    site: createSiteClient(),
    io: {
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      confirm: async (prompt) => {
        const rl = createInterface({ input, output });
        try {
          const answer = (await rl.question(prompt)).trim().toLowerCase();
          return answer === "yes" || answer === "y";
        } finally {
          rl.close();
        }
      },
    },
    statePath: join(root, VERIFY_STATE_RELATIVE),
    now: () => new Date(),
    ...overrides,
  };
}

export async function runLaunch(argv: string[], deps: LaunchDeps = createDefaultDeps()): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.io.error(parsed.error);
    return parsed.error.includes("Usage:") ? 0 : 1;
  }

  let result;
  switch (parsed.command) {
    case "status":
      result = await cmdStatus(deps);
      break;
    case "prepare":
      result = await cmdPrepare(deps, { mint: parsed.mint!, dryRun: parsed.dryRun, yes: parsed.yes });
      break;
    case "recover-mint":
      result = await cmdRecoverMint(deps, { mint: parsed.mint!, dryRun: parsed.dryRun, yes: parsed.yes });
      break;
    case "register":
      result = await cmdRegister(deps, { mint: parsed.mint!, dryRun: parsed.dryRun, yes: parsed.yes });
      break;
    case "publish":
      result = await cmdPublish(deps, { dryRun: parsed.dryRun, yes: parsed.yes });
      break;
    case "verify":
      result = await cmdVerify(deps, { eligible: parsed.eligible!, ineligible: parsed.ineligible! });
      break;
    case "activate":
      result = await cmdActivate(deps, { dryRun: parsed.dryRun, yes: parsed.yes });
      break;
    case "disable":
      result = await cmdDisable(deps, { dryRun: parsed.dryRun, yes: parsed.yes });
      break;
    case "deploy":
      result = await cmdDeploy(deps, { dryRun: parsed.dryRun, yes: parsed.yes });
      break;
  }

  if (!result.ok) {
    deps.io.error(result.error);
    return result.code;
  }
  if (result.message) deps.io.log(result.message);
  return result.code;
}

if (import.meta.main) {
  const code = await runLaunch(process.argv.slice(2));
  process.exit(code);
}
