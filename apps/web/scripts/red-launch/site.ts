import { HEALTH_URL, PRODUCTION_URL } from "./config";
import type { SiteClient } from "./types";

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
  };
}

export function homepageShowsMint(html: string, mint: string): boolean {
  return html.includes(mint) && /Official \$RED mint/i.test(html);
}

export function homepageHidesMint(html: string): boolean {
  return /Official mint address coming soon/i.test(html) && !/data-testid="red-mint-address"/i.test(html);
}

export function homepageHolderInactive(html: string): boolean {
  return /Token-holder scanning is not active yet/i.test(html);
}

export function homepageHolderActive(html: string): boolean {
  return /Token-holder scanning is enabled/i.test(html);
}

export function homepageSolscanFor(html: string, mint: string): boolean {
  return html.includes(`https://solscan.io/token/${mint}`);
}
