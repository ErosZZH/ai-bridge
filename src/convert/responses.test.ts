import assert from "node:assert/strict";
import test from "node:test";

import { __setResponseDeps } from "./response.js";
import {
  type ResponsesResponse,
  createResponsesConversionContext,
  mapRequestToResponses,
  mapResponsesResponse,
  streamResponsesResponse,
} from "./responses.js";

// Pin the message id so streaming/non-stream envelopes are deterministic.
__setResponseDeps({ id: () => "msg_test" });

function toolContext(...names: string[]) {
  return createResponsesConversionContext({
    model: "gpt-5.5",
    input: [],
    tools: names.map((name) => ({ type: "function", name, description: "", parameters: {}, strict: false })),
  });
}

const noTools = toolContext();
const weatherTool = toolContext("get_weather");

// --- request mapping ---

test("system -> instructions; user turn -> input item; max_output_tokens", () => {
  const out = mapRequestToResponses({
    model: "gpt-5.5",
    system: "be brief",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 4096,
  });
  assert.equal(out.instructions, "be brief");
  assert.deepEqual(out.input, [{ role: "user", content: "hi" }]);
  assert.equal(out.max_output_tokens, 4096);
  assert.ok(!("max_tokens" in out));
});

test("system blocks joined into instructions", () => {
  const out = mapRequestToResponses({
    model: "gpt-5.5",
    system: [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.instructions, "line one\nline two");
});

test("tools are flat (name at top level), tool_choice flattened", () => {
  const out = mapRequestToResponses({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "get_weather", description: "w", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "get_weather" },
  });
  assert.deepEqual(out.tools, [
    { type: "function", name: "get_weather", description: "w", parameters: { type: "object" }, strict: false },
  ]);
  assert.deepEqual(out.tool_choice, { type: "function", name: "get_weather" });
});

test("Responses tools opt out of strict normalization and preserve optional fields", () => {
  const tools = [
    {
      name: "Agent",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          prompt: { type: "string" },
          isolation: { type: "string", enum: ["worktree", "remote"] },
        },
        required: ["description", "prompt"],
      },
    },
    {
      name: "Monitor",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string" },
          command: { type: "string" },
          ws: {
            type: "object",
            properties: {
              url: { type: "string" },
              protocols: { type: "array", items: { type: "string" } },
            },
            required: ["url"],
          },
        },
        required: ["description"],
      },
    },
  ];
  const originalTools = structuredClone(tools);
  const out = mapRequestToResponses({ model: "gpt-5.5", messages: [], tools });

  // Check the serialized payload too: false must not be omitted as a falsy value.
  assert.deepEqual(JSON.parse(JSON.stringify(out)).tools, originalTools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: "",
    parameters: tool.input_schema,
    strict: false,
  })));
  // Neither required lists nor nested schemas gain defaults or placeholders.
  assert.deepEqual(tools, originalTools);
});

test("tool_use/tool_result blocks -> function_call / function_call_output items", () => {
  const out = mapRequestToResponses({
    model: "gpt-5.5",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
      },
    ],
  });
  assert.deepEqual(out.input, [
    { role: "assistant", content: "calling" },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
    { type: "function_call_output", call_id: "call_1", output: "sunny" },
  ]);
});

// --- non-stream response mapping ---

test("output[] message text -> one text block; usage mapped", () => {
  const res: ResponsesResponse = {
    model: "gpt-5.5-2026-04-23",
    status: "completed",
    output: [
      { type: "reasoning" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello one" }] },
    ],
    usage: {
      input_tokens: 19,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 3 },
    },
  };
  const m = mapResponsesResponse(res, noTools);
  assert.deepEqual(m.content, [{ type: "text", text: "hello one" }]);
  assert.equal(m.stop_reason, "end_turn");
  // input_tokens is cache-exclusive: 19 - 3 (cached) = 16.
  assert.equal(m.usage.input_tokens, 16);
  assert.equal(m.usage.output_tokens, 20);
  assert.equal(m.usage.cache_read_input_tokens, 3);
  assert.equal(m.model, "gpt-5.5-2026-04-23");
});

test("function_call output -> tool_use block; stop_reason tool_use", () => {
  const res: ResponsesResponse = {
    status: "completed",
    output: [
      { type: "function_call", call_id: "call_9", name: "get_weather", arguments: '{"city":"Paris"}' } as never,
    ],
  };
  const m = mapResponsesResponse(res, weatherTool);
  assert.deepEqual(m.content, [
    { type: "tool_use", id: "call_9", name: "get_weather", input: { city: "Paris" } },
  ]);
  assert.equal(m.stop_reason, "tool_use");
});

test("unadvertised function calls are rejected instead of reaching the harness", () => {
  const res: ResponsesResponse = {
    status: "completed",
    output: [{ type: "function_call", call_id: "call_bad", name: "parallel", arguments: "{}" } as never],
  };
  assert.throws(
    () => mapResponsesResponse(res, weatherTool),
    /unadvertised function 'parallel'.*get_weather/,
  );
});

test("incomplete due to max_output_tokens -> max_tokens", () => {
  const res: ResponsesResponse = {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "par" }] }],
  };
  const m = mapResponsesResponse(res, noTools);
  assert.equal(m.stop_reason, "max_tokens");
});

// --- streaming ---

async function* feed(events: unknown[]): AsyncGenerator<never> {
  for (const e of events) yield e as never;
}

