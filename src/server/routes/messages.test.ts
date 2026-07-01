import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeClaudeSettings } from "../../claude-config.js";
import { __setAuthDeps } from "../../auth/index.js";
import { __setCopilotDeps, chatCompletion } from "../../copilot/index.js";
import { __setResponsesDeps } from "../../copilot/responses.js";
import { __resetModelsCache, __setModelsDeps } from "../../copilot/models.js";
import { __setResponseDeps } from "../../convert/index.js";
import { __setSearchDeps } from "../../search/ddg.js";
import { __setSearchIdDep } from "../../search/websearch.js";
import { loadConfig } from "../../config.js";
import { Logger } from "../../obs/index.js";
import { createServer } from "../index.js";

__setResponseDeps({ id: () => "msg_test" });

// Error-path tests write capture files; isolate them in a temp dir instead of the
// real ~/.ai-bridge/logs.
const TEST_LOG_DIR = mkdtempSync(join(tmpdir(), "ai-bridge-test-"));
// The route now reads ~/.claude/settings.json on every request to pin the model.
// Keep route tests isolated from the developer's real Claude Code settings unless
// a test explicitly swaps HOME with withTempHome().
const TEST_HOME_DIR = mkdtempSync(join(tmpdir(), "ai-bridge-home-default-"));
process.env.HOME = TEST_HOME_DIR;
function testConfig() {
  return loadConfig({ AI_BRIDGE_LOG_DIR: TEST_LOG_DIR });
}

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

// A Claude model: the bridge must forward this bare id upstream even when the
// request carries Claude Code's `[1m]` context marker (claude-opus-4.8[1m]).
const CLAUDE = {
  id: "claude-opus-4.8",
  name: "Claude Opus 4.8",
  vendor: "Anthropic",
  object: "model",
  supported_endpoints: ["/chat/completions"],
  capabilities: { type: "chat", limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 936000 } },
};
const CLAUDE_HAIKU = {
  ...CLAUDE,
  id: "claude-haiku-4.5",
  name: "Claude Haiku 4.5",
};

