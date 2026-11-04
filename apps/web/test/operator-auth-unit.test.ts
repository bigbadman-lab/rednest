/**
 * Operator bearer-token boundary (no Postgres).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isOperator } from "@/server/auth";
import { resetConfig } from "@/server/config";

const TOKEN = "operator-token-for-rednest-entitlement-fix";

afterEach(() => {
  delete process.env.SANDCHEST_ADMIN_TOKEN;
  resetConfig();
});

describe("isOperator admin-token boundary", () => {
  test("rejects missing or wrong bearer tokens; accepts the configured admin token", () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused",
      GITHUB_WEBHOOK_SECRET: "unused",
      SANDCHEST_APP_URL: "https://sandchest.test",
      SANDCHEST_ADMIN_TOKEN: TOKEN,
    });
    resetConfig();
    expect(isOperator(new Request("https://sandchest.test/api/scans", { method: "POST" }))).toBe(false);
    expect(
      isOperator(
        new Request("https://sandchest.test/api/scans", {
          method: "POST",
          headers: { authorization: "Bearer wrong-token-that-is-long-enough" },
        }),
      ),
    ).toBe(false);
    expect(
      isOperator(
        new Request("https://sandchest.test/api/scans", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      ),
    ).toBe(true);
  });

  test("rejects all requests when SANDCHEST_ADMIN_TOKEN is unset", () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused",
      GITHUB_WEBHOOK_SECRET: "unused",
      SANDCHEST_APP_URL: "https://sandchest.test",
    });
    delete process.env.SANDCHEST_ADMIN_TOKEN;
    resetConfig();
    expect(
      isOperator(
        new Request("https://sandchest.test/api/scans", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      ),
    ).toBe(false);
  });
});
