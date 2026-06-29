import { Hono } from "hono";

import type { Config } from "../config.js";
import { Logger, newRequestId } from "../obs/index.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerModelRoutes } from "./routes/models.js";

// Per-request context the routes read: the request-scoped child logger (its lines
// are tagged with the id) and the id itself (returned in error bodies + the
// x-request-id header, and used to name capture files). Config rides along so the
// error paths know the log dir + retention cap for writing the `log_file`.
export type RequestVars = {
  requestId: string;
  logger: Logger;
  config: Config;
};

export function createServer(config: Config, logger: Logger): Hono<{ Variables: RequestVars }> {
  const app = new Hono<{ Variables: RequestVars }>();

  // Mint one id per inbound request and bind a child logger to it. Everything
  // downstream — request logs, error logs, the capture file, the error body —
  // shares this id, so a user pastes it and we land on their exact request.
  app.use("*", async (c, next) => {
    const requestId = newRequestId();
    const reqLogger = logger.child({ req: requestId });
    c.set("requestId", requestId);
    c.set("logger", reqLogger);
    c.set("config", config);
    c.header("x-request-id", requestId);
    reqLogger.debug("request", { method: c.req.method, path: c.req.path });
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok", baseUrl: config.baseUrl }));

  registerModelRoutes(app);
  registerMessageRoutes(app);

  return app;
}
