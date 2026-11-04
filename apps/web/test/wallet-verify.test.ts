import { describe, expect, test } from "bun:test";
import { hashes, sign } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { canonicalSolanaPubkey } from "@/server/solana/pubkey";
import { verifySolanaMessageSignature } from "@/server/solana/verify-message";

hashes.sha512 = sha512;

describe("Solana message verification", () => {
  test("accepts a valid signature and rejects tampering", async () => {
    const kp = await Keypair.generate();
    const message = "RedNest wallet verification\nDomain: rednest.tech\nNonce: abc";
    const sig = await sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32));
    const pubkey = kp.publicKey.toBase58();
    expect(canonicalSolanaPubkey(pubkey)).toBe(pubkey);
    expect(
      await verifySolanaMessageSignature({
        walletPubkey: pubkey,
        message,
        signature: bs58.encode(sig),
      }),
    ).toBe(true);
    expect(
      await verifySolanaMessageSignature({
        walletPubkey: pubkey,
        message: message + "x",
        signature: bs58.encode(sig),
      }),
    ).toBe(false);
    expect(
      await verifySolanaMessageSignature({
        walletPubkey: pubkey,
        message,
        signature: Buffer.from(sig).toString("base64"),
      }),
    ).toBe(true);
  });

  test("rejects invalid pubkeys and signatures", async () => {
    expect(canonicalSolanaPubkey("not-a-key")).toBeNull();
    expect(await verifySolanaMessageSignature({ walletPubkey: "nope", message: "x", signature: "aa" })).toBe(false);
  });
});
