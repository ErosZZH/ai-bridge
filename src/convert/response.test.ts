import assert from "node:assert/strict";
import test from "node:test";

import {
  __setResponseDeps,
  mapResponse,
  streamResponse,
  type AnthropicStreamEvent,
  type OpenAIResponse,
  type OpenAIStreamChunk,
} from "./response.js";

// Pin the id seam so assertions are deterministic (the random suffix is the
// point of the fix, but we don't want a random value in the expectations).
__setResponseDeps({ id: () => "msg_test" });

async function* gen(chunks: OpenAIStreamChunk[]): AsyncGenerator<OpenAIStreamChunk> {
  for (const c of chunks) yield c;
}

async function collect(stream: AsyncGenerator<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
  const out: AnthropicStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

// --- non-stream ---

test("text-only response -> one text block, end_turn, exact usage", () => {
  const res: OpenAIResponse = {
    id: "cc1",
    model: "gpt-4o",
    choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
  assert.deepEqual(mapResponse(res), {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "gpt-4o",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
});

test("tool_calls -> tool_use blocks with arguments parsed back to object", () => {
  const res: OpenAIResponse = {
    id: "cc2",
    model: "gpt-4o",
    choices: [
      {
        message: {
          role: "assistant",
          content: "looking",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const out = mapResponse(res);
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.content, [
    { type: "text", text: "looking" },
    { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
  ]);
});

test("tool_calls present override finish_reason=stop -> tool_use", () => {
  const res: OpenAIResponse = {
    id: "cc3",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "f", arguments: "" } }],
        },
        finish_reason: "stop",
      },
    ],
  };
  const out = mapResponse(res);
  assert.equal(out.stop_reason, "tool_use");
  // empty arguments string -> {} not a throw
  assert.deepEqual(out.content, [{ type: "tool_use", id: "c1", name: "f", input: {} }]);
});

test("finish_reason length -> max_tokens; content_filter -> end_turn", () => {
  const mk = (fr: "length" | "content_filter"): OpenAIResponse => ({
    id: "x",
    choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: fr }],
  });
  assert.equal(mapResponse(mk("length")).stop_reason, "max_tokens");
  assert.equal(mapResponse(mk("content_filter")).stop_reason, "end_turn");
});

test("cache fields in prompt_tokens_details map to read/creation counters", () => {
  const res: OpenAIResponse = {
    id: "x",
    choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 80, cache_creation_input_tokens: 20 },
    },
  };
  assert.deepEqual(mapResponse(res).usage, {
    input_tokens: 100,
    output_tokens: 5,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 20,
  });
});

test("malformed tool arguments fall back to {} instead of throwing", () => {
  const res: OpenAIResponse = {
    id: "x",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "f", arguments: "{not json" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  assert.deepEqual(mapResponse(res).content, [{ type: "tool_use", id: "c1", name: "f", input: {} }]);
});

// --- stream ---

test("text stream -> message_start, block lifecycle, message_delta/stop", async () => {
  const events = await collect(
    streamResponse(
      gen([
        { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } },
      ]),
      "gpt-4o",
    ),
  );

  assert.deepEqual(events, [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "gpt-4o",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    { type: "message_stop" },
  ]);
});

test("fragmented tool-call arguments reassemble via input_json_delta, keyed by index", async () => {
  const events = await collect(
    streamResponse(
      gen([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
      "gpt-4o",
    ),
  );

  // start carries id+name with empty input; the two arg fragments come through
  // verbatim as partial_json (not parsed), and stop_reason is tool_use.
  assert.deepEqual(events.slice(1), [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"x"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    { type: "message_stop" },
  ]);
});

test("text then tool_call -> text block closed before tool block opens, indices increment", async () => {
  const events = await collect(
    streamResponse(
      gen([
        { choices: [{ delta: { content: "thinking" }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
      "gpt-4o",
    ),
  );

  const types = events.map((e) => [e.type, "index" in e ? e.index : undefined]);
  assert.deepEqual(types, [
    ["message_start", undefined],
    ["content_block_start", 0],
    ["content_block_delta", 0],
    ["content_block_stop", 0],
    ["content_block_start", 1],
    ["content_block_delta", 1],
    ["content_block_stop", 1],
    ["message_delta", undefined],
    ["message_stop", undefined],
  ]);
});

test("two parallel tool calls -> two distinct blocks keyed by their index", async () => {
  const events = await collect(
    streamResponse(
      gen([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "fa", arguments: "" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "fb", arguments: "" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
      "gpt-4o",
    ),
  );

  const starts = events.filter((e) => e.type === "content_block_start");
  assert.deepEqual(starts, [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "fa", input: {} } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "b", name: "fb", input: {} } },
  ]);
  // fragment for tool index 0 (arriving after block 1 opened) still targets block 0
  const argDeltas = events.filter(
    (e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta",
  );
  assert.deepEqual(argDeltas.map((e) => (e as { index: number }).index), [0, 1]);
});

test("empty stream still yields a well-formed envelope", async () => {
  const events = await collect(streamResponse(gen([]), "gpt-4o"));
  assert.deepEqual(events.map((e) => e.type), ["message_start", "message_delta", "message_stop"]);
});
