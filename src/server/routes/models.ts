// Phase 4: the Anthropic /v1/models surface. Lists the Copilot chat catalog
// (copilot/models.ts, already TTL-cached and filtered to chat-eligible ids) in
// the Anthropic models shape the harness expects. agent-maestro built the same
// envelope from VS Code's model list; we build it from Copilot's /models. The
// harness mainly reads `id` and `max_input_tokens`, so we keep the object minimal.

import type { Context } from "hono";

import { type ModelInfo, getModels, resolveModel } from "../../copilot/models.js";
import type { RequestVars } from "../index.js";
import { anthropicError } from "../errors.js";

type Ctx = Context<{ Variables: RequestVars }>;

const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00Z";

type AnthropicModel = {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
};

type AnthropicModelsList = {
  data: AnthropicModel[];
  first_id: string | null;
  has_more: boolean;
  last_id: string | null;
};

// One catalog entry -> the Anthropic model object. Window is the prompt limit
// (what bounds input), falling back to the full context window when the catalog
// doesn't split them out.
function toAnthropicModel(m: ModelInfo): AnthropicModel {
  return {
    type: "model",
    id: m.id,
    display_name: m.name,
    created_at: UNKNOWN_CREATED_AT,
    max_input_tokens: m.maxPromptTokens || m.maxContextWindowTokens,
  };
}

function toList(models: ModelInfo[]): AnthropicModelsList {
  const data = models.map(toAnthropicModel);
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
  };
}

export function registerModelRoutes(app: {
  get: (path: string, handler: (c: Ctx) => Promise<Response>) => unknown;
}): void {
  app.get("/v1/models", (c) => listModels(c));
  app.get("/v1/models/:model_id", (c) => getModel(c));
}

async function listModels(c: Ctx): Promise<Response> {
  try {
    const models = await getModels();
    c.get("logger").debug("/v1/models", { count: models.length });
    return c.json(toList(models));
  } catch (err) {
    return modelError(c, err);
  }
}

async function getModel(c: Ctx): Promise<Response> {
  const id = c.req.param("model_id") ?? "";
  try {
    // resolveModel strips Claude Code's `[1m]` context marker before matching,
    // so a configured ANTHROPIC_MODEL like `claude-opus-4.8[1m]` resolves to the
    // bare catalog id instead of 404ing (the harness probes this route at startup
    // to validate the selected model).
    const model = await resolveModel(id);
    if (!model) {
      return c.json(anthropicError("not_found_error", `model '${id}' not found`), 404);
    }
    return c.json(toAnthropicModel(model));
  } catch (err) {
    return modelError(c, err);
  }
}

function modelError(c: Ctx, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  c.get("logger").error("/v1/models failed", { message });
  return c.json(anthropicError("api_error", message), 500);
}
