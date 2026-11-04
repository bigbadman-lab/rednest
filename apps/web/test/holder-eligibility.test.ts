import { describe, expect, test } from "bun:test";
import { createHolderEligibilityProvider } from "@/server/holder-eligibility";
import type { RedBalanceResult } from "@/server/solana/red-balance";

describe("holder eligibility provider", () => {
  test("stays not_activated when launch flag or mint is missing", async () => {
    const provider = createHolderEligibilityProvider({
      config: () => ({ enabled: false, mint: null, rpcUrl: null }),
      activeWallet: async () => ({ id: "w", userId: "u", walletPubkey: "x", verifiedAt: new Date() }),
      balance: async () => ({ ok: true, rawAmount: 0n, decimals: 0, wholeTokens: 0n, eligible: true }),
    });
    expect(await provider("u")).toBe("not_activated");

    const noMint = createHolderEligibilityProvider({
      config: () => ({ enabled: true, mint: null, rpcUrl: "https://example.invalid" }),
      activeWallet: async () => ({ id: "w", userId: "u", walletPubkey: "x", verifiedAt: new Date() }),
      balance: async () => ({ ok: true, rawAmount: 0n, decimals: 0, wholeTokens: 0n, eligible: true }),
    });
    expect(await noMint("u")).toBe("not_activated");
  });

  test("maps wallet and balance outcomes when activated", async () => {
    const balance = async (input: { walletPubkey: string }): Promise<RedBalanceResult> => {
      if (input.walletPubkey === "low") {
        return { ok: true, rawAmount: 1n, decimals: 0, wholeTokens: 1n, eligible: false };
      }
      if (input.walletPubkey === "rpc") return { ok: false, reason: "rpc_error" };
      return { ok: true, rawAmount: 50_000n, decimals: 0, wholeTokens: 50_000n, eligible: true };
    };
    const base = {
      config: () => ({
        enabled: true,
        mint: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        rpcUrl: "https://example.invalid",
      }),
      balance,
    };

    expect(
      await createHolderEligibilityProvider({
        ...base,
        activeWallet: async () => null,
      })("u"),
    ).toBe("no_wallet");

    expect(
      await createHolderEligibilityProvider({
        ...base,
        activeWallet: async () => ({ id: "w", userId: "u", walletPubkey: "low", verifiedAt: new Date() }),
      })("u"),
    ).toBe("insufficient_balance");

    expect(
      await createHolderEligibilityProvider({
        ...base,
        activeWallet: async () => ({ id: "w", userId: "u", walletPubkey: "rpc", verifiedAt: new Date() }),
      })("u"),
    ).toBe("unavailable");

    expect(
      await createHolderEligibilityProvider({
        ...base,
        activeWallet: async () => ({ id: "w", userId: "u", walletPubkey: "ok", verifiedAt: new Date() }),
      })("u"),
    ).toBe("eligible");
  });
});
