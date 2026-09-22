// Anthropic <-> OpenAI **Responses API** mappers, the sibling of request.ts +
// response.ts for the newest OpenAI models (gpt-5.5, gpt-5.3-codex, gpt-5.4-mini)
// that Copilot serves ONLY on /responses, not /chat/completions. Pure: no
// auth/net. The Responses wire shape differs from chat/completions:
//   - request:  system -> `instructions`; turns -> `input[]`; tools are FLAT
//               ({type:"function", name, ...}); the cap is `max_output_tokens`.
//   - response: an `output[]` array of items (reasoning | message | function_call)
//               instead of choices[]; usage is input_tokens/output_tokens.
//   - stream:   semantic events (response.output_text.delta,
//               response.function_call_arguments.delta, response.completed) rather
//               than chat delta chunks.
// Both response/stream are remapped to the SAME Anthropic shapes the harness
// already consumes (reusing the types + id seam from response.ts), so the route
// and the harness see one uniform Messages contract regardless of upstream.

import {
  type AnthropicMessage,
  type AnthropicRequest,
  type AnthropicSource,
  type AnthropicTool,
  type AnthropicToolChoice,
  type AnthropicToolResultBlock,
  sourceUrl,
  toolResultText,
} from "./request.js";
import {
  type AnthropicResponse,
  type AnthropicResponseBlock,
  type AnthropicStopReason,
  type AnthropicStreamEvent,
  type AnthropicUsage,
  newMessageId,
} from "./response.js";

// --- Responses request shape (subset we emit) ---

export type ResponsesInputItem =
  | { role: "user" | "assistant" | "system"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponsesTool = {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  strict: boolean;
};

export type ResponsesToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; name: string };

export type ResponsesRequest = {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
};

export type ResponsesConversionContext = {
  readonly advertisedToolNames: ReadonlySet<string>;
};

// Response conversion must be constrained by the exact function definitions we
// sent upstream. Otherwise an invented name can escape as a tool_use that the
// harness never advertised and cannot dispatch.
export function createResponsesConversionContext(
  req: ResponsesRequest,
): ResponsesConversionContext {
  return {
    advertisedToolNames: new Set((req.tools ?? []).map((tool) => tool.name)),
  };
}

// --- Responses non-stream response shape (subset we read) ---

type ResponsesOutputText = { type: "output_text"; text: string };
type ResponsesMessageItem = {
  type: "message";
  role: "assistant";
  content?: ResponsesOutputText[];
};
type ResponsesFunctionCallItem = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
};
type ResponsesReasoningItem = { type: "reasoning" };
type ResponsesOutputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesReasoningItem
  | { type: string };

export type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

export type ResponsesResponse = {
  id?: string;
  model?: string;
  status?: "completed" | "incomplete" | "failed" | string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
};

// --- request mapping ---

// system: Responses takes a single `instructions` string. A bare string passes
// through; system blocks are joined (their cache_control has no carrier here, so
// it is intentionally dropped — /responses has no per-block breakpoint field).
function mapInstructions(system: AnthropicRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system.length ? system : undefined;
  const text = system.map((b) => b.text).join("\n");
  return text.length ? text : undefined;
}

// Images and documents become their reference url inline (same pragmatic choice
// the chat mapper makes: no base64 tokenization).
function refUrl(source: AnthropicSource): string {
  return sourceUrl(source);
}

// One Anthropic message -> zero or more Responses input items. tool_use blocks
// become `function_call` items, tool_result blocks become `function_call_output`
// items (both keyed by the same call id), and the remaining text/media collapse
// to a single role item. Mirrors how the chat mapper fans 1->N, in Responses
// item vocabulary.
function mapInput(messages: AnthropicMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.content.length) out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const text: string[] = [];
    const calls: ResponsesInputItem[] = [];
    const results: ResponsesInputItem[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        text.push(block.text);
      } else if (block.type === "image" || block.type === "document") {
        text.push(refUrl(block.source));
      } else if (block.type === "tool_use") {
        calls.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        results.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: toolResult(block.content),
        });
      }
    }

    const joined = text.join("\n");
    if (joined.length) out.push({ role: msg.role, content: joined });
    // function_call items belong to the assistant turn; outputs answer the prior
    // call. Emit calls then results, after any text, preserving turn order.
    out.push(...calls, ...results);
  }

  return out;
}

