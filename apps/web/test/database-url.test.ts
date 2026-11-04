import { describe, expect, test } from "bun:test";
import { isSupabaseDirectDbHost, preferTransactionPooler, runtimeDatabaseUrl } from "@/server/database-url";

describe("runtimeDatabaseUrl", () => {
  test("skips IPv6-only db.<ref>.supabase.co and rewrites session DATABASE_URL to transaction port", () => {
    const pooler = "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:6543/postgres";
    const primary = "postgresql://postgres.abcdefghijklmnop:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
    expect(isSupabaseDirectDbHost(pooler)).toBe(true);
    expect(runtimeDatabaseUrl({ DATABASE_POOLER_URL: pooler, DATABASE_URL: primary })).toBe(
      "postgresql://postgres.abcdefghijklmnop:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    );
  });

  test("keeps a shared Supabase transaction pooler hostname", () => {
    const pooler = "postgresql://postgres.abc:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
    const primary = "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres";
    expect(runtimeDatabaseUrl({ DATABASE_POOLER_URL: pooler, DATABASE_URL: primary })).toBe(pooler);
  });

  test("rewrites a session-mode pooler URL used as DATABASE_POOLER_URL", () => {
    const pooler = "postgresql://postgres.abc:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
    expect(runtimeDatabaseUrl({ DATABASE_POOLER_URL: pooler })).toBe(
      "postgresql://postgres.abc:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    );
  });

  test("falls back to the pooler URL when it is the only value", () => {
    const pooler = "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:6543/postgres";
    expect(runtimeDatabaseUrl({ DATABASE_POOLER_URL: pooler })).toBe(pooler);
  });

  test("leaves non-Supabase URLs unchanged", () => {
    const url = "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
    expect(preferTransactionPooler(url)).toBeUndefined();
    expect(runtimeDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });
});
