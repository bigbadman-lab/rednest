/**
 * Choose the runtime Postgres URL for app queries and /api/health.
 *
 * Prefer DATABASE_POOLER_URL when it is a shared pooler. Skip
 * `db.<ref>.supabase.co`, which is IPv6-only unless the project buys the
 * IPv4 add-on — Vercel serverless cannot reach it, so fall back to
 * DATABASE_URL (typically `*.pooler.supabase.com`, which has A records).
 */
type Env = Record<string, string | undefined>;

export function runtimeDatabaseUrl(env: Env = process.env): string | undefined {
  const pooler = env.DATABASE_POOLER_URL?.trim();
  const primary = env.DATABASE_URL?.trim();
  if (pooler && !isSupabaseDirectDbHost(pooler)) return pooler;
  return primary || pooler || undefined;
}

/** True for Supabase's direct database hostname (IPv6-only without the add-on). */
export function isSupabaseDirectDbHost(url: string): boolean {
  try {
    return /^db\.[a-z0-9]+\.supabase\.co$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
