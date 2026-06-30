// impit-backed `fetch` adapter for the Copilot upstream. GitHub's Copilot edge
// gates Claude (and ~7 catalog entries) on the TLS ClientHello fingerprint: the
// same request succeeds from a real browser fingerprint but fails from Node's
// native TLS stack (undici AND node:https return a Claude-less catalog).
//
// impit (https://github.com/apify/impit) is a Rust/reqwest napi addon that
// emulates a Chrome ClientHello and ships prebuilt binaries for every platform
// INCLUDING Windows x64/arm64. It replaces node-libcurl, which had no usable
// Windows prebuilt and had to be compiled from source there (MSVC + vcpkg) —
// a build that routinely failed on user machines.
//
// Verified end-to-end against the live Copilot edge: the Chrome fingerprint
// surfaces all 7 Claude models in /models (native fetch surfaces 0) and streams
// chat/completions incrementally through res.body.getReader() (104 reads over
// ~2.4s for a 200-word generation). Because impit's Response is API-compatible
// with the slice copilot/ consumes (status/statusText/ok/json()/text()/
// body.getReader()), this adapter is a thin pass-through — no byte queue or
// header parsing like the old libcurl path needed.

import { Impit, type RequestInit as ImpitRequestInit } from "impit";

// Resolve the proxy explicitly and pass it to the instance. impit DOES honor
// HTTPS_PROXY/HTTP_PROXY from the environment on its own, but we resolve it here
// anyway to (a) add the AI_BRIDGE_PROXY override and (b) make the dependency
// explicit and unit-testable rather than ambient. Precedence mirrors what
// install.sh writes into the service env.
//
// The proxy is REQUIRED for Claude, and for a reason SEPARATE from the TLS
// fingerprint that impit fixes: Copilot gates Claude on egress IP/geo too.
// Verified — with impit's Chrome fingerprint, /models still returns 0 Claude
// (28 entries) on a direct connection and 7 Claude only when the call exits via
// the proxy. So both gates must be cleared: impit for the fingerprint, the proxy
// for egress. See memory: copilot-claude-requires-proxy.
function resolveProxyUrl(): string | undefined {
  const env = process.env;
  return (
    env.AI_BRIDGE_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    undefined
  );
}

// One Impit instance owns a connection pool, so reuse it across requests rather
// than rebuilding per call. Created lazily so importing this module has no side
// effects, and so tests (which swap fetchImpl via __set*Deps) never construct it
// or touch the network.
let impit: Impit | null = null;
function client(): Impit {
  if (!impit) {
    impit = new Impit({
      browser: "chrome",
      proxyUrl: resolveProxyUrl(),
      // Real cert verification stays ON: the local proxy is a CONNECT tunnel,
      // not a MITM, so the upstream cert chain validates. Verified end-to-end
      // (ignoreTlsErrors=false → 200 + Claude present).
    });
  }
  return impit;
}

// fetch-compatible entry point. The callers only ever set method/headers/body/
// signal, all of which impit honors; the two RequestInit shapes are structurally
// different types, so bridge them with a cast.
function copilotFetchImpl(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return client().fetch(input, init as unknown as ImpitRequestInit) as unknown as Promise<Response>;
}

// Exposed as `typeof fetch` to satisfy the callers' fetchImpl type without
// widening it; only the consumed subset of Response is real.
export const copilotFetch = copilotFetchImpl as unknown as typeof fetch;
