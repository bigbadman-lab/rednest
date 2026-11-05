/**
 * Vercel production operations for cope2/rednest.
 * Shells out to the Vercel CLI; never logs env values or tokens.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_HOLDER,
  ENV_MINT,
  ENV_MINT_PUBLIC,
  ENV_RPC,
  LAUNCH_ENVIRONMENT,
  LAUNCH_PROJECT,
  LAUNCH_TEAM,
  PRODUCTION_ALIASES,
  PRODUCTION_URL,
} from "./config";
import { isProtectedEnvPlaceholder, redactSecrets } from "./sanitize";
import { createGitClient, requireCleanApprovedRevision, type GitClient } from "./source";
import type { DeploymentInfo, EnvKey, EnvMap, VercelClient } from "./types";

export type RunCommand = (
  argv: string[],
  options?: { stdin?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function defaultRunCommand(
  argv: string[],
  options?: { stdin?: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    stdin: options?.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  if (options?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }
  const timeout = options?.timeoutMs ?? 600_000;
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code: code ?? 1, stdout, stderr };
}

function vercelScope(run: RunCommand, extra: string[], options?: { timeoutMs?: number }) {
  return run(["vercel", ...extra, "--scope", LAUNCH_TEAM], options);
}

export function createVercelClient(run: RunCommand = defaultRunCommand, git: GitClient = createGitClient(run)): VercelClient {
  return {
    async assertDeployableSource() {
      const sha = requireCleanApprovedRevision(await git.revision());
      return { gitSha: sha };
    },

    async assertTarget() {
      const listed = await vercelScope(run, ["project", "ls"], { timeoutMs: 60_000 });
      if (listed.code !== 0) {
        throw new Error(`Unable to list Vercel projects: ${redactSecrets(listed.stderr || listed.stdout)}`);
      }
      const text = `${listed.stdout}\n${listed.stderr}`;
      if (!/\brednest\b/i.test(text)) {
        throw new Error(`Fail-closed: project "${LAUNCH_PROJECT}" not found under team "${LAUNCH_TEAM}".`);
      }

      const who = await run(["vercel", "whoami"], { timeoutMs: 30_000 });
      if (who.code !== 0) {
        throw new Error("Fail-closed: vercel CLI is not authenticated.");
      }

      // Confirm project inspect resolves under the locked scope.
      const inspect = await vercelScope(run, ["project", "inspect", LAUNCH_PROJECT], { timeoutMs: 60_000 });
      if (inspect.code !== 0) {
        throw new Error(
          `Fail-closed: cannot inspect project ${LAUNCH_PROJECT} under ${LAUNCH_TEAM}: ${redactSecrets(inspect.stderr || inspect.stdout)}`,
        );
      }
      return { team: LAUNCH_TEAM, project: LAUNCH_PROJECT };
    },

    async readProductionEnv() {
      const dir = mkdtempSync(join(tmpdir(), "red-launch-env-"));
      const file = join(dir, ".env.production.local");
      try {
        const pulled = await run(
          [
            "vercel",
            "env",
            "pull",
            file,
            "--environment",
            LAUNCH_ENVIRONMENT,
            "--scope",
            LAUNCH_TEAM,
            "--project",
            LAUNCH_PROJECT,
            "--yes",
          ],
          { timeoutMs: 120_000 },
        );
        if (pulled.code !== 0) {
          return {
            _unknown: {
              RED_TOKEN_MINT: true,
              RED_MINT_PUBLIC: true,
              RED_HOLDER_SCANS_ENABLED: true,
              SOLANA_RPC_URL: true,
            },
          };
        }
        const body = readFileSync(file, "utf8");
        return parseEnvFile(body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async setProductionEnv(name, value) {
      const existing = await this.readProductionEnv();
      const key = name as EnvKey;
      if (existing._protected?.[key]) {
        throw new Error(
          `Existing ${name} is protected (Vercel Secret / [SENSITIVE] on pull). Refuse to overwrite automatically — verify in the Vercel dashboard or re-enter as a Config (--no-sensitive) value under separate approval.`,
        );
      }
      if (existing._unknown?.[key]) {
        throw new Error(`Existing ${name} is unreadable; refuse to overwrite automatically.`);
      }
      const current = existing[key];
      const known = current !== undefined && current !== null && String(current).trim() !== "";
      if (known && String(current) === value) return; // idempotent

      if (known) {
        const updated = await run(
          [
            "vercel",
            "env",
            "update",
            name,
            "--environment",
            LAUNCH_ENVIRONMENT,
            "--scope",
            LAUNCH_TEAM,
            "--project",
            LAUNCH_PROJECT,
            "--value",
            value,
            "--yes",
          ],
          { timeoutMs: 120_000 },
        );
        if (updated.code === 0) return;
        // Fall through to remove+add if update unsupported for this var type.
        await this.removeProductionEnv(name);
      }

      const added = await run(
        [
          "vercel",
          "env",
          "add",
          name,
          "--environment",
          LAUNCH_ENVIRONMENT,
          "--scope",
          LAUNCH_TEAM,
          "--project",
          LAUNCH_PROJECT,
          "--value",
          value,
          "--yes",
        ],
        { timeoutMs: 120_000 },
      );
      if (added.code !== 0) {
        throw new Error(`Failed to set ${name} in production: ${redactSecrets(added.stderr || added.stdout)}`);
      }
    },

    async removeProductionEnv(name) {
      const removed = await run(
        [
          "vercel",
          "env",
          "rm",
          name,
          LAUNCH_ENVIRONMENT,
          "--scope",
          LAUNCH_TEAM,
          "--project",
          LAUNCH_PROJECT,
          "--yes",
        ],
        { timeoutMs: 120_000 },
      );
      // Already absent is OK.
      if (removed.code !== 0 && !/not found|does not exist|no environment variable/i.test(removed.stderr + removed.stdout)) {
        throw new Error(`Failed to remove ${name}: ${redactSecrets(removed.stderr || removed.stdout)}`);
      }
    },

    async replaceProductionEnvAsConfig(name, value) {
      // Secrets cannot be converted in place — remove then add as Config.
      await this.removeProductionEnv(name);
      // From here, a failed add is partial recovery: mint is absent until Config is restored.

      const base = [
        "vercel",
        "env",
        "add",
        name,
        "--environment",
        LAUNCH_ENVIRONMENT,
        "--scope",
        LAUNCH_TEAM,
        "--project",
        LAUNCH_PROJECT,
        "--value",
        value,
        "--yes",
      ];

      const asType = await run([...base, "--type", "config"], { timeoutMs: 120_000 });
      if (asType.code === 0) return;

      const asFlag = await run([...base, "--no-sensitive"], { timeoutMs: 120_000 });
      if (asFlag.code === 0) return;

      const detail = redactSecrets(asType.stderr || asType.stdout || asFlag.stderr || asFlag.stdout);
      const error = new Error(
        `PARTIAL RECOVERY: removed Production ${name} but failed to re-add as Config. ${name} may now be ABSENT. Do not deploy. Do not publish or activate. Re-run recover-mint --mint <MINT> after fixing CLI/auth, or add ${name} as Config (--type config / --no-sensitive) in the Vercel dashboard for cope2/rednest Production. Detail: ${detail}`,
      ) as Error & { partialRecovery: true; envName: string };
      error.partialRecovery = true;
      error.envName = name;
      throw error;
    },

    async deployProduction() {
      // Defense in depth — mutating commands must also call assertDeployableSource first.
      const revision = requireCleanApprovedRevision(await git.revision());
      const deployed = await run(
        [
          "vercel",
          "deploy",
          "--prod",
          "--scope",
          LAUNCH_TEAM,
          "--project",
          LAUNCH_PROJECT,
          "--meta",
          `gitCommit=${revision}`,
          "--yes",
        ],
        { timeoutMs: 900_000 },
      );
      if (deployed.code !== 0) {
        throw new Error(`Production deploy failed: ${redactSecrets(deployed.stderr || deployed.stdout)}`);
      }
      const url = extractDeploymentUrl(deployed.stdout + "\n" + deployed.stderr);
      if (!url) throw new Error("Production deploy finished but no deployment URL was found in CLI output.");
      return {
        id: url,
        url,
        readyState: "BUILDING",
        target: "production",
        gitSha: revision,
      };
    },

    async waitUntilReady(deployment, timeoutMs = 600_000) {
      const waited = await run(["vercel", "inspect", deployment.url, "--scope", LAUNCH_TEAM, "--wait", `--timeout`, `${Math.ceil(timeoutMs / 1000)}s`], {
        timeoutMs: timeoutMs + 30_000,
      });
      if (waited.code !== 0) {
        throw new Error(`Deployment did not become Ready: ${redactSecrets(waited.stderr || waited.stdout)}`);
      }
      return { ...deployment, readyState: "READY" };
    },

    async verifyProductionAlias(deployment) {
      const inspected = await run(
        ["vercel", "inspect", PRODUCTION_URL, "--scope", LAUNCH_TEAM, "--json"],
        { timeoutMs: 60_000 },
      );
      if (inspected.code !== 0) {
        throw new Error(
          `Unable to inspect production alias ${PRODUCTION_URL}: ${redactSecrets(inspected.stderr || inspected.stdout)}`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(inspected.stdout);
      } catch {
        throw new Error(`Production alias inspect did not return JSON for ${PRODUCTION_URL}.`);
      }
      const check = evaluateProductionAlias(parsed, deployment);
      if (!check.ok) throw new Error(check.error);
    },

    async latestProductionDeployment() {
      const listed = await run(
        ["vercel", "ls", LAUNCH_PROJECT, "--scope", LAUNCH_TEAM, "--environment", "production", "--json"],
        { timeoutMs: 60_000 },
      );
      if (listed.code !== 0) return null;
      try {
        const parsed = JSON.parse(listed.stdout) as unknown;
        const rows = Array.isArray(parsed) ? parsed : (parsed as { deployments?: unknown[] }).deployments;
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const first = rows[0] as Record<string, unknown>;
        const url = String(first.url ?? first.urlOrAlias ?? "");
        if (!url) return null;
        return {
          id: String(first.uid ?? first.id ?? url),
          url: url.startsWith("http") ? url : `https://${url}`,
          readyState: String(first.readyState ?? first.state ?? "unknown"),
          target: "production",
          createdAt: typeof first.created === "number" ? first.created : undefined,
        };
      } catch {
        return null;
      }
    },
  };
}

export function parseEnvFile(body: string): EnvMap {
  const map: EnvMap = {};
  const wanted = new Set<EnvKey>([ENV_MINT, ENV_MINT_PUBLIC, ENV_HOLDER, ENV_RPC]);
  for (const line of body.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim() as EnvKey;
    if (!wanted.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (isProtectedEnvPlaceholder(value)) {
      map._protected = { ...map._protected, [key]: true };
      // Never store the placeholder as if it were the real mint/flag/RPC value.
      (map as Record<string, string | null>)[key] = null;
      continue;
    }
    (map as Record<string, string | null>)[key] = value;
  }
  for (const key of wanted) {
    if (!(key in map)) (map as Record<string, string | null>)[key] = null;
  }
  return map;
}

export function extractDeploymentUrl(text: string): string | null {
  const m =
    text.match(/https:\/\/rednest-[a-z0-9-]+\.vercel\.app/i) ??
    text.match(/Production:\s+(https:\/\/[^\s]+)/i) ??
    text.match(/(https:\/\/[a-z0-9.-]+\.vercel\.app)/i);
  return m?.[1] ?? m?.[0] ?? null;
}

function hostOf(urlOrHost: string): string {
  try {
    return new URL(urlOrHost.includes("://") ? urlOrHost : `https://${urlOrHost}`).host.toLowerCase();
  } catch {
    return urlOrHost.replace(/^https?:\/\//i, "").split("/")[0]!.toLowerCase();
  }
}

/**
 * Confirms the production alias inspect payload is Ready and attached to rednest.tech.
 * Prefer matching the promoted deployment host when the inspect payload exposes it.
 */
