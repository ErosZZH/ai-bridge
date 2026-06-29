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

// --- OpenAI output (subset we emit) ---

export type OpenAITextPart = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
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
    ...(b.cache_control ? { cache_control: b.cache_control } : {}),
  }));
  return parts.length ? { role: "system", content: parts } : undefined;
}
