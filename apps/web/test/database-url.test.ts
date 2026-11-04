import { describe, expect, test } from "bun:test";
import { isSupabaseDirectDbHost, runtimeDatabaseUrl } from "@/server/database-url";

describe("runtimeDatabaseUrl", () => {
  test("skips IPv6-only db.<ref>.supabase.co pooler URLs in favour of DATABASE_URL", () => {
    const pooler = "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:6543/postgres";
    const primary = "postgresql://postgres:x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres";
    expect(isSupabaseDirectDbHost(pooler)).toBe(true);
    expect(isSupabaseDirectDbHost(primary)).toBe(false);
    expect(runtimeDatabaseUrl({ DATABASE_POOLER_URL: pooler, DATABASE_URL: primary })).toBe(primary);
  });

  test("keeps a shared Supabase pooler hostname", () => {
    const pooler = "postgresql://postgres.abc:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
    const primary = "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:5432/postgres";
    expect(runtimeDatabaseUrl({ DATABASE_POOLER_URL: pooler, DATABASE_URL: primary })).toBe(pooler);
  });

  test("falls back to the pooler URL when it is the only value", () => {
    const pooler = "postgresql://postgres:x@db.abcdefghijklmnop.supabase.co:6543/postgres";
    expect(runtimeDatabaseUrl({ DATABASE_POOLER_URL: pooler })).toBe(pooler);
  });
});
