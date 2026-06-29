// Phase 3: OpenAI -> Anthropic response mapper, the mirror of request.ts.
// Copilot answers in OpenAI chat/completions shape (both a single JSON body and
// an SSE chunk stream); the Claude Code harness consumes Anthropic Messages
// events. This module turns one into the other. Pure: no auth/net. Input types
// are local on purpose — no @anthropic-ai/sdk dep, we model only what we map.
//
// Fixes carried over from the agent-maestro scan:
//  - message ids get a random suffix instead of bare Date.now() (Defect B:
//    anthropicRoutes.ts:460,513 collide within a millisecond).
//  - usage is forwarded exactly as Copilot reports it, including cache reads,
//    rather than re-estimated from stringified chunks (Defect A2).
//  - finish_reason "length" maps to "max_tokens" (maestro only set that via a
//    string-match error path; here it is a direct field map).

import type { CopilotUsage } from "../copilot/index.js";

// --- OpenAI input (subset we read) ---

export type OpenAIResponseToolCall = {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
};

export type OpenAIResponseMessage = {
  role: "assistant";
  content?: string | null;
  tool_calls?: OpenAIResponseToolCall[];
};

// OpenAI's four finish reasons. "content_filter" has no Anthropic equivalent;
// we fold it into end_turn (the turn did stop). null means "still going" and
// only appears mid-stream.
export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | null;

export type OpenAIResponseChoice = {
  index?: number;
  message: OpenAIResponseMessage;
  finish_reason: OpenAIFinishReason;
};

export type OpenAIResponse = {
  id: string;
  model?: string;
  choices: OpenAIResponseChoice[];
  usage?: CopilotUsage;
};

// Streaming delta. arguments arrives as fragments across chunks; OpenAI keys
// each fragment by the tool call's `index`, not its id (the id only rides on
// the first fragment), so reassembly is by index.
export type OpenAIDeltaToolCall = {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
};

export type OpenAIStreamDelta = {
  role?: "assistant";
  content?: string | null;
  tool_calls?: OpenAIDeltaToolCall[];
};

export type OpenAIStreamChoice = {
  index?: number;
  delta: OpenAIStreamDelta;
  finish_reason?: OpenAIFinishReason;
};

export type OpenAIStreamChunk = {
  id?: string;
  choices?: OpenAIStreamChoice[];
  usage?: CopilotUsage;
};

// --- Anthropic output (subset we emit) ---

export type AnthropicStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | null;

export type AnthropicRespTextBlock = { type: "text"; text: string };
export type AnthropicRespToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type AnthropicResponseBlock = AnthropicRespTextBlock | AnthropicRespToolUseBlock;

// The harness's usage object. input/cache counts land here from Copilot's
// prompt_tokens(+details); output_tokens from completion_tokens. The harness
// guards updates with `>0`, so reporting a real input count once (on the
// non-stream body, or message_start when streaming) is enough.
export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type AnthropicResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: string | null;
  usage: AnthropicUsage;
};

// --- Anthropic SSE events (subset the harness parses) ---

export type MessageStartEvent = {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: [];
    stop_reason: null;
    stop_sequence: null;
    usage: AnthropicUsage;
  };
};

export type ContentBlockStartEvent = {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: "" }
    | { type: "tool_use"; id: string; name: string; input: Record<string, never> };
};

export type ContentBlockDeltaEvent = {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string };
};

export type ContentBlockStopEvent = { type: "content_block_stop"; index: number };

export type MessageDeltaEvent = {
  type: "message_delta";
  delta: { stop_reason: AnthropicStopReason; stop_sequence: string | null };
  usage: AnthropicUsage;
};

export type MessageStopEvent = { type: "message_stop" };

export type AnthropicStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

// --- id generation seam ---

// Stable, collision-resistant message id. The random suffix is the fix for the
// Date.now()-only ids that collided in maestro. Injectable so tests pin it;
// Math.random()/Date.now() are avoided anyway (unavailable in some harness
// contexts), so the default leans on crypto.randomUUID.
let idImpl: () => string = () => `msg_${cryptoSuffix()}`;
function cryptoSuffix(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}
export function __setResponseDeps(deps: { id?: () => string }) {
  if (deps.id) idImpl = deps.id;
}

// --- mapping helpers ---

// content_filter folds into end_turn: the turn did stop, and there is no
// Anthropic reason for a filtered completion. null (only seen mid-stream) means
// not finished yet.
function mapStopReason(reason: OpenAIFinishReason): AnthropicStopReason {
  switch (reason) {
    case "stop":
    case "content_filter":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return null;
  }
}

// Copilot's OpenAI usage -> the harness's four counters. cached_tokens are
// reads; cache_creation_input_tokens are writes. Absent fields are 0, never
// undefined, so the harness's >0 guard reads them cleanly.
function mapUsage(usage?: CopilotUsage): AnthropicUsage {
  const details = usage?.prompt_tokens_details;
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: details?.cached_tokens ?? 0,
    cache_creation_input_tokens: details?.cache_creation_input_tokens ?? 0,
  };
}

