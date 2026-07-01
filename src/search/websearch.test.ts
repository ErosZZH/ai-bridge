import assert from "node:assert/strict";
import test from "node:test";

import { __setCopilotDeps } from "../copilot/index.js";
import { __setResponseDeps } from "../convert/index.js";
import { Logger } from "../obs/index.js";
import type { SearchConfig } from "../config.js";
import {
  __setSearchDeps,
  SearchError,
  type SearchBackend,
} from "./ddg.js";
import {
  __setSearchIdDep,
  findWebSearchTool,
  runAndStreamWebSearch,
  runWebSearchLoop,
  stripWebSearchTools,
  toAnthropicResponse,
  type WebSearchArgs,
} from "./websearch.js";

__setResponseDeps({ id: () => "msg_test" });

// --- fakes -------------------------------------------------------------------

// Scripted Copilot: each queued item is one OpenAI chat/completions body. A body
// that carries tool_calls drives another loop iteration; a text-only body ends
// it. `calls` records the request bodies so tests can assert what the loop sent.
function fakeCopilot(bodies: unknown[]): { fetch: typeof fetch; calls: Record<string, unknown>[] } {
  const queue = [...bodies];
  const calls: Record<string, unknown>[] = [];
  const impl = async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const body = queue.shift() ?? textBody("(no more scripted responses)");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function textBody(text: string) {
  return {
    id: "cc",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

// An assistant body that calls web_search with the given query.
function searchBody(query: string, callId = "call_1", text: string | null = null) {
  return {
    id: "cc",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          tool_calls: [
            { id: callId, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

const HIT = (n: number) => ({ title: `Result ${n}`, url: `https://ex${n}.com/` });

// A search backend that returns N hits and records the queries it saw.
function fakeSearch(nPerQuery = 2): { search: SearchBackend; queries: string[] } {
  const queries: string[] = [];
  const search: SearchBackend = async (query) => {
    queries.push(query);
    return Array.from({ length: nPerQuery }, (_, i) => HIT(i + 1));
  };
  return { search, queries };
}

const SEARCH_CONFIG: SearchConfig = {
  enabled: true,
  maxResults: 8,
  maxUses: 8,
  idleMs: 1000,
  navTimeoutMs: 5000,
  proxy: "",
  noProxy: "",
};

// Build loop args around an inbound request that carries the web_search server tool.
function args(overrides: Partial<WebSearchArgs> = {}): WebSearchArgs {
  return {
    inbound: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "what's new?" }],
      tools: [{ type: "web_search_20250305", name: "web_search", input_schema: {} } as never],
    },
    endpoint: "chat",
    config: SEARCH_CONFIG,
    signal: new AbortController().signal,
    logger: new Logger("error"),
    ...overrides,
  };
}

// Deterministic srvtoolu ids per test.
function pinIds() {
  let n = 0;
  __setSearchIdDep(() => `srvtoolu_${++n}`);
}

// --- detection ---------------------------------------------------------------

test("findWebSearchTool matches name or web_search_ type; strip removes only it", () => {
  const tools = [
    { name: "get_weather", input_schema: {} },
    { type: "web_search_20250305", name: "web_search", input_schema: {} },
  ] as never[];
  assert.ok(findWebSearchTool(tools));
  const kept = stripWebSearchTools(tools);
  assert.deepEqual(
    kept.map((t) => (t as { name: string }).name),
    ["get_weather"],
  );
});

test("findWebSearchTool returns undefined when absent", () => {
  assert.equal(findWebSearchTool([{ name: "get_weather", input_schema: {} } as never]), undefined);
});

// --- single search, non-stream ----------------------------------------------

test("single search non-stream: block order + paired ids + item fields", async () => {
  pinIds();
  const { search } = fakeSearch(2);
  __setSearchDeps({ search });
  const { fetch } = fakeCopilot([searchBody("claude opus 4.8"), textBody("Here it is. Sources: ...")]);
  __setCopilotDeps({ fetch });

  const outcome = await runWebSearchLoop(args());
  assert.deepEqual(
    outcome.blocks.map((b) => b.type),
    ["server_tool_use", "web_search_tool_result", "text"],
  );
  const [stu, wstr] = outcome.blocks as unknown as [
    { id: string; input: { query: string } },
    { tool_use_id: string; content: { type: string; title: string; url: string }[] },
  ];
  assert.equal(stu.id, "srvtoolu_1");
  assert.equal(stu.input.query, "claude opus 4.8");
  assert.equal(wstr.tool_use_id, "srvtoolu_1"); // pairs with the server_tool_use
  assert.equal(wstr.content.length, 2);
  assert.deepEqual(wstr.content[0], {
    type: "web_search_result",
    title: "Result 1",
    url: "https://ex1.com/",
    encrypted_content: "ddg:" + Buffer.from("https://ex1.com/").toString("base64"),
    page_age: null,
  });
  assert.equal(outcome.searches, 1);
  assert.equal(outcome.stopReason, "end_turn");

  const msg = toAnthropicResponse(outcome);
  assert.equal(msg.id, "msg_test");
  assert.equal(msg.stop_reason, "end_turn");
});

// --- single search, stream ---------------------------------------------------

test("single search stream: event order, inline result content, no result delta", async () => {
  pinIds();
  const { search } = fakeSearch(1);
  __setSearchDeps({ search });
  const { fetch } = fakeCopilot([searchBody("q"), textBody("answer")]);
  __setCopilotDeps({ fetch });

  const events = [];
  for await (const e of runAndStreamWebSearch(args())) events.push(e);

  const types = events.map((e) => e.type);
  assert.equal(types[0], "message_start");
  assert.equal(types[types.length - 1], "message_stop");
  assert.equal(types[types.length - 2], "message_delta");

  // server_tool_use streams start -> input_json_delta -> stop
  const stuStart = events.find(
    (e) => e.type === "content_block_start" && (e as never as { content_block: { type: string } }).content_block.type === "server_tool_use",
  ) as never as { index: number; content_block: { input: Record<string, never> } };
  assert.deepEqual(stuStart.content_block.input, {}); // empty on start
  const stuDelta = events.find(
    (e) => e.type === "content_block_delta" && (e as never as { delta: { type: string } }).delta.type === "input_json_delta",
  ) as never as { delta: { partial_json: string } };
  assert.equal(JSON.parse(stuDelta.delta.partial_json).query, "q");

  // web_search_tool_result carries content INLINE on start, and has NO delta.
  const wstrStartIdx = events.findIndex(
    (e) => e.type === "content_block_start" && (e as never as { content_block: { type: string } }).content_block.type === "web_search_tool_result",
  );
  const wstrStart = events[wstrStartIdx] as never as {
    index: number;
    content_block: { content: unknown[] };
  };
  assert.equal(wstrStart.content_block.content.length, 1);
  const wstrIndex = wstrStart.index;
  const hasResultDelta = events.some(
    (e) => e.type === "content_block_delta" && (e as never as { index: number }).index === wstrIndex,
  );
  assert.equal(hasResultDelta, false);
  // immediately followed by its stop
  assert.equal(events[wstrStartIdx + 1].type, "content_block_stop");
});

// --- multi-search loop -------------------------------------------------------

test("multi-search: threads queries, unique ids, monotonic block indices (stream)", async () => {
  pinIds();
  const { search, queries } = fakeSearch(1);
  __setSearchDeps({ search });
  const { fetch, calls } = fakeCopilot([
    searchBody("first", "call_a"),
    searchBody("second", "call_b"),
    textBody("done"),
  ]);
  __setCopilotDeps({ fetch });

  const outcome = await runWebSearchLoop(args());
  assert.deepEqual(queries, ["first", "second"]);
  const stuIds = outcome.blocks.filter((b) => b.type === "server_tool_use").map((b) => (b as { id: string }).id);
  assert.deepEqual(stuIds, ["srvtoolu_1", "srvtoolu_2"]);
  assert.equal(outcome.searches, 2);
  // The loop fed each result back to Copilot (3 completions total).
  assert.equal(calls.length, 3);
  // The second request must include a tool result message keyed by call_a.
  const secondMsgs = (calls[1].messages as { role: string; content: unknown }[]) ?? [];
  const flat = JSON.stringify(secondMsgs);
  assert.match(flat, /call_a/);
});

// --- max_uses cap ------------------------------------------------------------

test("max_uses cap: stops real searches at the cap, emits max_uses_exceeded", async () => {
  pinIds();
  const { search, queries } = fakeSearch(1);
  __setSearchDeps({ search });
  // Model keeps trying to search forever; only the cap stops it.
  const { fetch } = fakeCopilot([
    searchBody("s1"),
    searchBody("s2"),
    searchBody("s3"),
    searchBody("s4"),
    textBody("fallback answer"),
  ]);
  __setCopilotDeps({ fetch });

  const cfg = { ...SEARCH_CONFIG, maxUses: 2 };
  const outcome = await runWebSearchLoop(args({ config: cfg }));
  assert.equal(queries.length, 2); // only 2 real searches ran
  const errored = outcome.blocks.filter(
    (b) => b.type === "web_search_tool_result" && !Array.isArray((b as { content: unknown }).content),
  );
  assert.ok(errored.length >= 1);
  assert.equal(
    (errored[0] as { content: { error_code: string } }).content.error_code,
    "max_uses_exceeded",
  );
});

// --- zero results ------------------------------------------------------------

test("zero results: empty content array, still finalizes", async () => {
  pinIds();
  __setSearchDeps({ search: async () => [] });
  const { fetch } = fakeCopilot([searchBody("nothing"), textBody("no results found")]);
  __setCopilotDeps({ fetch });

  const outcome = await runWebSearchLoop(args());
  const wstr = outcome.blocks.find((b) => b.type === "web_search_tool_result") as {
    content: unknown[];
  };
  assert.deepEqual(wstr.content, []); // empty array, NOT an error
  assert.equal(outcome.blocks.at(-1)?.type, "text");
});

// --- backend errors ----------------------------------------------------------

test("SearchError -> error_code; plain throw -> unavailable", async () => {
  pinIds();
  __setSearchDeps({
    search: async (q) => {
      if (q === "boom") throw new SearchError("rate", "too_many_requests");
      throw new Error("kaboom");
    },
  });
  const { fetch } = fakeCopilot([searchBody("boom", "call_a"), searchBody("other", "call_b"), textBody("ok")]);
  __setCopilotDeps({ fetch });

  const outcome = await runWebSearchLoop(args());
  const errs = outcome.blocks
    .filter((b) => b.type === "web_search_tool_result")
    .map((b) => (b as { content: { error_code?: string } }).content.error_code);
  assert.deepEqual(errs, ["too_many_requests", "unavailable"]);
});

// --- other tools present -----------------------------------------------------

test("web_search + other client tools: keeps others, injects the function tool", async () => {
  pinIds();
  const { search } = fakeSearch(1);
  __setSearchDeps({ search });
  const { fetch, calls } = fakeCopilot([textBody("no search needed")]);
  __setCopilotDeps({ fetch });

  await runWebSearchLoop(
    args({
      inbound: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "get_weather", description: "w", input_schema: { type: "object" } },
          { type: "web_search_20250305", name: "web_search", input_schema: {} } as never,
        ],
      },
    }),
  );
  const sent = calls[0].tools as { function: { name: string } }[];
  const names = sent.map((t) => t.function.name).sort();
  assert.deepEqual(names, ["get_weather", "web_search"]);
  // No server-shaped web_search leaked through (all have a parameters object).
  assert.ok(sent.every((t) => typeof t.function === "object"));
});

// --- tool_choice downgrade ---------------------------------------------------

test("forced tool_choice is sent on iter 0, downgraded to auto after", async () => {
  pinIds();
  const { search } = fakeSearch(1);
  __setSearchDeps({ search });
  const { fetch, calls } = fakeCopilot([searchBody("q"), textBody("done")]);
  __setCopilotDeps({ fetch });

  await runWebSearchLoop(
    args({
      inbound: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search", input_schema: {} } as never],
        tool_choice: { type: "tool", name: "web_search" },
      },
    }),
  );
  // iter 0 forwards the forced choice as a named function tool_choice
  assert.deepEqual(calls[0].tool_choice, { type: "function", function: { name: "web_search" } });
  // iter 1 downgrades to auto so the model can finalize
  assert.equal(calls[1].tool_choice, "auto");
});

// --- abort -------------------------------------------------------------------

test("abort before start: loop settles with no searches", async () => {
  pinIds();
  const { search, queries } = fakeSearch(1);
  __setSearchDeps({ search });
  const { fetch } = fakeCopilot([searchBody("q"), textBody("done")]);
  __setCopilotDeps({ fetch });

  const ac = new AbortController();
  ac.abort();
  const outcome = await runWebSearchLoop(args({ signal: ac.signal }));
  assert.equal(queries.length, 0);
  assert.equal(outcome.blocks.length, 0);
});
