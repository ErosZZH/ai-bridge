import { serve } from "@hono/node-server";

import { getCopilotToken, getGitHubToken } from "./auth/index.js";
import { loadConfig } from "./config.js";
import { Logger, ensureLogDir } from "./obs/index.js";
import { createServer } from "./server/index.js";

async function main() {
  const config = loadConfig();
  ensureLogDir(config.logDir);
  const logger = new Logger(config.logLevel);

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
      "no GitHub Copilot credentials found; sign in via VS Code Copilot or `gh copilot`, then restart",
    );
  }

  const app = createServer(config, logger);

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    logger.info(`listening on ${config.baseUrl}`);
    logger.info(`logs: ${config.logDir}`);
    logger.info("point Claude Code here:");
    logger.info(`  export ANTHROPIC_BASE_URL=${config.baseUrl}`);
    logger.info("  export ANTHROPIC_AUTH_TOKEN=ai-bridge");
  });
}

main().catch((err) => {
  console.error("[ai-bridge] fatal:", err);
  process.exit(1);
});
