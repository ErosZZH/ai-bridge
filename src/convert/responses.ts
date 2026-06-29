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

function mapResponsesUsage(usage?: ResponsesUsage): AnthropicUsage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.input_tokens_details?.cached_tokens ?? 0,
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

// One Responses body -> one Anthropic Message. Walk output[]: skip reasoning,
// concatenate output_text into one text block, and turn each function_call into a
// tool_use block (input parsed back to an object). stop_reason upgrades to
// tool_use whenever any function_call appears.
export function mapResponsesResponse(res: ResponsesResponse): AnthropicResponse {
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
        name: call.name,
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

// The Responses stream events we act on. Everything else (in_progress,
// content_part.*, *.done closers, reasoning items) is ignored — the block
// lifecycle is driven by the text/arg deltas and the terminal event.
type ResponsesStreamEvent = {
  type?: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string };
  response?: ResponsesResponse;
};

type RState = {
  next: number; // next Anthropic content-block index to assign
  openIndex: number; // index of the open block, or -1
  openKind: "text" | "tool" | null;
};

function closeOpen(state: RState, events: AnthropicStreamEvent[]): void {
  if (state.openKind === null) return;
  events.push({ type: "content_block_stop", index: state.openIndex });
  state.openIndex = -1;
  state.openKind = null;
}

// Translate one Responses event into zero or more Anthropic SSE events. Pulled
// out of the generator so it is a pure (state, event) -> events step, mirroring
// chunkToEvents in response.ts. Mutates `state` for block bookkeeping.
function eventToAnthropic(state: RState, ev: ResponsesStreamEvent): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];

  switch (ev.type) {
    case "response.output_text.delta": {
      if (state.openKind !== "text") {
        closeOpen(state, events);
        state.openIndex = state.next++;
        state.openKind = "text";
        events.push({
          type: "content_block_start",
          index: state.openIndex,
          content_block: { type: "text", text: "" },
        });
      }
      if (ev.delta) {
        events.push({
          type: "content_block_delta",
          index: state.openIndex,
          delta: { type: "text_delta", text: ev.delta },
        });
      }
      break;
    }
    case "response.output_item.added": {
      // Only function_call items open a block here; message/reasoning items are
      // introduced lazily by their first text delta (above).
      if (ev.item?.type === "function_call") {
        closeOpen(state, events);
        state.openIndex = state.next++;
        state.openKind = "tool";
        events.push({
          type: "content_block_start",
          index: state.openIndex,
          content_block: {
            type: "tool_use",
            id: ev.item.call_id ?? "",
            name: ev.item.name ?? "",
            input: {},
          },
        });
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      if (state.openKind === "tool" && ev.delta) {
        events.push({
          type: "content_block_delta",
          index: state.openIndex,
          delta: { type: "input_json_delta", partial_json: ev.delta },
        });
      }
      break;
    }
  }

  return events;
}

// Responses SSE event stream -> Anthropic SSE event stream. Opens with
// message_start (usage filled from response.created if present, else zeros, then
// finalized on completion), streams block events, and closes with message_delta
// (stop_reason + final usage) and message_stop. The terminal event
// (response.completed / .incomplete / .failed) carries the authoritative usage
// and status.
export async function* streamResponsesResponse(
  events: AsyncIterable<ResponsesStreamEvent>,
  model: string,
): AsyncGenerator<AnthropicStreamEvent> {
  const id = newMessageId();
  const state: RState = { next: 0, openIndex: -1, openKind: null };
  let usage: ResponsesUsage | undefined;
  let stopReason: AnthropicStopReason = "end_turn";
  let sawTool = false;
  let started = false;

  const start = function* (): Generator<AnthropicStreamEvent> {
    if (started) return;
    started = true;
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
        usage: { ...mapResponsesUsage(usage), output_tokens: 0 },
      },
    };
  };

  for await (const ev of events) {
    // Terminal events carry the final response object (status + usage).
    if (
      ev.type === "response.completed" ||
      ev.type === "response.incomplete" ||
      ev.type === "response.failed"
    ) {
      if (ev.response?.usage) usage = ev.response.usage;
      if (ev.response) stopReason = stopReasonFor(ev.response, sawTool);
      continue;
    }
    if (ev.type === "response.created" && ev.response?.usage) usage = ev.response.usage;
    if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
      sawTool = true;
    }

    const mapped = eventToAnthropic(state, ev);
    if (mapped.length) {
      yield* start();
      yield* mapped;
    }
  }

  // A stream that produced nothing still needs a well-formed envelope.
  yield* start();
  if (state.openKind !== null) yield { type: "content_block_stop", index: state.openIndex };
  if (sawTool) stopReason = "tool_use";

  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: mapResponsesUsage(usage),
  };
  yield { type: "message_stop" };
}
