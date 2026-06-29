import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const numericString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const EnvSchema = z.object({
  AI_BRIDGE_PORT: numericString(11500),
  AI_BRIDGE_HOST: z.string().default("127.0.0.1"),
  AI_BRIDGE_LOG_DIR: z.string().default(join(homedir(), ".ai-bridge", "logs")),
  AI_BRIDGE_LOG_LEVEL: z.enum(["debug", "info", "error"]).default("info"),
  // How many rolling debug logs + per-error capture files to keep before the
  // oldest are pruned. Bounds disk use; payloads are large (full bodies at debug).
  AI_BRIDGE_LOG_MAX_FILES: numericString(20),
});

export type Config = {
  host: string;
  port: number;
  logDir: string;
  logLevel: "debug" | "info" | "error";
  logMaxFiles: number;
  baseUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    host: parsed.AI_BRIDGE_HOST,
    port: parsed.AI_BRIDGE_PORT,
    logDir: parsed.AI_BRIDGE_LOG_DIR,
    logLevel: parsed.AI_BRIDGE_LOG_LEVEL,
    logMaxFiles: parsed.AI_BRIDGE_LOG_MAX_FILES,
    baseUrl: `http://${parsed.AI_BRIDGE_HOST}:${parsed.AI_BRIDGE_PORT}`,
  };
}
