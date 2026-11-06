import { HEALTH_URL, PRODUCTION_URL } from "./config";
import { redactSecrets } from "./sanitize";
import type { SiteClient, SolanaPreflightResult } from "./types";

const SOLANA_PREFLIGHT_URL = `${PRODUCTION_URL}/api/launch/solana-preflight`;

export function createSiteClient(fetchImpl: typeof fetch = fetch): SiteClient {
  return {
    async health() {
      try {
        const res = await fetchImpl(HEALTH_URL, { signal: AbortSignal.timeout(15_000) });
        const body = await res.text();
        let ok = false;
        try {
          ok = res.ok && JSON.parse(body)?.ok === true;
        } catch {
          ok = false;
        }
        return { ok, body };
      } catch {
        return { ok: false };
      }
    },
    async homepageHtml() {
      const res = await fetchImpl(PRODUCTION_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Homepage HTTP ${res.status}`);
      return res.text();
    },
    async solanaPreflight(mint, operatorToken) {
      try {
        const res = await fetchImpl(SOLANA_PREFLIGHT_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${operatorToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ mint }),
          signal: AbortSignal.timeout(45_000),
        });
        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ok: false, error: `preflight_http_${res.status}` };
        }
        const body = parsed as SolanaPreflightResult;
        if (body && typeof body === "object" && "ok" in body) {
          if (body.ok === true) return body;
          if (body.ok === false && typeof body.error === "string") {
            return { ok: false, error: redactSecrets(body.error) };
          }
        }
        return { ok: false, error: `preflight_http_${res.status}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : "network_error";
        return { ok: false, error: `preflight_unreachable:${redactSecrets(message)}` };
      }
    },
  };
}

export function homepageShowsMint(html: string, mint: string): boolean {
  return html.includes(mint) && /Official \$NEST mint/i.test(html);
}

export function homepageHidesMint(html: string): boolean {
  return /Official mint address coming soon/i.test(html) && !/data-testid="red-mint-address"/i.test(html);
}

export function homepageHolderInactive(html: string): boolean {
  return (
    /Token-holder scanning is not active yet/i.test(html) ||
    /\$NEST has not launched yet/i.test(html) ||
    /token has not launched/i.test(html)
  );
}

export function homepageHolderActive(html: string): boolean {
  return /Token-holder scanning is enabled/i.test(html);
}

export function homepageSolscanFor(html: string, mint: string): boolean {
  return html.includes(`https://solscan.io/token/${mint}`);
}
