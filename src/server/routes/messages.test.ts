import assert from "node:assert/strict";
import test from "node:test";

import { __setAuthDeps } from "../../auth/index.js";
import { __setCopilotDeps } from "../../copilot/index.js";
import { __setResponsesDeps } from "../../copilot/responses.js";
import { __resetModelsCache, __setModelsDeps } from "../../copilot/models.js";
import { __setResponseDeps } from "../../convert/index.js";
import { loadConfig } from "../../config.js";
import { Logger } from "../../obs/index.js";
import { createServer } from "../index.js";

__setResponseDeps({ id: () => "msg_test" });

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// SSE response body from a list of OpenAI chunk objects, framed like Copilot's
// stream (`data: {...}` lines, terminated by `data: [DONE]`).
function sse(chunks: unknown[]): Response {
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(lines, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function authOk() {
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => json({ token: "copilot-bearer", expires_at: FAR_FUTURE }),
  });
}

const GPT = {
  id: "gpt-4o",
  name: "GPT-4o",
  vendor: "OpenAI",
  object: "model",
  supported_endpoints: ["/chat/completions"],
  capabilities: { type: "chat", limits: { max_context_window_tokens: 128000, max_prompt_tokens: 120000 } },
};

// A /responses-only model, with a catalog max_output_tokens the route should use
// as the default budget when the client omits max_tokens.
const RESP = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  vendor: "OpenAI",
  object: "model",
  supported_endpoints: ["/responses", "ws:/responses"],
  capabilities: { type: "chat", limits: { max_context_window_tokens: 1050000, max_output_tokens: 128000, max_prompt_tokens: 922000 } },
};

// Build a server with the model catalog stubbed; `chatFetch` stubs the Copilot
// chat/completions call (the seam the messages route ultimately drives).
function app(chatFetch: typeof fetch) {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [GPT, RESP] }), now: () => 0 });
  __setCopilotDeps({ fetch: chatFetch });
  return createServer(loadConfig({}), new Logger("error"));
}

// Like `app` but also stubs the /responses upstream. Returns the server plus a
// getter for the last body POSTed to /responses, so tests can assert mapping +
// the injected default budget.
function appWithResponses(respFetch: typeof fetch) {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [GPT, RESP] }), now: () => 0 });
  __setCopilotDeps({ fetch: async () => json({}, 200) });
  __setResponsesDeps({ fetch: respFetch });
  return createServer(loadConfig({}), new Logger("error"));
}

function post(server: ReturnType<typeof createServer>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    server.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /v1/messages non-stream -> Anthropic Message with exact usage", async () => {
  const server = app(async () =>
    json({
      id: "cc-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    }),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    id: string;
    content: { type: string; text: string }[];
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  };
  assert.equal(body.id, "msg_test");
  assert.deepEqual(body.content, [{ type: "text", text: "hi there" }]);
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.usage.input_tokens, 12);
  assert.equal(body.usage.output_tokens, 3);
  assert.equal(body.usage.cache_read_input_tokens, 8);
});

test("POST /v1/messages stream -> Anthropic SSE lifecycle", async () => {
  const server = app(async () =>
    sse([
      { choices: [{ delta: { role: "assistant", content: "he" } }] },
      { choices: [{ delta: { content: "llo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();

  // Event order: message_start, then a text block opens, deltas, closes, then
  // message_delta + message_stop.
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.match(text, /"text_delta","text":"he"/);
  assert.match(text, /"text_delta","text":"llo"/);
  assert.match(text, /"stop_reason":"end_turn"/);
});

test("POST /v1/messages 404s an unknown model (no fuzzy fallback)", async () => {
  const server = app(async () => json({}, 200));
  const res = await post(server, "/v1/messages", {
    model: "totally-made-up",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: { type: string } };
  assert.equal(body.error.type, "not_found_error");
});

test("POST /v1/messages maps a context-length error to 400 (Defect A3)", async () => {
  const server = app(async () =>
    new Response(JSON.stringify({ error: { message: "prompt is too long: 250000 tokens > context window" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { type: string } };
  assert.equal(body.error.type, "invalid_request_error");
});

test("POST /v1/messages surfaces missing creds as 401", async () => {
  // Prime the catalog cache while auth is good so model resolution succeeds...
  const server = app(async () => json({}, 200));
  await server.request("/v1/models");
  // ...then drop disk creds so only the chat call fails with an auth error.
  __setAuthDeps({ readTokens: () => [], fetch: async () => json({}, 200) });

  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { type: string } };
  assert.equal(body.error.type, "authentication_error");
});

test("POST /v1/messages/count_tokens returns a positive input_tokens", async () => {
  const server = app(async () => json({}, 200));
  const res = await post(server, "/v1/messages/count_tokens", {
    model: "gpt-4o",
    messages: [{ role: "user", content: "count the tokens in this sentence please" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { input_tokens: number };
  assert.ok(body.input_tokens > 0, "expected a positive token count");
});

test("POST /v1/messages routes a /responses-only model through the Responses path", async () => {
  let captured: { url: string; body: unknown } | null = null;
  const server = appWithResponses(async (url, init) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
    return json({
      id: "resp-1",
      model: "gpt-5.5-2026-04-23",
      status: "completed",
      output: [
        { type: "reasoning" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi from responses" }] },
      ],
      usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
    });
  });

  const res = await post(server, "/v1/messages", {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    content: { type: string; text: string }[];
    usage: { input_tokens: number; output_tokens: number };
  };
  assert.deepEqual(body.content, [{ type: "text", text: "hi from responses" }]);
  assert.equal(body.usage.input_tokens, 11);
  assert.equal(body.usage.output_tokens, 4);

  // It hit /responses, NOT /chat/completions, and the per-model catalog
  // max_output_tokens (128000) was injected as the default budget.
  assert.ok(captured, "responses upstream was called");
  assert.match((captured as { url: string }).url, /\/responses$/);
  const sent = (captured as { body: { max_output_tokens?: number } }).body;
  assert.equal(sent.max_output_tokens, 128000);
});

test("POST /v1/messages (responses) stream -> Anthropic SSE lifecycle", async () => {
  const events = [
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_text.delta", delta: "hel" },
    { type: "response.output_text.delta", delta: "lo" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 9, output_tokens: 5 } } },
  ];
  const server = appWithResponses(async () => sse(events));
  const res = await post(server, "/v1/messages", {
    model: "gpt-5.5",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const seen = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(seen, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.match(text, /"text_delta","text":"hel"/);
  assert.match(text, /"stop_reason":"end_turn"/);
});

test("chat model still gets a default budget when max_tokens omitted", async () => {
  let sentBody: { max_tokens?: number } | null = null;
  const server = app(async (_url, init) => {
    sentBody = JSON.parse(String(init?.body ?? "{}"));
    return json({
      id: "cc-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  await post(server, "/v1/messages", { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
  // gpt-4o has no max_output_tokens in its stubbed limits -> floor (32000).
  assert.equal((sentBody as unknown as { max_tokens: number }).max_tokens, 32000);
});
