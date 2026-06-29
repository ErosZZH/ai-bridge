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
  type ResponsesRequest,
  type ResponsesResponse,
  mapRequestToResponses,
  mapResponsesResponse,
  streamResponsesResponse,
} from "../../convert/index.js";
import {
  CopilotAuthError,
  CopilotRequestError,
  chatCompletion,
  streamChatCompletion,
} from "../../copilot/index.js";
import { responsesCompletion, streamResponsesCompletion } from "../../copilot/responses.js";
import { type ModelInfo, resolveModel } from "../../copilot/models.js";
import { writeCapture } from "../../obs/capture.js";
import type { RequestVars } from "../index.js";
import { type AnthropicErrorType, anthropicError, isContextLengthError } from "../errors.js";
import { countInputTokens } from "../tokens.js";

type Ctx = Context<{ Variables: RequestVars }>;

// What each error path needs to write a capture file and a tagged error body:
// the request id, where to write, the inbound + mapped bodies, and the model.
type ErrorScope = {
  endpoint: string;
  model?: string;
  request?: unknown;
  upstreamRequest?: unknown;
};

// Floor used only for `auto`/unknown ids, where no catalog max_output_tokens is
// known. Catalog-backed models get their own per-model ceiling (info.maxOutputTokens).
const DEFAULT_MAX_TOKENS_FLOOR = 32000;

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

export function registerMessageRoutes(app: {
  post: (path: string, handler: (c: Ctx) => Promise<Response>) => unknown;
}): void {
  app.post("/v1/messages", (c) => handleMessages(c));
  app.post("/v1/messages/count_tokens", (c) => handleCountTokens(c));
}

// Default the output cap to "as much as possible" for this model when the client
// omits max_tokens. Gemini/GPT-5 burn output budget on internal reasoning, so a
// missing/small cap silently truncates the visible answer; the catalog's
// max_output_tokens is the real ceiling. Returns a body with max_tokens set.
function withDefaultBudget(body: InboundRequest, info: ModelInfo | null): InboundRequest {
  if (body.max_tokens !== undefined) return body;
  const fallback = info?.maxOutputTokens || DEFAULT_MAX_TOKENS_FLOOR;
  return { ...body, max_tokens: fallback };
}

async function handleMessages(c: Ctx): Promise<Response> {
  const logger = c.get("logger");
  let raw: InboundRequest;
  try {
    raw = parseBody(await c.req.json());
  } catch {
    return c.json(anthropicError("invalid_request_error", "request body is not valid JSON"), 400);
  }

  const { info, isAuto } = await resolve(raw.model).catch(() => ({ info: null, isAuto: false }));
  if (!info && !isAuto) {
    return c.json(anthropicError("not_found_error", `model '${raw.model}' not found`), 404);
  }

  const body = withDefaultBudget(raw, info);
  const signal = c.req.raw.signal;
  const scope: ErrorScope = { endpoint: "/v1/messages", model: body.model, request: raw };

  // Newest OpenAI models are reachable only via the Responses API; everything
  // else (and `auto`) takes the chat/completions path.
  if (info?.endpoint === "responses") {
    const req = mapRequestToResponses(body);
    scope.upstreamRequest = req;
    return body.stream
      ? streamResponsesMessages(c, req, body.model, signal, scope)
      : completeResponses(c, req, body.model, signal, scope);
  }

  const openai = mapRequest(body);
  scope.upstreamRequest = openai;
  if (body.stream) {
    return streamMessages(c, openai, body.model, signal, scope);
  }

  try {
    const res = (await chatCompletion(openai, signal)) as unknown as OpenAIResponse;
    const mapped = mapResponse(res);
    logger.info("/v1/messages", {
      model: body.model,
      in: mapped.usage.input_tokens,
      out: mapped.usage.output_tokens,
      cache_read: mapped.usage.cache_read_input_tokens,
      status: 200,
    });
    return c.json(mapped);
  } catch (err) {
    return errorResponse(c, err, scope);
  }
}

// Non-stream Responses path: call /responses, map the output[] body back to an
// Anthropic Message. Errors classify the same way as the chat path.
async function completeResponses(
  c: Ctx,
  req: ResponsesRequest,
  model: string,
  signal: AbortSignal,
  scope: ErrorScope,
): Promise<Response> {
  try {
    const res = (await responsesCompletion(req, signal)) as ResponsesResponse;
    const mapped = mapResponsesResponse(res);
    c.get("logger").info("/v1/messages (responses)", {
      model,
      in: mapped.usage.input_tokens,
      out: mapped.usage.output_tokens,
      cache_read: mapped.usage.cache_read_input_tokens,
      status: 200,
    });
    return c.json(mapped);
  } catch (err) {
    return errorResponse(c, err, scope);
  }
}

