/**
 * Server-side Solana preflight for launch activation when SOLANA_RPC_URL is a
 * Vercel Secret ([SENSITIVE] on CLI pull). Uses the runtime RPC from env and
 * never returns the URL or credentials.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  checkRedHolderBalance,
  readMintDecimals,
} from "./solana/red-balance";
import { canonicalSolanaPubkey } from "./solana/pubkey";

/** Same throwaway wallet the launch CLI uses for getParsedTokenAccountsByOwner. */
const RPC_PROBE_WALLET = "11111111111111111111111111111111";

const PUMP_COIN_URL = (mint: string) => `https://frontend-api-v3.pump.fun/coins-v2/${mint}`;

export type LaunchSolanaPreflight =
  | {
      ok: true;
      mint: string;
      decimals: number;
      tokenProgram: "spl-token" | "token-2022";
      pumpFun: { verified: true; name?: string; symbol?: string };
    }
  | { ok: false; error: string };

export async function runLaunchSolanaPreflight(
  expectedMint: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
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

  let pumpName: string | undefined;
  let pumpSymbol: string | undefined;
  try {
    const res = await fetchImpl(PUMP_COIN_URL(mint), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return { ok: false, error: "pump_fun_unverified:not_found_on_pump_fun" };
    if (!res.ok) return { ok: false, error: `pump_fun_unverified:pump_api_http_${res.status}` };
    const body = (await res.json()) as { mint?: string; name?: string; symbol?: string };
    const bodyMint = typeof body.mint === "string" ? canonicalSolanaPubkey(body.mint) : null;
    if (!bodyMint || bodyMint !== mint) return { ok: false, error: "pump_fun_unverified:pump_mint_mismatch" };
    pumpName = body.name;
    pumpSymbol = body.symbol;
  } catch (error) {
    const message = error instanceof Error ? error.message : "network_error";
    return { ok: false, error: `pump_fun_unverified:pump_unreachable:${message}` };
  }

  return {
    ok: true,
    mint,
    decimals: meta.decimals,
    tokenProgram,
    pumpFun: { verified: true, name: pumpName, symbol: pumpSymbol },
  };
}
