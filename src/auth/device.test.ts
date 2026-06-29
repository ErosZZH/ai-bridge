import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CopilotAuthError, readGitHubTokens, writeGitHubToken } from "./index.js";
import { COPILOT_CLIENT_ID, type DeviceCode, pollForToken } from "./device.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CODE: DeviceCode = {
  deviceCode: "dev-code",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  interval: 5,
  expiresIn: 900,
};

// Records every sleep so we can assert backoff without real delays.
function fakeSleep() {
  const waits: number[] = [];
  const sleep = async (s: number) => {
    waits.push(s);
  };
  return { waits, sleep };
}

test("pollForToken returns the token after pending rounds", async () => {
  let calls = 0;
  const { sleep } = fakeSleep();
  const fetchImpl = (async () => {
    calls++;
    return calls < 3
      ? jsonResponse({ error: "authorization_pending" })
      : jsonResponse({ access_token: "gho_minted" });
  }) as unknown as typeof fetch;

  const token = await pollForToken(fetchImpl, sleep, CODE);
  assert.equal(token, "gho_minted");
  assert.equal(calls, 3);
});

test("pollForToken lengthens the interval on slow_down", async () => {
  let calls = 0;
  const { waits, sleep } = fakeSleep();
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return jsonResponse({ error: "slow_down", interval: 12 });
    return jsonResponse({ access_token: "gho_ok" });
  }) as unknown as typeof fetch;

  await pollForToken(fetchImpl, sleep, CODE);
  // first poll waits the base 5s, second waits the bumped 12s
  assert.deepEqual(waits, [5, 12]);
});

test("pollForToken throws on expired_token", async () => {
  const { sleep } = fakeSleep();
  const fetchImpl = (async () => jsonResponse({ error: "expired_token" })) as unknown as typeof fetch;
  await assert.rejects(pollForToken(fetchImpl, sleep, CODE), CopilotAuthError);
});

test("pollForToken throws on access_denied", async () => {
  const { sleep } = fakeSleep();
  const fetchImpl = (async () => jsonResponse({ error: "access_denied" })) as unknown as typeof fetch;
  await assert.rejects(pollForToken(fetchImpl, sleep, CODE), CopilotAuthError);
});

test("pollForToken gives up once expiresIn elapses", async () => {
  const { sleep } = fakeSleep();
  // Always pending; expiresIn is just under two intervals so it bails fast.
  const fetchImpl = (async () =>
    jsonResponse({ error: "authorization_pending" })) as unknown as typeof fetch;
  await assert.rejects(
    pollForToken(fetchImpl, sleep, { ...CODE, interval: 5, expiresIn: 9 }),
    CopilotAuthError,
  );
});

test("writeGitHubToken round-trips and preserves existing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-bridge-auth-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    // First write creates the github-copilot dir + apps.json.
    const path = writeGitHubToken("gho_first", "alice");
    // Inject a foreign cred (the kind VS Code/gh writes) directly, then write
    // again — it must survive.
    const seeded = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    seeded["github.com:other"] = { oauth_token: "gho_other", user: "bob" };
    writeFileSync(path, JSON.stringify(seeded, null, 2));

    writeGitHubToken("gho_second", "alice"); // overwrites our key, keeps github.com:other

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.ok(onDisk["github.com:other"], "foreign key preserved");
    assert.ok(onDisk[`github.com:${COPILOT_CLIENT_ID}`], "our key present");
    assert.equal(
      (onDisk[`github.com:${COPILOT_CLIENT_ID}`] as { oauth_token: string }).oauth_token,
      "gho_second",
    );

    const tokens = readGitHubTokens();
    assert.ok(tokens.some((t) => t.token === "gho_second"));
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  }
});
