import assert from "node:assert/strict";
import test from "node:test";

import {
  CopilotAuthError,
  type GitHubToken,
  __setAuthDeps,
  getCopilotToken,
  getGitHubToken,
  reauthCopilotToken,
} from "./index.js";

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("getCopilotToken exchanges the disk token and parses fields", async () => {
  let calls = 0;
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => {
      calls++;
      return jsonResponse({
        token: "copilot-1",
        expires_at: FAR_FUTURE,
        endpoints: { api: "https://api.example.com" },
      });
    },
  });

  const t = await getCopilotToken();
  assert.equal(t.token, "copilot-1");
  assert.equal(t.endpoint, "https://api.example.com");
  assert.equal(calls, 1);

  await getCopilotToken();
  assert.equal(calls, 1, "fresh token is cached, no second exchange");
});

test("getCopilotToken refreshes once expired", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60; // inside the 120s skew → stale
  let calls = 0;
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => {
      calls++;
      return jsonResponse({ token: `copilot-${calls}`, expires_at: exp });
    },
  });

  const a = await getCopilotToken();
  const b = await getCopilotToken();
  assert.notEqual(a.token, b.token);
  assert.equal(calls, 2, "stale token forces re-exchange");
});

test("defaults endpoint when none returned", async () => {
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => jsonResponse({ token: "c", expires_at: FAR_FUTURE }),
  });
  const t = await getCopilotToken();
  assert.equal(t.endpoint, "https://api.githubcopilot.com");
});

test("missing disk token raises sign-in error", async () => {
  __setAuthDeps({ readTokens: () => [], fetch: async () => jsonResponse({}) });
  await assert.rejects(getCopilotToken(), CopilotAuthError);
});

test("picks up creds written after startup without a restart", async () => {
  // Reproduces the wedged-401 bug: the service starts with no creds (so the
  // cache is an empty array), the user then runs `ai-bridge login` which writes
  // apps.json, and the very next request must succeed — no process restart, no
  // explicit reauth call. An empty cache must therefore never be authoritative.
  let disk: GitHubToken[] = [];
  __setAuthDeps({
    readTokens: () => disk,
    fetch: async () => jsonResponse({ token: "copilot-late", expires_at: FAR_FUTURE }),
  });

  // Startup probe with nothing on disk pins the cache to [] in the buggy version.
  assert.equal(getGitHubToken(), null);
  await assert.rejects(getCopilotToken(), CopilotAuthError);

  // `ai-bridge login` lands a token on disk.
  disk = [{ token: "oauth-late", user: "rick" }];

  // Next request re-reads disk on its own and exchanges — no restart needed.
  const t = await getCopilotToken();
  assert.equal(t.token, "copilot-late");
});

test("reauth re-reads disk and re-exchanges", async () => {
  let token = "oauth-1";
  let calls = 0;
  __setAuthDeps({
    readTokens: () => [{ token, user: "rick" }],
    fetch: async () => {
      calls++;
      return jsonResponse({ token: `copilot-${calls}`, expires_at: FAR_FUTURE });
    },
  });
  await getCopilotToken();
  token = "oauth-2";
  const t = await reauthCopilotToken();
  assert.equal(t.token, "copilot-2");
  assert.equal(calls, 2);
});

test("exchange HTTP 401 surfaces status", async () => {
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => jsonResponse({ message: "bad creds" }, 401),
  });
  await assert.rejects(getCopilotToken(), (e: CopilotAuthError) => e.status === 401);
});

test("tries the next disk token when the first fails", async () => {
  __setAuthDeps({
    readTokens: () => [
      { token: "ghu-bad", user: "rick" },
      { token: "gho-good", user: "rick" },
    ],
    fetch: async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth.includes("gho-good")
        ? jsonResponse({ token: "copilot-ok", expires_at: FAR_FUTURE })
        : jsonResponse({ message: "Bad credentials" }, 401);
    },
  });
  const t = await getCopilotToken();
  assert.equal(t.token, "copilot-ok");
});
