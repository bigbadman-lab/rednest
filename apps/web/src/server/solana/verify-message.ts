/**
 * Ed25519 verification for Solana wallet `signMessage` results.
 * Accepts base58 or base64 signatures; message must match the server challenge exactly.
 */
import { hashes, verify } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// @noble/ed25519 v3 requires an explicit SHA-512 implementation.
hashes.sha512 = sha512;

function decodeSignature(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const as58 = bs58.decode(trimmed);
    if (as58.length === 64) return as58;
  } catch {
    // fall through to base64
  }
  try {
    const as64 = Buffer.from(trimmed, "base64");
    if (as64.length === 64) return new Uint8Array(as64);
  } catch {
    return null;
  }
  return null;
}

/** True when `signature` is a valid Ed25519 signature of exact `message` by `walletPubkey`. */
export async function verifySolanaMessageSignature(input: {
  walletPubkey: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  const sig = decodeSignature(input.signature);
  if (!sig) return false;
  let publicKey: Uint8Array;
  try {
    publicKey = new PublicKey(input.walletPubkey).toBytes();
  } catch {
    return false;
  }
  const message = new TextEncoder().encode(input.message);
  try {
    return await verify(sig, message, publicKey);
  } catch {
    return false;
  }
}
