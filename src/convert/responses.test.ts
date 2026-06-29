import assert from "node:assert/strict";
import test from "node:test";

import { __setResponseDeps } from "./response.js";
import {
  type ResponsesResponse,
  mapRequestToResponses,
  mapResponsesResponse,
  streamResponsesResponse,
} from "./responses.js";

// Pin the message id so streaming/non-stream envelopes are deterministic.
__setResponseDeps({ id: () => "msg_test" });

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
    { type: "function", name: "get_weather", description: "w", parameters: { type: "object" } },
  ]);
  assert.deepEqual(out.tool_choice, { type: "function", name: "get_weather" });
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
  const m = mapResponsesResponse(res);
  assert.deepEqual(m.content, [{ type: "text", text: "hello one" }]);
  assert.equal(m.stop_reason, "end_turn");
  assert.equal(m.usage.input_tokens, 19);
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
  const m = mapResponsesResponse(res);
  assert.deepEqual(m.content, [
    { type: "tool_use", id: "call_9", name: "get_weather", input: { city: "Paris" } },
  ]);
  assert.equal(m.stop_reason, "tool_use");
});

test("incomplete due to max_output_tokens -> max_tokens", () => {
  const res: ResponsesResponse = {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "par" }] }],
  };
  const m = mapResponsesResponse(res);
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
  const out = await collect(streamResponsesResponse(feed(events), "gpt-5.5"));
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
  const out = await collect(streamResponsesResponse(feed(events), "gpt-5.5"));
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

test("empty stream still yields a well-formed envelope", async () => {
  const out = await collect(streamResponsesResponse(feed([{ type: "response.completed", response: { status: "completed" } }]), "gpt-5.5"));
  assert.deepEqual(out.map((e) => e.type), ["message_start", "message_delta", "message_stop"]);
});