function toolResult(content: AnthropicToolResultBlock["content"]): string {
  return toolResultText(content);
}

function mapResponsesTools(tools?: AnthropicTool[]): ResponsesTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema,
    // Responses may normalize omitted strict mode, making optional fields required.
    strict: false,
  }));
}

// Responses uses the same four modes as chat, but a named tool is flat
// ({type:"function", name}) rather than nested under `function`.
function mapResponsesToolChoice(choice?: AnthropicToolChoice): ResponsesToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", name: choice.name };
  }
}

// Assemble the Responses body. Optionals are omitted (not null) when absent so
// Copilot applies its own defaults; `stream` is set by the client, like the chat
// path. max_output_tokens is the per-model default the route injects.
export function mapRequestToResponses(req: AnthropicRequest): ResponsesRequest {
  const instructions = mapInstructions(req.system);
  const tools = mapResponsesTools(req.tools);
  const tool_choice = mapResponsesToolChoice(req.tool_choice);

  return {
    model: req.model,
    input: mapInput(req.messages),
    ...(instructions ? { instructions } : {}),
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(req.max_tokens !== undefined ? { max_output_tokens: req.max_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
  };
}

// --- response mapping (non-stream) ---

// `incomplete` with reason max_output_tokens is the Responses equivalent of
// chat's finish_reason "length" -> Anthropic max_tokens. A failed status with no
// tool calls still stops the turn; we report end_turn (the route surfaces real
// upstream errors separately, before mapping).
function stopReasonFor(res: ResponsesResponse, sawTool: boolean): AnthropicStopReason {
  if (sawTool) return "tool_use";
  if (res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens";
  }
  return "end_turn";
}

// Responses usage -> the harness's four counters. Like the chat path, Copilot's
// `input_tokens` here is cache-INCLUSIVE (cached_tokens is a SUBSET of it), while
// the harness treats Anthropic `input_tokens` as cache-EXCLUSIVE and sums all
// four counters. Emitting input_tokens AND cache_read straight through would
// double-count the cached tokens and inflate the harness's context estimate, so
// subtract cached out of input_tokens. The /responses wire carries no
// cache-creation field, so that counter is always 0.
function mapResponsesUsage(usage?: ResponsesUsage): AnthropicUsage {
  const input = usage?.input_tokens ?? 0;
  const cacheRead = usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, input - cacheRead),
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
  };
}

function parseArgs(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function validateFunctionName(
  name: string | undefined,
  context: ResponsesConversionContext,
): string {
  const shown = name || "<missing>";
  if (!name || !context.advertisedToolNames.has(name)) {
    const advertised = [...context.advertisedToolNames].sort().join(", ") || "none";
    throw new Error(
      `upstream returned unadvertised function '${shown}' (advertised functions: ${advertised})`,
    );
  }
  return name;
}

// One Responses body -> one Anthropic Message. Walk output[]: skip reasoning,
// concatenate output_text into one text block, and turn each function_call into a
// tool_use block (input parsed back to an object). stop_reason upgrades to
// tool_use whenever any function_call appears.
export function mapResponsesResponse(
  res: ResponsesResponse,
  context: ResponsesConversionContext,
): AnthropicResponse {
  const content: AnthropicResponseBlock[] = [];
  let sawTool = false;
  let text = "";

  for (const item of res.output ?? []) {
    if (item.type === "message") {
      for (const part of (item as ResponsesMessageItem).content ?? []) {
        if (part.type === "output_text") text += part.text;
      }
    } else if (item.type === "function_call") {
      const call = item as ResponsesFunctionCallItem;
      sawTool = true;
      content.push({
        type: "tool_use",
        id: call.call_id,
        name: validateFunctionName(call.name, context),
        input: parseArgs(call.arguments),
      });
    }
  }

  // text block goes first (before tool_use), matching the chat mapper's ordering.
  if (text) content.unshift({ type: "text", text });

  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: res.model ?? "",
    content,
    stop_reason: stopReasonFor(res, sawTool),
    stop_sequence: null,
    usage: mapResponsesUsage(res.usage),
  };
}

