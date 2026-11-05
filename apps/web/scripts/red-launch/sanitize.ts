/** Redacts credentials from operator-facing strings. Never print RPC keys. */

const KEYISH =
  /(?:api[_-]?key|token|secret|bearer|password)=[^&\s]+|(?:helius|quicknode|alchemy)[^/\s]*\/[A-Za-z0-9_-]{16,}|https?:\/\/[^\s]*[?&](?:api-key|api_key|apikey)=[^\s&]+/gi;

/** Literal placeholders Vercel writes instead of Secret values on `env pull`. */
const PROTECTED_PLACEHOLDERS = new Set(["[SENSITIVE]", "[sensitive]", "<SENSITIVE>", "SENSITIVE"]);

export function redactSecrets(text: string): string {
  return text.replace(KEYISH, "[redacted]");
}

/**
 * True when a pulled env value is a Vercel Secret redaction placeholder, not a
 * real configuration string. Never treat these as mint addresses or flags.
 */
export function isProtectedEnvPlaceholder(value: string | null | undefined): boolean {
  if (value == null) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (PROTECTED_PLACEHOLDERS.has(trimmed)) return true;
  // Defensive: any bracketed SENSITIVE token Vercel might emit.
  return /^\[[\s_]*SENSITIVE[\s_]*\]$/i.test(trimmed);
}

/** Host class only — never the full RPC URL. */
export function rpcPresence(url: string | null | undefined): "configured" | "absent" | "unknown" {
  if (url === undefined) return "unknown";
  if (url === null || !url.trim()) return "absent";
  return "configured";
}

export function flagPresence(raw: string | null | undefined): "true" | "false" | "absent" | "unknown" {
  if (raw === undefined) return "unknown";
  if (raw === null || raw.trim() === "") return "absent";
  const v = raw.trim().toLowerCase();
  if (v === "true") return "true";
  if (v === "false") return "false";
  return "unknown";
}
