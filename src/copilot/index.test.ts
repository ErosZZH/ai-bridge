import assert from "node:assert/strict";
import test from "node:test";

import { __setAuthDeps } from "../auth/index.js";
import {
  CopilotRequestError,
  __setCopilotDeps,
  chatCompletion,
  streamChatCompletion,
} from "./index.js";

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function authOk() {
  __setAuthDeps({
    readTokens: () => [{ token: "oauth-1", user: "rick" }],
    fetch: async () => json({ token: "copilot-bearer", expires_at: FAR_FUTURE }),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(lines: string[]): Response {
  return new Response(lines.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("chatCompletion parses usage incl cache fields", async () => {
  authOk();
  __setCopilotDeps({
    fetch: async () =>
      json({
        id: "chatcmpl-1",
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 90 },
        },
      }),
  });
  const out = await chatCompletion({ model: "x", messages: [] });
  assert.equal(out.usage?.prompt_tokens, 100);
  assert.equal(out.usage?.prompt_tokens_details?.cached_tokens, 90);
});

test("streamChatCompletion reassembles a chunk split across reads", async () => {
  authOk();
  // first data line is split mid-JSON to exercise the line buffer
  __setCopilotDeps({
    fetch: async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"hel',
        'lo"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
        "data: [DONE]\n\n",
      ]),
  });
  const chunks = [];
  for await (const c of streamChatCompletion({ model: "x", messages: [] })) chunks.push(c);
  assert.equal(chunks.length, 2);
  assert.equal((chunks[0].choices?.[0] as any).delta.content, "hello");
  assert.equal(chunks[1].usage?.total_tokens, 4);
});

test("401 triggers reauth then retry", async () => {
  authOk();
  let calls = 0;
  __setCopilotDeps({
    fetch: async () => {
      calls++;
      return calls === 1 ? json({ message: "expired" }, 401) : json({ id: "ok", choices: [] });
    },
  });
  const out = await chatCompletion({ model: "x", messages: [] });
  assert.equal(out.id, "ok");
  assert.equal(calls, 2);
});

test("non-401 error surfaces status + body", async () => {
  authOk();
  __setCopilotDeps({ fetch: async () => json({ error: "too long" }, 413) });
  await assert.rejects(
    chatCompletion({ model: "x", messages: [] }),
    (e: CopilotRequestError) => e.status === 413,
  );
});