// --- stream mapping ---

// Correlation fields vary between Responses events, so retain every stable id
// the API may provide. Tool argument fragments are buffered per call because
// Anthropic content blocks cannot legally interleave.
type ResponsesStreamItem = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

type ResponsesStreamEvent = {
  type?: string;
  delta?: string;
  arguments?: string;
  output_index?: number;
  item_id?: string;
  call_id?: string;
  item?: ResponsesStreamItem;
  response?: ResponsesResponse;
};

type PendingCall = {
  callId: string;
  name: string;
  fragments: string[];
  done: boolean;
};

type RState = {
  next: number;
  textIndex: number;
  textOpen: boolean;
  calls: PendingCall[];
  callsByAlias: Map<string, PendingCall>;
};

function aliasesFor(ev: ResponsesStreamEvent): string[] {
  const aliases: string[] = [];
  const add = (alias: string | undefined) => {
    if (alias && !aliases.includes(alias)) aliases.push(alias);
  };
  if (ev.output_index !== undefined) add(`output:${ev.output_index}`);
  add(ev.item_id ? `item:${ev.item_id}` : undefined);
  add(ev.call_id ? `call:${ev.call_id}` : undefined);
  add(ev.item?.id ? `item:${ev.item.id}` : undefined);
  add(ev.item?.call_id ? `call:${ev.item.call_id}` : undefined);
  return aliases;
}

function registerCall(
  state: RState,
  ev: ResponsesStreamEvent,
  context: ResponsesConversionContext,
): void {
  const callId = ev.item?.call_id;
  if (!callId) throw new Error("upstream returned a function call without a call_id");
  const call: PendingCall = {
    callId,
    name: validateFunctionName(ev.item?.name, context),
    fragments: [],
    done: false,
  };
  for (const alias of aliasesFor(ev)) {
    if (state.callsByAlias.has(alias)) {
      throw new Error(`upstream reused function-call identifier '${alias}'`);
    }
    state.callsByAlias.set(alias, call);
  }
  state.calls.push(call);
}

function resolveCall(state: RState, ev: ResponsesStreamEvent): PendingCall {
  let matched: PendingCall | undefined;
  for (const alias of aliasesFor(ev)) {
    const call = state.callsByAlias.get(alias);
    if (!call) throw new Error(`upstream referenced unknown function call '${alias}'`);
    if (matched && matched !== call) {
      throw new Error("upstream function-call identifiers refer to different calls");
    }
    matched = call;
  }
  if (matched) return matched;

  let pending: PendingCall | undefined;
  let pendingCount = 0;
  for (const call of state.calls) {
    if (!call.done) {
      pending = call;
      pendingCount++;
    }
  }
  if (pendingCount === 1) return pending as PendingCall;
  throw new Error(
    `upstream function-call event is ambiguous (${pendingCount} pending calls and no correlation id)`,
  );
}

function closeText(state: RState): AnthropicStreamEvent[] {
  if (!state.textOpen) return [];
  state.textOpen = false;
  return [{ type: "content_block_stop", index: state.textIndex }];
}

function* emitCalls(state: RState): Generator<AnthropicStreamEvent> {
  yield* closeText(state);
  for (const call of state.calls) {
    const index = state.next++;
    yield {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: call.callId, name: call.name, input: {} },
    };
    for (const fragment of call.fragments) {
      if (fragment) {
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: fragment },
        };
      }
    }
    yield { type: "content_block_stop", index };
  }
}

