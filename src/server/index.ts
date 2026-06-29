import { Hono } from "hono";

import type { Config } from "../config.js";
import type { Logger } from "../obs/index.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerModelRoutes } from "./routes/models.js";

export function createServer(config: Config, logger: Logger): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    logger.debug("request", { method: c.req.method, path: c.req.path });
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok", baseUrl: config.baseUrl }));

  registerModelRoutes(app, logger);
  registerMessageRoutes(app, logger);

  return app;
}
