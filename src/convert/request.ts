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

// A user-turn block carries either prior tool output (tool_result) or text.
// tool_use ids must pair with the tool_result that answered them. thinking/
// redacted land in 6f. Other fields kept opaque.
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
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock;

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
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

export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

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
    const toolCalls: OpenAIToolCall[] = [];
    const trailing: OpenAIMessage[] = []; // tool messages emit after the parent

    for (const block of msg.content) {
      if (block.type === "text") {
        text.push(block.text);
      } else if (block.type === "image" || block.type === "document") {
        media.push({ type: "image_url", image_url: { url: sourceUrl(block.source) } });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "tool_result") {
        trailing.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultText(block.content),
        });
      }
    }

    // Text-only turns stay a plain string; once any image/document is present
    // the message is OpenAI multipart with text parts ahead of media. null only
    // when there is nothing but tool_calls.
    let content: string | OpenAIContentPart[] | null;
    if (media.length) {
      content = [...text.map((t) => ({ type: "text" as const, text: t })), ...media];
    } else {
      content = text.length ? text.join("\n") : null;
    }
    if (content !== null || toolCalls.length) {
      out.push({ role: msg.role, content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
    out.push(...trailing);
  }

  return out;
}

// base64 -> inline data: URL; url -> verbatim. agent-maestro JSON-stringified
// url images (anthropic.ts:15) and skipped documents (123); both are real
// content and forwarded as-is.
function sourceUrl(source: AnthropicSource): string {
  return source.type === "url"
    ? source.url
    : `data:${source.media_type};base64,${source.data}`;
}

function toolResultText(content: AnthropicToolResultBlock["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((c) => c.text).join("\n");
}
