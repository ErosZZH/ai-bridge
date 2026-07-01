// WebSearch backend: a headless browser scraping DuckDuckGo's server-rendered
// /html/ endpoint. This is the search executor behind Claude Code's web_search
// server tool, which Copilot cannot run itself (see src/search/websearch.ts).
//
// Why a real browser and not a plain HTTP fetch: from a datacenter IP, DDG
// soft-blocks non-browser clients (HTTP 202 + JS homepage shell) and Google
// CAPTCHA-walls even real headless Chrome. A genuine Chrome (correct TLS
// fingerprint, full headers, JS/cookies) gets DDG's /html/ results served
// server-side, which parse without executing a SPA. We use playwright-core
// driving the system-installed Google Chrome (channel:'chrome') so there is no
// bundled-browser download — the box already has /usr/bin/google-chrome.
//
// Lifecycle: the browser is launched LAZILY on the first search, ONE browser +
// context is reused across the up-to-8 searches in a WebSearch call, and it is
// torn down after an idle window so the background service stays light.

import { chromium, type Browser, type BrowserContext } from "playwright-core";

// A single search hit. Only title+url are strictly needed by the harness; the
// snippet is carried for potential future use but not currently surfaced.
export type SearchResult = { title: string; url: string; snippet?: string };

export type SearchOptions = {
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxResults?: number;
  navTimeoutMs?: number;
};

// The pluggable search function. websearch.ts calls this via runSearch(); tests
// swap it through __setSearchDeps so no real browser/network is touched.
export type SearchBackend = (
  query: string,
  opts: SearchOptions,
  signal?: AbortSignal,
) => Promise<SearchResult[]>;

// Chrome's proxy option shape (mirrors playwright's ProxySettings subset we use).
export type ProxyOption = { server: string; bypass?: string };

// The error codes Anthropic's web_search_tool_result_error uses. websearch.ts
// maps a thrown SearchError.code straight into that block, so a backend failure
// surfaces to the model as a real search error rather than a bridge 500.
export type WebSearchErrorCode =
  | "unavailable"
  | "too_many_requests"
  | "max_uses_exceeded"
  | "query_too_long"
  | "request_too_large"
  | "invalid_tool_input";

export class SearchError extends Error {
  constructor(
    message: string,
    readonly code: WebSearchErrorCode,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

// Desktop Chrome UA so DDG serves the full results page rather than a lite/JS
// variant. Kept in sync with a recent stable Chrome.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
// DDG rejects very long queries; guard before we spend a page navigation on it.
const MAX_QUERY_LEN = 500;

// --- proxy resolution ---

// Turn the config's proxy/noProxy strings into Chrome's proxy option, or
// undefined for a direct connection. Empty / "none" -> direct. Exposed for unit
// tests (the whole point is that machines without a proxy behave identically).
export function resolveProxyOption(proxy: string, noProxy: string): ProxyOption | undefined {
  const server = (proxy ?? "").trim();
  if (!server || server.toLowerCase() === "none") return undefined;
  const bypass = (noProxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
  return bypass ? { server, bypass } : { server };
}

// --- browser lifecycle (module singleton) ---

type Live = { browser: Browser; context: BrowserContext };
let live: Live | null = null;
// In-flight launch, so concurrent first-searches share one cold start instead of
// racing to launch two browsers.
let launching: Promise<Live> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function launch(proxyOpt?: ProxyOption): Promise<Live> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      // --no-sandbox: the service runs headless without a user namespace;
      // --disable-dev-shm-usage: avoid /dev/shm exhaustion in small containers.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(proxyOpt ? { proxy: proxyOpt } : {}),
    });
  } catch (err) {
    // Chrome missing / unlaunchable -> a soft search error, not a crash. The
    // model still answers, just without sources.
    throw new SearchError(
      `chrome launch failed: ${err instanceof Error ? err.message : String(err)}`,
      "unavailable",
    );
  }
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: "en-US" });
  return { browser, context };
}

// Reuse the live browser; otherwise join the in-flight launch; otherwise start
// one. The proxy is fixed at first launch (it comes from static config), so a
// live browser is reused regardless of the passed option.
async function ensureBrowser(proxyOpt?: ProxyOption): Promise<Live> {
  if (live) return live;
  if (launching) return launching;
  launching = launch(proxyOpt)
    .then((l) => {
      live = l;
      return l;
    })
    .finally(() => {
      launching = null;
    });
  return launching;
}

// (Re)start the idle countdown. Timer is unref()'d so it never keeps the process
// alive on its own. No-op when nothing is running.
function armIdleTeardown(idleMs: number): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!live && !launching) return;
  idleTimer = setTimeout(() => {
    void teardownBrowser();
  }, idleMs);
  idleTimer.unref?.();
}

