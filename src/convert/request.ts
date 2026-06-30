// Phase 3: Anthropic -> OpenAI request mapper. Pure body->body, no auth/net.
// Output feeds copilot.chatCompletion (task 4). Input types are local on
// purpose: no @anthropic-ai/sdk dep — we only model the fields the bridge maps.
// Built sub-item by sub-item (Backlog 6a-6f); each fixes one agent-maestro defect.

// --- Anthropic input (subset we map) ---

export type CacheControl = { type: "ephemeral"; ttl?: string };

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
};

// system is either a bare string or a list of text blocks, each independently
// cacheable. agent-maestro's anthropic.ts:227 coerced these to User messages,
// dropping both the system role and the cache breakpoints. We keep both.
export type AnthropicSystem = string | SystemBlock[];

// A tool's schema is opaque to the bridge; only name/description/schema and the
// optional breakpoint matter here. agent-maestro's convertAnthropicToolToVSCode
// dropped cache_control (test anthropic.test.ts:497); we keep it.
export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: unknown;
  cache_control?: CacheControl;
};

// auto/any/none all four map cleanly; named tool keeps its name. agent-maestro
// collapsed any+tool to Required (losing the name) and none to undefined=auto
// (anthropic.ts:304) because the LM API had no fields for them. OpenAI does.
export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

// A turn block carries text, prior tool output (tool_result), tool calls, media,
// or the model's reasoning. tool_use ids must pair with the tool_result that
// answered them. Other fields kept opaque.
export type AnthropicTextBlock = { type: "text"; text: string; cache_control?: CacheControl };
export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | { type: "text"; text: string }[];
};
// base64 (data + media_type) or a url. Documents share the same shape; both
// are forwarded, neither is JSON-stringified or skipped.
export type AnthropicSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };
export type AnthropicImageBlock = { type: "image"; source: AnthropicSource };
export type AnthropicDocumentBlock = { type: "document"; source: AnthropicSource };
// The model's reasoning from a prior assistant turn. agent-maestro flattened
// these to bare text (anthropic.ts:25-31), discarding the type and the
// `signature` Anthropic needs to verify replayed thinking. We keep both so the
// turn round-trips, not just the visible text.
export type AnthropicThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
export type AnthropicRedactedThinkingBlock = { type: "redacted_thinking"; data: string };
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

// The scalars 6f forwards verbatim. max_tokens/temperature/top_p pass straight
// through; stop_sequences renames to OpenAI `stop`. model is required; stream is
// decided by the route, so it's set there, not here.
export type AnthropicRequest = {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystem;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
};

// --- OpenAI output (subset we emit) ---

export type OpenAITextPart = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
};

export type OpenAIImagePart = {
  type: "image_url";
  image_url: { url: string };
};

// Reasoning preserved as a typed content part rather than collapsed to a text
// part: the type stays distinct and the signature/redacted data ride along, so
// the assistant turn replays the same thinking it produced.
export type OpenAIThinkingPart = {
  type: "thinking";
  thinking: string;
  signature?: string;
};
export type OpenAIRedactedThinkingPart = {
  type: "redacted_thinking";
  data: string;
};

export type OpenAIContentPart =
  | OpenAITextPart
  | OpenAIImagePart
  | OpenAIThinkingPart
  | OpenAIRedactedThinkingPart;

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
    cache_control?: CacheControl;
  };
};

export type OpenAISystemMessage = {
  role: "system";
  content: string | OpenAITextPart[];
};

// "auto" | "required" | "none" | a named function. Mirrors the four Anthropic
// modes 1:1, so no information is dropped.
export type OpenAIToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } };

// The assembled chat/completions body. stream is added by copilot.chatCompletion
// / streamChatCompletion, so it isn't part of the mapped body. The output cap is
// emitted under `max_tokens` for most models but `max_completion_tokens` for the
// GPT-5 series, which rejects the legacy name — see emitMaxTokens.
export type OpenAIRequest = {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
};

// One OpenAI system message from the Anthropic system prompt, NOT a User
// message. A bare string stays a string; blocks become text parts so each
// block's cache_control survives (6b). Undefined/empty -> no message at all.
export function mapSystem(system?: AnthropicSystem): OpenAISystemMessage | undefined {
  if (!system) return undefined;

  if (typeof system === "string") {
    return system.length ? { role: "system", content: system } : undefined;
  }

  const parts: OpenAITextPart[] = system.map((b) => ({
    type: "text",
    text: b.text,
    ...withCache(b),
  }));
  return parts.length ? { role: "system", content: parts } : undefined;
}

// 6b: forward a breakpoint instead of dropping it. The single carrier that lets
// Copilot reuse cache (Defect A1, the whole reason we go direct vs the LM API,
// which had no field for it). Spreadable so the key is absent, not undefined,
// when there is no breakpoint.
function withCache(b: { cache_control?: CacheControl }): { cache_control?: CacheControl } {
  return b.cache_control ? { cache_control: b.cache_control } : {};
}

