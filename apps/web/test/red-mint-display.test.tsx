import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RedAccessSectionView } from "@/components/red-access-section";
import {
  FREE_ACCESS_SUMMARY,
  GET_STARTED_READY_LEAD,
  HOLDER_ACCESS_SUMMARY,
  HOLDER_STATUS_INACTIVE,
  MINT_COMING_SOON,
} from "@/lib/access-copy";
import { holderScansEnabled, readRedMintDisplay } from "@/server/red-mint-display";

/** Well-known Solana token program id — valid pubkey shape for tests only. */
const SAMPLE_MINT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("readRedMintDisplay", () => {
  test("hides mint when RED_TOKEN_MINT is unset", () => {
    expect(readRedMintDisplay({ RED_MINT_PUBLIC: "true" })).toEqual({
      published: false,
      reason: "missing_mint",
    });
  });

  test("hides mint when registration exists but publication is not approved", () => {
    expect(
      readRedMintDisplay({
        RED_TOKEN_MINT: SAMPLE_MINT,
        RED_MINT_PUBLIC: "false",
      }),
    ).toEqual({ published: false, reason: "not_approved" });

    expect(readRedMintDisplay({ RED_TOKEN_MINT: SAMPLE_MINT })).toEqual({
      published: false,
      reason: "not_approved",
    });
  });

  test("rejects invalid mint strings", () => {
    expect(
      readRedMintDisplay({
        RED_TOKEN_MINT: "not-a-mint",
        RED_MINT_PUBLIC: "true",
      }),
    ).toEqual({ published: false, reason: "invalid_mint" });
  });

  test("publishes full mint and Solscan URL only when registered and approved", () => {
    expect(
      readRedMintDisplay({
        RED_TOKEN_MINT: `  ${SAMPLE_MINT}  `,
        RED_MINT_PUBLIC: "true",
      }),
    ).toEqual({
      published: true,
      mint: SAMPLE_MINT,
      solscanUrl: `https://solscan.io/token/${SAMPLE_MINT}`,
    });
  });

  test("publication never implies holder scans are enabled", () => {
    const env = {
      RED_TOKEN_MINT: SAMPLE_MINT,
      RED_MINT_PUBLIC: "true",
      RED_HOLDER_SCANS_ENABLED: "false",
    };
    expect(readRedMintDisplay(env).published).toBe(true);
    expect(holderScansEnabled(env)).toBe(false);
    expect(holderScansEnabled({ RED_HOLDER_SCANS_ENABLED: "true" })).toBe(true);
  });
});

describe("RedAccessSectionView", () => {
  test("shows free allowance and pre-launch holder messaging without a mint", () => {
    const html = renderToStaticMarkup(<RedAccessSectionView published={false} holdersActive={false} />);
    expect(html).toContain("Powered by $RED.");
    expect(html).toContain(FREE_ACCESS_SUMMARY);
    expect(html).toContain(HOLDER_ACCESS_SUMMARY);
    expect(html).toContain("50,000 $RED");
    expect(html).toContain("50 scans per UTC month");
    expect(html).toContain("$RED holder access — coming soon");
    expect(html).toContain(HOLDER_STATUS_INACTIVE);
    expect(html).toContain(MINT_COMING_SOON);
    expect(html).not.toContain('data-testid="red-mint-address"');
    expect(html).not.toContain('data-testid="red-mint-copy"');
    expect(html).not.toContain("solscan.io");
  });

  test("renders full official mint with copy and explorer controls when approved", () => {
    const html = renderToStaticMarkup(
      <RedAccessSectionView
        published
        mint={SAMPLE_MINT}
        solscanUrl={`https://solscan.io/token/${SAMPLE_MINT}`}
        holdersActive={false}
      />,
    );
    expect(html).toContain("Official $RED mint");
    expect(html).toContain(SAMPLE_MINT);
    expect(html).toContain(`href="https://solscan.io/token/${SAMPLE_MINT}"`);
    expect(html).toContain("Copy address");
    expect(html).toContain("View on Solscan");
    expect(html).not.toContain(MINT_COMING_SOON);
    expect(html).toContain(HOLDER_STATUS_INACTIVE);
  });

  test("holder-active status copy does not appear unless the launch flag is on", () => {
    const off = renderToStaticMarkup(<RedAccessSectionView published={false} holdersActive={false} />);
    expect(off).not.toContain("Token-holder scanning is enabled");

    const on = renderToStaticMarkup(<RedAccessSectionView published={false} holdersActive />);
    expect(on).toContain("Token-holder scanning is enabled for eligible verified wallets.");
  });
});

describe("access copy consistency", () => {
  test("get-started and homepage free wording both avoid reset / billing language", () => {
    for (const text of [GET_STARTED_READY_LEAD, FREE_ACCESS_SUMMARY, HOLDER_ACCESS_SUMMARY]) {
      expect(text).not.toMatch(/resets|subscription|Stripe|Autumn|\bjake\b|without billing/i);
    }
  });
});
