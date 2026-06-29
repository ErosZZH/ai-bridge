import assert from "node:assert/strict";
import test from "node:test";

import { mapMessages, mapSystem, mapTools } from "./request.js";

test("string system -> one system message, not user", () => {
  const m = mapSystem("be brief");
  assert.deepEqual(m, { role: "system", content: "be brief" });
});

test("block[] system -> one system message preserving cache_control", () => {
  const m = mapSystem([
    { type: "text", text: "rules" },
    { type: "text", text: "context", cache_control: { type: "ephemeral" } },
  ]);
  assert.equal(m?.role, "system");
  assert.deepEqual(m?.content, [
    { type: "text", text: "rules" },
    { type: "text", text: "context", cache_control: { type: "ephemeral" } },
  ]);
});

test("empty/undefined system -> no message", () => {
  assert.equal(mapSystem(), undefined);
  assert.equal(mapSystem(""), undefined);
  assert.equal(mapSystem([]), undefined);
});

test("tool cache_control forwarded onto function, not dropped", () => {
  const out = mapTools([
    { name: "search", description: "find", input_schema: { type: "object" } },
    {
      name: "cached_lookup",
      input_schema: { type: "object" },
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.deepEqual(out, [
    { type: "function", function: { name: "search", description: "find", parameters: { type: "object" } } },
    {
      type: "function",
      function: {
        name: "cached_lookup",
        description: "",
        parameters: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    },
  ]);
});

test("no tools -> undefined, no cache_control key when absent", () => {
  assert.equal(mapTools(), undefined);
  assert.equal(mapTools([]), undefined);
  const out = mapTools([{ name: "t", input_schema: {} }]);
  assert.ok(out && !("cache_control" in out[0].function));
});

test("string content -> message kept as plain string, not coerced", () => {
  assert.deepEqual(mapMessages([{ role: "user", content: "hi" }]), [
    { role: "user", content: "hi" },
  ]);
});

test("assistant tool_use -> tool_calls with JSON-string arguments", () => {
  const out = mapMessages([
    {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
      ],
    },
  ]);
  assert.deepEqual(out, [
    {
      role: "assistant",
      content: "looking",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
      ],
    },
  ]);
});

test("each tool_result -> own tool message paired by tool_call_id", () => {
  const out = mapMessages([
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "ok" },
        { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "two" }] },
      ],
    },
  ]);
  assert.deepEqual(out, [
    { role: "tool", tool_call_id: "call_1", content: "ok" },
    { role: "tool", tool_call_id: "call_2", content: "two" },
  ]);
});

test("text-only tool_use turn -> assistant content null, no empty message dropped", () => {
  const out = mapMessages([
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: {} }] },
  ]);
  assert.deepEqual(out, [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
  ]);
});

test("image base64 -> data: URL, url -> passthrough; text kept as parts", () => {
  const out = mapMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "image", source: { type: "url", url: "https://x/y.png" } },
      ],
    },
  ]);
  assert.deepEqual(out, [
    {
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    },
  ]);
});

test("document blocks included, not skipped", () => {
  const out = mapMessages([
    {
      role: "user",
      content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } }],
    },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:application/pdf;base64,JVBE" } }] },
  ]);
});
