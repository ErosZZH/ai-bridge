// Phase 2: Copilot HTTP client. POSTs OpenAI-shaped chat/completions to the
// per-account endpoint from token exchange, streaming and non-streaming.
// Translation between Anthropic and OpenAI lives in convert/ (tasks 6-7); this
// layer speaks raw OpenAI both ways. Usage is parsed including cache fields so
// the bridge can report exact reads (the whole reason we go direct, not via the
// VS Code LM API). On 401 the bearer is re-exchanged once and the call retried.

import {
  CopilotAuthError,
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
  USER_AGENT,
  getCopilotToken,
  reauthCopilotToken,
} from "../auth/index.js";
import { copilotFetch } from "./copilotFetch.js";

// Exact-as-returned usage. Cache fields are optional — Copilot only sends them
// when cache_control breakpoints actually hit, but when present they are the
// real reads, not an estimate.
export type CopilotUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
};

export type ChatCompletion = {
  id: string;
  choices: unknown[];
  usage?: CopilotUsage;
  [k: string]: unknown;
};

// One parsed `data:` line from the SSE stream. usage arrives on a trailing
// chunk whose choices array is empty.
export type ChatCompletionChunk = {
  id?: string;
  choices?: unknown[];
  usage?: CopilotUsage;
  [k: string]: unknown;
};

export class CopilotRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "CopilotRequestError";
  }
}

// Test seam, mirroring auth/__setAuthDeps. Lets the stream/401 logic be unit
// tested without disk creds or a live endpoint. Production default is the impit
// transport (copilotFetch) — undici/native TLS is fingerprint-blocked from Claude
// by the Copilot edge; see copilot/copilotFetch.ts.
let fetchImpl: typeof fetch = copilotFetch;
export function __setCopilotDeps(deps: { fetch?: typeof fetch }) {
  if (deps.fetch) fetchImpl = deps.fetch;
}

async function send(
  body: Record<string, unknown>,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const attempt = async (token: { token: string; endpoint: string }) =>
    fetchImpl(`${token.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "Editor-Version": EDITOR_VERSION,
        "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
        "Copilot-Integration-Id": "vscode-chat",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ ...body, stream }),
      signal,
    });

  let res = await attempt(await getCopilotToken());
  if (res.status === 401) {
    res = await attempt(await reauthCopilotToken());
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CopilotRequestError(
      `chat/completions failed: ${res.status} ${res.statusText}`,
      res.status,
      text,
    );
  }
  return res;
}

export async function chatCompletion(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ChatCompletion> {
  const res = await send(body, false, signal);
  return (await res.json()) as ChatCompletion;
}

// Yield each OpenAI chunk as it arrives; `[DONE]` ends the stream. Buffering is
// line-based so a chunk split across reads is reassembled before parsing.
export async function* streamChatCompletion(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<ChatCompletionChunk> {
  const res = await send(body, true, signal);
  if (!res.body) throw new CopilotRequestError("stream response had no body", res.status, "");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      if (payload) yield JSON.parse(payload) as ChatCompletionChunk;
    }
  }
}

export { CopilotAuthError };
