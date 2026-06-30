// Copilot auth. The GitHub oauth_token is read from creds already on disk
// (apps.json/hosts.json, written by VS Code / copilot.vim / `gh`, or by our own
// `ai-bridge login` device flow). That token is exchanged at
// copilot_internal/v2/token for a short-lived Copilot bearer, cached, refreshed
// before expiry, and re-read from disk on a 401. The device flow itself lives in
// ./device.ts; this module orchestrates it and persists the result.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import {
  COPILOT_CLIENT_ID,
  fetchGitHubUser,
  pollForToken,
  realSleep,
  requestDeviceCode,
  type Sleep,
} from "./device.js";

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

// Editor identity sent to both the token exchange and chat/completions; Copilot
// rejects requests without it. Shared so the client and auth stay in lockstep.
export const EDITOR_VERSION = "vscode/1.96.0";
export const EDITOR_PLUGIN_VERSION = "copilot-chat/0.23.0";
export const USER_AGENT = "GitHubCopilotChat/0.23.0";
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

// Tokens for the next exchange, re-reading disk whenever the cache is empty.
//
// An empty cache is never authoritative: the service often starts before the
// user runs `ai-bridge login` (which writes apps.json), and `getGitHubToken()`
// at startup would otherwise pin `cached` to `[]` forever. Treating that empty
// array as final wedges the process into permanent 401s until it is restarted.
// So we re-read disk on every call while there are no creds — picking up a
// freshly written token on the next request, no restart needed — and only
// short-circuit once a populated cache exists (keeping the steady state free of
// a per-call disk hit).
function ensureTokens(): GitHubToken[] {
  if (cached === undefined || cached.length === 0) cached = readTokens();
  return cached;
}

export function getGitHubToken(): GitHubToken | null {
  return ensureTokens()[0] ?? null;
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
// deviceFetch + sleep are separate so the device-flow polling loop can be driven
// without real network or wall-clock delays.
let fetchImpl: typeof fetch = fetch;
let readTokens: () => GitHubToken[] = readGitHubTokens;
let deviceFetchImpl: typeof fetch = fetch;
let sleepImpl: Sleep = realSleep;
export function __setAuthDeps(deps: {
  fetch?: typeof fetch;
  readTokens?: () => GitHubToken[];
  deviceFetch?: typeof fetch;
  sleep?: Sleep;
}) {
  if (deps.fetch) fetchImpl = deps.fetch;
  if (deps.readTokens) readTokens = deps.readTokens;
  if (deps.deviceFetch) deviceFetchImpl = deps.deviceFetch;
  if (deps.sleep) sleepImpl = deps.sleep;
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

  const tokens = ensureTokens();
  if (tokens.length === 0) throw new CopilotAuthError(SIGN_IN_HINT);

  inflight = exchangeAny(tokens)
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

// Persist a freshly-minted oauth_token to apps.json in the shape readGitHubTokens
// consumes. Preserves any keys already in the file (VS Code / gh creds) and
// writes 0600 since the file holds a credential. Returns the path written.
export function writeGitHubToken(oauthToken: string, user: string): string {
  const dir = findCopilotConfigDirs()[0];
  if (!dir) throw new CopilotAuthError("no writable github-copilot config dir");
  const path = join(dir, "apps.json");

  let obj: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      // malformed existing file — overwrite rather than fail the login
    }
  }

  obj[`github.com:${COPILOT_CLIENT_ID}`] = {
    githubAppId: COPILOT_CLIENT_ID,
    oauth_token: oauthToken,
    user,
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  return path;
}

// Run the full device flow: get a code, show it to the user, poll until they
// authorize, resolve their username, persist the token, and drop the in-memory
// cache so the next getCopilotToken() picks it up. Returns the stored token.
export async function loginWithDeviceFlow(): Promise<GitHubToken> {
  const code = await requestDeviceCode(deviceFetchImpl);

  // User-facing prompt — direct to stdout, not the logger. The user_code is not
  // a secret and this is interactive UX, not a log event.
  console.log("");
  console.log("To authorize ai-bridge with GitHub Copilot:");
  console.log(`  1. Open ${code.verificationUri}`);
  console.log(`  2. Enter the code: ${code.userCode}`);
  console.log("");
  console.log("Waiting for authorization...");

  const oauthToken = await pollForToken(deviceFetchImpl, sleepImpl, code);
  const user = await fetchGitHubUser(deviceFetchImpl, oauthToken);
  writeGitHubToken(oauthToken, user);
  refreshGitHubToken();
  return { token: oauthToken, user };
}