export function evaluateProductionAlias(
  inspectJson: unknown,
  deployment: DeploymentInfo,
): { ok: true } | { ok: false; error: string } {
  if (!inspectJson || typeof inspectJson !== "object") {
    return { ok: false, error: `Production alias ${PRODUCTION_URL} inspect payload was empty.` };
  }
  const row = inspectJson as Record<string, unknown>;
  const readyState = String(row.readyState ?? row.state ?? "").toUpperCase();
  if (readyState !== "READY") {
    return { ok: false, error: `Production alias ${PRODUCTION_URL} is not Ready (state=${readyState || "unknown"}).` };
  }

  const aliasHosts = collectAliasHosts(row);
  const hasCanonical = PRODUCTION_ALIASES.some((host) => aliasHosts.has(host.toLowerCase()));
  if (!hasCanonical) {
    return {
      ok: false,
      error: `Production alias verification failed: ${PRODUCTION_URL} is not attached to the inspected deployment.`,
    };
  }

  const deploymentHost = hostOf(deployment.url);
  if (deploymentHost.endsWith(".vercel.app") && aliasHosts.size > 0) {
    const deploymentHosts = [...aliasHosts].filter((h) => h.endsWith(".vercel.app"));
    if (deploymentHosts.length > 0 && !deploymentHosts.includes(deploymentHost)) {
      return {
        ok: false,
        error: `Production alias does not yet point at deployment ${deployment.url}.`,
      };
    }
  }

  return { ok: true };
}

function collectAliasHosts(row: Record<string, unknown>): Set<string> {
  const aliasHosts = new Set<string>();
  const aliases = row.aliases;
  if (Array.isArray(aliases)) {
    for (const entry of aliases) {
      if (typeof entry === "string") aliasHosts.add(hostOf(entry));
      else if (entry && typeof entry === "object") {
        const obj = entry as { host?: unknown; domain?: unknown; alias?: unknown };
        if (typeof obj.host === "string") aliasHosts.add(hostOf(obj.host));
        if (typeof obj.domain === "string") aliasHosts.add(hostOf(obj.domain));
        if (typeof obj.alias === "string") aliasHosts.add(hostOf(obj.alias));
      }
    }
  }
  if (typeof row.url === "string") aliasHosts.add(hostOf(row.url));
  if (typeof row.alias === "string") aliasHosts.add(hostOf(row.alias));
  return aliasHosts;
}