// arguments is a JSON string in the OpenAI wire shape; Anthropic tool_use.input
// is a parsed object. maestro left it stringified one direction and double-
// parsed the other; here we parse once, and fall back to {} on the empty string
// (a tool with no args) or malformed JSON rather than throwing mid-response.
function parseToolInput(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

// --- non-stream ---

// One OpenAI body -> one Anthropic Message. Text (if any) becomes a single text
// block, then one tool_use block per tool_call with its arguments parsed back to
// an object. stop_reason comes from finish_reason, upgraded to tool_use whenever
// tool calls are present (OpenAI sometimes reports "stop" alongside tool_calls).
export function mapResponse(res: OpenAIResponse): AnthropicResponse {
  const choice = res.choices[0];
  const message = choice?.message;
  const content: AnthropicResponseBlock[] = [];

  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }
  const toolCalls = message?.tool_calls ?? [];
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseToolInput(call.function.arguments),
    });
  }

  const stop_reason = toolCalls.length
    ? "tool_use"
    : mapStopReason(choice?.finish_reason ?? null);

  return {
    id: idImpl(),
    type: "message",
    role: "assistant",
    model: res.model ?? "",
    content,
    stop_reason,
    stop_sequence: null,
    usage: mapUsage(res.usage),
  };
}

// --- stream ---

// Per-stream cursor over the Anthropic content blocks we are emitting. OpenAI's
// flat delta stream (text and tool-call fragments interleaved on one channel)
// has to become Anthropic's explicit per-block lifecycle. `openIndex` is the
// index of the block currently open (-1 when none) so close events always carry
// the right index; `next` is the next index to assign; the map ties each OpenAI
// tool `index` to our block index, since arg fragments reference only that.
type StreamState = {
  next: number; // next content-block index to assign
  openIndex: number; // index of the open block, or -1
  openKind: "text" | "tool" | null;
  toolBlockByIndex: Map<number, number>; // OpenAI tool index -> our block index
};

// Translate one OpenAI chunk into zero or more Anthropic SSE events. Pulled out
// of the generator so it is unit-testable as a pure (state, chunk) -> events
// step. Mutates `state` to carry block bookkeeping across chunks.
function chunkToEvents(state: StreamState, chunk: OpenAIStreamChunk): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  const delta = chunk.choices?.[0]?.delta;

  if (delta?.content) {
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
    events.push({
      type: "content_block_delta",
      index: state.openIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  for (const call of delta?.tool_calls ?? []) {
    let blockIndex = state.toolBlockByIndex.get(call.index);
    // First fragment for this tool index: close whatever was open and start a
    // fresh tool_use block. The id/name only ride this first fragment.
    if (blockIndex === undefined) {
      closeOpen(state, events);
      blockIndex = state.next++;
      state.toolBlockByIndex.set(call.index, blockIndex);
      state.openIndex = blockIndex;
      state.openKind = "tool";
      events.push({
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: call.id ?? "",
          name: call.function?.name ?? "",
          input: {},
        },
      });
    }
    // Argument fragment: forward verbatim as partial_json. The harness
    // concatenates these, so we must not parse or reshape them here.
    const args = call.function?.arguments;
    if (args) {
      events.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: args },
      });
    }
  }

  return events;
}

// Emit a content_block_stop for the open block (if any) and clear the cursor.
function closeOpen(state: StreamState, events: AnthropicStreamEvent[]): void {
  if (state.openKind === null) return;
  events.push({ type: "content_block_stop", index: state.openIndex });
  state.openIndex = -1;
  state.openKind = null;
}

// OpenAI chunk stream -> Anthropic SSE event stream. Opens with message_start
// (carrying input/cache usage so the harness's >0 guard captures it once),
// streams block events as deltas arrive, then closes the last open block and
// emits message_delta (stop_reason + final output usage) and message_stop.
//
// Usage placement: Copilot sends the usage object on a late chunk whose choices
// are empty. We keep the latest usage seen and fold the prompt/cache side into
// message_start and the completion side into message_delta. If it only arrives
// at the end, message_start carries zeros — acceptable, since the harness fills
// output from message_delta and treats input as monotonic.
export async function* streamResponse(
  chunks: AsyncIterable<OpenAIStreamChunk>,
  model: string,
): AsyncGenerator<AnthropicStreamEvent> {
  const id = idImpl();
  const state: StreamState = { next: 0, openIndex: -1, openKind: null, toolBlockByIndex: new Map() };
  let stopReason: AnthropicStopReason = "end_turn";
  let usage: CopilotUsage | undefined;
  let sawTool = false;
  let started = false;

  // message_start must be the first event; emit it lazily on the first chunk so
  // any usage already present is included, but never later than block events.
  const ensureStarted = function* (): Generator<AnthropicStreamEvent> {
    if (started) return;
    started = true;
    const u = mapUsage(usage);
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
        usage: { ...u, output_tokens: 0 },
      },
    };
  };

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (choice?.delta?.tool_calls?.length) sawTool = true;
    if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason);

    const events = chunkToEvents(state, chunk);
    if (events.length) {
      yield* ensureStarted();
      yield* events;
    }
  }

  // A stream that produced nothing still needs a well-formed envelope.
  yield* ensureStarted();

  if (state.openKind !== null) yield { type: "content_block_stop", index: state.openIndex };

  // tool_calls present overrides whatever finish_reason said (OpenAI may report
  // "stop"); mirrors the non-stream path.
  if (sawTool) stopReason = "tool_use";

  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: mapUsage(usage),
  };
  yield { type: "message_stop" };
}
