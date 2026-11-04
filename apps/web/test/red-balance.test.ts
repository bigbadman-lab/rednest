import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  checkRedHolderBalance,
  minimumRawAmount,
  type RedBalanceRpc,
} from "@/server/solana/red-balance";

function mintInfo(decimals: number) {
  return {
    data: { parsed: { info: { decimals }, type: "mint" }, program: "spl-token" },
  };
}

function tokenAccount(mint: string, owner: string, amount: string, programId: PublicKey, accountPubkey: PublicKey) {
  return {
    pubkey: accountPubkey,
    account: {
      owner: programId,
      data: {
        parsed: {
          info: {
            mint,
            owner,
            tokenAmount: { amount, decimals: 6, uiAmount: null },
          },
          type: "account",
        },
        program: "spl-token",
      },
    },
  };
}

describe("RED balance verification", () => {
  test("minimum raw amount uses integer powers of ten", () => {
    expect(minimumRawAmount(0)).toBe(50_000n);
    expect(minimumRawAmount(6)).toBe(50_000n * 1_000_000n);
  });

  test("sums every token account for the mint program including non-ATA accounts", async () => {
    const wallet = await Keypair.generate();
    const mint = await Keypair.generate();
    const ata = (await Keypair.generate()).publicKey;
    const nonAta = (await Keypair.generate()).publicKey;
    const walletPk = wallet.publicKey.toBase58();
    const mintPk = mint.publicKey.toBase58();
    const need = minimumRawAmount(6);

    let queriedProgram: PublicKey | undefined;
    const rpc: RedBalanceRpc = {
      async getParsedAccountInfo() {
        return { value: { ...mintInfo(6), owner: TOKEN_PROGRAM_ID } };
      },
      async getParsedTokenAccountsByOwner(_owner, filter) {
        queriedProgram = filter.programId;
        // Mint is SPL Token-owned: only that program is queried. Return ATA + non-ATA.
        expect(filter.mint.equals(new PublicKey(mintPk))).toBe(true);
        return {
          value: [
            tokenAccount(mintPk, walletPk, (need / 2n).toString(), TOKEN_PROGRAM_ID, ata),
            tokenAccount(mintPk, walletPk, (need / 2n).toString(), TOKEN_PROGRAM_ID, nonAta),
          ],
        };
      },
    };

    const at = await checkRedHolderBalance({ walletPubkey: walletPk, mint: mintPk, rpc });
    expect(queriedProgram?.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(at).toMatchObject({ ok: true, eligible: true, decimals: 6 });
    if (at.ok) expect(at.rawAmount).toBe(need);

    const lowNonAta = (await Keypair.generate()).publicKey;
    const lowRpc: RedBalanceRpc = {
      async getParsedAccountInfo() {
        return { value: { ...mintInfo(6), owner: TOKEN_PROGRAM_ID } };
      },
      async getParsedTokenAccountsByOwner() {
        return { value: [tokenAccount(mintPk, walletPk, (need - 1n).toString(), TOKEN_PROGRAM_ID, lowNonAta)] };
      },
    };
    const low = await checkRedHolderBalance({ walletPubkey: walletPk, mint: mintPk, rpc: lowRpc });
    expect(low).toMatchObject({ ok: true, eligible: false });
  });

  test("enumerates Token-2022 mint accounts under the mint owner program only", async () => {
    const wallet = await Keypair.generate();
    const mint = await Keypair.generate();
    const a = (await Keypair.generate()).publicKey;
    const b = (await Keypair.generate()).publicKey;
    const walletPk = wallet.publicKey.toBase58();
    const mintPk = mint.publicKey.toBase58();
    const need = minimumRawAmount(6);
    let calls = 0;

    const rpc: RedBalanceRpc = {
      async getParsedAccountInfo() {
        return { value: { ...mintInfo(6), owner: TOKEN_2022_PROGRAM_ID } };
      },
      async getParsedTokenAccountsByOwner(_owner, filter) {
        calls += 1;
        expect(filter.programId?.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
        return {
          value: [
            tokenAccount(mintPk, walletPk, (need / 4n).toString(), TOKEN_2022_PROGRAM_ID, a),
            tokenAccount(mintPk, walletPk, ((need * 3n) / 4n).toString(), TOKEN_2022_PROGRAM_ID, b),
          ],
        };
      },
    };

    const result = await checkRedHolderBalance({ walletPubkey: walletPk, mint: mintPk, rpc });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: true, eligible: true });
    if (result.ok) expect(result.rawAmount).toBe(need);
  });

  test("fails closed on RPC errors and malformed mint or accounts", async () => {
    const wallet = await Keypair.generate();
    const mint = await Keypair.generate();
    const walletPk = wallet.publicKey.toBase58();
    const mintPk = mint.publicKey.toBase58();

    expect(await checkRedHolderBalance({ walletPubkey: "bad", mint: mintPk, rpc: {} as RedBalanceRpc })).toEqual({
      ok: false,
      reason: "invalid_wallet",
    });

    const rpcFail: RedBalanceRpc = {
      async getParsedAccountInfo() {
        throw new Error("network");
      },
      async getParsedTokenAccountsByOwner() {
        return { value: [] };
      },
    };
    expect(await checkRedHolderBalance({ walletPubkey: walletPk, mint: mintPk, rpc: rpcFail })).toEqual({
      ok: false,
      reason: "rpc_error",
    });

    const junkOwner = (await Keypair.generate()).publicKey;
    const badMintOwner: RedBalanceRpc = {
      async getParsedAccountInfo() {
        return { value: { ...mintInfo(6), owner: junkOwner } };
      },
      async getParsedTokenAccountsByOwner() {
        return { value: [] };
      },
    };
    expect(await checkRedHolderBalance({ walletPubkey: walletPk, mint: mintPk, rpc: badMintOwner })).toEqual({
      ok: false,
      reason: "malformed",
    });

    const badAta = (await Keypair.generate()).publicKey;
    const badAccount: RedBalanceRpc = {
      async getParsedAccountInfo() {
        return { value: { ...mintInfo(6), owner: TOKEN_PROGRAM_ID } };
      },
      async getParsedTokenAccountsByOwner() {
        return {
          value: [
            {
              pubkey: badAta,
              account: {
                owner: TOKEN_PROGRAM_ID,
                data: { parsed: { info: { mint: mintPk, owner: "someone-else", tokenAmount: { amount: "1" } } } },
              },
            },
          ],
        };
      },
    };
    expect(await checkRedHolderBalance({ walletPubkey: walletPk, mint: mintPk, rpc: badAccount })).toEqual({
      ok: false,
      reason: "malformed",
    });

    const incompleteRpc: RedBalanceRpc = {
      async getParsedAccountInfo() {
        return { value: { ...mintInfo(6), owner: TOKEN_PROGRAM_ID } };
      },
      async getParsedTokenAccountsByOwner() {
        return { value: null as unknown as [] };
      },
    };
    expect(await checkRedHolderBalance({ walletPubkey: walletPk, mint: mintPk, rpc: incompleteRpc })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
