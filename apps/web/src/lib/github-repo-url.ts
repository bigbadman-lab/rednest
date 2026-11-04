/**
 * Strict public github.com repository URL parsing for Quick Scan.
 * Never returns a user-controlled fetch/clone URL — only owner/repo identity.
 */

/** GitHub login: up to 39 chars, alphanumeric or single hyphens, not starting/ending with hyphen. */
const OWNER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
/** Repository name segment: letters, digits, dot, underscore, hyphen. */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export type ParsedGithubRepoUrl =
  | { ok: true; owner: string; repo: string; canonicalUrl: string }
  | { ok: false; reason: "invalid_url" | "unsupported_host" | "invalid_path" };

/**
 * Accepts only `https://github.com/owner/repo` (optional `.git`, optional trailing slash).
 * Rejects other hosts, enterprise, IPs, localhost, extra path segments, credentials, and query/hash.
 */
export function parsePublicGithubRepoUrl(raw: string): ParsedGithubRepoUrl {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return { ok: false, reason: "invalid_url" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "invalid_url" };
  if (url.username || url.password) return { ok: false, reason: "invalid_url" };
  if (url.search || url.hash) return { ok: false, reason: "invalid_path" };

  const host = url.hostname.toLowerCase();
  if (host !== "github.com") return { ok: false, reason: "unsupported_host" };

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return { ok: false, reason: "invalid_path" };

  let [owner, repo] = parts as [string, string];
  try {
    owner = decodeURIComponent(owner);
    repo = decodeURIComponent(repo);
  } catch {
    return { ok: false, reason: "invalid_path" };
  }
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);

  if (!OWNER_RE.test(owner) || owner.toLowerCase() === "www") return { ok: false, reason: "invalid_path" };
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") return { ok: false, reason: "invalid_path" };
  // Block GitHub URL namespaces that are not repositories.
  if (/^(settings|marketplace|orgs|users|login|signup|notifications|explore|topics|collections|events|sponsors|codespaces|copilot|features|enterprise|security|pricing|about|customer-stories)$/i.test(owner)) {
    return { ok: false, reason: "invalid_path" };
  }

  return {
    ok: true,
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

/** Server-built clone URL from validated owner/repo only. */
export function publicGithubCloneUrl(owner: string, repo: string): string {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) throw new Error("Invalid owner/repo for clone URL");
  return `https://github.com/${owner}/${repo}.git`;
}
