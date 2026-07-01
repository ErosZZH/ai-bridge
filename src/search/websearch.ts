// WebSearch emulation: intercept Claude Code's web_search server tool and run it
// against a local browser backend (src/search/ddg.ts), synthesizing the exact
// server_tool_use + web_search_tool_result content blocks the harness expects.
//
// Why this exists: web_search is an Anthropic SERVER-SIDE tool (web_search_20250305).
// The harness sends the tool schema and expects the BACKEND to execute searches
// inline. Copilot has no such tool, so left alone the search silently returns
// nothing. Here we reproduce Anthropic's internal search loop at the bridge:
//   - hand Copilot a normal FUNCTION tool named `web_search`,
//   - when Copilot calls it, run the query in the browser backend,
//   - feed the results back so Copilot can search again (up to a cap) or finalize,
//   - emit the whole thing as the server-tool block sequence the harness parses.
//
// Dual id spaces: Copilot sees its own `call_…` tool ids (used to thread the
// tool_result back to it); the harness sees `srvtoolu_…` ids pairing each
// server_tool_use with its web_search_tool_result. The two never mix.

import type { Logger } from "../obs/index.js";
import type { SearchConfig } from "../config.js";
import {
  type AnthropicRequest,
  type AnthropicResponse,
  type AnthropicResponseBlock,
  type AnthropicRespTextBlock,
  type AnthropicRespToolUseBlock,
  type AnthropicRespWebSearchToolResultBlock,
  type AnthropicMessage,
  type AnthropicTool,
  type AnthropicToolChoice,
  type AnthropicToolResultBlock,
  type AnthropicUsage,
  type AnthropicStopReason,
  type AnthropicStreamEvent,
  type WebSearchResultItem,
  type OpenAIResponse,
  type ResponsesResponse,
  mapRequest,
  mapResponse,
  mapRequestToResponses,
  mapResponsesResponse,
  newMessageId,
} from "../convert/index.js";
import { chatCompletion } from "../copilot/index.js";
import { responsesCompletion } from "../copilot/responses.js";
import {
  type SearchResult,
  SearchError,
  resolveProxyOption,
  runSearch,
} from "./ddg.js";

// --- server-tool detection ---

type MaybeServerTool = AnthropicTool & { type?: string };

// True for the web_search server tool in any shape Claude Code might send it:
// the tool NAME is `web_search`, and its TYPE (present on server tools) starts
// with `web_search_` (e.g. `web_search_20250305`). Takes the minimal shape so it
// works on both full AnthropicTool[] and the stripped generic below.
function isWebSearchTool(t: { name: string; type?: string }): boolean {
  return t.name === "web_search" || (typeof t.type === "string" && t.type.startsWith("web_search_"));
}

// The web_search tool in the request, or undefined. Detection point for the route.
export function findWebSearchTool(tools?: MaybeServerTool[]): MaybeServerTool | undefined {
  return tools?.find(isWebSearchTool);
}

// Remove web_search from a tool list, leaving any other (client) tools intact so
// a request that mixes web_search with real tools still works.
export function stripWebSearchTools<T extends { name: string; type?: string }>(tools: T[]): T[] {
  return tools.filter((t) => !isWebSearchTool(t));
}

// The function-tool form we actually hand to Copilot. Mirrors the real
// web_search input schema so the model drives it the same way.
const WEB_SEARCH_FUNCTION: AnthropicTool = {
  name: "web_search",
  description:
    "Search the web and return relevant results. Use for current events, recent " +
    "information, or anything beyond your knowledge cutoff.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only include results from these domains",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Never include results from these domains",
      },
    },
    required: ["query"],
  },
};

// --- id seam ---

// srvtoolu_ ids pairing server_tool_use <-> web_search_tool_result. crypto.randomUUID
// per the codebase convention (Date.now()/Math.random() are avoided). Injectable
// so tests get stable ids.
let nextServerToolId: () => string = () =>
  "srvtoolu_" + globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24);
export function __setSearchIdDep(fn: () => string): void {
  nextServerToolId = fn;
}

// --- internal completion (reuses the normal chat/responses stack) ---

// One round-trip to Copilot, mapped back to the same AnthropicResponse the route
// produces — so tool_use blocks expose a parsed `input`. Branches on the model's
// endpoint exactly like the route does.
export async function internalComplete(
  body: AnthropicRequest,
  endpoint: "chat" | "responses",
  signal?: AbortSignal,
): Promise<AnthropicResponse> {
  if (endpoint === "responses") {
    const req = mapRequestToResponses(body);
    const res = (await responsesCompletion(req, signal)) as ResponsesResponse;
    return mapResponsesResponse(res);
  }
  const openai = mapRequest(body);
  const res = (await chatCompletion(openai, signal)) as unknown as OpenAIResponse;
  return mapResponse(res);
}

// --- the loop ---

