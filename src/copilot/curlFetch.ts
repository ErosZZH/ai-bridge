// node-libcurl-backed `fetch` adapter for the Copilot upstream. GitHub's Copilot
// edge gates Claude (and ~7 catalog entries) on the TLS ClientHello fingerprint:
// the same request succeeds from libcurl but fails from Node's native TLS stack
// (undici AND node:https return `model_not_supported` / a Claude-less catalog).
// Routing copilot/ through libcurl is what makes Claude reachable standalone.
//
// Only the slice of the Fetch `Response` that copilot/index.ts and copilot/
// models.ts actually use is implemented: ok/status/statusText, json()/text(),
// and a streaming body via getReader(). Tests inject a real undici Response
// through the __set*Deps seam, so this file is production-only.

import { Curl } from "node-libcurl";

type CurlResponseInit = {
  status: number;
  statusText: string;
  stream: boolean;
  // Pushed by the libcurl WRITEFUNCTION as bytes arrive; closed on `end`/`error`.
  chunks: AsyncQueue;
};

// A single-producer/single-consumer byte queue bridging libcurl's push-based
// WRITEFUNCTION to the pull-based getReader().read() the stream loop expects.
class AsyncQueue {
  private buffers: Uint8Array[] = [];
  private waiting: ((r: { value: Uint8Array; done: boolean }) => void) | null = null;
  private ended = false;
  private error: Error | null = null;

  push(chunk: Uint8Array): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: chunk, done: false });
    } else {
      this.buffers.push(chunk);
    }
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error ?? null;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      // A reader awaiting when an error lands is rejected via the stored error
      // on the next read; here we just release it as done.
      resolve({ value: new Uint8Array(0), done: true });
    }
  }

  read(): Promise<{ value: Uint8Array; done: boolean }> {
    if (this.error && this.buffers.length === 0) return Promise.reject(this.error);
    const next = this.buffers.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (this.ended) return Promise.resolve({ value: new Uint8Array(0), done: true });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  // Drain everything into one buffer — used by json()/text() on the non-stream
  // path, where the whole body is wanted at once.
  async collect(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await this.read();
      if (value.length) parts.push(value);
      if (done) break;
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

// The minimal Response the two callers consume. `body` is null when no stream
// was requested, matching how they branch on Accept.
class CurlResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly body: { getReader: () => { read: () => Promise<{ value: Uint8Array; done: boolean }> } } | null;
  private readonly chunks: AsyncQueue;

  constructor(init: CurlResponseInit) {
    this.status = init.status;
    this.statusText = init.statusText;
    this.ok = init.status >= 200 && init.status < 300;
    this.chunks = init.chunks;
    this.body = init.stream
      ? { getReader: () => ({ read: () => this.chunks.read() }) }
      : null;
  }

  async text(): Promise<string> {
    const bytes = await this.chunks.collect();
    return new TextDecoder().decode(bytes);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

function headerArray(headers: RequestInit["headers"]): string[] {
  if (!headers) return [];
  const out: string[] = [];
  // copilot/ always passes a plain record, but tolerate Headers/entries too.
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers as Record<string, string>);
  for (const [k, v] of entries) out.push(`${k}: ${v}`);
  return out;
}

// Map HTTP status code -> reason phrase for the few the callers log. Falls back
// to an empty string (callers only ever read it into an error message).
function reason(status: number): string {
  const map: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    413: "Payload Too Large",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return map[status] ?? "";
}

// fetch-compatible entry point. Honors method/headers/body, streams when the
// Accept header asks for SSE, and tears the transfer down on AbortSignal.
function curlFetchImpl(
  input: string | URL,
  init: RequestInit = {},
): Promise<CurlResponse> {
  const url = typeof input === "string" ? input : input.toString();
  const headers = headerArray(init.headers);
  const accept = headers.find((h) => h.toLowerCase().startsWith("accept:")) ?? "";
  const stream = accept.toLowerCase().includes("text/event-stream");
  const signal = init.signal ?? undefined;

  return new Promise<CurlResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const curl = new Curl();
    const chunks = new AsyncQueue();
    let settled = false;
    let onAbort: (() => void) | null = null;

    const cleanup = () => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };

    curl.setOpt("URL", url);
    if (init.method && init.method !== "GET") curl.setOpt("CUSTOMREQUEST", init.method);
    if (headers.length) curl.setOpt("HTTPHEADER", headers);
    if (init.body != null) curl.setOpt("POSTFIELDS", String(init.body));
    // Follow redirects the way fetch does; keep it conservative.
    curl.setOpt("FOLLOWLOCATION", true);

    // Push body bytes to the queue as they arrive. Returning the byte count
    // tells libcurl we consumed them. The same queue feeds both the streaming
    // reader and the non-stream collect().
    curl.setOpt(Curl.option.WRITEFUNCTION, (buf: Buffer) => {
      chunks.push(new Uint8Array(buf));
      return buf.length;
    });

    // Parse the HTTP status from the response's status line ourselves (libcurl
    // delivers each header line here, status line first). Avoids getInfo() mid
    // transfer, which can throw inside the C callback and silently stall the
    // perform. Resolve the Response once the header block ends (blank line) so
    // streaming consumers can read while the body is still arriving; callers
    // read res.status before the body, so status must be known by resolve time.
    let resolvedStatus = false;
    let status = 0;
    const resolveOnce = () => {
      if (resolvedStatus || settled) return;
      resolvedStatus = true;
      resolve(new CurlResponse({ status, statusText: reason(status), stream, chunks }));
    };
    curl.setOpt(Curl.option.HEADERFUNCTION, (buf: Buffer) => {
      const line = buf.toString("latin1");
      const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
      if (m) status = Number(m[1]); // a redirect chain resets this to the final hop
      else if (line === "\r\n" || line === "\n") resolveOnce(); // end of a header block
      return buf.length;
    });

    curl.on("end", (statusCode: number) => {
      settled = true;
      cleanup();
      // Fallback: if no blank-line header terminator was seen, resolve here.
      if (!resolvedStatus) {
        status = status || statusCode;
        resolvedStatus = true;
        resolve(new CurlResponse({ status, statusText: reason(status), stream, chunks }));
      }
      chunks.end();
      curl.close();
    });

    curl.on("error", (err: Error) => {
      settled = true;
      cleanup();
      chunks.end(err);
      curl.close();
      if (!resolvedStatus) reject(err);
    });

    if (signal) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        chunks.end(abortError());
        try {
          curl.close();
        } catch {
          // already closing
        }
        if (!resolvedStatus) reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    curl.perform();
  });
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

// Exposed as `typeof fetch` to satisfy the callers' fetchImpl type without
// widening it; only the consumed subset of Response is real.
export const curlFetch = curlFetchImpl as unknown as typeof fetch;