async function collect(gen: AsyncGenerator<{ type: string }>): Promise<any[]> {
  const out: any[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("text stream -> full Anthropic lifecycle", async () => {
  const events = [
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_item.added", item: { type: "message" } },
    { type: "response.output_text.delta", delta: "hel" },
    { type: "response.output_text.delta", delta: "lo" },
    { type: "response.output_text.done" },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 9, output_tokens: 5 } },
    },
  ];
  const out = await collect(streamResponsesResponse(feed(events), "gpt-5.5", 0, noTools));
  const types = out.map((e) => e.type);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  // text deltas concatenate to "hello"
  const text = out
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (e as { delta: { text: string } }).delta.text)
    .join("");
  assert.equal(text, "hello");
  const final = out.find((e) => e.type === "message_delta") as {
    delta: { stop_reason: string };
    usage: { output_tokens: number };
  };
  assert.equal(final.delta.stop_reason, "end_turn");
  assert.equal(final.usage.output_tokens, 5);
});

test("stream seeds message_start.input_tokens from the estimate; real usage wins in delta", async () => {
  // Regression: /responses reports usage only on response.completed, so
  // message_start would carry input_tokens: 0, which the Claude Code subagent
  // progress tracker shows as "0 tokens". Seed it from the bridge's estimate.
  const events = [
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_item.added", item: { type: "message" } },
    { type: "response.output_text.delta", delta: "hi" },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 77, output_tokens: 4 } },
    },
  ];
  const out = await collect(streamResponsesResponse(feed(events), "gpt-5.5", 55, noTools));
  const start = out.find((e) => e.type === "message_start") as any;
  const delta = out.find((e) => e.type === "message_delta") as any;
  // message_start shows the estimate; message_delta carries the exact count.
  assert.equal(start.message.usage.input_tokens, 55);
  assert.equal(start.message.usage.output_tokens, 0);
  assert.equal(delta.usage.input_tokens, 77);
  assert.equal(delta.usage.output_tokens, 4);
});

test("function_call stream -> tool_use block + input_json_delta + tool_use stop", async () => {
  const events = [
    { type: "response.created", response: { id: "r1" } },
    {
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "call_5", name: "get_weather" },
    },
    { type: "response.function_call_arguments.delta", delta: '{"city":' },
    { type: "response.function_call_arguments.delta", delta: '"Paris"}' },
    { type: "response.function_call_arguments.done" },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 53, output_tokens: 18 } },
    },
  ];
  const out = await collect(streamResponsesResponse(feed(events), "gpt-5.5", 0, weatherTool));
  const start = out.find((e) => e.type === "content_block_start") as {
    content_block: { type: string; id: string; name: string };
  };
  assert.equal(start.content_block.type, "tool_use");
  assert.equal(start.content_block.id, "call_5");
  assert.equal(start.content_block.name, "get_weather");
  const args = out
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (e as { delta: { partial_json: string } }).delta.partial_json)
    .join("");
  assert.equal(args, '{"city":"Paris"}');
  const final = out.find((e) => e.type === "message_delta") as { delta: { stop_reason: string } };
  assert.equal(final.delta.stop_reason, "tool_use");
});

test("function-call done events are idempotent across both Responses closers", async () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "get_weather" },
    },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
    { type: "response.function_call_arguments.done", output_index: 0 },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "get_weather", arguments: "{}" },
    },
  ];
  const out = await collect(streamResponsesResponse(feed(events), "gpt-5.5", 0, weatherTool));
  assert.equal(out.filter((event) => event.type === "content_block_start").length, 1);
});

test("interleaved function calls keep arguments correlated and blocks contiguous", async () => {
  const context = toolContext("first", "second");
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "first" },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "item_2", call_id: "call_2", name: "second" },
    },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"a":' },
    { type: "response.function_call_arguments.delta", item_id: "item_2", delta: '{"b":' },
    { type: "response.function_call_arguments.delta", call_id: "call_1", delta: "1}" },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: "2}" },
    { type: "response.function_call_arguments.done", item_id: "item_2" },
    { type: "response.function_call_arguments.done", output_index: 0 },
    { type: "response.completed", response: { status: "completed" } },
  ];

  const out = await collect(streamResponsesResponse(feed(events), "gpt-5.5", 0, context));
  const blocks = out.filter((event) => event.type.startsWith("content_block_"));
  assert.deepEqual(blocks.map((event) => event.type), [
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
  ]);
  const starts = blocks.filter((event) => event.type === "content_block_start") as any[];
  assert.deepEqual(starts.map((event) => event.content_block.name), ["first", "second"]);
  for (const start of starts) {
    const fragments = blocks
      .filter((event: any) => event.type === "content_block_delta" && event.index === start.index)
      .map((event: any) => event.delta.partial_json)
      .join("");
    assert.equal(fragments, start.content_block.name === "first" ? '{"a":1}' : '{"b":2}');
  }
});

test("ambiguous uncorrelated arguments fail instead of choosing a call", async () => {
  const context = toolContext("first", "second");
  const events = [
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", name: "first" } },
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_2", name: "second" } },
    { type: "response.function_call_arguments.delta", delta: "{}" },
  ];
  await assert.rejects(
    () => collect(streamResponsesResponse(feed(events), "gpt-5.5", 0, context)),
    /ambiguous \(2 pending calls/,
  );
});

test("stream rejects an unadvertised parallel call before emitting a tool block", async () => {
  const events = [
    { type: "response.output_item.added", item: { type: "function_call", call_id: "call_bad", name: "parallel" } },
  ];
  await assert.rejects(
    () => collect(streamResponsesResponse(feed(events), "gpt-5.5", 0, weatherTool)),
    /unadvertised function 'parallel'/,
  );
});

test("empty stream still yields a well-formed envelope", async () => {
  const out = await collect(streamResponsesResponse(feed([{ type: "response.completed", response: { status: "completed" } }]), "gpt-5.5", 0, noTools));
  assert.deepEqual(out.map((e) => e.type), ["message_start", "message_delta", "message_stop"]);
});