// Streaming path. The Copilot client yields OpenAI chunks; streamResponse turns
// them into Anthropic SSE events; we write each as `event:`/`data:` framing the
// harness's SDK parser consumes. The fetch carries the request's abort signal,
// so a client disconnect tears down the upstream stream; we also stop quietly if
// the signal trips mid-iteration.
function streamMessages(
  c: Ctx,
  openai: OpenAIRequest,
  model: string,
  signal: AbortSignal,
  scope: ErrorScope,
): Response {
  const logger = c.get("logger");
  return streamSSE(
    c,
    async (sse) => {
      const chunks = streamChatCompletion(openai, signal) as AsyncIterable<OpenAIStreamChunk>;
      try {
        for await (const event of streamResponse(chunks, model)) {
          if (signal.aborted) break;
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        logger.info("/v1/messages (stream) done", { model, status: 200 });
      } catch (err) {
        if (signal.aborted) return; // client went away — nothing to report
        await writeErrorEvent(c, sse, err, scope);
      }
    },
    async (err, sse) => {
      if (signal.aborted) return;
      await writeErrorEvent(c, sse, err, scope);
    },
  );
}

// Streaming Responses path: the /responses client yields semantic events;
// streamResponsesResponse turns them into the same Anthropic SSE lifecycle the
// harness consumes. Abort handling matches the chat stream.
function streamResponsesMessages(
  c: Ctx,
  req: ResponsesRequest,
  model: string,
  signal: AbortSignal,
  scope: ErrorScope,
): Response {
  const logger = c.get("logger");
  return streamSSE(
    c,
    async (sse) => {
      const events = streamResponsesCompletion(req, signal);
      try {
        for await (const event of streamResponsesResponse(events as never, model)) {
          if (signal.aborted) break;
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        logger.info("/v1/messages (stream, responses) done", { model, status: 200 });
      } catch (err) {
        if (signal.aborted) return;
        await writeErrorEvent(c, sse, err, scope);
      }
    },
    async (err, sse) => {
      if (signal.aborted) return;
      await writeErrorEvent(c, sse, err, scope);
    },
  );
}

// Mid-stream failures can't change the HTTP status (headers are already sent),
// so we surface them as an SSE `error` event, which the harness recognizes. We
// still write a capture file and fold its path + the request id into the error
// body, so a streamed failure is just as diagnosable as a non-streamed one.
async function writeErrorEvent(
  c: Ctx,
  sse: { writeSSE: (m: { event: string; data: string }) => Promise<void> },
  err: unknown,
  scope: ErrorScope,
): Promise<void> {
  const { type, message } = classify(err);
  const logFile = capture(c, err, scope);
  c.get("logger").error("/v1/messages (stream) failed", { message, log_file: logFile });
  await sse.writeSSE({
    event: "error",
    data: JSON.stringify(errorBody(c, type, message, logFile)),
  });
}

async function handleCountTokens(c: Ctx): Promise<Response> {
  const logger = c.get("logger");
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
  logger.debug("/v1/messages/count_tokens", { model: body.model, input_tokens });
  return c.json({ input_tokens });
}

// Write the per-error capture file for this request and return its path (or
// undefined if the write failed). Pulls the request id + log dir + retention cap
// off the request context, so every error path captures identically.
function capture(c: Ctx, err: unknown, scope: ErrorScope): string | undefined {
  const config = c.get("config");
  const upstream = err instanceof CopilotRequestError ? err : undefined;
  return writeCapture({
    requestId: c.get("requestId"),
    dir: config.logDir,
    maxFiles: config.logMaxFiles,
    endpoint: scope.endpoint,
    model: scope.model,
    request: scope.request,
    upstreamRequest: scope.upstreamRequest,
    upstreamStatus: upstream?.status,
    upstreamBody: upstream?.body,
    error: err,
  });
}

// Anthropic error envelope carrying the request id + capture path.
//
// The harness only ever RENDERS `error.message` (sourcemap
// errorUtils.ts:formatAPIError → SystemAPIErrorMessage.tsx:59); it ignores any
// sibling fields. So to make the capture file reachable on screen we must fold
// the id + path INTO the message string. The structured `request_id`/`log_file`
// fields are kept too — they survive into the session JSONL for programmatic
// readers — but the message suffix is what the user actually sees.
function errorBody(c: Ctx, type: AnthropicErrorType, message: string, logFile?: string) {
  const requestId = c.get("requestId");
  const suffix = logFile
    ? ` (request_id: ${requestId}, log_file: ${logFile})`
    : ` (request_id: ${requestId})`;
  const body = anthropicError(type, message + suffix);
  return {
    ...body,
    error: { ...body.error, request_id: requestId, log_file: logFile },
  };
}

// Map a thrown error to its Anthropic type + HTTP status, write the capture file,
// and return the tagged error body. Context-length is checked first (Defect A3:
// off the real status), then auth, then any other Copilot HTTP error keeps its
// status, and everything else is a 500.
function errorResponse(c: Ctx, err: unknown, scope: ErrorScope): Response {
  const { type, message, status } = classify(err);
  const logFile = capture(c, err, scope);
  c.get("logger").error("/v1/messages failed", { status, message, log_file: logFile });
  return c.json(errorBody(c, type, message, logFile), status as 400 | 401 | 404 | 500);
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
