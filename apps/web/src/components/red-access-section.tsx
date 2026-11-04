import { connection } from "next/server";
import { MintAddress } from "@/components/mint-address";
import {
  FREE_ACCESS_SUMMARY,
  HOLDER_ACCESS_SUMMARY,
  HOLDER_STATUS_ACTIVE,
  HOLDER_STATUS_INACTIVE,
  MINT_COMING_SOON,
} from "@/lib/access-copy";
import { holderScansEnabled, readRedMintDisplay } from "@/server/red-mint-display";

/** Static fallback while the runtime mint config resolves (or when prerendered). */
export function RedAccessSectionFallback() {
  return <RedAccessSectionView published={false} holdersActive={false} />;
}

/**
 * Homepage $RED access block. Reads runtime env so build-time prerenders never
 * invent a mint; awaits connection() so deploy-time settings apply.
 */
export async function RedAccessSection() {
  await connection();
  const display = readRedMintDisplay();
  return (
    <RedAccessSectionView
      published={display.published}
      mint={display.published ? display.mint : undefined}
      solscanUrl={display.published ? display.solscanUrl : undefined}
      holdersActive={holderScansEnabled()}
    />
  );
}

export function RedAccessSectionView({
  published,
  mint,
  solscanUrl,
  holdersActive,
}: {
  published: boolean;
  mint?: string;
  solscanUrl?: string;
  holdersActive: boolean;
}) {
  return (
    <section className="section red-access" aria-labelledby="red-access-title" data-testid="red-access-section">
      <h2 id="red-access-title" className="section-title">
        Powered by $RED.
      </h2>
      <p className="pitch-body">RedNest connects AI-powered repository security with Solana token-based access.</p>

      <ul className="red-access-points">
        <li>
          <strong>Free access</strong>
          <span>{FREE_ACCESS_SUMMARY}</span>
        </li>
        <li>
          <strong>$RED holder access — coming soon</strong>
          <span>{HOLDER_ACCESS_SUMMARY}</span>
        </li>
        <li>
          <strong>Status</strong>
          <span data-testid="red-holder-status">{holdersActive ? HOLDER_STATUS_ACTIVE : HOLDER_STATUS_INACTIVE}</span>
        </li>
      </ul>

      <div className="red-mint-panel" data-testid="red-mint-panel">
        {published && mint && solscanUrl ? (
          <MintAddress mint={mint} solscanUrl={solscanUrl} />
        ) : (
          <p className="red-mint-pending" data-testid="red-mint-pending">
            {MINT_COMING_SOON}
          </p>
        )}
      </div>
    </section>
  );
}