export type WebSearchArgs = {
  inbound: AnthropicRequest & { stream?: boolean };
  endpoint: "chat" | "responses";
  config: SearchConfig;
  signal: AbortSignal;
  logger: Logger;
};

export type WebSearchOutcome = {
  blocks: AnthropicResponseBlock[];
  usage: AnthropicUsage;
  model: string;
  searches: number;
  stopReason: AnthropicStopReason;
};

type LoopMeta = { usage: AnthropicUsage; model: string; searches: number; stopReason: AnthropicStopReason };

function emptyUsage(): AnthropicUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function addUsage(acc: AnthropicUsage, u: AnthropicUsage): void {
  acc.input_tokens += u.input_tokens;
  acc.output_tokens += u.output_tokens;
  acc.cache_read_input_tokens += u.cache_read_input_tokens;
  acc.cache_creation_input_tokens += u.cache_creation_input_tokens;
}

// A forced {type:'tool', name:'web_search'} choice must only apply to the FIRST
// turn — otherwise the model can never stop searching to write its answer. After
// the first turn, downgrade a forced choice to auto; leave others untouched.
function stepToolChoice(choice: AnthropicToolChoice | undefined, iter: number): AnthropicToolChoice | undefined {
  if (iter === 0) return choice;
  if (choice?.type === "tool") return { type: "auto" };
  return choice;
}

function toItem(h: SearchResult): WebSearchResultItem {
  return {
    type: "web_search_result",
    title: h.title,
    url: h.url,
    // Opaque locally — the harness never replays it; kept for shape fidelity.
    encrypted_content: "ddg:" + Buffer.from(h.url).toString("base64"),
    page_age: null,
  };
}

// The assistant turn we replay to Copilot so it sees its own prior text + tool
// calls on the next round.
function assistantTurn(
  texts: AnthropicRespTextBlock[],
  toolUses: AnthropicRespToolUseBlock[],
): AnthropicMessage {
  return {
    role: "assistant",
    content: [
      ...texts.map((t) => ({ type: "text" as const, text: t.text })),
      ...toolUses.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
    ],
  };
}

// Core generator: yields the synthesized Anthropic blocks in order as the loop
// runs, and RETURNS the final usage/model/stop metadata. Both the non-stream and
// stream entry points consume this, so the loop logic lives in exactly one place.
async function* webSearchBlocks(args: WebSearchArgs): AsyncGenerator<AnthropicResponseBlock, LoopMeta> {
  const { inbound, endpoint, config, signal, logger } = args;
  const cap = Math.min(config.maxUses, 8);
  const proxyOpt = resolveProxyOption(config.proxy, config.noProxy);

  // Seed the working transcript from the inbound request, swapping the server
  // tool for the function tool Copilot understands. stream is dropped (we drive
  // completions non-streamed and assemble the stream ourselves).
  const working: AnthropicRequest = {
    ...inbound,
    tools: [...stripWebSearchTools((inbound.tools ?? []) as MaybeServerTool[]), WEB_SEARCH_FUNCTION],
  };
  delete (working as { stream?: boolean }).stream;

  const usage = emptyUsage();
  let model = inbound.model;
  let uses = 0;
  let stopReason: AnthropicStopReason = "end_turn";
  // Bounded round-trips: cap real searches, plus a small allowance for the final
  // answer turn(s) so a model that keeps trying past the cap still terminates.
  const maxIters = cap + 2;

  for (let iter = 0; iter < maxIters; iter++) {
    if (signal.aborted) break;

    const resp = await internalComplete(
      { ...working, tool_choice: stepToolChoice(inbound.tool_choice, iter) },
      endpoint,
      signal,
    );
    if (resp.model) model = resp.model;
    addUsage(usage, resp.usage);

    const texts = resp.content.filter((b): b is AnthropicRespTextBlock => b.type === "text");
    const toolUses = resp.content.filter((b): b is AnthropicRespToolUseBlock => b.type === "tool_use");

    for (const t of texts) if (t.text) yield { type: "text", text: t.text };

    if (toolUses.length === 0) {
      stopReason = "end_turn";
      break; // model wrote its final answer
    }

    // Replay this assistant turn for the next Copilot round.
    working.messages = [...working.messages, assistantTurn(texts, toolUses)];

    const toolResults: AnthropicToolResultBlock[] = [];
    let terminal = false;

    for (const call of toolUses) {
      if (call.name !== "web_search") {
        // A non-web_search (client) tool can't be executed here; surface it and
        // stop. The harness's web_search parser ignores it, but it round-trips.
        yield call;
        stopReason = "tool_use";
        terminal = true;
        continue;
      }

      const input = (call.input ?? {}) as {
        query?: string;
        allowed_domains?: string[];
        blocked_domains?: string[];
      };
      const query = typeof input.query === "string" ? input.query : "";
      const srvId = nextServerToolId();
      yield {
        type: "server_tool_use",
        id: srvId,
        name: "web_search",
        input: {
          query,
          ...(input.allowed_domains ? { allowed_domains: input.allowed_domains } : {}),
          ...(input.blocked_domains ? { blocked_domains: input.blocked_domains } : {}),
        },
      };

      let resultBlock: AnthropicRespWebSearchToolResultBlock;
      let feedback: string;
      if (uses >= cap) {
        resultBlock = {
          type: "web_search_tool_result",
          tool_use_id: srvId,
          content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
        };
        feedback = "Search limit reached. Do not search again; answer with the results you already have.";
      } else {
        uses++;
        try {
          const hits = await runSearch(
            query,
            {
              allowedDomains: input.allowed_domains,
              blockedDomains: input.blocked_domains,
              maxResults: config.maxResults,
              navTimeoutMs: config.navTimeoutMs,
            },
            proxyOpt,
            config.idleMs,
            signal,
          );
          resultBlock = {
            type: "web_search_tool_result",
            tool_use_id: srvId,
            content: hits.map(toItem),
          };
          feedback = JSON.stringify(hits.map((h) => ({ title: h.title, url: h.url })));
          logger.debug("web_search", { query, results: hits.length });
        } catch (err) {
          const code = err instanceof SearchError ? err.code : "unavailable";
          resultBlock = {
            type: "web_search_tool_result",
            tool_use_id: srvId,
            content: { type: "web_search_tool_result_error", error_code: code },
          };
          feedback = `Search error (${code}). Answer with what you have.`;
          logger.error("web_search failed", { query, error_code: code });
        }
      }
      yield resultBlock;
      // Feed the result back to Copilot keyed by ITS call id (not srvId).
      toolResults.push({ type: "tool_result", tool_use_id: call.id, content: feedback });
    }

    if (terminal) break;
    if (toolResults.length) {
      working.messages = [...working.messages, { role: "user", content: toolResults }];
    }
  }

  return { usage, model, searches: uses, stopReason };
}

