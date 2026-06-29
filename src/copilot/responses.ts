// Copilot HTTP client for the **Responses API** (/responses), the sibling of
// index.ts's /chat/completions client. Same transport (curlFetch — the Copilot
// edge fingerprint-gates Node's native TLS), same headers, same exchange-once-on
// -401 retry. The only differences are the path and that the streaming events are
// the Responses semantic events (response.output_text.delta, response.completed,
// ...), which the route hands to convert/responses.ts. Non-stream returns the raw
// Responses body; the stream yields each parsed `data:` event object.

import {
  EDITOR_PLUGIN_VERSION,
  EDITOR_VERSION,
  USER_AGENT,
  getCopilotToken,
  reauthCopilotToken,
} from "../auth/index.js";
import { curlFetch } from "./curlFetch.js";
import { CopilotRequestError } from "./index.js";

// One parsed `data:` line from the Responses SSE stream. The discriminating
// `type` field (e.g. "response.output_text.delta") plus whatever payload that
// event carries; convert/responses.ts reads the fields it needs.
export type ResponsesStreamEvent = {
  type?: string;
  [k: string]: unknown;
};

let fetchImpl: typeof fetch = curlFetch;
// Test seam, mirroring __setCopilotDeps. Lets the stream/401 logic be exercised
// without disk creds or a live endpoint.
export function __setResponsesDeps(deps: { fetch?: typeof fetch }) {
  if (deps.fetch) fetchImpl = deps.fetch;
}

async function send(body: Record<string, unknown>, stream: boolean): Promise<Response> {
  const attempt = async (token: { token: string; endpoint: string }) =>
    fetchImpl(`${token.endpoint}/responses`, {
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
    });

  let res = await attempt(await getCopilotToken());
  if (res.status === 401) {
    res = await attempt(await reauthCopilotToken());
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CopilotRequestError(
      `responses failed: ${res.status} ${res.statusText}`,
      res.status,
      text,
    );
  }
  return res;
}

export async function responsesCompletion(
  body: Record<string, unknown>,
  _signal?: AbortSignal,
): Promise<unknown> {
  const res = await send(body, false);
  return res.json();
}

// Yield each Responses SSE event as it arrives. Buffering is line-based so an
// event split across reads is reassembled before parsing; `event:` lines are
// ignored (the payload's own `type` field is authoritative). `[DONE]` — if the
// edge ever sends one — ends the stream.
export async function* streamResponsesCompletion(
  body: Record<string, unknown>,
  _signal?: AbortSignal,
): AsyncGenerator<ResponsesStreamEvent> {
  const res = await send(body, true);
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
      if (payload) yield JSON.parse(payload) as ResponsesStreamEvent;
    }
  }
}