// Build a server with the model catalog stubbed; `chatFetch` stubs the Copilot
// chat/completions call (the seam the messages route ultimately drives).
function app(chatFetch: typeof fetch) {
  authOk();
  __resetModelsCache();
  __setModelsDeps({ fetch: async () => json({ data: [GPT, RESP, CLAUDE, CLAUDE_HAIKU] }), now: () => 0 });
  __setCopilotDeps({ fetch: chatFetch });
  return createServer(testConfig(), new Logger("error"));
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
  return createServer(testConfig(), new Logger("error"));
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

async function withTempHome<T>(body: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-bridge-home-"));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await body();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
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
  // input_tokens is cache-exclusive: prompt 12 - cached 8 = 4.
  assert.equal(body.usage.input_tokens, 4);
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

test("POST /v1/messages uses the configured gpt-5.5 model despite an inbound subagent override", async () => {
  await withTempHome(async () => {
    writeClaudeSettings({
      baseUrl: "http://127.0.0.1:11500",
      authToken: "ai-bridge",
      model: "gpt-5.5",
      maxInputTokens: 922000,
    });
    let captured: { url: string; body: unknown } | null = null;
    const server = appWithResponses(async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
      return json({
        id: "resp-override",
        model: "gpt-5.5-2026-04-23",
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pinned" }] }],
        usage: { input_tokens: 11, output_tokens: 2 },
      });
    });

    const res = await post(server, "/v1/messages", {
      model: "claude-sonnet-4-6",
      temperature: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { content: { type: string; text: string }[] };
    assert.deepEqual(body.content, [{ type: "text", text: "pinned" }]);

    assert.ok(captured, "responses upstream was called");
    assert.match((captured as { url: string }).url, /\/responses$/);
    const sent = (captured as { body: { model?: string; temperature?: number } }).body;
    assert.equal(sent.model, "gpt-5.5");
    assert.equal(sent.temperature, 1);
  });
});

test("POST /v1/messages without a configured model uses the inbound model", async () => {
  await withTempHome(async () => {
    let sentBody: { model?: string } | null = null;
    const server = app(async (_url, init) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return json({
        id: "cc-1",
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const res = await post(server, "/v1/messages", {
      model: "gpt-4o",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    assert.ok(sentBody, "upstream was called");
    assert.equal((sentBody as { model: string }).model, "gpt-4o");
  });
});

test("POST /v1/messages/count_tokens uses the configured model", async () => {
  await withTempHome(async () => {
    writeClaudeSettings({
      baseUrl: "http://127.0.0.1:11500",
      authToken: "ai-bridge",
      model: "claude-opus-4.8",
      maxInputTokens: 936000,
    });
    const server = app(async () => json({}, 200));
    const res = await post(server, "/v1/messages/count_tokens", {
      model: "totally-made-up",
      messages: [{ role: "user", content: "count with configured model" }],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { input_tokens: number };
    assert.ok(body.input_tokens > 0, "expected a positive token count");
  });
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

test("every response carries an x-request-id header (observability)", async () => {
  const server = app(async () =>
    json({
      id: "cc-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 8,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(res.headers.get("x-request-id") ?? "", /^[a-z0-9]+-[0-9a-f]{8}$/);
});

test("an errored request returns request_id + log_file and writes the capture", async () => {
  const before = readdirSync(TEST_LOG_DIR).length;
  const server = app(async () =>
    new Response(JSON.stringify({ error: { message: "prompt is too long: 250000 > context window" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 400);

  const headerId = res.headers.get("x-request-id");
  const body = (await res.json()) as {
    error: { type: string; message: string; request_id: string; log_file: string };
  };
  // The id in the body matches the header, so a user can quote either.
  assert.equal(body.error.request_id, headerId);
  assert.ok(body.error.log_file, "expected a log_file path in the error body");

  // The harness only renders `error.message`, so the id + capture path must be
  // folded into the message text to be visible on screen (task 11 finding).
  assert.ok(body.error.message.includes(headerId as string));
  assert.ok(body.error.message.includes(body.error.log_file));

  // The capture file actually exists, is named with the id, and holds the
  // upstream status — the real exchange agent-maestro could not see.
  const after = readdirSync(TEST_LOG_DIR);
  assert.equal(after.length, before + 1);
  assert.ok(body.error.log_file.includes(headerId as string));
  const dump = JSON.parse(readFileSync(body.error.log_file, "utf8"));
  assert.equal(dump.requestId, headerId);
  assert.equal(dump.upstream.status, 400);
  assert.equal(dump.endpoint, "/v1/messages");
});

// --- Task 10: tools / cache / compaction / abort (integration vs the route) ---

test("POST /v1/messages (tools) forwards OpenAI tools+tool_choice and maps tool_calls -> tool_use", async () => {
  let sent: { tools?: unknown; tool_choice?: unknown } | null = null;
  const server = app(async (_url, init) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return json({
      id: "cc-1",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
    });
  });

  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 64,
    tools: [{ name: "get_weather", description: "Look up weather", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "get_weather" },
    messages: [{ role: "user", content: "weather in SF?" }],
  });
  assert.equal(res.status, 200);

  // Upstream got OpenAI-shaped tools + a named tool_choice (the 6b/6e fixes).
  assert.ok(sent, "upstream was called");
  const body = sent as { tools: { type: string; function: { name: string } }[]; tool_choice: unknown };
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "get_weather");
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "get_weather" } });

  // Response: the tool_call became a tool_use block with parsed input, and
  // stop_reason upgraded to tool_use.
  const out = (await res.json()) as {
    content: { type: string; id?: string; name?: string; input?: unknown }[];
    stop_reason: string;
  };
  assert.equal(out.stop_reason, "tool_use");
  const toolBlock = out.content.find((b) => b.type === "tool_use");
  assert.ok(toolBlock, "expected a tool_use block");
  assert.equal(toolBlock.id, "call_1");
  assert.equal(toolBlock.name, "get_weather");
  assert.deepEqual(toolBlock.input, { city: "SF" });
});

test("POST /v1/messages (tools, stream) reassembles arg fragments into input_json_delta", async () => {
  const server = app(async () =>
    sse([
      {
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "search", arguments: "" } }],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'cats"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 } },
    ]),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    stream: true,
    tools: [{ name: "search", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "find cats" }],
  });
  assert.equal(res.status, 200);
  const text = await res.text();

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
  // The tool_use block opens with id+name, and the arg fragments are forwarded
  // verbatim as input_json_delta (the harness concatenates them).
  assert.match(text, /"type":"tool_use","id":"call_9","name":"search"/);
  assert.match(text, /"input_json_delta","partial_json":"\{\\"q\\":\\""/);
  assert.match(text, /"input_json_delta","partial_json":"cats\\"\}"/);
  assert.match(text, /"stop_reason":"tool_use"/);
});

test("POST /v1/messages forwards cache_control breakpoints upstream (Defect A1)", async () => {
  let sent: { messages: { content: unknown }[]; tools?: { function: { cache_control?: unknown } }[] } | null = null;
  const server = app(async (_url, init) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return json({
      id: "cc-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });

  await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 16,
    system: [{ type: "text", text: "you are helpful", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "t", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  assert.ok(sent, "upstream was called");
  const body = sent as {
    messages: { content: { type: string; cache_control?: unknown }[] }[];
    tools: { function: { cache_control?: unknown } }[];
  };
  // The system breakpoint survives on the system message's text part...
  const systemPart = body.messages[0].content[0];
  assert.deepEqual(systemPart.cache_control, { type: "ephemeral" });
  // ...and the tool breakpoint survives on the function. The LM API dropped both.
  assert.deepEqual(body.tools[0].function.cache_control, { type: "ephemeral" });
});

test("POST /v1/messages forwards the resolved catalog id upstream, stripping [1m]", async () => {
  // The harness usually strips [1m] before the wire, but when the literal
  // `claude-opus-4.8[1m]` reaches the bridge it must still send the bare id
  // upstream — Copilot rejects the suffixed string with an error-shaped body.
  let sent: { model?: string } | null = null;
  const server = app(async (_url, init) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return json({
      id: "cc-1",
      model: "claude-opus-4.8",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });

  const res = await post(server, "/v1/messages", {
    model: "claude-opus-4.8[1m]",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(res.status, 200);
  assert.ok(sent, "upstream was called");
  assert.equal((sent as { model: string }).model, "claude-opus-4.8");
});

test("POST /v1/messages forwards Anthropic canonical Claude ids as Copilot catalog ids", async () => {
  let sent: { model?: string } | null = null;
  const server = app(async (_url, init) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    return json({
      id: "cc-1",
      model: "claude-haiku-4.5",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  });

  const res = await post(server, "/v1/messages", {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(res.status, 200);
  assert.ok(sent, "upstream was called");
  assert.equal((sent as { model: string }).model, "claude-haiku-4.5");
});

test("POST /v1/messages rejects malformed request shapes as 400", async () => {
  const server = app(async () => json({}, 200));

  for (const body of [
    {},
    { model: "", messages: [{ role: "user", content: "hi" }] },
    { model: 123, messages: [{ role: "user", content: "hi" }] },
    { model: "gpt-4o" },
    { model: "gpt-4o", messages: "hi" },
  ]) {
    const res = await post(server, "/v1/messages", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const out = (await res.json()) as { error: { type: string; message: string } };
    assert.equal(out.error.type, "invalid_request_error");
    assert.match(out.error.message, /model|messages/);
  }
});

test("POST /v1/messages/count_tokens rejects malformed request shapes as 400", async () => {
  const server = app(async () => json({}, 200));
  const res = await post(server, "/v1/messages/count_tokens", {});
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /model/);
});

test("POST /v1/messages maps an upstream body with no choices to a clean error, not a crash", async () => {
  // A malformed/error-shaped upstream body (no choices[]) must surface as a
  // classified API error, not an opaque "Cannot read properties of undefined".
  const server = app(async () => json({ error: { message: "model unavailable" } }));

  const res = await post(server, "/v1/messages", {
    model: "claude-opus-4.8",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(body.error.type, "api_error");
  assert.match(body.error.message, /no choices/);
});

test("POST /v1/messages surfaces cache_read + cache_creation usage (compaction inputs)", async () => {
  // The bridge goes direct precisely so CC sees real cache reads AND writes; the
  // write count is what lets the harness size the prefix and decide to compact.
  const server = app(async () =>
    json({
      id: "cc-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 10,
        total_tokens: 1010,
        prompt_tokens_details: { cached_tokens: 800, cache_creation_input_tokens: 120 },
      },
    }),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  };
  // input_tokens is cache-exclusive: 1000 - 800 (read) - 120 (creation) = 80, so
  // the harness's four-counter sum stays at the real 1000 input, not 1920.
  assert.equal(body.usage.input_tokens, 80);
  assert.equal(body.usage.cache_read_input_tokens, 800);
  assert.equal(body.usage.cache_creation_input_tokens, 120);
});

test("POST /v1/messages tears down the upstream call when the client disconnects", async () => {
  // Proves the abort wiring at the client seam: the Copilot client now forwards
  // its AbortSignal to the transport (the fix), so an aborted request reaches the
  // upstream fetch. We assert against the client directly rather than through
  // Hono's in-process request helper, which does not propagate a signal to
  // c.req.raw.signal the way the node-server adapter does at runtime.
  authOk();
  let upstreamSawAbort = false;
  const abortRejection = () => {
    upstreamSawAbort = true;
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
  };
  __setCopilotDeps({
    fetch: ((_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return reject(new Error("no signal threaded to the upstream fetch"));
        // The signal may already be aborted by the time the fetch runs (the
        // client aborts before send() finishes its token hop), so check both the
        // already-aborted state and the future event — exactly as curlFetch does.
        if (signal.aborted) return reject(abortRejection());
        signal.addEventListener("abort", () => reject(abortRejection()), { once: true });
      });
    }) as unknown as typeof fetch,
  });

  const ac = new AbortController();
  const call = chatCompletion({ model: "gpt-4o", messages: [] }, ac.signal);
  ac.abort(); // client goes away mid-flight
  await assert.rejects(call, (e: Error) => e.name === "AbortError");
  assert.equal(upstreamSawAbort, true, "the upstream fetch should have seen the abort signal");
});

// A scripted Copilot for the web_search route branch: first call asks to search,
// second call writes the final answer. Records nothing; the route drives it.
function webSearchChatFetch(query: string) {
  let n = 0;
  return (async () => {
    n++;
    if (n === 1) {
      return json({
        id: "cc",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      });
    }
    return json({
      id: "cc",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "Answer.\n\nSources:\n- [R1](https://ex1.com/)" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 },
    });
  }) as unknown as typeof fetch;
}

test("POST /v1/messages executes web_search server tool locally (non-stream)", async () => {
  __setSearchIdDep(() => "srvtoolu_x");
  __setSearchDeps({ search: async () => [{ title: "R1", url: "https://ex1.com/" }] });
  const server = app(webSearchChatFetch("latest ts release"));

  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 128,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    messages: [{ role: "user", content: "Perform a web search for the query: latest ts release" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { content: Record<string, unknown>[] };
  assert.deepEqual(
    body.content.map((b) => b.type),
    ["server_tool_use", "web_search_tool_result", "text"],
  );
  const stu = body.content[0] as unknown as { id: string };
  const wstr = body.content[1] as unknown as { tool_use_id: string; content: { title: string; url: string }[] };
  assert.equal(stu.id, "srvtoolu_x");
  assert.equal(wstr.tool_use_id, "srvtoolu_x");
  assert.equal(wstr.content[0].url, "https://ex1.com/");
});

test("POST /v1/messages web_search streams the server-tool block lifecycle", async () => {
  __setSearchIdDep(() => "srvtoolu_y");
  __setSearchDeps({ search: async () => [{ title: "R1", url: "https://ex1.com/" }] });
  const server = app(webSearchChatFetch("q"));

  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 128,
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    messages: [{ role: "user", content: "Perform a web search for the query: q" }],
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.equal(events[0], "message_start");
  assert.ok(events.includes("content_block_start"));
  assert.equal(events.at(-1), "message_stop");
  // The synthesized result block carries its content inline on the start event.
  assert.match(text, /"type":"web_search_tool_result"/);
  assert.match(text, /"tool_use_id":"srvtoolu_y"/);
  assert.match(text, /"url":"https:\/\/ex1\.com\/"/);
});

test("POST /v1/messages leaves requests without web_search untouched", async () => {
  let searched = false;
  __setSearchDeps({ search: async () => { searched = true; return []; } });
  const server = app(async () =>
    json({
      id: "cc",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "plain" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  );
  const res = await post(server, "/v1/messages", {
    model: "gpt-4o",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  assert.deepEqual(body.content, [{ type: "text", text: "plain" }]);
  assert.equal(searched, false);
});
