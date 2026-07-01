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
  // prompt_tokens (100) is cache-INCLUSIVE; the harness sums all four counters, so
  // input_tokens must exclude the cache buckets: 100 - 60 - 15 = 25.
  assert.equal(msg.usage.input_tokens, 25);
  assert.equal(msg.usage.output_tokens, 20);
  assert.equal(msg.usage.cache_read_input_tokens, 60);
  assert.equal(msg.usage.cache_creation_input_tokens, 15);
  // The four counters sum back to the real prompt + output (no double-count).
  assert.equal(
    msg.usage.input_tokens +
      msg.usage.cache_read_input_tokens +
      msg.usage.cache_creation_input_tokens +
      msg.usage.output_tokens,
    120,
  );
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
  // input_tokens is cache-exclusive: 42 - 30 (cached) - 5 (creation) = 7.
  assert.equal(start.message.usage.input_tokens, 7);
  assert.equal(start.message.usage.cache_read_input_tokens, 30);
  assert.equal(start.message.usage.cache_creation_input_tokens, 5);
  assert.equal(start.message.usage.output_tokens, 0);

  const delta = events.find((e) => e.type === "message_delta");
  assert.ok(delta && delta.type === "message_delta");
  // full usage (incl. output) lands on message_delta.
  assert.equal(delta.usage.output_tokens, 7);
  assert.equal(delta.usage.input_tokens, 7);
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
  // input_tokens (80) is cache-inclusive; subtract the cached subset: 80 - 50 = 30.
  assert.equal(msg.usage.input_tokens, 30);
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
  // input_tokens is cache-exclusive: 70 - 40 (cached) = 30.
  assert.equal(start.message.usage.input_tokens, 30);
  assert.equal(start.message.usage.cache_read_input_tokens, 40);
  assert.equal(start.message.usage.output_tokens, 0);

  const delta = out.find((e) => e.type === "message_delta");
  assert.ok(delta && delta.type === "message_delta");
  // completion side comes from the terminal response.completed usage.
  assert.equal(delta.usage.output_tokens, 9);
  assert.equal(delta.usage.input_tokens, 30);
  assert.equal(delta.usage.cache_read_input_tokens, 40);
});

// --- regression: cache double-count (the gpt-5.5 subagent preempt loop) ---

// The harness sizes context with getTokenCountFromUsage = input + cache_read +
// cache_creation + output. OpenAI/Copilot report a cache-INCLUSIVE input (cached
// is a subset of it), so passing input straight through while also emitting the
// cache buckets counted every cached token twice — nearly doubling the harness's
// perceived context and tripping "Prompt is too long" on subagents. These use the
// real numbers from the failing session (input≈15141, cache_read≈14848) and pin
// the four counters to sum back to the true prompt, not ~2x it.
test("responses usage does not double-count cache reads (harness four-counter sum)", () => {
  const res = {
    id: "resp-loop",
    model: "gpt-5.5",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 15141, output_tokens: 192, input_tokens_details: { cached_tokens: 14848 } },
  };
  const u = mapResponsesResponse(res as never).usage;
  // Cache-exclusive input: 15141 - 14848 = 293.
  assert.equal(u.input_tokens, 293);
  assert.equal(u.cache_read_input_tokens, 14848);
  // The harness's sum equals the real prompt (15141) + output (192) = 15333, NOT
  // the buggy 30181 that pushed subagents past the blocking limit.
  const harnessCount =
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens;
  assert.equal(harnessCount, 15333);
});

test("chat usage does not double-count cache reads or creation (harness four-counter sum)", () => {
  const res: OpenAIResponse = {
    id: "cc-loop",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 15141,
      completion_tokens: 192,
      total_tokens: 15333,
      prompt_tokens_details: { cached_tokens: 12000, cache_creation_input_tokens: 2848 },
    },
  };
  const u = mapResponse(res).usage;
  // Cache-exclusive input: 15141 - 12000 - 2848 = 293.
  assert.equal(u.input_tokens, 293);
  const harnessCount =
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens;
  assert.equal(harnessCount, 15333);
});
