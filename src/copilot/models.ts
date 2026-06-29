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
import { CopilotRequestError } from "./index.js";

export const MODELS_TTL_MS = 5 * 60 * 1000;

export type ModelInfo = {
  id: string;
  name: string;
  vendor: string;
  maxContextWindowTokens: number;
  maxOutputTokens: number;
  maxPromptTokens: number;
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

let fetchImpl: typeof fetch = fetch;
let nowMs: () => number = () => Date.now();
export function __setModelsDeps(deps: { fetch?: typeof fetch; now?: () => number }) {
  if (deps.fetch) fetchImpl = deps.fetch;
  if (deps.now) nowMs = deps.now;
}

let cache: { at: number; models: ModelInfo[] } | null = null;
let inflight: Promise<ModelInfo[]> | null = null;

function isChatModel(m: RawModel): boolean {
  if (m.object && m.object !== "model") return false;
  if (m.capabilities?.type && m.capabilities.type !== "chat") return false;
  if (m.supported_endpoints && !m.supported_endpoints.includes("/chat/completions")) return false;
  return Boolean(m.id);
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

// Resolve a requested id to a catalog model. `auto` lets Copilot pick — pass it
// through unchanged. Anything else must match exactly; no fuzzy fallback.
export async function resolveModel(requested: string): Promise<ModelInfo | null> {
  if (requested === "auto") return null;
  const models = await getModels();
  return models.find((m) => m.id === requested) ?? null;
}

export function __resetModelsCache() {
  cache = null;
  inflight = null;
}
