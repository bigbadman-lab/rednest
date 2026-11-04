/**
 * Solana base58 public key validation without trusting client formatting.
 */
import { PublicKey } from "@solana/web3.js";

/** Canonical base58 pubkey, or null when the input is not a valid ed25519 address. */
export function canonicalSolanaPubkey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 32 || trimmed.length > 64) return null;
  try {
    const key = new PublicKey(trimmed);
    const canonical = key.toBase58();
    // Reject the all-zero system program style misuse only when bytes are wrong length — PublicKey already checks.
    if (key.toBytes().length !== 32) return null;
    return canonical;
  } catch {
    return null;
  }
}