// --- non-stream entry ---

export async function runWebSearchLoop(args: WebSearchArgs): Promise<WebSearchOutcome> {
  const it = webSearchBlocks(args);
  const blocks: AnthropicResponseBlock[] = [];
  let r = await it.next();
  while (!r.done) {
    blocks.push(r.value);
    r = await it.next();
  }
  return { blocks, ...r.value };
}

export function toAnthropicResponse(outcome: WebSearchOutcome): AnthropicResponse {
  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: outcome.model,
    content: outcome.blocks,
    stop_reason: outcome.stopReason,
    stop_sequence: null,
    usage: outcome.usage,
  };
}

// --- stream entry ---

// Turn one synthesized block into its Anthropic SSE lifecycle. text and
// server_tool_use stream open/delta/stop; web_search_tool_result carries its
// content array INLINE on the start event with no delta (the harness reads
// content_block.content directly).
function* blockToStreamEvents(block: AnthropicResponseBlock, index: number): Generator<AnthropicStreamEvent> {
  switch (block.type) {
    case "text":
      yield { type: "content_block_start", index, content_block: { type: "text", text: "" } };
      if (block.text) {
        yield { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } };
      }
      yield { type: "content_block_stop", index };
      return;
    case "server_tool_use":
      yield {
        type: "content_block_start",
        index,
        content_block: { type: "server_tool_use", id: block.id, name: "web_search", input: {} },
      };
      yield {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      };
      yield { type: "content_block_stop", index };
      return;
    case "web_search_tool_result":
      yield {
        type: "content_block_start",
        index,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
        },
      };
      yield { type: "content_block_stop", index };
      return;
    case "tool_use":
      yield {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      };
      yield {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      };
      yield { type: "content_block_stop", index };
      return;
  }
}

// Assemble the full Anthropic SSE event stream around the loop. message_start
// carries zero usage (totals aren't known until the loop ends); message_delta
// carries the accumulated usage and final stop_reason. Blocks stream as they are
// produced, honoring the harness's idle watchdog.
export async function* runAndStreamWebSearch(args: WebSearchArgs): AsyncGenerator<AnthropicStreamEvent> {
  const id = newMessageId();
  yield {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: args.inbound.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: emptyUsage(),
    },
  };

  const it = webSearchBlocks(args);
  let index = 0;
  let r = await it.next();
  while (!r.done) {
    if (args.signal.aborted) break;
    yield* blockToStreamEvents(r.value, index++);
    r = await it.next();
  }
  const meta: LoopMeta = r.done
    ? r.value
    : { usage: emptyUsage(), model: args.inbound.model, searches: 0, stopReason: "end_turn" };

  yield {
    type: "message_delta",
    delta: { stop_reason: meta.stopReason, stop_sequence: null },
    usage: meta.usage,
  };
  yield { type: "message_stop" };
}