// Idempotent close, used by the idle timer and the process shutdown hook.
export async function teardownBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = live;
  live = null;
  if (!current) return;
  try {
    await current.context.close();
  } catch {
    // ignore
  }
  try {
    await current.browser.close();
  } catch {
    // ignore
  }
}

// --- result parsing (pure, unit-tested without a browser) ---

// DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded-real-url>. Pull
// the real URL back out; pass through already-absolute http(s) hrefs; anything
// else (relative chrome, unparseable) -> null so the caller drops it.
export function decodeDdgHref(href: string): string | null {
  if (!href) return null;
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(href)) return href;
  return null;
}

type RawHit = { title: string; href: string; snippet: string };

// Turn raw scraped rows into clean results: drop DDG ad rows (y.js redirector),
// decode the real URL, drop empty/undecodable rows, apply domain filters, and
// cap to maxResults. allowed_domains and blocked_domains are mutually exclusive
// in the harness's schema, so allowed wins when both are somehow present.
export function postProcess(raw: RawHit[], opts: SearchOptions): SearchResult[] {
  const allowed = opts.allowedDomains?.filter(Boolean);
  const blocked = opts.blockedDomains?.filter(Boolean);
  const out: SearchResult[] = [];
  for (const r of raw) {
    if (r.href.includes("duckduckgo.com/y.js")) continue; // sponsored/ad row
    const url = decodeDdgHref(r.href);
    if (!url) continue;
    const title = r.title.trim();
    if (!title) continue;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (allowed?.length) {
      if (!allowed.some((d) => hostMatches(host, d))) continue;
    } else if (blocked?.length) {
      if (blocked.some((d) => hostMatches(host, d))) continue;
    }
    out.push({ title, url, snippet: r.snippet.trim() || undefined });
    if (out.length >= (opts.maxResults ?? 8)) break;
  }
  return out;
}

// A host matches a domain filter when it equals it or is a subdomain of it, so
// "example.com" matches "www.example.com" but not "notexample.com".
function hostMatches(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^\.+/, "");
  return host === d || host.endsWith("." + d);
}

// --- the real backend ---

// Navigate DDG's /html/ endpoint in a fresh page and scrape the result rows.
// One page per search (opened/closed) keeps searches isolated within the shared
// context. Never called directly by websearch.ts — go through runSearch so the
// idle teardown is always armed.
async function ddgSearch(
  query: string,
  opts: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (query.length > MAX_QUERY_LEN) {
    throw new SearchError(`query too long (${query.length} > ${MAX_QUERY_LEN})`, "query_too_long");
  }
  if (signal?.aborted) throw new SearchError("aborted", "unavailable");

  const { context } = await ensureBrowser(activeProxy);
  const page = await context.newPage();
  try {
    await page.goto(DDG_HTML_ENDPOINT + "?q=" + encodeURIComponent(query), {
      waitUntil: "domcontentloaded",
      timeout: opts.navTimeoutMs ?? 15000,
    });
    const raw = (await page.$$eval(".result__body", (nodes) =>
      nodes.map((n) => {
        const a = n.querySelector("a.result__a");
        const s = n.querySelector(".result__snippet");
        return {
          title: a?.textContent?.trim() ?? "",
          href: a?.getAttribute("href") ?? "",
          snippet: s?.textContent?.trim() ?? "",
        };
      }),
    )) as RawHit[];
    return postProcess(raw, opts);
  } catch (err) {
    if (err instanceof SearchError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // Navigation timeout / transient page failure -> a retryable search error.
    throw new SearchError(`search failed: ${msg}`, "unavailable");
  } finally {
    await page.close().catch(() => {});
  }
}

// --- injectable seam + public entry ---

let backend: SearchBackend = ddgSearch;
// The proxy the live browser was (or will be) launched with. Set by runSearch
// from config so ddgSearch's ensureBrowser call uses it on cold start.
let activeProxy: ProxyOption | undefined;

// Test seam mirroring copilot's __setCopilotDeps: swap the search backend for a
// fake so unit tests never launch Chrome or hit the network.
export function __setSearchDeps(deps: { search?: SearchBackend }): void {
  if (deps.search) backend = deps.search;
}

// The single entry point websearch.ts uses. Runs the (real or injected) backend
// and always (re)arms the idle teardown afterwards, so the browser is reclaimed
// once a burst of searches goes quiet.
export async function runSearch(
  query: string,
  opts: SearchOptions,
  proxyOpt: ProxyOption | undefined,
  idleMs: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  activeProxy = proxyOpt;
  try {
    return await backend(query, opts, signal);
  } finally {
    armIdleTeardown(idleMs);
  }
}
