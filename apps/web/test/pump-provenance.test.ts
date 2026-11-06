import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  BONDING_CURVE_DISCRIMINATOR,
  PUMP_FUN_PROGRAM_ID,
  bondingCurveAddress,
  verifyPumpFunProvenance,
} from "../src/server/solana/pump-provenance";
import { createPumpClient } from "../scripts/red-launch/solana";

async function samplePubkey(): Promise<PublicKey> {
  return (await Keypair.generate()).publicKey;
}

function encodeCurve(opts: {
  complete: boolean;
  supply?: bigint;
  creator?: PublicKey;
  wrongDisc?: boolean;
  truncate?: boolean;
  badComplete?: number;
}): Buffer {
  const buf = Buffer.alloc(81);
  const disc = opts.wrongDisc
    ? createHash("sha256").update("account:NotBondingCurve").digest().subarray(0, 8)
    : BONDING_CURVE_DISCRIMINATOR;
  disc.copy(buf, 0);
  buf.writeBigUInt64LE(1n, 8);
  buf.writeBigUInt64LE(2n, 16);
  buf.writeBigUInt64LE(3n, 24);
  buf.writeBigUInt64LE(4n, 32);
  buf.writeBigUInt64LE(opts.supply ?? 1_000_000_000_000_000n, 40);
  buf.writeUInt8(opts.badComplete ?? (opts.complete ? 1 : 0), 48);
  const creatorBytes = opts.creator ? Buffer.from(opts.creator.toBytes()) : Buffer.alloc(32, 7);
  creatorBytes.copy(buf, 49);
  return opts.truncate ? buf.subarray(0, 40) : buf;
}

function fakeConnection(account: { owner: PublicKey; data: Buffer } | null): Connection {
  return {
    async getAccountInfo() {
      return account;
    },
  } as unknown as Connection;
}

describe("verifyPumpFunProvenance", () => {
  test("accepts an active bonding-curve account owned by Pump.fun", async () => {
    const mint = await samplePubkey();
    const curve = await bondingCurveAddress(mint);
    expect(curve).toBeInstanceOf(PublicKey);

    const result = await verifyPumpFunProvenance(
      fakeConnection({
        owner: PUMP_FUN_PROGRAM_ID,
        data: encodeCurve({ complete: false, creator: await samplePubkey() }),
      }),
      mint,
    );
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.source).toBe("on_chain_bonding_curve");
      expect(result.complete).toBe(false);
      expect(result.bondingCurve).toBe(curve.toBase58());
      expect(result.tokenTotalSupply).toBe("1000000000000000");
      expect(result.creator).toBeTruthy();
    }
  });

  test("accepts a graduated/migrated bonding-curve (complete=true)", async () => {
    const mint = await samplePubkey();
    const result = await verifyPumpFunProvenance(
      fakeConnection({
        owner: PUMP_FUN_PROGRAM_ID,
        data: encodeCurve({ complete: true }),
      }),
      mint,
    );
    expect(result.verified).toBe(true);
    if (result.verified) expect(result.complete).toBe(true);
  });

  test("rejects missing bonding-curve account (non-Pump.fun token)", async () => {
    const mint = await samplePubkey();
    const result = await verifyPumpFunProvenance(fakeConnection(null), mint);
    expect(result).toEqual({ verified: false, reason: "bonding_curve_absent" });
  });

  test("rejects wrong program owner", async () => {
    const mint = await samplePubkey();
    const result = await verifyPumpFunProvenance(
      fakeConnection({
        owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        data: encodeCurve({ complete: false }),
      }),
      mint,
    );
    expect(result).toEqual({ verified: false, reason: "bonding_curve_wrong_owner" });
  });

  test("rejects truncated or contradictory curve data", async () => {
    const mint = await samplePubkey();
    const truncated = await verifyPumpFunProvenance(
      fakeConnection({
        owner: PUMP_FUN_PROGRAM_ID,
        data: encodeCurve({ complete: false, truncate: true }),
      }),
      mint,
    );
    expect(truncated).toEqual({ verified: false, reason: "bonding_curve_truncated" });

    const badDisc = await verifyPumpFunProvenance(
      fakeConnection({
        owner: PUMP_FUN_PROGRAM_ID,
        data: encodeCurve({ complete: false, wrongDisc: true }),
      }),
      mint,
    );
    expect(badDisc).toEqual({ verified: false, reason: "bonding_curve_bad_discriminator" });

    const zeroSupply = await verifyPumpFunProvenance(
      fakeConnection({
        owner: PUMP_FUN_PROGRAM_ID,
        data: encodeCurve({ complete: false, supply: 0n }),
      }),
      mint,
    );
    expect(zeroSupply).toEqual({ verified: false, reason: "bonding_curve_zero_supply" });

    const badComplete = await verifyPumpFunProvenance(
      fakeConnection({
        owner: PUMP_FUN_PROGRAM_ID,
        data: encodeCurve({ complete: false, badComplete: 7 }),
      }),
      mint,
    );
    expect(badComplete).toEqual({ verified: false, reason: "bonding_curve_bad_complete_flag" });
  });

  test("reports rpc_error when the connection throws", async () => {
    const mint = await samplePubkey();
    const connection = {
      async getAccountInfo() {
        throw new Error("upstream timeout");
      },
    } as unknown as Connection;
    const result = await verifyPumpFunProvenance(connection, mint);
    expect(result).toEqual({ verified: false, reason: "rpc_error" });
  });
});

describe("createPumpClient HTTP 403 resilience", () => {
  test("on-chain success still verifies when Pump.fun HTTP returns 403", async () => {
    const mint = await samplePubkey();
    const curve = await bondingCurveAddress(mint);
    const original = Connection.prototype.getAccountInfo;
    Connection.prototype.getAccountInfo = (async () =>
      ({
        owner: PUMP_FUN_PROGRAM_ID,
        data: encodeCurve({ complete: false }),
        executable: false,
        lamports: 1,
        rentEpoch: 0,
        space: 81n,
      }) as unknown as Awaited<ReturnType<Connection["getAccountInfo"]>>) as typeof Connection.prototype.getAccountInfo;

    try {
      const pump = createPumpClient((async () =>
        new Response("<html>blocked</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch);
      const result = await pump.verifyMint(mint.toBase58(), "https://rpc.test");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source).toBe("on_chain_bonding_curve");
        expect(result.bondingCurve).toBe(curve.toBase58());
        expect(result.name).toBeUndefined();
      }
    } finally {
      Connection.prototype.getAccountInfo = original;
    }
  });
});
