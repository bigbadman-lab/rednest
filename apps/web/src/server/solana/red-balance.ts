/**
 * Server-only $NEST SPL balance check. Fail-closed: any RPC or parse ambiguity
 * yields insufficient/unavailable rather than eligibility.
 *
 * Enumerates every token account owned by the wallet for the canonical mint
 * under the mint's actual token program (SPL Token or Token-2022), including
 * non-associated accounts. Never trusts client-reported balances.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { canonicalSolanaPubkey } from "./pubkey";

export const RED_HOLDER_MINIMUM_WHOLE = 50_000n;

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export type RedBalanceResult =
  | { ok: true; rawAmount: bigint; decimals: number; wholeTokens: bigint; eligible: boolean }
  | { ok: false; reason: "invalid_mint" | "invalid_wallet" | "rpc_error" | "malformed" };

export type RedBalanceRpc = {
  getParsedAccountInfo(address: PublicKey): Promise<{
    value: null | {
      data: unknown;
      owner: PublicKey;
    };
  }>;
  getParsedTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey; programId?: PublicKey },
  ): Promise<{
    value: Array<{
      pubkey: PublicKey;
      account: {
        owner: PublicKey;
        data: unknown;
      };
    }>;
  }>;
};

function readParsedInfo(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const parsed = (data as { parsed?: unknown }).parsed;
  if (!parsed || typeof parsed !== "object") return null;
  const info = (parsed as { info?: unknown }).info;
  if (!info || typeof info !== "object") return null;
  return info as Record<string, unknown>;
}

function parseAmount(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw >= 0n ? raw : null;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  return null;
}

export type MintDecimalsError = "rpc_error" | "account_absent" | "not_a_mint" | "malformed";

/** Reads mint decimals and owning token program from a trusted RPC mint account. */
export async function readMintDecimals(
  rpc: RedBalanceRpc,
  mint: PublicKey,
): Promise<{ decimals: number; ownerProgram: PublicKey } | { error: MintDecimalsError }> {
  let account: Awaited<ReturnType<RedBalanceRpc["getParsedAccountInfo"]>>;
  try {
    account = await rpc.getParsedAccountInfo(mint);
  } catch {
    return { error: "rpc_error" };
  }
  if (!account.value) return { error: "account_absent" };
  const owner = account.value.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) return { error: "not_a_mint" };
  const info = readParsedInfo(account.value.data);
  if (!info) return { error: "malformed" };
  const decimals = info.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return { error: "malformed" };
  }
  return { decimals, ownerProgram: owner };
}

/**
 * Sums raw token amounts for `wallet` holding `mint` under `programId`.
 * Uses getParsedTokenAccountsByOwner(mint filter) so every token account for
 * that mint is included (ATA and non-ATA). Validates owner, mint and program.
 */
export async function sumMintBalance(
  rpc: RedBalanceRpc,
  wallet: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
): Promise<{ rawAmount: bigint } | { error: "rpc_error" | "malformed" }> {
  if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) {
    return { error: "malformed" };
  }

  let accounts: Awaited<ReturnType<RedBalanceRpc["getParsedTokenAccountsByOwner"]>>;
  try {
    accounts = await rpc.getParsedTokenAccountsByOwner(wallet, { mint, programId });
  } catch {
    return { error: "rpc_error" };
  }
  if (!accounts || !Array.isArray(accounts.value)) return { error: "malformed" };

  let total = 0n;
  for (const entry of accounts.value) {
    if (!entry?.account?.owner?.equals(programId)) return { error: "malformed" };
    const info = readParsedInfo(entry.account.data);
    if (!info) return { error: "malformed" };
    const tokenMint = typeof info.mint === "string" ? info.mint : null;
    const tokenOwner = typeof info.owner === "string" ? info.owner : null;
    if (!tokenMint || !tokenOwner) return { error: "malformed" };
    if (tokenMint !== mint.toBase58()) return { error: "malformed" };
    if (tokenOwner !== wallet.toBase58()) return { error: "malformed" };
    const tokenAmount = info.tokenAmount;
    if (!tokenAmount || typeof tokenAmount !== "object") return { error: "malformed" };
    const amount = parseAmount((tokenAmount as { amount?: unknown }).amount);
    if (amount === null) return { error: "malformed" };
    total += amount;
  }
  return { rawAmount: total };
}

/** Whole-token threshold as raw units for the mint's decimals. */
export function minimumRawAmount(decimals: number, whole = RED_HOLDER_MINIMUM_WHOLE): bigint {
  return whole * 10n ** BigInt(decimals);
}

/**
 * Full eligibility balance check. Pass a Connection or a test double.
 * When `rpcUrl` is provided, a Connection is constructed (production path).
 */
export async function checkRedHolderBalance(input: {
  walletPubkey: string;
  mint: string;
  rpc?: RedBalanceRpc;
  rpcUrl?: string;
}): Promise<RedBalanceResult> {
  const walletCanon = canonicalSolanaPubkey(input.walletPubkey);
  const mintCanon = canonicalSolanaPubkey(input.mint);
  if (!walletCanon) return { ok: false, reason: "invalid_wallet" };
  if (!mintCanon) return { ok: false, reason: "invalid_mint" };

  let wallet: PublicKey;
  let mint: PublicKey;
  try {
    wallet = new PublicKey(walletCanon);
    mint = new PublicKey(mintCanon);
  } catch {
    return { ok: false, reason: "invalid_mint" };
  }

  const rpc: RedBalanceRpc =
    input.rpc ??
    (() => {
      if (!input.rpcUrl?.trim()) throw new Error("rpcUrl required");
      return new Connection(input.rpcUrl.trim(), { commitment: "confirmed" });
    })();

  let mintMeta: { decimals: number; ownerProgram: PublicKey } | { error: MintDecimalsError };
  try {
    mintMeta = await readMintDecimals(rpc, mint);
  } catch {
    return { ok: false, reason: "rpc_error" };
  }
  if ("error" in mintMeta) {
    // Balance API stays fail-closed with the existing reason vocabulary.
    return { ok: false, reason: mintMeta.error === "rpc_error" ? "rpc_error" : "malformed" };
  }

  const summed = await sumMintBalance(rpc, wallet, mint, mintMeta.ownerProgram);
  if ("error" in summed) return { ok: false, reason: summed.error };

  const need = minimumRawAmount(mintMeta.decimals);
  const wholeTokens = summed.rawAmount / 10n ** BigInt(mintMeta.decimals);
  return {
    ok: true,
    rawAmount: summed.rawAmount,
    decimals: mintMeta.decimals,
    wholeTokens,
    eligible: summed.rawAmount >= need,
  };
}
