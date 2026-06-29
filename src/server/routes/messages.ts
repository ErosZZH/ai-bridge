// Phase 4: the Anthropic /v1/messages surface. Resolve the model against the
// live Copilot catalog, map Anthropic -> OpenAI (convert/), call the Copilot
// client (copilot/), map the answer back, and stream or return it. The defect
// fixes from tasks 5-7 reach the wire here: exact usage, stable ids, faithful
// cache forwarding, plus the two this route owns — too-long via real HTTP status
// (Defect A3, server/errors.ts) and abort on client disconnect (Defect B, via
// c.req.raw.signal), neither of which agent-maestro could do through the LM API.

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import {
  type AnthropicRequest,
  type OpenAIRequest,
  mapRequest,
  mapResponse,
  streamResponse,
  type OpenAIResponse,
  type OpenAIStreamChunk,
} from "../../convert/index.js";
import {
  CopilotAuthError,
  CopilotRequestError,
  chatCompletion,
  streamChatCompletion,
} from "../../copilot/index.js";
import { resolveModel } from "../../copilot/models.js";
import type { Logger } from "../../obs/index.js";
import { type AnthropicErrorType, anthropicError, isContextLengthError } from "../errors.js";
import { countInputTokens } from "../tokens.js";

// Resolve the requested id to a catalog entry. `auto` is the explicit
// passthrough sentinel (resolveModel returns null) — we forward `model` as-is
// and let Copilot pick. A null for any other id means "unknown", which is a hard
// 404 (no Jaccard fuzzy fallback — the task-5 fix).
async function resolve(model: string) {
  const info = await resolveModel(model);
  return { info, isAuto: model === "auto" };
}

// The inbound body is the Anthropic request plus `stream` (which the convert
// layer omits, since streaming is the client's concern, not the body's). The
// route reads `stream` to choose the path but never forwards it through mapping.
type InboundRequest = AnthropicRequest & { stream?: boolean };

// Body is forwarded verbatim, exactly as agent-maestro deliberately skipped
// schema validation so upstream API drift doesn't break the bridge. The convert
// layer only reads the fields it maps and tolerates extras.
function parseBody(raw: unknown): InboundRequest {
  return raw as InboundRequest;
}

export function registerMessageRoutes(
  app: { post: (path: string, handler: (c: Context) => Promise<Response>) => unknown },
  logger: Logger,
): void {
  app.post("/v1/messages", (c) => handleMessages(c, logger));
  app.post("/v1/messages/count_tokens", (c) => handleCountTokens(c, logger));
}

async function handleMessages(c: Context, logger: Logger): Promise<Response> {
  let body: InboundRequest;
  try {
    body = parseBody(await c.req.json());
  } catch {
    return c.json(anthropicError("invalid_request_error", "request body is not valid JSON"), 400);
  }

  const { info, isAuto } = await resolve(body.model).catch(() => ({ info: null, isAuto: false }));
  if (!info && !isAuto) {
    return c.json(anthropicError("not_found_error", `model '${body.model}' not found`), 404);
  }

  const openai = mapRequest(body);
  const signal = c.req.raw.signal;

  if (body.stream) {
    return streamMessages(c, openai, body.model, signal, logger);
  }

  try {
    const res = (await chatCompletion(openai, signal)) as unknown as OpenAIResponse;
    const mapped = mapResponse(res);
    logger.info(
      `/v1/messages ${body.model} in=${mapped.usage.input_tokens} out=${mapped.usage.output_tokens} cache_read=${mapped.usage.cache_read_input_tokens}`,
    );
    return c.json(mapped);
  } catch (err) {
    return errorResponse(c, err, logger);
  }
}

// Streaming path. The Copilot client yields OpenAI chunks; streamResponse turns
// them into Anthropic SSE events; we write each as `event:`/`data:` framing the
// harness's SDK parser consumes. The fetch carries the request's abort signal,
// so a client disconnect tears down the upstream stream; we also stop quietly if
// the signal trips mid-iteration.
function streamMessages(
  c: Context,
  openai: OpenAIRequest,
  model: string,
  signal: AbortSignal,
  logger: Logger,
): Response {
  return streamSSE(
    c,
    async (sse) => {
      const chunks = streamChatCompletion(openai, signal) as AsyncIterable<OpenAIStreamChunk>;
      try {
        for await (const event of streamResponse(chunks, model)) {
          if (signal.aborted) break;
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        logger.info(`/v1/messages (stream) ${model} done`);
      } catch (err) {
        if (signal.aborted) return; // client went away — nothing to report
        await writeErrorEvent(sse, err, model, logger);
      }
    },
    async (err, sse) => {
      if (signal.aborted) return;
      await writeErrorEvent(sse, err, model, logger);
    },
  );
}

// Mid-stream failures can't change the HTTP status (headers are already sent),
// so we surface them as an SSE `error` event, which the harness recognizes.
async function writeErrorEvent(
  sse: { writeSSE: (m: { event: string; data: string }) => Promise<void> },
  err: unknown,
  model: string,
  logger: Logger,
): Promise<void> {
  const { type, message } = classify(err);
  logger.error(`/v1/messages (stream) ${model} failed: ${message}`);
  await sse.writeSSE({ event: "error", data: JSON.stringify(anthropicError(type, message)) });
}

async function handleCountTokens(c: Context, logger: Logger): Promise<Response> {
  let body: InboundRequest;
  try {
    body = parseBody(await c.req.json());
  } catch {
    return c.json(anthropicError("invalid_request_error", "request body is not valid JSON"), 400);
  }

  const { info, isAuto } = await resolve(body.model).catch(() => ({ info: null, isAuto: false }));
  if (!info && !isAuto) {
    return c.json(anthropicError("not_found_error", `model '${body.model}' not found`), 404);
  }

  const openai = mapRequest(body);
  const input_tokens = await countInputTokens(openai, info?.vendor ?? "", body.model);
  logger.debug(`/v1/messages/count_tokens ${body.model} -> ${input_tokens}`);
  return c.json({ input_tokens });
}

// Map a thrown error to its Anthropic type + HTTP status. Context-length is
// checked first (Defect A3: off the real status), then auth, then any other
// Copilot HTTP error keeps its status, and everything else is a 500.
function errorResponse(c: Context, err: unknown, logger: Logger): Response {
  const { type, message, status } = classify(err);
  logger.error(`/v1/messages failed (${status}): ${message}`);
  return c.json(anthropicError(type, message), status as 400 | 401 | 404 | 500);
}

function classify(err: unknown): {
  type: AnthropicErrorType;
  message: string;
  status: number;
} {
  if (isContextLengthError(err)) {
    return { type: "invalid_request_error", message: err.message, status: 400 };
  }
  if (err instanceof CopilotAuthError) {
    return { type: "authentication_error", message: err.message, status: 401 };
  }
  if (err instanceof CopilotRequestError) {
    const status = err.status >= 500 ? 500 : err.status;
    return { type: "api_error", message: err.message, status };
  }
  return { type: "api_error", message: err instanceof Error ? err.message : String(err), status: 500 };
}
