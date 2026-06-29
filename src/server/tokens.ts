// Phase 4: input-token counting for POST /v1/messages/count_tokens. This is a
// SIZING HINT only — the harness uses it to decide when to compact, and the
// exact accounting still comes back in every response's `usage` (convert layer,
// task 7). So we bias toward "count high so the harness compacts before the
// window fills" rather than chasing exactness on every vendor.
//
// Copilot serves three model families, each with a different real tokenizer:
//  - GPT    -> gpt-tokenizer (o200k_base), exact, fully bundled, zero deps.
//  - Gemini -> @google/genai LocalTokenizer, the exact SentencePiece tokenizer.
//             Its vocab is fetched once from raw.githubusercontent.com and then
//             cached under os.tmpdir(); after that, counting is fully offline.
//  - Claude -> char/3.5. The Claude Code sourcemap has no offline Claude BPE
//             (its only local counter is roughTokenCountEstimation = char/4);
//             3.5 rounds up vs that, the safe direction for a compaction hint.
//
// Any tokenizer failure (e.g. a Gemini cold start with no network) falls back
// to the char/3.5 estimate so the endpoint never errors.

import { encode } from "gpt-tokenizer/encoding/o200k_base";

import type { OpenAIContentPart, OpenAIRequest } from "../convert/index.js";

const CLAUDE_BYTES_PER_TOKEN = 3.5;

// Rough estimate, mirroring the harness's roughTokenCountEstimation but with a
// tighter divisor so the result rounds up. The universal fallback.
function roughCount(text: string): number {
  return Math.round(text.length / CLAUDE_BYTES_PER_TOKEN);
}

// Flatten the mapped OpenAI body to the text that actually gets sent: system +
// every message's textual content, plus tool-call names/arguments. Images are
// counted by their reference string only (we do not tokenize base64 payloads —
// neither does the model in the same way, and it would wildly inflate the hint).
function requestText(req: OpenAIRequest): string {
  const parts: string[] = [];
  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) parts.push(partText(part));
    }
    for (const call of msg.tool_calls ?? []) {
      parts.push(call.function.name, call.function.arguments);
    }
  }
  for (const tool of req.tools ?? []) {
    parts.push(tool.function.name, tool.function.description);
  }
  return parts.join("\n");
}

function partText(part: OpenAIContentPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image_url":
      return part.image_url.url;
    case "thinking":
      return part.thinking;
    case "redacted_thinking":
      return part.data;
  }
}

// Gemini tokenizers are keyed by model id and memoized — constructing one may
// fetch the vocab, so we never build the same one twice. The import is lazy so
// GPT/Claude requests never load @google/genai at all.
type GeminiTokenizer = { countTokens(text: string): Promise<{ totalTokens?: number }> };
const geminiByModel = new Map<string, Promise<GeminiTokenizer>>();

async function geminiTokenizer(model: string): Promise<GeminiTokenizer> {
  let pending = geminiByModel.get(model);
  if (!pending) {
    pending = import("@google/genai/tokenizer").then(
      ({ LocalTokenizer }) => new LocalTokenizer(model) as GeminiTokenizer,
    );
    geminiByModel.set(model, pending);
  }
  return pending;
}

// Coarse vendor classification from the catalog's `vendor` string (and the id
// as a fallback, since some catalogs leave vendor blank). Only three buckets
// matter; anything unrecognized takes the rough path.
type Family = "gpt" | "gemini" | "claude" | "other";
function family(vendor: string, model: string): Family {
  const v = `${vendor} ${model}`.toLowerCase();
  if (v.includes("gemini") || v.includes("google")) return "gemini";
  if (v.includes("claude") || v.includes("anthropic")) return "claude";
  if (v.includes("gpt") || v.includes("openai") || v.includes("o1") || v.includes("o3")) {
    return "gpt";
  }
  return "other";
}

// Count input tokens for the mapped request, routed by model family. `vendor`
// comes from the resolved ModelInfo; `model` is the requested id (used for the
// Gemini tokenizer and as a vendor fallback). Always resolves to a number.
export async function countInputTokens(
  req: OpenAIRequest,
  vendor: string,
  model: string,
): Promise<number> {
  const text = requestText(req);
  if (!text) return 0;

  try {
    switch (family(vendor, model)) {
      case "gpt":
        return encode(text).length;
      case "gemini": {
        const tok = await geminiTokenizer(model);
        const { totalTokens } = await tok.countTokens(text);
        return totalTokens ?? roughCount(text);
      }
      default:
        return roughCount(text);
    }
  } catch {
    return roughCount(text);
  }
}

export function __resetTokenizers() {
  geminiByModel.clear();
}
