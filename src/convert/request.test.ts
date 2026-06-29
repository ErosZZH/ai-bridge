import assert from "node:assert/strict";
import test from "node:test";

import { mapSystem, mapTools } from "./request.js";

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
