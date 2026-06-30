// Phase 2: Copilot model catalog. GET /models from the per-account endpoint,
// caches the list with a TTL, and resolves a requested model id. Resolution is
// EXACT (or the passthrough sentinel `auto`) — agent-maestro fuzzy-matched on
// Jaccard ≥0.3, which silently routed e.g. an unknown id to a wrong model; we
// drop that and fail loudly instead. Embedding/non-chat entries are filtered
// so only ids servable by /chat/completions surface. Windows feed the routes'
// context-length cap (task 8).

import {
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
  USER_AGENT,
  getCopilotToken,
  reauthCopilotToken,
} from "../auth/index.js";
import { curlFetch } from "./curlFetch.js";
import { CopilotRequestError } from "./index.js";

export const MODELS_TTL_MS = 5 * 60 * 1000;

export type ModelInfo = {
  id: string;
  name: string;
  vendor: string;
  maxContextWindowTokens: number;
  maxOutputTokens: number;
  maxPromptTokens: number;
  // Which upstream surface serves this model. Most go through /chat/completions;
  // the newest OpenAI models (gpt-5.5, gpt-5.3-codex, gpt-5.4-mini) are only
  // reachable via /responses. The route picks the path off this.
  endpoint: "chat" | "responses";
};

// Raw /models entry, narrowed to the fields we read. Copilot also returns
// embeddings and tool-only models; those lack /chat/completions support and are
// dropped by isChatModel.
type RawModel = {
  id?: string;
  name?: string;
  vendor?: string;
  object?: string;
  supported_endpoints?: string[];
  capabilities?: {
    type?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
    };
  };
};

let fetchImpl: typeof fetch = curlFetch;
let nowMs: () => number = () => Date.now();
export function __setModelsDeps(deps: { fetch?: typeof fetch; now?: () => number }) {
  if (deps.fetch) fetchImpl = deps.fetch;
  if (deps.now) nowMs = deps.now;
}

let cache: { at: number; models: ModelInfo[] } | null = null;
let inflight: Promise<ModelInfo[]> | null = null;

// A model is usable if it serves chat-style turns over EITHER /chat/completions
// OR /responses (the newest OpenAI models are /responses-only). Embeddings and
// other non-chat entries lack both endpoints (and carry object/type markers we
// reject), so they stay filtered out.
function isChatModel(m: RawModel): boolean {
  if (m.object && m.object !== "model") return false;
  if (m.capabilities?.type && m.capabilities.type !== "chat") return false;
  if (!m.id) return false;
  const endpoints = m.supported_endpoints;
  if (!endpoints) return true; // no endpoint list advertised -> assume chat
  return endpoints.includes("/chat/completions") || endpoints.includes("/responses");
}

// Prefer /chat/completions when a model supports it (richer, already-mapped
// path); fall back to /responses for the models that only expose that surface.
function modelEndpoint(m: RawModel): "chat" | "responses" {
  const endpoints = m.supported_endpoints;
  if (!endpoints || endpoints.includes("/chat/completions")) return "chat";
  return "responses";
}

function toModelInfo(m: RawModel): ModelInfo {
  const limits = m.capabilities?.limits ?? {};
  return {
    id: m.id!,
    name: m.name ?? m.id!,
    vendor: m.vendor ?? "",
    maxContextWindowTokens: limits.max_context_window_tokens ?? 0,
    maxOutputTokens: limits.max_output_tokens ?? 0,
    maxPromptTokens: limits.max_prompt_tokens ?? 0,
    endpoint: modelEndpoint(m),
  };
}

async function fetchModels(): Promise<ModelInfo[]> {
  const attempt = async (token: { token: string; endpoint: string }) =>
    fetchImpl(`${token.endpoint}/models`, {
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/json",
        "Editor-Version": EDITOR_VERSION,
        "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
        "Copilot-Integration-Id": "vscode-chat",
        "User-Agent": USER_AGENT,
      },
    });

  let res = await attempt(await getCopilotToken());
  if (res.status === 401) res = await attempt(await reauthCopilotToken());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CopilotRequestError(`models failed: ${res.status} ${res.statusText}`, res.status, text);
  }
  const data = (await res.json()) as { data?: RawModel[] };
  return (data.data ?? []).filter(isChatModel).map(toModelInfo);
}

// Cached list of chat-eligible models. Concurrent callers share one in-flight
// fetch; stale entries refetch after MODELS_TTL_MS.
export async function getModels(): Promise<ModelInfo[]> {
  if (cache && nowMs() - cache.at < MODELS_TTL_MS) return cache.models;
  if (inflight) return inflight;
  inflight = fetchModels()
    .then((models) => {
      cache = { at: nowMs(), models };
      return models;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4-8": "claude-opus-4.8",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
};

function modelCandidates(requested: string): string[] {
  const id = requested.replace(/\[1m\]$/, "");
  const aliased = CLAUDE_MODEL_ALIASES[id];
  return aliased && aliased !== id ? [id, aliased] : [id];
}

// Resolve a requested id to a catalog model. A trailing `[1m]` is Claude Code's
// 1M-context marker (added when we write ANTHROPIC_MODEL), not part of the
// Copilot id — strip it before matching. Claude Code may also send Anthropic
// canonical aliases (`claude-opus-4-8`, dated Haiku ids); Copilot's catalog uses
// dot-style ids (`claude-opus-4.8`), so try those deterministic aliases after an
// exact match. `auto` lets Copilot pick; pass it through. No fuzzy fallback.
export async function resolveModel(requested: string): Promise<ModelInfo | null> {
  const candidates = modelCandidates(requested);
  if (candidates[0] === "auto") return null;
  const models = await getModels();
  return candidates.map((id) => models.find((m) => m.id === id)).find(Boolean) ?? null;
}

export function __resetModelsCache() {
  cache = null;
  inflight = null;
}
