/**
 * The health check behind /api/health: settings usable (see readiness) and
 * the database answering, in setup mode too. Its own one-connection client
 * uses the pooler when set (same path as app queries), and gives up after
 * two seconds. The answer is reused for two seconds, and concurrent checks
 * share one query, so unauthenticated health requests cannot hammer the
 * database.
 *
 * Failures report a coarse `reason` (`configuration` | `database`) with no
 * setting names or values, so operators can tell the two cases apart without
 * leaking secrets.
 */
import { createDb, type Db } from "@sandchest/db";
import { configurationProblem } from "./readiness";

const CACHE_MS = 2_000;
const TIMEOUT_MS = 2_000;

type Env = Record<string, string | undefined>;

export type HealthReason = "configuration" | "database";
export type HealthStatus = { ok: true } | { ok: false; reason: HealthReason };

let probe: { url: string; db: Db } | undefined;
let last: { at: number; status: HealthStatus } | undefined;
let pending: Promise<HealthStatus> | undefined;

export function healthStatus(env: Env = process.env): Promise<HealthStatus> {
  if (last && Date.now() - last.at < CACHE_MS) return Promise.resolve(last.status);
  pending ??= check(env)
    .then((status) => {
      last = { at: Date.now(), status };
      return status;
    })
    .finally(() => (pending = undefined));
  return pending;
}

export async function healthy(env: Env = process.env): Promise<boolean> {
  return (await healthStatus(env)).ok;
}

/** For tests. */
export function resetHealth(): void {
  last = undefined;
}

async function check(env: Env): Promise<HealthStatus> {
  if (configurationProblem(env)) return { ok: false, reason: "configuration" };
  // The path the app's queries take: the pooler when there is one.
  const url = env.DATABASE_POOLER_URL?.trim() || env.DATABASE_URL?.trim();
  if (!url) return { ok: false, reason: "database" };
  if (probe?.url !== url) {
    void probe?.db.$client.end({ timeout: 1 }).catch(() => {});
    probe = { url, db: createDb(url, { max: 1, connectTimeout: TIMEOUT_MS / 1000 }) };
  }
  const client = probe.db.$client;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), TIMEOUT_MS)));
  try {
    const ok = await Promise.race([client`select 1`.then(() => true as const), timeout]);
    return ok ? { ok: true } : { ok: false, reason: "database" };
  } catch {
    return { ok: false, reason: "database" };
  } finally {
    clearTimeout(timer);
  }
}
