// Task 9 (observability) tests. Cover the four guarantees the spec makes:
// request ids are unique + propagated, creds never reach a log/capture, the
// rolling file actually gets written, the per-error capture holds the real
// exchange and its path comes back as `log_file`, and retention is bounded.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger, newRequestId, pruneOldLogs } from "./index.js";
import { redactString, redactValue } from "./redact.js";
import { writeCapture } from "./capture.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ai-bridge-obs-"));
}

test("redactString masks GitHub tokens, bearers, and token fields", () => {
  assert.equal(redactString("token gho_abcdEFGH1234567890xyz used"), "token [REDACTED] used");
  assert.equal(
    redactString("Authorization: Bearer eyJ.some.jwt-value_here"),
    "Authorization: Bearer [REDACTED]",
  );
  assert.equal(
    redactString('{"oauth_token":"ghu_secretsecretsecret123456"}'),
    '{"oauth_token":"[REDACTED]"}',
  );
  // github_pat_ fine-grained PAT
  assert.match(redactString("github_pat_11ABCDEFG0aaaaaaaaaaaa_bbbbbbbb"), /\[REDACTED\]/);
  // A normal prompt is left untouched.
  assert.equal(redactString("please refactor the auth module"), "please refactor the auth module");
});

test("redactValue deep-scrubs by key name and by value, guarding cycles", () => {
  const obj: Record<string, unknown> = {
    prompt: "keep me",
    headers: { authorization: "Bearer abc.def", "x-trace": "fine" },
    creds: { access_token: "gho_aaaaaaaaaaaaaaaaaaaa" },
  };
  obj.self = obj; // cycle
  const out = redactValue(obj) as typeof obj;
  assert.equal(out.prompt, "keep me");
  assert.equal((out.headers as Record<string, string>).authorization, "[REDACTED]");
  assert.equal((out.headers as Record<string, string>)["x-trace"], "fine");
  assert.equal((out.creds as Record<string, string>).access_token, "[REDACTED]");
});

test("newRequestId is unique and sortable-prefixed", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newRequestId()));
  assert.equal(ids.size, 1000); // no collisions, unlike Date.now()-only ids
  assert.match([...ids][0], /^[a-z0-9]+-[0-9a-f]{8}$/);
});

test("Logger writes a redacted NDJSON line to the rolling file", () => {
  const dir = tmp();
  const logger = new Logger({ level: "debug", dir, fileName: "run-bridge.log" }).child({
    req: "req-123",
  });
  logger.info("hello", { token: "gho_aaaaaaaaaaaaaaaaaaaa", model: "gpt-4o" });

  const contents = readFileSync(join(dir, "run-bridge.log"), "utf8").trim();
  const record = JSON.parse(contents);
  assert.equal(record.level, "info");
  assert.equal(record.req, "req-123");
  assert.equal(record.msg, "hello");
  // The secret-keyed field is gone; the benign one survives.
  assert.equal(record.fields.token, "[REDACTED]");
  assert.equal(record.fields.model, "gpt-4o");
  assert.ok(!contents.includes("gho_aaaa"));
});

test("Logger respects level threshold (debug suppressed at info)", () => {
  const dir = tmp();
  const logger = new Logger({ level: "info", dir, fileName: "lvl-bridge.log" });
  logger.debug("should not appear");
  logger.info("should appear");
  const lines = readFileSync(join(dir, "lvl-bridge.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /should appear/);
});

test("a console-only logger (no dir) writes no file and does not throw", () => {
  const logger = new Logger("error");
  assert.doesNotThrow(() => logger.error("boom", { secret: "gho_aaaaaaaaaaaaaaaaaaaa" }));
});

test("writeCapture dumps the real exchange, redacts creds, returns the path", () => {
  const dir = tmp();
  const err = Object.assign(new Error("chat/completions failed: 400 Bad Request"), {
    name: "CopilotRequestError",
  });
  const path = writeCapture({
    requestId: "req-cap",
    dir,
    maxFiles: 20,
    endpoint: "/v1/messages",
    model: "gpt-4o",
    request: { model: "gpt-4o", messages: [{ role: "user", content: "diagnose me" }] },
    upstreamRequest: {
      model: "gpt-4o",
      headers: { authorization: "Bearer leaky.token.value" },
    },
    upstreamStatus: 400,
    upstreamBody: '{"error":{"message":"prompt too long"}}',
    error: err,
  });

  assert.ok(path && path.startsWith(dir));
  assert.ok(path.endsWith("-error.json"));
  assert.ok(path.includes("req-cap"));

  const dump = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(dump.requestId, "req-cap");
  assert.equal(dump.endpoint, "/v1/messages");
  assert.equal(dump.model, "gpt-4o");
  assert.equal(dump.error.message, "chat/completions failed: 400 Bad Request");
  assert.equal(dump.upstream.status, 400);
  // Prompts are kept (you need them to diagnose)...
  assert.equal(dump.request.messages[0].content, "diagnose me");
  // ...but the credential header is scrubbed.
  assert.equal(dump.upstreamRequest.headers.authorization, "[REDACTED]");
  assert.ok(!readFileSync(path, "utf8").includes("leaky.token.value"));
});

test("pruneOldLogs keeps only the newest N by sortable name", () => {
  const dir = tmp();
  // Names sort lexically by their timestamp prefix; create six, keep three.
  for (const ts of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"]) {
    writeFileSync(join(dir, `${ts}-error.json`), "{}");
  }
  pruneOldLogs(dir, "-error.json", 3);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, ["2026-01-04-error.json", "2026-01-05-error.json", "2026-01-06-error.json"]);
});

test("pruneOldLogs only touches files with the given suffix", () => {
  const dir = tmp();
  writeFileSync(join(dir, "keep-bridge.log"), "x");
  for (const ts of ["2026-01-01", "2026-01-02"]) writeFileSync(join(dir, `${ts}-error.json`), "{}");
  pruneOldLogs(dir, "-error.json", 1);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, ["2026-01-02-error.json", "keep-bridge.log"]);
});
