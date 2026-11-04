/**
 * The public site's header and footer, shared by the landing page, the docs
 * and the legal pages so their navigation stays the same. Server components:
 * no JavaScript.
 */
import { isDraftLegalLink } from "@/lib/legal";
import { brandAsset, site } from "@/lib/site";

const NAV = [
  { id: "docs", label: "Docs", href: site.links.docs },
  { id: "pricing", label: "Pricing", href: site.links.pricing },
  { id: "github", label: "Open source", href: site.githubUrl },
] as const;

const FOOTER = [
  {
    title: "Product",
    links: [
      { id: "docs", label: "Docs", href: site.links.docs },
      { id: "pricing", label: "Pricing", href: site.links.pricing },
      { id: "quick-scan", label: "Quick Scan", href: site.links.quickScan },
      { id: "scans", label: "How scans work", href: site.links.scans },
      { id: "findings", label: "Findings", href: site.links.findings },
      { id: "agents", label: "Use it from your agent", href: site.links.agents },
    ],
  },
  {
    title: "Open source",
    links: [
      { id: "github", label: "GitHub", href: site.githubUrl },
      { id: "self-hosting", label: "Self-hosting", href: site.links.selfHosting },
      { id: "security", label: "Privacy & security", href: site.links.security },
    ],
  },
  {
    title: "Legal",
    links: [
      { id: "terms", label: "Terms of service", href: site.links.terms },
      { id: "privacy", label: "Privacy policy", href: site.links.privacy },
      { id: "acceptable-use", label: "Acceptable use", href: site.links.acceptableUse },
    ],
  },
] as const;

type Section = (typeof FOOTER)[number]["links"][number]["id"];

/**
 * `visitor` is set only on the landing page, which is built once for each
 * (see `homeRewrites`): signed in, a Dashboard key; otherwise Sign in. Docs
 * and legal pages stay a single static page and show neither.
 */
export function SiteHeader({ current, visitor }: { current?: Section; visitor?: "signed-in" | "signed-out" }) {
  return (
    <header className="site-header">
      <a href="/" className="wordmark" aria-label="RedNest home">
        <img src={brandAsset("/red.png")} alt="RedNest" width={148} height={37} />
      </a>
      <nav aria-label="Main" className="header-nav">
        {NAV.map((link) => (
          <a key={link.id} href={link.href} aria-current={link.id === current ? "page" : undefined}>
            {link.label}
          </a>
        ))}
        {visitor === "signed-out" && (
          <a href={site.links.signIn} data-track="nav-sign-in">
            Sign in
          </a>
        )}
        {visitor === "signed-in" && (
          <a href={site.links.dashboard} className="button button-primary button-small">
            <span className="button-face">Dashboard</span>
          </a>
        )}
      </nav>
    </header>
  );
}

export function SiteFooter({ current }: { current?: Section }) {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-brand">
          <a href="/" className="footer-mark" aria-label="RedNest home">
            <img src={brandAsset("/red_white.png")} alt="" width={46} height={46} />
          </a>
          <p className="footer-tagline">Autonomous AI code security scanning.</p>
          <p className="footer-blurb">Finds real vulnerabilities in your code, and proves them, before attackers do.</p>
          <a href={site.xUrl} className="footer-social" rel="noreferrer me" target="_blank" aria-label="RedNest on X">
            <XIcon />
            <span>@rednestai</span>
          </a>
        </div>
        <nav aria-label="Footer" className="footer-columns">
          {FOOTER.map((column) => {
            // Legal pages stay unlinked while they still hold placeholders (lib/legal.ts).
            const links = column.links.filter((link) => !isDraftLegalLink(link.href));
            if (links.length === 0) return null;
            return (
              <div key={column.title} className="footer-column">
                <h2 className="footer-heading">{column.title}</h2>
                <ul>
                  {links.map((link) => (
                    <li key={link.id}>
                      <a href={link.href} aria-current={link.id === current ? "page" : undefined}>
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </div>
      <div className="footer-base">
        <p>
          &copy; {new Date().getFullYear()} {site.name}. Open source under AGPL-3.0.
        </p>
        <a href={site.parent.url} className="footer-parent" rel="noreferrer">
          Built on {site.parent.name}
        </a>
      </div>
    </footer>
  );
}

/** Official X logo (simple path from X Corp brand guidelines). */
function XIcon() {
  return (
    <svg className="footer-social-icon" viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}
