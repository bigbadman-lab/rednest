/**
 * The public address, baked into static pages (metadata, llms.txt, the docs'
 * Markdown copies). On Vercel it falls back to the production domain;
 * next.config.ts stops a production build that has neither.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.NEXT_PUBLIC_SITE_URL) return env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return undefined;
}

export const site = {
  name: "RedNest",
  title: "RedNest — Autonomous AI code security scanning",
  description:
    "AI-powered security scanning for GitHub repositories. One free lifetime scan, then planned $RED holder access—no recurring fiat subscription for holder scans.",
  url: siteUrl() ?? "http://localhost:3000",
  githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/apps/rednestai",
  /** Official X (Twitter) account. */
  xUrl: "https://x.com/rednestai",
  /**
   * Attribution for the open-source lineage. The product UI is RedNest;
   * the codebase is AGPL-licensed and derived from Sandchest.
   */
  parent: { name: "Sandchest (AGPL)", url: "https://github.com/CapSoftware/Sandchest" },
  links: {
    getStarted: "/get-started",
    signIn: "/sign-in",
    dashboard: "/dashboard",
    dashboardScans: "/dashboard/scans",
    settings: "/dashboard/settings",
    docs: "/docs",
    quickScan: "/docs/quick-scan",
    githubApp: "/docs/github-app",
    wallet: "/docs/wallet",
    scans: "/docs/scans",
    findings: "/docs/findings",
    pricing: "/docs/pricing",
    agents: "/docs/agents",
    security: "/docs/security",
    selfHosting: "/docs/self-hosting",
    llms: "/llms.txt",
    terms: "/terms",
    privacy: "/privacy",
    acceptableUse: "/acceptable-use",
  },
} as const;

/**
 * Logo and icon files keep their names, and Cloudflare tells browsers to cache
 * them for hours. Bump this when the art changes so visitors fetch the new files.
 */
const BRAND_VERSION = "11";

export const brandAsset = (path: string) => `${path}?v=${BRAND_VERSION}`;

/**
 * The link preview. Prefer a static OG image; video remains optional if present.
 */
export const socialImage = {
  url: brandAsset("/redmeta.jpg"),
  width: 1200,
  height: 630,
  alt: "RedNest — autonomous AI code security scanning for GitHub repositories.",
};

/**
 * OG video still uses the Sandchest chest animation until a RedNest original
 * is supplied. Omit it from metadata so shares do not show outdated branding.
 */
export const socialVideo = null;
