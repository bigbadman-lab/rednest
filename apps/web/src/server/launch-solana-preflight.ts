/**
 * Server-side Solana preflight for launch activation when SOLANA_RPC_URL is a
 * Vercel Secret ([SENSITIVE] on CLI pull). Uses the runtime RPC from env and
 * never returns the URL or credentials.
 *
 * Pump.fun identity is verified via the on-chain bonding-curve PDA, not the
 * bot-gated frontend HTTP API.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  checkRedHolderBalance,
  readMintDecimals,
} from "./solana/red-balance";
import { verifyPumpFunProvenance } from "./solana/pump-provenance";
import { canonicalSolanaPubkey } from "./solana/pubkey";

/** Same throwaway wallet the launch CLI uses for getParsedTokenAccountsByOwner. */
const RPC_PROBE_WALLET = "11111111111111111111111111111111";

export type LaunchSolanaPreflight =
  | {
      ok: true;
      mint: string;
      decimals: number;
      tokenProgram: "spl-token" | "token-2022";
      pumpFun: {
        verified: true;
        name?: string;
        symbol?: string;
        bondingCurve?: string;
        complete?: boolean;
        source: "on_chain_bonding_curve";
      };
    }
  | { ok: false; error: string };

export async function runLaunchSolanaPreflight(
  expectedMint: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LaunchSolanaPreflight> {
  const mint = canonicalSolanaPubkey(expectedMint);
  if (!mint) return { ok: false, error: "invalid_mint" };

  const configuredMint = canonicalSolanaPubkey(env.RED_TOKEN_MINT?.trim() || "");
  if (!configuredMint) return { ok: false, error: "production_mint_unconfigured" };
  if (configuredMint !== mint) return { ok: false, error: "production_mint_mismatch" };

  const rpcUrl = env.SOLANA_RPC_URL?.trim() || "";
  if (!rpcUrl) return { ok: false, error: "rpc_unconfigured" };

  let connection: Connection;
  try {
    connection = new Connection(rpcUrl, { commitment: "confirmed" });
  } catch {
    return { ok: false, error: "rpc_error" };
  }

  const meta = await readMintDecimals(connection, new PublicKey(mint));
  if ("error" in meta) {
    if (meta.error === "account_absent") return { ok: false, error: "account_absent" };
    if (meta.error === "not_a_mint") return { ok: false, error: "not_a_mint" };
    return { ok: false, error: meta.error };
  }

  let tokenProgram: "spl-token" | "token-2022";
  if (meta.ownerProgram.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = "token-2022";
  else if (meta.ownerProgram.equals(TOKEN_PROGRAM_ID)) tokenProgram = "spl-token";
  else return { ok: false, error: "unsupported_token_program" };

  const probe = await checkRedHolderBalance({
    walletPubkey: RPC_PROBE_WALLET,
    mint,
    rpcUrl,
  });
  if (!probe.ok) return { ok: false, error: `rpc_probe_failed:${probe.reason}` };

  const provenance = await verifyPumpFunProvenance(connection, mint);
  if (!provenance.verified) {
    return { ok: false, error: `pump_fun_unverified:${provenance.reason}` };
  }

  return {
    ok: true,
    mint,
    decimals: meta.decimals,
    tokenProgram,
    pumpFun: {
      verified: true,
      bondingCurve: provenance.bondingCurve,
      complete: provenance.complete,
      source: "on_chain_bonding_curve",
    },
  };
}
