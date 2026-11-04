/**
 * Choose the runtime Postgres URL for app queries and /api/health.
 *
 * Prefer DATABASE_POOLER_URL when it is a usable shared pooler. Skip
 * `db.<ref>.supabase.co` (IPv6-only without the IPv4 add-on — unreachable
 * from Vercel). When the only IPv4 option is Supabase's session-mode pooler
 * (`*.pooler.supabase.com:5432`, typically capped ~15 clients), rewrite it to
 * transaction mode on port 6543 so serverless instances share the pooler
 * instead of exhausting session slots.
 *
 * Credentials and project-specific hosts are never hardcoded — only port and
 * known hostname patterns are adjusted.
 */
type Env = Record<string, string | undefined>;

export function runtimeDatabaseUrl(env: Env = process.env): string | undefined {
  const pooler = env.DATABASE_POOLER_URL?.trim();
  const primary = env.DATABASE_URL?.trim();

  if (pooler && !isSupabaseDirectDbHost(pooler)) {
    return preferTransactionPooler(pooler) ?? pooler;
  }

  const fallback = primary || pooler;
  if (!fallback) return undefined;
  return preferTransactionPooler(fallback) ?? fallback;
}

/** True for Supabase's direct database hostname (IPv6-only without the add-on). */
export function isSupabaseDirectDbHost(url: string): boolean {
  try {
    return /^db\.[a-z0-9]+\.supabase\.co$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Supabase session pooler is `*.pooler.supabase.com:5432`; transaction mode
 * is the same host on `6543`. Returns a rewritten URL, or undefined when the
 * input is not that session endpoint (leave non-Supabase URLs alone).
 */
export function preferTransactionPooler(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!/\.pooler\.supabase\.com$/i.test(parsed.hostname)) return undefined;
    const port = parsed.port || (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:" ? "5432" : "");
    if (port !== "5432") return undefined;
    parsed.port = "6543";
    return parsed.toString();
  } catch {
    return undefined;
  }
}
