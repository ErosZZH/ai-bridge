// Task 9 (observability). The logger is the spine of "find the log fast, and it
// holds enough to diagnose" (Req #6):
//
//  - Request IDs. Every inbound request mints one (server middleware); the child
//    logger tags every line with it and the error body returns it, so a user
//    pastes the id and we grep straight to their request. Random suffix, not
//    Date.now() — that collision was an agent-maestro defect (anthropicRoutes
//    :460,513). The same id seeds the per-error capture filename (obs/capture.ts).
//  - A file sink. Lines go to console AND a rolling NDJSON file in the configured
//    dir (printed at startup), so logs survive after the terminal scrolls away.
//    Previously ensureLogDir created a dir nothing was ever written to.
//  - Redaction. Every line is scrubbed of creds (obs/redact.ts) before it leaves
//    the process — prompts stay (you need them), tokens never do.
//  - Levels. info = one line per request (id, model, in/out, status); debug =
//    full bodies; error = also writes a capture file.

import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { redactString } from "./redact.js";

export type LogLevel = "debug" | "info" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, error: 30 };

export function ensureLogDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A short, collision-resistant id: time-ordered prefix (so files sort by age)
// plus a random tail (so two requests in the same millisecond never clash — the
// exact failure mode of the Date.now()-only ids we replace).
export function newRequestId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

// Keep at most `maxFiles` entries matching `suffix` in `dir`, deleting the
// oldest. Names start with a sortable timestamp, so lexical order == age order.
// Best-effort: a prune failure must never break a request.
export function pruneOldLogs(dir: string, suffix: string, maxFiles: number): void {
  if (maxFiles <= 0) return;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(suffix))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - maxFiles))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    // dir may not exist yet, or be unreadable — nothing to prune.
  }
}

export type LoggerOptions = {
  level: LogLevel;
  dir?: string;
  // Filename for the rolling log; one per process run so a session's lines stay
  // together. Defaults to a timestamped name when a dir is given.
  fileName?: string;
};

export class Logger {
  private readonly level: LogLevel;
  private readonly dir?: string;
  private readonly filePath?: string;
  // Tags carried onto every line (request id, and anything a child binds).
  private readonly tags: Record<string, string>;

  constructor(options: LogLevel | LoggerOptions, tags: Record<string, string> = {}) {
    const opts: LoggerOptions = typeof options === "string" ? { level: options } : options;
    this.level = opts.level;
    this.dir = opts.dir;
    this.tags = tags;
    if (opts.dir) {
      const name = opts.fileName ?? `${timestamp()}-bridge.log`;
      this.filePath = join(opts.dir, name);
    }
  }

  // Bind extra tags (typically `{ req: <id> }`) for the lifetime of one request.
  // Shares the parent's sink and level, so child lines land in the same file.
  child(tags: Record<string, string>): Logger {
    const clone = Object.create(Logger.prototype) as Logger;
    Object.assign(clone, this, { tags: { ...this.tags, ...tags } });
    return clone;
  }

  get logDir(): string | undefined {
    return this.dir;
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[this.level]) return;

    const safeMsg = redactString(msg);
    // Console line shows tags + fields together for at-a-glance reading; the file
    // record keeps tags at top level (the `req` field) and fields separate, so
    // they aren't duplicated.
    const merged = { ...this.tags, ...(fields ?? {}) };
    const hasMerged = Object.keys(merged).length > 0;
    const prefix = this.tags.req ? `[ai-bridge ${this.tags.req}]` : "[ai-bridge]";
    const line = hasMerged ? `${safeMsg} ${redactString(JSON.stringify(merged))}` : safeMsg;
    (level === "error" ? console.error : console.log)(`${prefix} ${line}`);

    this.writeFile(level, safeMsg, fields);
  }

  // NDJSON to the rolling file: one JSON object per line, easy to grep/`jq`.
  // Synchronous append keeps lines ordered without a write queue; failures are
  // swallowed so logging never takes down the bridge.
  private writeFile(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (!this.filePath) return;
    const hasFields = fields !== undefined && Object.keys(fields).length > 0;
    const record = {
      ts: new Date().toISOString(),
      level,
      ...this.tags,
      msg,
      ...(hasFields ? { fields: redactValueShallow(fields) } : {}),
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(record) + "\n");
    } catch {
      // disk full / permission — already echoed to console; drop silently.
    }
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.emit("info", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.emit("error", msg, fields);
  }
}

// The file record already had its string values scrubbed at the call site via
// redactString on the message; for the structured `fields` we scrub by stringify
// round-trip so token-shaped values inside are caught too.
function redactValueShallow(fields: Record<string, unknown>): unknown {
  try {
    return JSON.parse(redactString(JSON.stringify(fields)));
  } catch {
    return fields;
  }
}

// Filesystem-safe sortable timestamp: YYYY-MM-DD_HH-MM-SS-mmm, matching the
// agent-maestro capture-file convention so the two are visually consistent.
export function timestamp(): string {
  const iso = new Date().toISOString(); // 2026-06-30T01:23:45.678Z
  return iso.slice(0, 23).replace("T", "_").replace(/:/g, "-").replace(".", "-");
}
