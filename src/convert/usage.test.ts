// Task 10: focused unit tests for usage mapping — the data the bridge exists to
// preserve (Defect A2: exact Copilot usage incl. cache reads, vs the VS Code LM
// API which hid it). Covers both the chat (response.ts) and Responses
// (responses.ts) mappers, non-stream and stream, since usage lands on different
// shapes/positions in each.

import assert from "node:assert/strict";
import test from "node:test";

import {
  __setResponseDeps,
  mapResponse,
  streamResponse,
  mapResponsesResponse,
  streamResponsesResponse,
  type OpenAIResponse,
  type OpenAIStreamChunk,
  type AnthropicStreamEvent,
} from "./index.js";

__setResponseDeps({ id: () => "msg_usage" });

// Drain an async generator of SSE events into an array for assertions.
async function collect(gen: AsyncIterable<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
  const out: AnthropicStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// Wrap concrete chunk objects as an async iterable, the shape the stream mappers
// consume from the Copilot client.
async function* iter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// --- chat: non-stream ---

test("mapResponse maps cache read + creation from prompt_tokens_details", () => {
  const res: OpenAIResponse = {
    id: "cc-1",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 60, cache_creation_input_tokens: 15 },
    },
  };
  const msg = mapResponse(res);
  assert.equal(msg.usage.input_tokens, 100);
  assert.equal(msg.usage.output_tokens, 20);
  assert.equal(msg.usage.cache_read_input_tokens, 60);
  assert.equal(msg.usage.cache_creation_input_tokens, 15);
});

test("mapResponse zeroes absent usage fields (never undefined, for the harness >0 guard)", () => {
  const res: OpenAIResponse = {
    id: "cc-1",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    // no usage at all
  };
  const msg = mapResponse(res);
  assert.deepEqual(msg.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

// --- chat: stream ---

test("streamResponse: usage present before block events lands on message_start", async () => {
  // message_start is emitted lazily on the first chunk that yields events, so it
  // captures usage already seen by then. Here a usage-bearing chunk precedes the
  // text, so input/cache are visible at message_start with output still 0.
  const chunks: OpenAIStreamChunk[] = [
    {
      choices: [],
      usage: {
        prompt_tokens: 42,
        completion_tokens: 0,
        total_tokens: 42,
        prompt_tokens_details: { cached_tokens: 30, cache_creation_input_tokens: 5 },
      },
    },
    { choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, prompt_tokens_details: { cached_tokens: 30, cache_creation_input_tokens: 5 } } },
  ];
  const events = await collect(streamResponse(iter(chunks), "gpt-4o"));

  const start = events.find((e) => e.type === "message_start");
  assert.ok(start && start.type === "message_start");
  // input + cache visible at message_start; output is 0 there (filled later).
  assert.equal(start.message.usage.input_tokens, 42);
  assert.equal(start.message.usage.cache_read_input_tokens, 30);
  assert.equal(start.message.usage.cache_creation_input_tokens, 5);
  assert.equal(start.message.usage.output_tokens, 0);

  const delta = events.find((e) => e.type === "message_delta");
  assert.ok(delta && delta.type === "message_delta");
  // full usage (incl. output) lands on message_delta.
  assert.equal(delta.usage.output_tokens, 7);
  assert.equal(delta.usage.input_tokens, 42);
  assert.equal(delta.usage.cache_read_input_tokens, 30);
});

test("streamResponse: usage only on the final chunk -> message_start zeros, message_delta authoritative", async () => {
  // The realistic Copilot pattern: usage rides the trailing empty-choices chunk.
  // message_start has already been emitted (on the text delta) so it carries
  // zeros; the harness fills output from message_delta and treats input as
  // monotonic, so the full counts on message_delta are what matters.
  const chunks: OpenAIStreamChunk[] = [
    { choices: [{ index: 0, delta: { content: "x" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } },
  ];
  const events = await collect(streamResponse(iter(chunks), "gpt-4o"));
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  const start = events.find((e) => e.type === "message_start");
  assert.ok(start && start.type === "message_start");
  assert.equal(start.message.usage.input_tokens, 0, "input not yet seen at message_start");

  const delta = events.find((e) => e.type === "message_delta");
  assert.ok(delta && delta.type === "message_delta");
  assert.equal(delta.usage.input_tokens, 9);
  assert.equal(delta.usage.output_tokens, 1);
});

// --- responses: non-stream ---

test("mapResponsesResponse maps cached_tokens to cache_read; cache_creation is always 0", () => {
  const res = {
    id: "resp-1",
    model: "gpt-5.5",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
    usage: { input_tokens: 80, output_tokens: 12, input_tokens_details: { cached_tokens: 50 } },
  };
  const msg = mapResponsesResponse(res as never);
  assert.equal(msg.usage.input_tokens, 80);
  assert.equal(msg.usage.output_tokens, 12);
  assert.equal(msg.usage.cache_read_input_tokens, 50);
  // /responses has no cache-creation field, so it is reported as 0, not undefined.
  assert.equal(msg.usage.cache_creation_input_tokens, 0);
});

// --- responses: stream ---

test("streamResponsesResponse takes authoritative usage from the terminal event", async () => {
  const events = [
    { type: "response.created", response: { id: "r1", usage: { input_tokens: 70, output_tokens: 0, input_tokens_details: { cached_tokens: 40 } } } },
    { type: "response.output_text.delta", delta: "hi" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 70, output_tokens: 9, input_tokens_details: { cached_tokens: 40 } } } },
  ];
  const out = await collect(streamResponsesResponse(iter(events) as never, "gpt-5.5"));

  const start = out.find((e) => e.type === "message_start");
  assert.ok(start && start.type === "message_start");
  assert.equal(start.message.usage.input_tokens, 70);
  assert.equal(start.message.usage.cache_read_input_tokens, 40);
  assert.equal(start.message.usage.output_tokens, 0);

  const delta = out.find((e) => e.type === "message_delta");
  assert.ok(delta && delta.type === "message_delta");
  // completion side comes from the terminal response.completed usage.
  assert.equal(delta.usage.output_tokens, 9);
  assert.equal(delta.usage.input_tokens, 70);
  assert.equal(delta.usage.cache_read_input_tokens, 40);
});
