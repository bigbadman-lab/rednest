"use client";

/**
 * Compact Settings wallet section: connect via Reown AppKit, sign a server
 * challenge, show verified status. Holder scanning copy stays fail-closed.
 *
 * AppKit hooks must not run until createAppKit has run on the client. The
 * connect controls mount only after ensureWalletAppKit() succeeds.
 */
import { useAppKit, useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import type { Provider } from "@reown/appkit-adapter-solana/react";
import { useEffect, useState, useTransition } from "react";
import { disconnectWallet, requestWalletChallenge, verifyWalletChallenge } from "@/server/wallet-actions";
import { ensureWalletAppKit } from "./wallet-appkit";

export type WalletSettingsProps = {
  wallet: { pubkey: string; verifiedAt: string } | null;
  holderStatus: "eligible" | "no_wallet" | "insufficient_balance" | "not_activated" | "unavailable";
  holderLaunchActive: boolean;
  monthlyAllowance: number;
};

function shortPubkey(pubkey: string): string {
  return pubkey.length <= 12 ? pubkey : `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

export function WalletSettings(props: WalletSettingsProps) {
  const [kitReady, setKitReady] = useState(false);
  const [kitConfigured, setKitConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [wallet, setWallet] = useState(props.wallet);

  useEffect(() => {
    const ok = ensureWalletAppKit();
    setKitConfigured(ok);
    setKitReady(true);
  }, []);

  function run(label: string, work: () => Promise<void>) {
    setError(null);
    startTransition(() => {
      void work().catch(() => setError(`Could not ${label}. Try again.`));
    });
  }

  async function onDisconnect() {
    const result = await disconnectWallet();
    if (!result.ok) {
      setError("Could not disconnect the wallet.");
      return;
    }
    setWallet(null);
  }

  return (
    <section id="wallet" className="account" aria-labelledby="wallet-title">
      <div>
        <h2 id="wallet-title" className="account-name">
          Solana wallet
        </h2>
        <p className="account-role">Optional — for $NEST holder scans after launch</p>
      </div>
      <div className="settings-form">
        <div>
          <p className="field-legend">Holder requirement</p>
          <p className="field-help">
            After launch, chargeable scans beyond your free lifetime scan need a verified wallet holding at least 50,000 $NEST.
            Allowance: {props.monthlyAllowance} holder scans per UTC month. GitHub remains your RedNest identity.
          </p>
          {!props.holderLaunchActive && (
            <p className="field-help">$NEST holder scanning is not active yet.</p>
          )}
        </div>

        <div>
          <p className="field-legend">Verified wallet</p>
          {wallet ? (
            <>
              <p className="field-help">
                <code title={wallet.pubkey}>{shortPubkey(wallet.pubkey)}</code>
                <span className="tag">verified</span>
                <span className="field-help"> {new Date(wallet.verifiedAt).toISOString().slice(0, 10)}</span>
              </p>
              <div className="hero-actions" style={{ gap: "0.5rem", marginTop: "0.75rem" }}>
                {kitReady && kitConfigured ? (
                  <WalletConnectControls
                    mode="replace"
                    pending={pending}
                    onError={setError}
                    onVerified={(next) => setWallet(next)}
                    run={run}
                  />
                ) : (
                  <button type="button" className="key key-secondary" disabled>
                    <span className="key-face">Replace wallet</span>
                  </button>
                )}
                <button
                  type="button"
                  className="key key-secondary"
                  disabled={pending}
                  data-track="wallet-disconnect"
                  onClick={() => run("disconnect", onDisconnect)}
                >
                  <span className="key-face">Disconnect</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="field-help">No verified Solana wallet on this account.</p>
              <div className="hero-actions" style={{ gap: "0.5rem", marginTop: "0.75rem" }}>
                {kitReady && kitConfigured ? (
                  <WalletConnectControls
                    mode="connect"
                    pending={pending}
                    onError={setError}
                    onVerified={(next) => setWallet(next)}
                    run={run}
                  />
                ) : (
                  <button type="button" className="key key-primary" disabled>
                    <span className="key-face">{kitReady ? "Connect Solana wallet" : "Loading wallet…"}</span>
                  </button>
                )}
              </div>
            </>
          )}
          {error && (
            <p className="field-help" role="alert" style={{ marginTop: "0.75rem" }}>
              {error}
            </p>
          )}
          {kitReady && !kitConfigured && (
            <p className="field-help" style={{ marginTop: "0.75rem" }}>
              Wallet connect needs NEXT_PUBLIC_REOWN_PROJECT_ID.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Mounted only after createAppKit has run on the client. */
function WalletConnectControls(props: {
  mode: "connect" | "replace";
  pending: boolean;
  onError: (message: string | null) => void;
  onVerified: (wallet: { pubkey: string; verifiedAt: string }) => void;
  run: (label: string, work: () => Promise<void>) => void;
}) {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<Provider>("solana");

  async function verifyConnected() {
    if (!address || !walletProvider) {
      props.onError("Connect a Solana wallet first.");
      return;
    }
    const challenge = await requestWalletChallenge(address);
    if (!challenge.ok) {
      props.onError(challenge.error === "invalid_wallet" ? "That wallet address is not valid." : "Could not start verification.");
      return;
    }
    const encoded = new TextEncoder().encode(challenge.message);
    const signed = await walletProvider.signMessage(encoded);
    const signature =
      typeof signed === "string"
        ? signed
        : Buffer.from(signed instanceof Uint8Array ? signed : new Uint8Array(signed as ArrayBuffer)).toString("base64");
    const verified = await verifyWalletChallenge({
      challengeId: challenge.challengeId,
      walletPubkey: address,
      signature,
    });
    if (!verified.ok) {
      const messages: Record<string, string> = {
        invalid_signature: "Signature did not match. Sign the exact message from RedNest.",
        wallet_taken: "That wallet is already verified on another RedNest account.",
        challenge_expired: "The verification message expired. Try again.",
        challenge_consumed: "That verification message was already used.",
      };
      props.onError(messages[verified.error] ?? "Verification failed.");
      return;
    }
    props.onVerified({ pubkey: verified.walletPubkey, verifiedAt: verified.verifiedAt });
  }

  const label = props.mode === "replace" ? "Replace wallet" : isConnected ? "Sign to verify" : "Connect Solana wallet";
  const className = props.mode === "replace" ? "key key-secondary" : "key key-primary";
  const track = props.mode === "replace" ? "wallet-replace" : "wallet-connect";
  const runLabel = props.mode === "replace" ? "replace wallet" : "connect wallet";

  return (
    <button
      type="button"
      className={className}
      disabled={props.pending}
      data-track={track}
      onClick={() =>
        props.run(runLabel, async () => {
          if (!isConnected) await open({ view: "Connect", namespace: "solana" });
          await verifyConnected();
        })
      }
    >
      <span className="key-face">{label}</span>
    </button>
  );
}
