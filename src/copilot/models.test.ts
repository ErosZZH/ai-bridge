import assert from "node:assert/strict";
import test from "node:test";

import { __setAuthDeps } from "../auth/index.js";
import { CopilotRequestError } from "./index.js";
import { __resetModelsCache, __setModelsDeps, getModels, resolveModel } from "./models.js";

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function authOk() {
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => json({ token: "copilot-bearer", expires_at: FAR_FUTURE }),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CHAT = {
  id: "claude-opus-4.8",
  name: "Claude Opus 4.8",
  vendor: "Anthropic",
  object: "model",
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    type: "chat",
    limits: { max_context_window_tokens: 200000, max_output_tokens: 64000, max_prompt_tokens: 136000 },
  },
};
const SONNET = {
  ...CHAT,
  id: "claude-sonnet-4.6",
  name: "Claude Sonnet 4.6",
};
const HAIKU = {
  ...CHAT,
  id: "claude-haiku-4.5",
  name: "Claude Haiku 4.5",
};
const EMBED = { id: "text-embedding-3-small", object: "model", capabilities: { type: "embeddings" } };

// A /responses-only model (e.g. gpt-5.5): no /chat/completions in its endpoints.
const RESPONSES_ONLY = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  vendor: "OpenAI",
  object: "model",
  supported_endpoints: ["/responses", "ws:/responses"],
  capabilities: {
    type: "chat",
    limits: { max_context_window_tokens: 1050000, max_output_tokens: 128000, max_prompt_tokens: 922000 },
  },
};

test("getModels parses windows and drops non-chat entries", async () => {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [CHAT, EMBED] }), now: () => 0 });
  const models = await getModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "claude-opus-4.8");
  assert.equal(models[0].maxContextWindowTokens, 200000);
  assert.equal(models[0].maxPromptTokens, 136000);
});

test("getModels tags endpoint: chat for /chat/completions, responses for /responses-only", async () => {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [CHAT, RESPONSES_ONLY, EMBED] }), now: () => 0 });
  const models = await getModels();
  // embeddings still dropped; both chat + responses-only survive
  assert.deepEqual(
    models.map((m) => m.id).sort(),
    ["claude-opus-4.8", "gpt-5.5"],
  );
  assert.equal(models.find((m) => m.id === "claude-opus-4.8")?.endpoint, "chat");
  assert.equal(models.find((m) => m.id === "gpt-5.5")?.endpoint, "responses");
  assert.equal(models.find((m) => m.id === "gpt-5.5")?.maxOutputTokens, 128000);
});

test("getModels caches within TTL, refetches after expiry", async () => {
  authOk();
  __resetModelsCache();
  let calls = 0;
  let t = 0;
  __setModelsDeps({
    fetch: async () => {
      calls++;
      return json({ data: [CHAT] });
    },
    now: () => t,
  });
  await getModels();
  await getModels();
  assert.equal(calls, 1); // second hit served from cache
  t = 6 * 60 * 1000; // past 5m TTL
  await getModels();
  assert.equal(calls, 2);
});

test("resolveModel matches exact id, no fuzzy fallback", async () => {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [CHAT] }), now: () => 0 });
  assert.equal((await resolveModel("claude-opus-4.8"))?.id, "claude-opus-4.8");
  assert.equal(await resolveModel("claude-opus"), null); // close but not exact -> null
});

test("resolveModel strips Claude Code's [1m] suffix before matching", async () => {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [CHAT] }), now: () => 0 });
  // CC writes ANTHROPIC_MODEL with [1m]; the bare id is what the catalog carries.
  assert.equal((await resolveModel("claude-opus-4.8[1m]"))?.id, "claude-opus-4.8");
});

test("resolveModel maps Anthropic canonical Claude ids to Copilot catalog ids", async () => {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [CHAT, SONNET, HAIKU] }), now: () => 0 });
  assert.equal((await resolveModel("claude-opus-4-8"))?.id, "claude-opus-4.8");
  assert.equal((await resolveModel("claude-opus-4-8[1m]"))?.id, "claude-opus-4.8");
  assert.equal((await resolveModel("claude-sonnet-4-6"))?.id, "claude-sonnet-4.6");
  assert.equal((await resolveModel("claude-haiku-4-5"))?.id, "claude-haiku-4.5");
  assert.equal((await resolveModel("claude-haiku-4-5-20251001"))?.id, "claude-haiku-4.5");
  assert.equal(await resolveModel("claude-haiku-4-6"), null);
});

test("resolveModel passes 'auto' through", async () => {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [CHAT] }), now: () => 0 });
  assert.equal(await resolveModel("auto"), null);
});

test("getModels surfaces non-ok status", async () => {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ error: "boom" }, 500), now: () => 0 });
  await assert.rejects(getModels(), (e: CopilotRequestError) => e.status === 500);
});
