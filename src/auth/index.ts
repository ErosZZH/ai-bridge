// Phase 1: Copilot auth. The GitHub oauth_token is reused from the creds
// already on disk (apps.json/hosts.json, written by VS Code / copilot.vim).
// Task 3: exchange that oauth_token at copilot_internal/v2/token for a
// short-lived Copilot bearer, cache it, refresh before expiry, and on 401
// re-read the disk token + prompt the user to re-sign-in.

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type DeviceCodePrompt = {
  userCode: string;
  verificationUri: string;
};

export type GitHubToken = {
  token: string;
  user: string;
};

export type CopilotToken = {
  token: string;
  expiresAt: number; // unix seconds
  endpoint: string; // chat/completions base, e.g. https://api.githubcopilot.com
};

const APPS_FILES = ["apps.json", "hosts.json"];
const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_API = "https://api.githubcopilot.com";
const EDITOR_VERSION = "vscode/1.96.0";
const EDITOR_PLUGIN_VERSION = "copilot-chat/0.23.0";
const USER_AGENT = "GitHubCopilotChat/0.23.0";
// Re-exchange this many seconds before expiry so an in-flight request never
// races the clock.
const REFRESH_SKEW_SECONDS = 120;

const SIGN_IN_HINT =
  "GitHub Copilot sign-in required: sign in via VS Code Copilot or `gh copilot`, then restart ai-bridge";

export class CopilotAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CopilotAuthError";
  }
}

export function findCopilotConfigDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | undefined) => {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  };

  if (platform() === "win32") {
    add(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "github-copilot"));
    add(process.env.APPDATA && join(process.env.APPDATA, "GitHub Copilot"));
  } else {
    add(process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, "github-copilot"));
    add(join(homedir(), ".config", "github-copilot"));
  }
  return dirs;
}

function extractTokens(parsed: unknown): GitHubToken[] {
  if (!parsed || typeof parsed !== "object") return [];
  const found: GitHubToken[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.startsWith("github.com")) continue;
    if (!value || typeof value !== "object") continue;
    const { oauth_token, user } = value as { oauth_token?: string; user?: string };
    if (typeof oauth_token === "string" && oauth_token.length > 0) {
      found.push({ token: oauth_token, user: user ?? "unknown" });
    }
  }
  return found;
}

// All on-disk candidates. apps.json often holds both a GitHub-App (ghu_) and
// an OAuth-app (gho_) token; only one exchanges, so callers try each.
export function readGitHubTokens(): GitHubToken[] {
  for (const dir of findCopilotConfigDirs()) {
    for (const file of APPS_FILES) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        const found = extractTokens(JSON.parse(readFileSync(path, "utf8")));
        if (found.length > 0) return found;
      } catch {
        // malformed file — try the next candidate
      }
    }
  }
  return [];
}

export function readGitHubToken(): GitHubToken | null {
  return readGitHubTokens()[0] ?? null;
}

let cached: GitHubToken[] | undefined;

export function getGitHubToken(): GitHubToken | null {
  if (cached === undefined) cached = readTokens();
  return cached[0] ?? null;
}

// Drop the in-memory copies and re-read from disk; used on 401 in case the
// user signed in again and rewrote apps.json.
export function refreshGitHubToken(): GitHubToken | null {
  cached = readTokens();
  copilot = null;
  return cached[0] ?? null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Test seam: swap fetch + disk-read so the cache/refresh/401 logic is unit-testable.
let fetchImpl: typeof fetch = fetch;
let readTokens: () => GitHubToken[] = readGitHubTokens;
export function __setAuthDeps(deps: { fetch?: typeof fetch; readTokens?: () => GitHubToken[] }) {
  if (deps.fetch) fetchImpl = deps.fetch;
  if (deps.readTokens) readTokens = deps.readTokens;
  cached = undefined;
  copilot = null;
  inflight = null;
}

async function exchange(oauthToken: string): Promise<CopilotToken> {
  const res = await fetchImpl(TOKEN_URL, {
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      Accept: "application/json",
      "Editor-Version": EDITOR_VERSION,
      "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CopilotAuthError(
      `token exchange failed: ${res.status} ${res.statusText} ${body}`.trim(),
      res.status,
    );
  }
  const data = (await res.json()) as {
    token?: string;
    expires_at?: number;
    endpoints?: { api?: string };
  };
  if (!data.token || typeof data.expires_at !== "number") {
    throw new CopilotAuthError("token exchange returned no token");
  }
  return {
    token: data.token,
    expiresAt: data.expires_at,
    endpoint: data.endpoints?.api ?? DEFAULT_API,
  };
}

// Try each disk token; apps.json may hold both an unusable GitHub-App token and
// the OAuth-app token that exchanges. Keep the last error if all fail.
async function exchangeAny(tokens: GitHubToken[]): Promise<CopilotToken> {
  let lastErr: unknown;
  for (const gh of tokens) {
    try {
      return await exchange(gh.token);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new CopilotAuthError(SIGN_IN_HINT);
}

let copilot: CopilotToken | null = null;
let inflight: Promise<CopilotToken> | null = null;

function isFresh(token: CopilotToken): boolean {
  return token.expiresAt - REFRESH_SKEW_SECONDS > nowSeconds();
}

// Return a Copilot bearer good for the next request, exchanging or refreshing
// as needed. Concurrent callers share one in-flight exchange.
export async function getCopilotToken(): Promise<CopilotToken> {
  if (copilot && isFresh(copilot)) return copilot;
  if (inflight) return inflight;

  if (cached === undefined) cached = readTokens();
  if (cached.length === 0) throw new CopilotAuthError(SIGN_IN_HINT);

  inflight = exchangeAny(cached)
    .then((t) => {
      copilot = t;
      return t;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Called after a 401 from Copilot: drop the cached bearer, re-read the disk
// token, and exchange again. If disk has nothing, surface the sign-in hint.
export async function reauthCopilotToken(): Promise<CopilotToken> {
  copilot = null;
  const gh = refreshGitHubToken();
  if (!gh) throw new CopilotAuthError(SIGN_IN_HINT);
  return getCopilotToken();
}

export async function ensureAuth(): Promise<DeviceCodePrompt | null> {
  getGitHubToken();
  return null;
}
