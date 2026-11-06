import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  checkRedHolderBalance,
  readMintDecimals,
} from "../../src/server/solana/red-balance";
import { verifyPumpFunProvenance } from "../../src/server/solana/pump-provenance";
import { canonicalSolanaPubkey } from "../../src/server/solana/pubkey";
import { PUMP_COIN_URL } from "./config";
import { redactSecrets } from "./sanitize";
import type { MintInspection, MintOnChain, PumpClient, SolanaClient } from "./types";

/** Valid throwaway wallet used only to exercise getParsedTokenAccountsByOwner. */
export const RPC_PROBE_WALLET = "11111111111111111111111111111111";

export function createSolanaClient(): SolanaClient {
  const client: SolanaClient = {
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
      if ("error" in meta) {
        if (meta.error === "account_absent") return { error: "account_absent" };
        if (meta.error === "not_a_mint") return { error: "not_a_mint" };
        return { error: meta.error };
      }

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

    async probeHolderInfrastructure(mintRaw, rpcUrl) {
      const onChain = await client.inspectMint(mintRaw, rpcUrl);
      if ("error" in onChain) return { ok: false, error: onChain.error };

      const probe = await client.checkBalance({
        walletPubkey: RPC_PROBE_WALLET,
        mint: onChain.mint,
        rpcUrl,
      });
      if (!probe.ok) {
        return { ok: false, error: `rpc_probe_failed:${probe.reason}` };
      }
      return { ok: true, mint: onChain };
    },
  };
  return client;
}

/**
 * Optional HTTP enrichment only. 403/bot blocks and network failures are ignored
 * when on-chain provenance already succeeded.
 */
async function optionalPumpHttpMetadata(
  mint: string,
  fetchImpl: typeof fetch,
): Promise<{ name?: string; symbol?: string }> {
  try {
    const res = await fetchImpl(PUMP_COIN_URL(mint), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return {};
    const body = (await res.json()) as { mint?: string; name?: string; symbol?: string };
    const bodyMint = typeof body.mint === "string" ? canonicalSolanaPubkey(body.mint) : null;
    if (!bodyMint || bodyMint !== mint) return {};
    return { name: body.name, symbol: body.symbol };
  } catch {
    return {};
  }
}

export function createPumpClient(fetchImpl: typeof fetch = fetch): PumpClient {
  return {
    async verifyMint(mintRaw, rpcUrl) {
      const canon = canonicalSolanaPubkey(mintRaw);
      if (!canon) return { ok: false, reason: "invalid_mint" };
      if (!rpcUrl?.trim()) return { ok: false, reason: "missing_rpc" };

      let connection: Connection;
      try {
        connection = new Connection(rpcUrl.trim(), { commitment: "confirmed" });
      } catch {
        return { ok: false, reason: "rpc_error" };
      }

      const provenance = await verifyPumpFunProvenance(connection, canon);
      if (!provenance.verified) {
        return { ok: false, reason: redactSecrets(provenance.reason) };
      }

      const meta = await optionalPumpHttpMetadata(canon, fetchImpl);
      return {
        ok: true,
        bondingCurve: provenance.bondingCurve,
        complete: provenance.complete,
        source: "on_chain_bonding_curve",
        ...meta,
      };
    },
  };
}

/** On-chain mint check + Pump.fun bonding-curve provenance. Pubkey alone is never enough. */
export async function requireVerifiedPumpMint(
  solana: SolanaClient,
  pump: PumpClient,
  mintRaw: string,
  rpcUrl: string,
): Promise<MintInspection | { error: string }> {
  const onChain = await solana.inspectMint(mintRaw, rpcUrl);
  if ("error" in onChain) return onChain;

  const pumpResult = await pump.verifyMint(onChain.mint, rpcUrl);
  if (!pumpResult.ok) {
    return { error: `pump_fun_unverified:${pumpResult.reason}` };
  }
  return {
    ...onChain,
    pumpFun: {
      verified: true,
      name: pumpResult.name,
      symbol: pumpResult.symbol,
      bondingCurve: pumpResult.bondingCurve,
      complete: pumpResult.complete,
      source: "on_chain_bonding_curve",
    },
  };
}