function handleToolEvent(
  state: RState,
  ev: ResponsesStreamEvent,
  context: ResponsesConversionContext,
): void {
  if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
    registerCall(state, ev, context);
    return;
  }
  if (ev.type === "response.function_call_arguments.delta") {
    const call = resolveCall(state, ev);
    if (call.done) throw new Error(`upstream sent arguments after function call '${call.callId}' completed`);
    if (ev.delta) call.fragments.push(ev.delta);
    return;
  }
  const argumentsDone = ev.type === "response.function_call_arguments.done";
  const itemDone = ev.type === "response.output_item.done" && ev.item?.type === "function_call";
  if (argumentsDone || itemDone) {
    const call = resolveCall(state, ev);
    const args = argumentsDone ? ev.arguments ?? ev.item?.arguments : ev.item?.arguments;
    if (call.fragments.length === 0 && args) call.fragments.push(args);
    // Responses normally emits both arguments.done and output_item.done for one
    // call. Treat the second closer as idempotent while still rejecting deltas
    // that arrive after either closer.
    call.done = true;
  }
}

// Responses SSE event stream -> Anthropic SSE event stream. Opens with
// message_start (usage filled from response.created if present, else the
// input-token estimate, then finalized on completion), streams block events, and
// closes with message_delta (stop_reason + final usage) and message_stop. The
// terminal event (response.completed / .incomplete / .failed) carries the
// authoritative usage and status.
//
// message_start seeding: like the chat path, Copilot only reports real usage at
// the END (response.completed), so message_start would carry zeros — which the
// Claude Code subagent progress tracker latches as "0 tokens" (it samples usage
// at content_block_stop and never re-reads message_delta). `inputTokensEstimate`
// (the bridge's tokenizer count, threaded in from the route) seeds a real input
// number up front, mirroring the Anthropic API; the exact count still corrects
// in message_delta for the main loop.
export async function* streamResponsesResponse(
  events: AsyncIterable<ResponsesStreamEvent>,
  model: string,
  inputTokensEstimate: number,
  context: ResponsesConversionContext,
): AsyncGenerator<AnthropicStreamEvent> {
  const id = newMessageId();
  const state: RState = {
    next: 0,
    textIndex: -1,
    textOpen: false,
    calls: [],
    callsByAlias: new Map(),
  };
  let usage: ResponsesUsage | undefined;
  let stopReason: AnthropicStopReason = "end_turn";
  let started = false;

  const start = function* (): Generator<AnthropicStreamEvent> {
    if (started) return;
    started = true;
    const u = mapResponsesUsage(usage);
    const input_tokens = u.input_tokens || inputTokensEstimate;
    yield {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...u, input_tokens, output_tokens: 0 },
      },
    };
  };

  for await (const ev of events) {
    if (
      ev.type === "response.completed" ||
      ev.type === "response.incomplete" ||
      ev.type === "response.failed"
    ) {
      if (ev.response?.usage) usage = ev.response.usage;
      if (ev.response) stopReason = stopReasonFor(ev.response, state.calls.length > 0);
      continue;
    }
    if (ev.type === "response.created" && ev.response?.usage) usage = ev.response.usage;

    if (ev.type === "response.output_text.delta" && ev.delta) {
      yield* start();
      if (!state.textOpen) {
        state.textIndex = state.next++;
        state.textOpen = true;
        yield {
          type: "content_block_start",
          index: state.textIndex,
          content_block: { type: "text", text: "" },
        };
      }
      yield {
        type: "content_block_delta",
        index: state.textIndex,
        delta: { type: "text_delta", text: ev.delta },
      };
      continue;
    }

    handleToolEvent(state, ev, context);
  }

  // Tool calls are buffered so interleaved upstream fragments become legal,
  // contiguous Anthropic content blocks in upstream addition order.
  yield* start();
  yield* emitCalls(state);
  if (state.calls.length) stopReason = "tool_use";

  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: mapResponsesUsage(usage),
  };
  yield { type: "message_stop" };
}
