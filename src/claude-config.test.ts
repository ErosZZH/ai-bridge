import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_MODEL,
  claudeSettingsPath,
  syncClaudeConnection,
  withClaudeCode1mSuffix,
  writeClaudeSettings,
} from "./claude-config.js";

test("default model matches the Copilot catalog id for Opus 4.8", () => {
  assert.equal(DEFAULT_MODEL, "claude-opus-4.8");
});

test("withClaudeCode1mSuffix tags only in-band windows", () => {
  // in band (800K, 1.5M) -> suffix added
  assert.equal(withClaudeCode1mSuffix("claude-opus-4.8", 936000), "claude-opus-4.8[1m]");
  // below the low edge -> unchanged
  assert.equal(withClaudeCode1mSuffix("claude-opus-4.8", 200000), "claude-opus-4.8");
  // at/above the high edge -> unchanged (future 2M tier gets its own band)
  assert.equal(withClaudeCode1mSuffix("future-huge", 2_000_000), "future-huge");
  // no window known -> unchanged
  assert.equal(withClaudeCode1mSuffix("claude-opus-4.8"), "claude-opus-4.8");
  // already suffixed -> not doubled
  assert.equal(withClaudeCode1mSuffix("gpt-5.5[1m]", 936000), "gpt-5.5[1m]");
});

// Run a body with HOME pointed at a throwaway dir so the real ~/.claude is untouched.
function withTempHome(body: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "ai-bridge-home-"));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    body();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeClaudeSettings writes the three keys and the 1m suffix", () => {
  withTempHome(() => {
    const path = writeClaudeSettings({
      baseUrl: "http://127.0.0.1:11500",
      authToken: "ai-bridge",
      model: "claude-opus-4.8",
      maxInputTokens: 936000,
    });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { env: Record<string, string> };
    assert.equal(onDisk.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11500");
    assert.equal(onDisk.env.ANTHROPIC_AUTH_TOKEN, "ai-bridge");
    assert.equal(onDisk.env.ANTHROPIC_MODEL, "claude-opus-4.8[1m]");
    assert.equal(onDisk.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "936000");
  });
});

test("writeClaudeSettings preserves unrelated top-level and env keys", () => {
  withTempHome(() => {
    const path = claudeSettingsPath();
    // First write creates the file + dir.
    writeClaudeSettings({
      baseUrl: "http://x",
      authToken: "ai-bridge",
      model: "m",
      maxInputTokens: 200000,
    });
    // Inject foreign keys CC owns, then write again — they must survive.
    const seeded = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
      env: Record<string, string>;
    };
    seeded.permissions = { allow: ["Bash"] };
    seeded.enabledPlugins = ["foo"];
    seeded.env.SOME_OTHER_VAR = "keep-me";
    writeFileSync(path, JSON.stringify(seeded, null, 2));

    writeClaudeSettings({
      baseUrl: "http://y",
      authToken: "ai-bridge",
      model: "claude-opus-4.8",
      maxInputTokens: 200000,
    });

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
      env: Record<string, string>;
    };
    assert.deepEqual(onDisk.permissions, { allow: ["Bash"] });
    assert.deepEqual(onDisk.enabledPlugins, ["foo"]);
    assert.equal(onDisk.env.SOME_OTHER_VAR, "keep-me");
    assert.equal(onDisk.env.ANTHROPIC_BASE_URL, "http://y"); // updated
  });
});

test("syncClaudeConnection updates base URL + token but leaves model and window intact", () => {
  withTempHome(() => {
    // Simulate a prior full login at the old port.
    const path = writeClaudeSettings({
      baseUrl: "http://127.0.0.1:11500",
      authToken: "ai-bridge",
      model: "claude-opus-4.8",
      maxInputTokens: 936000,
    });

    // Installer reselects 11501 and reconciles connection-only keys.
    const synced = syncClaudeConnection({
      baseUrl: "http://127.0.0.1:11501",
      authToken: "ai-bridge",
    });
    assert.equal(synced, path);

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { env: Record<string, string> };
    // base URL repointed to the new port...
    assert.equal(onDisk.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11501");
    assert.equal(onDisk.env.ANTHROPIC_AUTH_TOKEN, "ai-bridge");
    // ...while the model + auto-compact window from login survive untouched.
    assert.equal(onDisk.env.ANTHROPIC_MODEL, "claude-opus-4.8[1m]");
    assert.equal(onDisk.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "936000");
  });
});

test("syncClaudeConnection preserves unrelated top-level and env keys", () => {
  withTempHome(() => {
    const path = claudeSettingsPath();
    writeClaudeSettings({
      baseUrl: "http://127.0.0.1:11500",
      authToken: "ai-bridge",
      model: "claude-opus-4.8",
      maxInputTokens: 200000,
    });
    const seeded = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
      env: Record<string, string>;
    };
    seeded.permissions = { defaultMode: "bypassPermissions" };
    seeded.model = "opus[1m]";
    seeded.env.SOME_OTHER_VAR = "keep-me";
    writeFileSync(path, JSON.stringify(seeded, null, 2));

    syncClaudeConnection({ baseUrl: "http://127.0.0.1:11501", authToken: "ai-bridge" });

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
      env: Record<string, string>;
    };
    assert.deepEqual(onDisk.permissions, { defaultMode: "bypassPermissions" });
    assert.equal(onDisk.model, "opus[1m]");
    assert.equal(onDisk.env.SOME_OTHER_VAR, "keep-me");
    assert.equal(onDisk.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11501");
  });
});

test("syncClaudeConnection creates settings.json when none exists yet", () => {
  withTempHome(() => {
    const path = syncClaudeConnection({
      baseUrl: "http://127.0.0.1:11501",
      authToken: "ai-bridge",
    });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { env: Record<string, string> };
    assert.equal(onDisk.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11501");
    assert.equal(onDisk.env.ANTHROPIC_AUTH_TOKEN, "ai-bridge");
    // No model written yet — a later `ai-bridge login` fills it in.
    assert.equal(onDisk.env.ANTHROPIC_MODEL, undefined);
  });
});
