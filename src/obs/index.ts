import { mkdirSync } from "node:fs";

export type LogLevel = "debug" | "info" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, error: 30 };

export function ensureLogDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class Logger {
  constructor(private readonly level: LogLevel) {}

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line = fields ? `${msg} ${JSON.stringify(fields)}` : msg;
    (level === "error" ? console.error : console.log)(`[ai-bridge] ${line}`);
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
