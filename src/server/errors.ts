// Phase 4: Anthropic-shaped error bodies + Copilot -> HTTP status mapping.
//
// agent-maestro decided "too long" by string-matching a thrown Error message
// (languageModelErrors.ts: `message.includes("Response too long")`) because the
// VS Code LM API hid the real HTTP response. We wrap Copilot directly, so the
// real status is available — Defect A3 is fixed by reading err.status, not text.
//
// Full per-error capture files (the `log_file` field) are task 9; here we just
// shape the body and pick the status. The handlers leave the log_file hook open.
//
// Note (task 11): the harness renders only `error.message` — it does NOT read
// sibling fields like `log_file`/`request_id` out of the error body. The route's
// errorBody() therefore appends both into the message string so they reach the
// user's screen; the structured fields are retained for the session JSONL.

import { CopilotRequestError } from "../copilot/index.js";

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "not_found_error"
  | "api_error";

export type AnthropicErrorBody = {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
};

// The Anthropic error envelope CC expects. `type: "error"` at the top with a
// nested `{ type, message }`.
export function anthropicError(type: AnthropicErrorType, message: string): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

// A context-length / too-long failure, identified by the real HTTP status
// Copilot returned (413 Payload Too Large, or a 400 whose body names the
// context limit) rather than a substring of a generic Error. This is the
// Defect A3 fix.
export function isContextLengthError(err: unknown): err is CopilotRequestError {
  if (!(err instanceof CopilotRequestError)) return false;
  if (err.status === 413) return true;
  if (err.status === 400) {
    return /context|too long|too many tokens|maximum.*length|max_tokens/i.test(err.body);
  }
  return false;
}
