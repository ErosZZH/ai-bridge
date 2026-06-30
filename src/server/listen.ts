// Binds the HTTP server, scanning forward from a starting port until one is free.
// This is the authority on which port the bridge actually runs on: unlike the
// installer's pre-probe (a time-of-check that can go stale before the service
// binds at logon), this reacts to the real bind result, so the port it returns
// is the port clients can truly reach. The caller writes that port into
// ~/.claude/settings.json, keeping ANTHROPIC_BASE_URL in lockstep with the bind.

import { serve } from "@hono/node-server";

// Derive the fetch handler type straight from serve's own options so whatever we
// accept is exactly what serve accepts (no drift if the lib's signature changes).
type FetchHandler = Parameters<typeof serve>[0]["fetch"];

export type ListenResult = {
  server: ReturnType<typeof serve>;
  port: number;
};

// Try startPort, startPort+1, … up to scanLimit attempts, resolving with the
// first port that binds. Only EADDRINUSE advances to the next candidate; any
// other listen error (e.g. EACCES) is fatal and rethrown. onSkip is invoked with
// each occupied port so the caller can log the hop.
export async function listenWithFallback(
  fetch: FetchHandler,
  hostname: string,
  startPort: number,
  scanLimit = 50,
  onSkip?: (port: number) => void,
): Promise<ListenResult> {
  let lastErr: NodeJS.ErrnoException | undefined;

  for (let port = startPort; port < startPort + scanLimit; port++) {
    try {
      return await new Promise<ListenResult>((resolve, reject) => {
        // Reject the attempt on a bind error; detach this handler once we're
        // listening so it can't later swallow a genuine runtime error.
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        const server = serve({ fetch, hostname, port }, (info) => {
          server.removeListener("error", onError);
          resolve({ server, port: info.port });
        });
        server.once("error", onError);
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EADDRINUSE") {
        onSkip?.(port);
        lastErr = e;
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `no free port found in range ${startPort}-${startPort + scanLimit - 1}` +
      (lastErr ? `: ${lastErr.message}` : ""),
  );
}
