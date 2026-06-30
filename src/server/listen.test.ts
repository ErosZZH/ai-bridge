import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, test } from "node:test";

import { listenWithFallback } from "./listen.js";

// A trivial fetch handler; these tests only exercise port binding, not routing.
const noopFetch = () => new Response("ok");

const HOST = "127.0.0.1";
const closers: Array<() => void> = [];
after(() => {
  for (const close of closers) close();
});

// Occupy a port so the next listen attempt sees EADDRINUSE, exactly as a WSL
// guest holding the default port would. Resolves with the held port number.
function occupy(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const blocker = createServer();
    blocker.once("error", reject);
    blocker.listen({ host, port: 0, exclusive: true }, () => {
      closers.push(() => blocker.close());
      resolve((blocker.address() as { port: number }).port);
    });
  });
}

test("binds the requested port when it is free", async () => {
  const { server, port } = await listenWithFallback(noopFetch, HOST, 0);
  closers.push(() => server.close());
  assert.ok(port > 0);
});

test("hops to the next port and reports the actual bound port when the first is taken", async () => {
  const taken = await occupy(HOST);

  const skipped: number[] = [];
  const { server, port } = await listenWithFallback(
    noopFetch,
    HOST,
    taken,
    10,
    (p) => skipped.push(p),
  );
  closers.push(() => server.close());

  // It must NOT return the occupied port — that's the whole bug. The returned
  // port is what gets written to settings.json, so it has to be the live one.
  assert.notEqual(port, taken);
  assert.ok(port > taken);
  assert.deepEqual(skipped, [taken]);
});

test("throws when no port is free within the scan window", async () => {
  const taken = await occupy(HOST);
  // scanLimit 1 means it only tries the occupied port, then gives up.
  await assert.rejects(
    () => listenWithFallback(noopFetch, HOST, taken, 1),
    /no free port found/,
  );
});
