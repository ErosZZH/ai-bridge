import assert from "node:assert/strict";
import test from "node:test";

import { __setAuthDeps } from "../../auth/index.js";
import { __resetModelsCache, __setModelsDeps } from "../../copilot/models.js";
import { loadConfig } from "../../config.js";
import { Logger } from "../../obs/index.js";
import { createServer } from "../index.js";

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Stub the disk-creds + token-exchange seam so the catalog fetch has a bearer
// without touching the real filesystem or network.
function authOk() {
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => json({ token: "copilot-bearer", expires_at: FAR_FUTURE }),
  });
}

const CHAT_A = {
  id: "gpt-4o",
  name: "GPT-4o",
  vendor: "OpenAI",
  object: "model",
  supported_endpoints: ["/chat/completions"],
  capabilities: { type: "chat", limits: { max_context_window_tokens: 128000, max_prompt_tokens: 120000 } },
};
const CHAT_B = {
  id: "claude-opus-4.8",
  name: "Claude Opus 4.8",
  vendor: "Anthropic",
  object: "model",
  supported_endpoints: ["/chat/completions"],
  capabilities: { type: "chat", limits: { max_context_window_tokens: 200000, max_prompt_tokens: 136000 } },
};

function app(catalogFetch: typeof fetch) {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: catalogFetch, now: () => 0 });
  return createServer(loadConfig({}), new Logger("error"));
}

test("GET /v1/models returns the Anthropic models envelope", async () => {
  const server = app(async () => json({ data: [CHAT_A, CHAT_B] }));
  const res = await server.request("/v1/models");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: { id: string; type: string; max_input_tokens: number }[];
    first_id: string;
    last_id: string;
    has_more: boolean;
  };
  assert.equal(body.data.length, 2);
  assert.deepEqual(
    body.data.map((m) => m.id),
    ["gpt-4o", "claude-opus-4.8"],
  );
  assert.equal(body.data[0].type, "model");
  assert.equal(body.data[0].max_input_tokens, 120000); // prompt window preferred
  assert.equal(body.first_id, "gpt-4o");
  assert.equal(body.last_id, "claude-opus-4.8");
  assert.equal(body.has_more, false);
});

test("GET /v1/models/:id returns one model", async () => {
  const server = app(async () => json({ data: [CHAT_A, CHAT_B] }));
  const res = await server.request("/v1/models/claude-opus-4.8");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; display_name: string; max_input_tokens: number };
  assert.equal(body.id, "claude-opus-4.8");
  assert.equal(body.display_name, "Claude Opus 4.8");
  assert.equal(body.max_input_tokens, 136000);
});

test("GET /v1/models/:id strips Claude Code's [1m] suffix before matching", async () => {
  const server = app(async () => json({ data: [CHAT_A, CHAT_B] }));
  const res = await server.request("/v1/models/claude-opus-4.8%5B1m%5D");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string };
  assert.equal(body.id, "claude-opus-4.8");
});

test("GET /v1/models/:id 404s an unknown id", async () => {
  const server = app(async () => json({ data: [CHAT_A] }));
  const res = await server.request("/v1/models/nope");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { type: string; error: { type: string } };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "not_found_error");
});

test("GET /v1/models surfaces a catalog failure as 500", async () => {
  const server = app(async () => json({ error: "boom" }, 500));
  const res = await server.request("/v1/models");
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: { type: string } };
  assert.equal(body.error.type, "api_error");
});
