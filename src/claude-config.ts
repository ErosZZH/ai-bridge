// Writes the connection config Claude Code reads at launch into the `env` block
// of ~/.claude/settings.json — base URL, auth sentinel, and selected model. This
// is the "config file" the user picks instead of exporting env vars by hand.
// Follows agent-maestro's configurator: merge into existing settings (never
// clobber permissions/plugins/etc.) and tag wide-context models with [1m] so CC
// turns on its 1M path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The auth header value the bridge expects; it ignores the actual token (the
// real credential is the Copilot bearer it holds), so any stable sentinel works.
export const AUTH_TOKEN_VALUE = "ai-bridge";

// Default model written on `ai-bridge login`. This must match the exact Copilot
// catalog id shown by `ai-bridge model`; Claude Code's [1m] suffix (if
// applicable) is applied by withClaudeCode1mSuffix at write time.
export const DEFAULT_MODEL = "claude-opus-4.8";

const CLAUDE_MODEL_1M_SUFFIX = "[1m]";
// Band edges (not hard caps) bracketing real 1M models, which advertise
// ~900K–1M input tokens. Future 2M+ tiers get their own band rather than
// widening this one. Ported from agent-maestro/src/utils/claude.ts.
const CLAUDE_CODE_1M_BAND_LOW = 800_000;
const CLAUDE_CODE_1M_BAND_HIGH = 1_500_000;

// Append [1m] to models advertising a roughly 1M-token input window so Claude
// Code enables its 1M path for both Claude and non-Claude backends.
export function withClaudeCode1mSuffix(modelId: string, maxInputTokens?: number): string {
  if (
    modelId.endsWith(CLAUDE_MODEL_1M_SUFFIX) ||
    !maxInputTokens ||
    maxInputTokens <= CLAUDE_CODE_1M_BAND_LOW ||
    maxInputTokens >= CLAUDE_CODE_1M_BAND_HIGH
  ) {
    return modelId;
  }
  return `${modelId}${CLAUDE_MODEL_1M_SUFFIX}`;
}

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

type ClaudeSettings = {
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type ClaudeSettingsInput = {
  baseUrl: string;
  authToken: string;
  model: string;
  maxInputTokens?: number;
};

// Merge the three connection keys into ~/.claude/settings.json's env block,
// preserving every other key already there. Returns the path written.
export function writeClaudeSettings(input: ClaudeSettingsInput): string {
  const path = claudeSettingsPath();

  let settings: ClaudeSettings = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") settings = parsed as ClaudeSettings;
    } catch {
      // malformed settings — overwrite rather than fail the command
    }
  }

  settings.env = {
    ...settings.env,
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_AUTH_TOKEN: input.authToken,
    ANTHROPIC_MODEL: withClaudeCode1mSuffix(input.model, input.maxInputTokens),
  };
  // CC sizes its auto-compaction window off this; agent-maestro sets it to the
  // model's input ceiling. Only set when we actually know the window.
  if (input.maxInputTokens) {
    settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(input.maxInputTokens);
  }

  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}
