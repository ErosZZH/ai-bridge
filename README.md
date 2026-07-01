# ai-bridge

A standalone bridge that lets the **Claude Code** harness talk to the **GitHub Copilot** API. It runs a small local HTTP server that speaks the Anthropic Messages API on the front and forwards to Copilot on the back, so you can drive Claude Code (and Copilot's other models) using your existing GitHub Copilot subscription.

## Prerequisites

- **Node.js >= 22** (`node -v`)
- An active **GitHub Copilot** subscription
- **Claude Code** installed (`claude`)

## Install

The installer builds the release output, registers ai-bridge as an auto-starting / auto-restarting background service, and adds an `ai-bridge` command to your PATH.

### Linux / macOS

```bash
cd ai-bridge
./install.sh
```

- **Linux** — installs a per-user **systemd** unit (`systemctl --user`) and enables *linger* so the service survives logout and starts at boot. No `sudo` required.
- **macOS** — installs a per-user **LaunchAgent** that loads at login and is kept alive.

### Windows

```powershell
cd ai-bridge
.\install.ps1
```

Registers a **Scheduled Task** that starts ai-bridge at logon and restarts it on failure (runs in your user session — no administrator required). Open a new terminal afterwards so the `ai-bridge` command resolves.

> The service runs from this checkout in place, using the `dist/` build the installer produces. If you later upgrade or switch your Node.js version, re-run the installer so the service points at the new `node`.

## First run

```bash
ai-bridge login     # GitHub device-flow sign-in to Copilot
ai-bridge model     # optional: pick a model (default: claude-opus-4.8)
claude              # use Claude Code as usual
```

`ai-bridge login` runs the GitHub device flow: it prints a code and a URL, you authorize in the browser, and the token is saved. It then writes the connection settings into `~/.claude/settings.json` so Claude Code points at the bridge automatically — no environment variables to export.

`ai-bridge model` lists the Copilot catalog and persists your choice into the same settings file. Restart Claude Code after changing the model.

## How it wires Claude Code

`login` / `model` merge an `env` block into `~/.claude/settings.json`:

| Key | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:11500` |
| `ANTHROPIC_AUTH_TOKEN` | `ai-bridge` (sentinel — the real credential is the Copilot token the bridge holds) |
| `ANTHROPIC_MODEL` | the selected model (a `[1m]` suffix is added for ~1M-context models) |

Other keys in `settings.json` (permissions, plugins, …) are preserved.

## Verify it's running

The bridge listens on `http://127.0.0.1:11500`.

```bash
curl -s http://127.0.0.1:11500/health
# -> {"status":"ok","baseUrl":"http://127.0.0.1:11500"}
```

## Managing the service

**Linux (systemd):**

```bash
systemctl --user status ai-bridge      # status
systemctl --user stop    ai-bridge      # stop
systemctl --user start   ai-bridge      # start
journalctl --user -u ai-bridge -f       # follow service output
```

**macOS (LaunchAgent):**

```bash
launchctl list | grep com.ai-bridge.server          # status
launchctl unload -w ~/Library/LaunchAgents/com.ai-bridge.server.plist   # stop
launchctl load   -w ~/Library/LaunchAgents/com.ai-bridge.server.plist   # start
```

**Windows (Scheduled Task):**

```powershell
Get-ScheduledTask   -TaskName ai-bridge    # status
Stop-ScheduledTask  -TaskName ai-bridge    # stop
Start-ScheduledTask -TaskName ai-bridge    # start
```

Application logs (all platforms) are written to `~/.ai-bridge/logs`.

## Configuration

Set these in the `env` block of `~/.claude/settings.json` (or as real environment variables for the service):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_BRIDGE_PORT` | `11500` | Port the bridge listens on |
| `AI_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `AI_BRIDGE_LOG_DIR` | `~/.ai-bridge/logs` | Log directory |
| `AI_BRIDGE_LOG_LEVEL` | `info` | `debug` \| `info` \| `error` (`debug` logs full bodies) |
| `AI_BRIDGE_LOG_MAX_FILES` | `20` | Rolling log files to keep before pruning |
| `AI_BRIDGE_SEARCH_ENABLED` | `1` | Enable WebSearch support (`0`/`false` disables) |
| `AI_BRIDGE_SEARCH_MAX_RESULTS` | `8` | Max results returned per search |
| `AI_BRIDGE_SEARCH_MAX_USES` | `8` | Max searches per WebSearch call |
| `AI_BRIDGE_SEARCH_IDLE_MS` | `30000` | Idle time before the search browser is torn down |
| `AI_BRIDGE_SEARCH_NAV_TIMEOUT_MS` | `15000` | Per-search page navigation timeout |
| `AI_BRIDGE_SEARCH_PROXY` | *(shared proxy)* | Proxy for search only; defaults to the service proxy, `none` forces direct |

> If you change `AI_BRIDGE_PORT` / `AI_BRIDGE_HOST`, re-run `ai-bridge login` (or `model`) so `ANTHROPIC_BASE_URL` is rewritten to match.

## WebSearch

Claude Code's **WebSearch** tool is an Anthropic *server-side* tool: the harness expects the
backend to run the searches and return the results inline. Copilot's API has no equivalent, so
the bridge runs the search itself. It intercepts the tool, drives a Copilot tool-loop to reproduce
Anthropic's search behavior, and executes each query against **DuckDuckGo** using a headless
**Google Chrome** (via `playwright-core`, driving your system-installed Chrome — no browser is
downloaded). Results are returned as the exact `server_tool_use` / `web_search_tool_result` blocks
Claude Code expects, so answers still end with a **Sources:** section.

- **No API key required.** Search runs through your existing Chrome install.
- **Proxy-aware.** Search reuses the same proxy the service already routes through (the installer
  bakes `HTTPS_PROXY`/`HTTP_PROXY` into the unit; override search alone with `AI_BRIDGE_SEARCH_PROXY`,
  or set it to `none` for a direct connection). Machines without a proxy connect directly.
- **Lightweight.** The browser launches lazily on the first search, is reused across the searches in
  a call, and is torn down after `AI_BRIDGE_SEARCH_IDLE_MS` of inactivity.
- Requires Google Chrome on the machine. If Chrome can't launch, the search returns an error result
  and Claude Code still answers (without sources) rather than failing the request. Set
  `AI_BRIDGE_SEARCH_ENABLED=0` to disable interception entirely.

## Uninstall

```bash
./install.sh uninstall      # Linux / macOS
```

```powershell
.\install.ps1 -Uninstall    # Windows
```

This stops and removes the service and the `ai-bridge` CLI wrapper. Your build output (`dist/`) and Claude Code config (`~/.claude/settings.json`) are left untouched.

## Development

```bash
npm run dev        # run from source with tsx (no build)
npm run build      # compile TypeScript to dist/
npm test           # run the test suite
npm run typecheck  # type-check only
```

`ai-bridge login` and `ai-bridge model` map to the same CLI entry point; during development run them with `npm run dev -- login` / `npm run dev -- model`.
