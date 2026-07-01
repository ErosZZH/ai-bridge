import { createInterface } from "node:readline/promises";

import { getCopilotToken, getGitHubToken, loginWithDeviceFlow } from "./auth/index.js";
import {
  AUTH_TOKEN_VALUE,
  DEFAULT_MODEL,
  syncClaudeConnection,
  withClaudeCode1mSuffix,
  writeClaudeSettings,
} from "./claude-config.js";
import { loadConfig, makeBaseUrl } from "./config.js";
import { getModels, resolveModel } from "./copilot/models.js";
import { Logger, ensureLogDir, pruneOldLogs } from "./obs/index.js";
import { teardownBrowser } from "./search/ddg.js";
import { createServer } from "./server/index.js";
import { listenWithFallback } from "./server/listen.js";

// `ai-bridge login` runs the interactive GitHub device flow, writes the default
// model + connection config into ~/.claude/settings.json, and exits without
// starting the server.
async function login() {
  const config = loadConfig();
  const token = await loginWithDeviceFlow();

  // Resolve the default model against the live catalog to learn its real input
  // window (drives the [1m] suffix + auto-compact sizing). Best-effort: if the
  // account's catalog lacks it, still write the id so CC is wired.
  const info = await resolveModel(DEFAULT_MODEL).catch(() => null);
  const path = writeClaudeSettings({
    baseUrl: config.baseUrl,
    authToken: AUTH_TOKEN_VALUE,
    model: DEFAULT_MODEL,
    maxInputTokens: info?.maxPromptTokens || info?.maxContextWindowTokens,
  });

  console.log(`Signed in as ${token.user}.`);
  console.log(`Wrote ${path} (model: ${withClaudeCode1mSuffix(DEFAULT_MODEL, info?.maxPromptTokens || info?.maxContextWindowTokens)}).`);
  console.log("Run `ai-bridge model` to choose a different model, or start the bridge with no arguments.");
}

// `ai-bridge model` lists the Copilot catalog and persists the chosen model into
// ~/.claude/settings.json. Each row shows the display name and the real id used
// in code.
async function selectModel() {
  const config = loadConfig();
  const models = await getModels();
  if (models.length === 0) {
    console.error("No models available. Run `ai-bridge login` first (or check your Copilot access).");
    process.exit(1);
  }

  console.log("Available models:");
  models.forEach((m, i) => {
    const ctx = m.maxPromptTokens || m.maxContextWindowTokens;
    const ctxLabel = ctx ? `${Math.round(ctx / 1000)}k ctx` : "ctx unknown";
    console.log(`  ${String(i + 1).padStart(2)}) ${m.name}  [${m.id}]  (${ctxLabel})`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let chosen;
  try {
    while (true) {
      const answer = (await rl.question(`Select a model [1-${models.length}]: `)).trim();
      const idx = Number(answer) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < models.length) {
        chosen = models[idx];
        break;
      }
      console.log("Invalid selection, try again.");
    }
  } finally {
    rl.close();
  }

  const path = writeClaudeSettings({
    baseUrl: config.baseUrl,
    authToken: AUTH_TOKEN_VALUE,
    model: chosen.id,
    maxInputTokens: chosen.maxPromptTokens || chosen.maxContextWindowTokens,
  });
  console.log(`Selected ${chosen.name} (${chosen.id}).`);
  console.log(`Wrote ${path}. Restart Claude Code for the change to take effect.`);
}

// `ai-bridge sync-config` reconciles ~/.claude/settings.json's base URL + auth
// token with the port this install is configured for (AI_BRIDGE_PORT, baked in
// by the installer), without touching the model or contacting the network. The
// installer runs it on every install so a dynamically reselected port always
// reaches Claude Code — even on re-installs where `login` is skipped because
// Copilot creds already exist (the bug where settings.json kept a stale port).
function syncConfig() {
  const config = loadConfig();
  const path = syncClaudeConnection({
    baseUrl: config.baseUrl,
    authToken: AUTH_TOKEN_VALUE,
  });
  console.log(`Reconciled ${path} -> ANTHROPIC_BASE_URL=${config.baseUrl}.`);
}

async function main() {
  const config = loadConfig();
  ensureLogDir(config.logDir);
  pruneOldLogs(config.logDir, "-bridge.log", config.logMaxFiles);
  const logger = new Logger({ level: config.logLevel, dir: config.logDir });

  const auth = getGitHubToken();
  if (auth) {
    logger.info(`using GitHub Copilot credentials for ${auth.user}`);
    try {
      const token = await getCopilotToken();
      logger.info(`Copilot session valid until ${new Date(token.expiresAt * 1000).toISOString()}`);
    } catch (err) {
      logger.error(`Copilot token exchange failed: ${(err as Error).message}`);
    }
  } else {
    logger.info(
      "no GitHub Copilot credentials found; run `ai-bridge login` to sign in",
    );
  }

  const app = createServer(config, logger);

  // Bind the port the server can ACTUALLY hold right now, scanning forward from
  // the configured one. The installer pre-probes a free port too, but that check
  // can go stale before the Scheduled Task binds at logon (e.g. a WSL guest grabs
  // it in between) — only the live listen() result is authoritative.
  const startPort = config.port;
  const { port } = await listenWithFallback(
    app.fetch,
    config.host,
    startPort,
    50,
    (busy) => logger.info(`port ${busy} in use; trying ${busy + 1}`),
  );

  // Pin config to what we actually bound, so every downstream reader of
  // config.baseUrl/config.port (e.g. the /health route) reports the live port
  // rather than the configured guess.
  config.port = port;
  config.baseUrl = makeBaseUrl(config.host, port);

  // Reconcile ~/.claude/settings.json to the port we actually bound, so Claude
  // Code's ANTHROPIC_BASE_URL always matches the live server — this is what
  // closes the ConnectionRefused drift when the bound port differs from the one
  // the installer wrote. Connection keys only; model/window are left untouched.
  // Best-effort: a settings write failure must not take the server down.
  try {
    const settingsPath = syncClaudeConnection({ baseUrl: config.baseUrl, authToken: AUTH_TOKEN_VALUE });
    if (port !== startPort) {
      logger.info(`bound port ${port} != configured ${startPort}; rewrote ${settingsPath} -> ${config.baseUrl}`);
    }
  } catch (err) {
    logger.error(`could not reconcile ~/.claude/settings.json: ${(err as Error).message}`);
  }

  logger.info(`listening on ${config.baseUrl}`);
  logger.info(`logs: ${config.logDir}`);
  logger.info("Claude Code config lives in ~/.claude/settings.json");
  logger.info("  run `ai-bridge login` to wire it, or `ai-bridge model` to change model");

  // Reclaim the headless search browser on shutdown so a stopped/restarted
  // service never leaves an orphaned Chrome behind. Best-effort and idempotent.
  const shutdown = () => {
    void teardownBrowser();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("beforeExit", shutdown);
}

const command = process.argv[2];
const run =
  command === "login"
    ? login
    : command === "model"
      ? selectModel
      : command === "sync-config"
        ? async () => syncConfig()
        : main;

run().catch((err) => {
  console.error("[ai-bridge] fatal:", err);
  process.exit(1);
});
