import assert from "node:assert/strict";
import test from "node:test";

import { mapSystem } from "./request.js";

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
