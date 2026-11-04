import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  checkRedHolderBalance,
  readMintDecimals,
} from "../../src/server/solana/red-balance";
import { canonicalSolanaPubkey } from "../../src/server/solana/pubkey";
import { PUMP_COIN_URL } from "./config";
import type { MintInspection, MintOnChain, PumpClient, SolanaClient } from "./types";

export function createSolanaClient(): SolanaClient {
  return {
    async inspectMint(mintRaw, rpcUrl) {
      const mint = canonicalSolanaPubkey(mintRaw);
      if (!mint) return { error: "invalid_mint" };
      if (!rpcUrl?.trim()) return { error: "missing_rpc" };

      let connection: Connection;
      try {
        connection = new Connection(rpcUrl.trim(), { commitment: "confirmed" });
      } catch {
        return { error: "rpc_error" };
      }

      const meta = await readMintDecimals(connection, new PublicKey(mint));
      if ("error" in meta) return { error: meta.error };

      let tokenProgram: MintOnChain["tokenProgram"];
      if (meta.ownerProgram.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = "token-2022";
      else if (meta.ownerProgram.equals(TOKEN_PROGRAM_ID)) tokenProgram = "spl-token";
      else return { error: "unsupported_token_program" };

      return {
        mint,
        decimals: meta.decimals,
        tokenProgram,
        tokenProgramId: meta.ownerProgram.toBase58(),
      };
    },

    async checkBalance(input) {
      return checkRedHolderBalance(input);
    },
  };
}

export function createPumpClient(fetchImpl: typeof fetch = fetch): PumpClient {
  return {
    async lookupCoin(mint) {
      const canon = canonicalSolanaPubkey(mint);
      if (!canon) return { ok: false, reason: "invalid_mint" };
      try {
        const res = await fetchImpl(PUMP_COIN_URL(canon), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 404) return { ok: false, reason: "not_found_on_pump_fun" };
        if (!res.ok) return { ok: false, reason: `pump_api_http_${res.status}` };
        const body = (await res.json()) as { mint?: string; name?: string; symbol?: string };
        const bodyMint = typeof body.mint === "string" ? canonicalSolanaPubkey(body.mint) : null;
        if (!bodyMint || bodyMint !== canon) return { ok: false, reason: "pump_mint_mismatch" };
        return { ok: true, name: body.name, symbol: body.symbol };
      } catch (error) {
        const message = error instanceof Error ? error.message : "network_error";
        return { ok: false, reason: `pump_unreachable:${message}` };
      }
    },
  };
}

/** On-chain mint check + Pump.fun coins-v2 lookup. Pubkey alone is never enough. */
export async function requireVerifiedPumpMint(
  solana: SolanaClient,
  pump: PumpClient,
  mintRaw: string,
  rpcUrl: string,
): Promise<MintInspection | { error: string }> {
  const onChain = await solana.inspectMint(mintRaw, rpcUrl);
  if ("error" in onChain) return onChain;

  const pumpResult = await pump.lookupCoin(onChain.mint);
  if (!pumpResult.ok) {
    return { error: `pump_fun_unverified:${pumpResult.reason}` };
  }
  return {
    ...onChain,
    pumpFun: { verified: true, name: pumpResult.name, symbol: pumpResult.symbol },
  };
}
