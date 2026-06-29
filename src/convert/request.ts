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

// --- OpenAI output (subset we emit) ---

export type OpenAITextPart = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
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