// Tools carry the last reusable breakpoint (system, then messages, then tools).
// agent-maestro stripped it (anthropic.ts:284, test:497); we forward it onto the
// function so the cached tool prefix isn't billed every turn.
export function mapTools(tools?: AnthropicTool[]): OpenAITool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema,
      ...withCache(t),
    },
  }));
}

// 6e: forward the caller's intent verbatim. any->required, none->"none" (vs
// maestro dropping none to auto), tool->the named function (vs maestro losing
// the name to bare Required). Undefined choice -> undefined: let Copilot default.
export function mapToolChoice(choice?: AnthropicToolChoice): OpenAIToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}

// 6c: messages. One Anthropic message can fan out to several OpenAI ones —
// assistant tool_use blocks become a tool_calls array on the assistant message,
// while each user tool_result becomes its own `tool` message keyed by the
// tool_use_id it answers (OpenAI has no multi-result message). agent-maestro
// flattened the same 1->N way; the difference here is the OpenAI shape and that
// we keep tool_use/tool_result ids paired rather than coercing both to text.
export function mapMessages(messages: AnthropicMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const text: string[] = [];
    const media: OpenAIImagePart[] = []; // images + documents, kept not skipped
    const thinking: (OpenAIThinkingPart | OpenAIRedactedThinkingPart)[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: OpenAIMessage[] = []; // emitted before the parent (see below)

    for (const block of msg.content) {
      if (block.type === "text") {
        text.push(block.text);
      } else if (block.type === "image" || block.type === "document") {
        media.push({ type: "image_url", image_url: { url: sourceUrl(block.source) } });
      } else if (block.type === "thinking") {
        thinking.push({ type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) });
      } else if (block.type === "redacted_thinking") {
        thinking.push({ type: "redacted_thinking", data: block.data });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultText(block.content),
        });
      }
    }

    // Text-only turns stay a plain string. Any thinking/image/document forces
    // multipart, reasoning first so it precedes the visible answer. null only
    // when there is nothing but tool_calls.
    let content: string | OpenAIContentPart[] | null;
    if (thinking.length || media.length) {
      content = [...thinking, ...text.map((t) => ({ type: "text" as const, text: t })), ...media];
    } else {
      content = text.length ? text.join("\n") : null;
    }
    // Tool results must come FIRST, so they sit immediately after the previous
    // assistant turn's tool_calls. OpenAI (and Copilot's Anthropic re-mapping)
    // reject a tool_use whose tool_result doesn't immediately follow — emitting
    // the parent (e.g. sibling text in the same Anthropic user turn) before the
    // tool messages splits that pairing and triggers a 400. Anthropic already
    // requires tool_result blocks at the START of a user turn, so any companion
    // text/media is logically a follow-up and is emitted AFTER the tool results.
    out.push(...toolResults);
    if (content !== null || toolCalls.length) {
      out.push({ role: msg.role, content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
  }

  return out;
}

// base64 -> inline data: URL; url -> verbatim. agent-maestro JSON-stringified
// url images (anthropic.ts:15) and skipped documents (123); both are real
// content and forwarded as-is.
export function sourceUrl(source: AnthropicSource): string {
  return source.type === "url"
    ? source.url
    : `data:${source.media_type};base64,${source.data}`;
}

export function toolResultText(content: AnthropicToolResultBlock["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((c) => c.text).join("\n");
}

// The GPT-5 series rejects the legacy `max_tokens` on /chat/completions with
// "Unsupported parameter ... Use max_completion_tokens instead". Every other
// family still takes `max_tokens`. Detect GPT-5 by id so the cap lands under the
// name the model accepts; an unknown/blank value emits nothing (Copilot defaults).
export function isGpt5(model: string): boolean {
  return /^gpt-5(\.|-|$)/i.test(model);
}

function emitMaxTokens(model: string, value?: number): Record<string, number> {
  if (value === undefined) return {};
  return isGpt5(model) ? { max_completion_tokens: value } : { max_tokens: value };
}

// 6f: assemble the full chat/completions body. system message goes first, then
// the mapped turns; tools/tool_choice via the 6b/6e mappers; scalars verbatim
// except stop_sequences -> OpenAI `stop`. Optionals are omitted (not null) when
// absent so Copilot applies its own defaults. stream is set by the client. The
// output cap is emitted under the family-correct key (see emitMaxTokens).
export function mapRequest(req: AnthropicRequest): OpenAIRequest {
  const system = mapSystem(req.system);
  const messages = mapMessages(req.messages);
  const tools = mapTools(req.tools);
  const tool_choice = mapToolChoice(req.tool_choice);

  return {
    model: req.model,
    messages: system ? [system, ...messages] : messages,
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...emitMaxTokens(req.model, req.max_tokens),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    ...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
  };
}
