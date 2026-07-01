import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const numericString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .pipe(z.number().int().positive());

// A boolean env flag that is ON unless explicitly set to "0"/"false"/"off"
// (case-insensitive). Unset -> on, matching how the other search defaults lean.
const boolString = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? fallback : !["0", "false", "off", "no"].includes(v.trim().toLowerCase()),
    );

// The proxy the search browser dials. Search reuses the SAME proxy the rest of
// the service already routes through (the installer bakes HTTPS_PROXY/HTTP_PROXY
// into the systemd unit so Copilot can reach Claude), so a censorship proxy is
// honored automatically; machines without one connect directly. AI_BRIDGE_SEARCH_PROXY
// overrides just search; AI_BRIDGE_PROXY / *_PROXY are the shared fallbacks;
// "none" (from either search or the shared knob) forces a direct connection.
const resolveSearchProxy = (env: NodeJS.ProcessEnv): string => {
  const raw =
    env.AI_BRIDGE_SEARCH_PROXY ??
    env.AI_BRIDGE_PROXY ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.HTTP_PROXY ??
    env.http_proxy ??
    "";
  return raw.trim().toLowerCase() === "none" ? "" : raw.trim();
};

const EnvSchema = z.object({
  AI_BRIDGE_PORT: numericString(11500),
  AI_BRIDGE_HOST: z.string().default("127.0.0.1"),
  AI_BRIDGE_LOG_DIR: z.string().default(join(homedir(), ".ai-bridge", "logs")),
  AI_BRIDGE_LOG_LEVEL: z.enum(["debug", "info", "error"]).default("info"),
  // How many rolling debug logs + per-error capture files to keep before the
  // oldest are pruned. Bounds disk use; payloads are large (full bodies at debug).
  AI_BRIDGE_LOG_MAX_FILES: numericString(20),
  // WebSearch emulation (src/search/). The bridge intercepts Claude Code's
  // web_search server tool and runs it locally in a headless browser, since
  // Copilot has no server-side search. Off -> the tool is passed through
  // untouched (and thus returns nothing, as before).
  AI_BRIDGE_SEARCH_ENABLED: boolString(true),
  AI_BRIDGE_SEARCH_MAX_RESULTS: numericString(8),
  // Hard cap on searches per WebSearch call; Anthropic's own tool caps at 8.
  AI_BRIDGE_SEARCH_MAX_USES: numericString(8),
  // Idle window before the shared headless browser is torn down (keeps the
  // service light; the browser relaunches lazily on the next search).
  AI_BRIDGE_SEARCH_IDLE_MS: numericString(30000),
  // Per-search page navigation timeout.
  AI_BRIDGE_SEARCH_NAV_TIMEOUT_MS: numericString(15000),
});

export type SearchConfig = {
  enabled: boolean;
  maxResults: number;
  maxUses: number;
  idleMs: number;
  navTimeoutMs: number;
  // Proxy the headless search browser dials, or "" for a direct connection.
  proxy: string;
  // Comma-separated hosts that bypass the proxy (Chrome's proxy bypass list).
  noProxy: string;
};

export type Config = {
  host: string;
  port: number;
  logDir: string;
  logLevel: "debug" | "info" | "error";
  logMaxFiles: number;
  baseUrl: string;
  search: SearchConfig;
};

// Build the base URL clients dial for a given host/port. config.baseUrl reflects
// the *configured* port; once the server binds (and may have hopped to a free
// port), the entrypoint rebuilds the URL from the *actual* port with this so
// ANTHROPIC_BASE_URL tracks the real bind rather than the pre-probe guess.
export function makeBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    host: parsed.AI_BRIDGE_HOST,
    port: parsed.AI_BRIDGE_PORT,
    logDir: parsed.AI_BRIDGE_LOG_DIR,
    logLevel: parsed.AI_BRIDGE_LOG_LEVEL,
    logMaxFiles: parsed.AI_BRIDGE_LOG_MAX_FILES,
    baseUrl: makeBaseUrl(parsed.AI_BRIDGE_HOST, parsed.AI_BRIDGE_PORT),
    search: {
      enabled: parsed.AI_BRIDGE_SEARCH_ENABLED,
      maxResults: parsed.AI_BRIDGE_SEARCH_MAX_RESULTS,
      maxUses: parsed.AI_BRIDGE_SEARCH_MAX_USES,
      idleMs: parsed.AI_BRIDGE_SEARCH_IDLE_MS,
      navTimeoutMs: parsed.AI_BRIDGE_SEARCH_NAV_TIMEOUT_MS,
      proxy: resolveSearchProxy(env),
      noProxy: (env.NO_PROXY ?? env.no_proxy ?? "").trim(),
    },
  };
}
