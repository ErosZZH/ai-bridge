# Follow-up: Monitor argument validation and Responses strict mode

Status: proposed compatibility fix; not implemented or verified.

## Symptom

A subagent intermittently reports this error when calling the harness's `Monitor` tool:

```text
InputValidationError: [
  {
    "code": "custom",
    "path": ["ws", "url"],
    "message": "url must be a valid ASCII ws:// or wss:// URL with no userinfo or whitespace"
  },
  {
    "code": "custom",
    "path": [],
    "message": "exactly one of command or ws"
  }
]
```

This is input validation before monitoring starts, not evidence of a failed WebSocket connection.

`Monitor` accepts exactly one source:

- A shell `command`, with `ws` omitted.
- A `ws` object containing a valid WebSocket URL, with `command` omitted.

For example, the following source fields would violate both rules:

```json
{
  "command": "some shell command",
  "ws": { "url": "" }
}
```

This is an illustrative payload, **not a captured failing call**. The actual arguments are still needed to establish what happened.

## Evidence and uncertainty

Inspection of the working tree during this investigation found:

- `sanitizeSchemaForCopilot()` in [`src/convert/request.ts`](../src/convert/request.ts) recursively copies schemas and removes certain unsupported regex patterns. It does not intentionally make optional properties required or insert defaults.
- `mapResponsesTools()` in [`src/convert/responses.ts`](../src/convert/responses.ts) supplies function names, descriptions, and sanitized parameters, but does not set `strict`. The `ResponsesTool` type also has no `strict` field.
- Tool response conversion forwards valid argument objects/fragments without selectively removing unused `command` or `ws` fields.

OpenAI's [function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling) states that Responses requests with `strict` omitted attempt to normalize schemas into strict mode when possible. Strict schemas require all declared properties to be required and object schemas to disallow additional properties. Explicit `strict: false` opts out. Chat Completions defaults to best-effort schema adherence instead.

**Important limitation:** ai-bridge targets GitHub Copilot's API. OpenAI's documented behavior is a compatibility concern, not proof that the selected Copilot endpoint applies identical normalization. We have not captured the failing request's endpoint, tool schema, or generated arguments.

Possible failure chain:

1. The bridge forwards a tool schema with optional, mutually exclusive source fields and no explicit strict-mode setting.
2. The upstream Responses implementation normalizes the schema, making optional fields required.
3. The model supplies both fields, potentially using an empty URL for an unused WebSocket source.
4. The harness rejects the call using its local validation rules.

This chain is a hypothesis. The model could also generate invalid arguments without schema normalization, or the incoming schema could already misrepresent the tool's optional fields. JSON Schema may not expose all constraints enforced by the harness's custom validators.

## Proposed implementation

Explicitly disable strict mode for forwarded Responses function tools so upstream defaults do not silently change optional-field semantics.

In `src/convert/responses.ts`:

1. Extend `ResponsesTool` to represent the `strict` field (for example, `strict?: boolean`).
2. Set `strict: false` in `mapResponsesTools()` for every forwarded function tool.
3. Add a short comment explaining why preserving optional fields requires an explicit opt-out.

Illustrative mapping:

```ts
return tools.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description ?? "",
  parameters: sanitizeSchemaForCopilot(t.input_schema),
  strict: false,
}));
```

Keep this change scoped to the Responses path initially. Do not rewrite every tool schema into strict form, invent defaults, or automatically strip empty/null values from returned arguments. Those values may be meaningful to other tools, and silent argument repair can change the requested operation.

This is a compatibility hardening measure, not a guarantee that models will always produce valid calls.

## Validation plan

- [ ] Capture a failing `Monitor` call: selected upstream endpoint/model, outbound tool definition, and returned tool arguments. Redact credentials, sensitive command text, URL query secrets, and other private data before sharing.
- [ ] Confirm whether optional fields are already marked required in the incoming schema or are filled despite remaining optional.
- [ ] Add a regression test in [`src/convert/responses.test.ts`](../src/convert/responses.test.ts) using a Monitor-like schema with optional `command` and `ws` fields and a required `url` inside `ws` when present.
- [ ] Assert the mapped tool includes `strict: false`, retains the original `required` lists, and adds no defaults or placeholder values.
- [ ] Update exact expected tool objects in existing tests as needed; keep argument pass-through behavior unchanged.
- [ ] Run `npm run typecheck` and `npm test`.
- [ ] Verify that the selected Copilot Responses endpoint accepts `strict: false` and that command-only monitoring can execute without an unwanted `ws` field. A unit test cannot prove upstream behavior.
- [ ] If failures persist, compare captured arguments and schemas before considering any further fix. Do not assume the strict-mode change resolved the original incident.

## Scope of this note

No runtime changes or reproduction tests were performed for this follow-up. The error is confirmed; its precise cause remains unverified. The source observations describe the inspected working tree, which contained unrelated uncommitted changes, so re-check the named functions before implementing.
