// Task 9 (observability): credential scrubbing for anything we log.
//
// The whole point of ai-bridge wrapping Copilot directly is that the real
// request/response is loggable — but that exchange carries the GitHub OAuth
// token and the exchanged Copilot bearer. The spec keeps prompts in debug/capture
// dumps (you need them to diagnose) but never the creds. These run over both the
// flat log line and the structured capture object.

// GitHub tokens are prefix-tagged: gho_/ghu_/ghp_/ghs_ (classic + OAuth) and the
// newer github_pat_ fine-grained PATs. Copilot bearers from token exchange are
// opaque, so we catch those positionally via the `Bearer <x>` and oauth_token
// shapes rather than by prefix.
const GITHUB_TOKEN = /\b(gh[opsu]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=_-]+/gi;
// oauth_token / access_token / api_key as a JSON or k=v field, value quoted or
// bare up to the next delimiter. `authorization` is intentionally NOT here — its
// value is `Bearer <token>`, caught by the BEARER rule below; matching it as a
// field would swallow the literal "Bearer" and leak the token after it.
const TOKEN_FIELD =
  /("?(?:oauth_token|access_token|api[_-]?key)"?\s*[:=]\s*)("?)([^",}\s]+)\2/gi;

const PLACEHOLDER = "[REDACTED]";

// Scrub a single string. Order matters: field-shaped matches first (they carry
// the key for context), then loose Bearer/token-prefix sweeps for anything bare.
export function redactString(input: string): string {
  return input
    .replace(TOKEN_FIELD, (_m, key: string, q: string) => `${key}${q}${PLACEHOLDER}${q}`)
    .replace(BEARER, `Bearer ${PLACEHOLDER}`)
    .replace(GITHUB_TOKEN, PLACEHOLDER);
}

// Deep-scrub an arbitrary value for the structured capture file. Strings are run
// through redactString; objects/arrays are walked. Also redacts by KEY NAME, so a
// value that doesn't match a token pattern (a future opaque secret) is still
// caught when its field is obviously a credential. Cycles are guarded.
const SECRET_KEY = /token|secret|api[_-]?key|authorization|password|cookie/i;

export function redactValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactString(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? PLACEHOLDER : redactValue(v, seen);
  }
  return out as T;
}
