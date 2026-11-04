"use client";

/**
 * Settings-scoped Reown AppKit (Solana only). Initialized once on the client;
 * no email/social login and no EVM adapters.
 */
import { createAppKit } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana } from "@reown/appkit/networks";

let configured = false;

export function ensureWalletAppKit(): boolean {
  if (configured) return true;
  const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim();
  if (!projectId || typeof window === "undefined") return false;

  const metadata = {
    name: "RedNest",
    description: "Verify a Solana wallet for $RED holder scans",
    url: window.location.origin,
    icons: [`${window.location.origin}/red.png`],
  };

  createAppKit({
    adapters: [new SolanaAdapter()],
    networks: [solana],
    projectId,
    metadata,
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
  });
  configured = true;
  return true;
}
