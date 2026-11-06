"use client";

import { useState } from "react";

/** Full official mint with copy control. Renders nothing useful without a real address. */
export function MintAddress({ mint, solscanUrl }: { mint: string; solscanUrl: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="red-mint">
      <p className="red-mint-label">Official $NEST mint</p>
      <code className="red-mint-address" data-testid="red-mint-address">
        {mint}
      </code>
      <div className="red-mint-actions">
        <button type="button" className="button button-secondary button-small" onClick={copy} data-testid="red-mint-copy">
          <span className="button-face">{copied ? "Copied" : "Copy address"}</span>
        </button>
        <a className="red-mint-link" href={solscanUrl} target="_blank" rel="noreferrer" data-testid="red-mint-solscan">
          View on Solscan
        </a>
      </div>
    </div>
  );
}
