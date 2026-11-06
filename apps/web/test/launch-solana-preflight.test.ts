import { afterEach, describe, expect, test } from "bun:test";
import { POST } from "../src/app/api/launch/solana-preflight/route";
import { resetConfig } from "../src/server/config";
import { runLaunchSolanaPreflight } from "../src/server/launch-solana-preflight";

const TOKEN = "operator-token-for-rednest-solana-preflight";

afterEach(() => {
  delete process.env.SANDCHEST_ADMIN_TOKEN;
  resetConfig();
});

describe("runLaunchSolanaPreflight", () => {
  test("rejects invalid mint without touching RPC", async () => {
    const result = await runLaunchSolanaPreflight("not-a-mint", {
      RED_TOKEN_MINT: "not-a-mint",
      SOLANA_RPC_URL: "https://example.invalid",
    });
    expect(result).toEqual({ ok: false, error: "invalid_mint" });
  });

  test("rejects mint mismatch against production Config", async () => {
    const result = await runLaunchSolanaPreflight("11111111111111111111111111111111", {
      RED_TOKEN_MINT: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      SOLANA_RPC_URL: "https://example.invalid",
    });
    expect(result).toEqual({ ok: false, error: "production_mint_mismatch" });
  });

  test("rejects missing production RPC without leaking URLs", async () => {
    const mint = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const result = await runLaunchSolanaPreflight(mint, { RED_TOKEN_MINT: mint });
    expect(result).toEqual({ ok: false, error: "rpc_unconfigured" });
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });
});

describe("POST /api/launch/solana-preflight", () => {
  test("rejects unauthenticated callers", async () => {
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused",
      GITHUB_WEBHOOK_SECRET: "unused",
      SANDCHEST_APP_URL: "https://sandchest.test",
      SANDCHEST_ADMIN_TOKEN: TOKEN,
    });
    resetConfig();

    const res = await POST(
      new Request("https://rednest.tech/api/launch/solana-preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unauthorized");
  });
});
