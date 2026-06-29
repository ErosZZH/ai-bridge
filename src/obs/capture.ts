// Task 9 (observability): the per-error capture file — the `log_file` the spec
// (and agent-maestro's handleErrorWithLogging) returns in the error body.
//
// Because ai-bridge wraps Copilot directly, the *real* exchange is capturable:
// the inbound Anthropic request, the exact body we mapped and sent to Copilot,
// and Copilot's actual error status + response body — none of which agent-maestro
// could see behind the VS Code LM API. We dump all of it, keyed by the same
// request id that tags the logs and rides in the error envelope, so the user
// pastes one id and gets the log line, the capture file, and the upstream truth.
//
// Prompts are KEPT here (you cannot diagnose a bad request without seeing it);
// only creds are scrubbed, via the shared redactor. The file is written under the
// configured log dir and pruned to the retention cap.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { pruneOldLogs, timestamp } from "./index.js";
import { redactValue } from "./redact.js";

const CAPTURE_SUFFIX = "-error.json";

export type CaptureContext = {
  requestId: string;
  dir: string;
  maxFiles: number;
  endpoint: string;
  model?: string;
  // The inbound Anthropic request, verbatim (pre-mapping).
  request?: unknown;
  // The OpenAI/Responses body we actually sent to Copilot, post-mapping.
  upstreamRequest?: unknown;
  // Copilot's HTTP status + raw response body, when the failure came from the
  // upstream call (CopilotRequestError carries both).
  upstreamStatus?: number;
  upstreamBody?: string;
  error: unknown;
};

// Write one capture file and return its absolute path, or undefined if the write
// itself fails (logging must never mask the original error). Caller puts the path
// into the error body's `log_file`.
export function writeCapture(ctx: CaptureContext): string | undefined {
  const fileName = `${timestamp()}-${ctx.requestId}${CAPTURE_SUFFIX}`;
  const filePath = join(ctx.dir, fileName);

  const err = ctx.error;
  const payload = {
    timestamp: new Date().toISOString(),
    requestId: ctx.requestId,
    endpoint: ctx.endpoint,
    model: ctx.model,
    error: {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
    upstream:
      ctx.upstreamStatus !== undefined || ctx.upstreamBody !== undefined
        ? { status: ctx.upstreamStatus, body: ctx.upstreamBody }
        : undefined,
    request: ctx.request,
    upstreamRequest: ctx.upstreamRequest,
  };

  try {
    writeFileSync(filePath, JSON.stringify(redactValue(payload), null, 2) + "\n");
    pruneOldLogs(ctx.dir, CAPTURE_SUFFIX, ctx.maxFiles);
    return filePath;
  } catch {
    return undefined;
  }
}
