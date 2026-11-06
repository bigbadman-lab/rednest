/**
 * Deterministic, read-only Pump.fun provenance from on-chain bonding-curve PDAs.
 *
 * The frontend-api-v3.pump.fun HTTP surface is bot-gated (403 → static.pump.fun/blocked)
 * and must not be the sole source of truth. A mint suffix of "pump" is never evidence.
 *
 * Evidence: PDA seeds ["bonding-curve", mint] under program
 * 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P, Anchor BondingCurve discriminator,
 * program ownership, and a decodable curve layout (works for active and graduated curves).
 */
import { createHash } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";

/** Official Pump.fun program (mainnet + devnet). */
export const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/** sha256("account:BondingCurve")[0..8] — verified against live mainnet accounts. */
export const BONDING_CURVE_DISCRIMINATOR = createHash("sha256")
  .update("account:BondingCurve")
  .digest()
  .subarray(0, 8);

const MIN_CURVE_LEN = 49; // discriminator(8) + 5×u64(40) + complete(1)

export type PumpFunProvenance =
  | {
      verified: true;
      bondingCurve: string;
      complete: boolean;
      tokenTotalSupply: string;
      creator?: string;
      source: "on_chain_bonding_curve";
    }
  | { verified: false; reason: string };

function mintBytes(mint: PublicKey): Buffer {
  return Buffer.from(mint.toBytes());
}

export async function bondingCurveAddress(mint: PublicKey): Promise<PublicKey> {
  const [pda] = await PublicKey.findProgramAddress(
    [Buffer.from("bonding-curve"), mintBytes(mint)],
    PUMP_FUN_PROGRAM_ID,
  );
  return pda;
}

/**
 * Verify Pump.fun creation/migration provenance for an exact mint.
 * Fail-closed on missing, wrong-owner, malformed, or contradictory curve accounts.
 */
export async function verifyPumpFunProvenance(
  connection: Connection,
  mintInput: PublicKey | string,
): Promise<PumpFunProvenance> {
  let mint: PublicKey;
  try {
    mint = typeof mintInput === "string" ? new PublicKey(mintInput) : mintInput;
  } catch {
    return { verified: false, reason: "invalid_mint" };
  }

  let curve: PublicKey;
  try {
    curve = await bondingCurveAddress(mint);
  } catch {
    return { verified: false, reason: "bonding_curve_pda_failed" };
  }

  let info: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    info = await connection.getAccountInfo(curve);
  } catch {
    return { verified: false, reason: "rpc_error" };
  }

  if (!info) return { verified: false, reason: "bonding_curve_absent" };
  if (!info.owner.equals(PUMP_FUN_PROGRAM_ID)) {
    return { verified: false, reason: "bonding_curve_wrong_owner" };
  }
  if (info.data.length < MIN_CURVE_LEN) {
    return { verified: false, reason: "bonding_curve_truncated" };
  }

  const data = Buffer.from(info.data);
  if (!data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) {
    return { verified: false, reason: "bonding_curve_bad_discriminator" };
  }

  const tokenTotalSupply = data.readBigUInt64LE(40);
  if (tokenTotalSupply <= 0n) {
    return { verified: false, reason: "bonding_curve_zero_supply" };
  }

  const complete = data.readUInt8(48) === 1;
  // complete may be true after graduation; the account persists — both states are valid Pump.fun.
  if (data.readUInt8(48) > 1) {
    return { verified: false, reason: "bonding_curve_bad_complete_flag" };
  }

  const result: Extract<PumpFunProvenance, { verified: true }> = {
    verified: true,
    bondingCurve: curve.toBase58(),
    complete,
    tokenTotalSupply: tokenTotalSupply.toString(),
    source: "on_chain_bonding_curve",
  };
  if (data.length >= 81) {
    try {
      result.creator = new PublicKey(data.subarray(49, 81)).toBase58();
    } catch {
      return { verified: false, reason: "bonding_curve_bad_creator" };
    }
  }
  return result;
}
