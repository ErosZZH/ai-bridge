#!/usr/bin/env bash
#
# install.sh — install ai-bridge as an auto-starting, auto-restarting service.
#
#   Linux  : a per-user systemd unit (systemctl --user) + linger so it survives
#            logout and starts at boot. No root required.
#   macOS  : a per-user LaunchAgent (~/Library/LaunchAgents) that loads at login
#            and is kept alive. No root required.
#
# It builds the release output (npm run build -> dist/), runs the service from
# this checkout in place, and installs an `ai-bridge` CLI wrapper on PATH so you
# can run `ai-bridge login` / `ai-bridge model` interactively.
#
# Usage:
#   ./install.sh            install (build + register + start)
#   ./install.sh uninstall  stop, disable, and remove the service + wrapper
#
set -euo pipefail

# --- locations ---------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_DIR="$SCRIPT_DIR"
DIST_ENTRY="$REPO_DIR/dist/index.js"

SERVICE_NAME="ai-bridge"
BIN_DIR="$HOME/.local/bin"
WRAPPER="$BIN_DIR/ai-bridge"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/${SERVICE_NAME}.service"

PLIST_LABEL="com.ai-bridge.server"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$HOME/.ai-bridge/logs"

OS="$(uname -s)"

# --- pretty output -----------------------------------------------------------
info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- proxy detection ---------------------------------------------------------
# The service runs without a login shell, so it does NOT inherit the proxy you
# have exported interactively. On some networks GitHub Copilot only serves
# certain models (e.g. Claude) when traffic exits through a proxy, so a missing
# proxy silently strips those models from the catalog. Detect the proxy now and
# bake it into the unit. Override with AI_BRIDGE_PROXY=... ; disable with
# AI_BRIDGE_PROXY=none.
PROXY_URL=""
NO_PROXY_VAL=""
detect_proxy() {
  if [ "${AI_BRIDGE_PROXY:-}" = "none" ]; then
    info "proxy detection disabled (AI_BRIDGE_PROXY=none)"
    return
  fi
  PROXY_URL="${AI_BRIDGE_PROXY:-${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}}"
  NO_PROXY_VAL="${NO_PROXY:-${no_proxy:-localhost,127.0.0.0/8,::1}}"

  if [ -n "$PROXY_URL" ]; then
    info "detected proxy $PROXY_URL — baking it into the service env"
  else
    info "no proxy detected in env; service will connect directly"
    warn "if Copilot withholds models (e.g. Claude) without a proxy, re-run with:
    AI_BRIDGE_PROXY=http://host:port ./install.sh"
  fi
}

# =============================================================================
# credential detection + pre-start login
# =============================================================================
# The service mints short-lived Copilot bearer tokens from a long-lived GitHub
# oauth_token on disk (apps.json/hosts.json, written by VS Code Copilot, gh, or
# our own `ai-bridge login`). If that token is absent the service starts but
# answers 401 to every request — and because it caches the empty credential set
# at startup, a later `ai-bridge login` won't recover until the service is
# restarted. So sign in BEFORE registering the service. Mirrors
# findCopilotConfigDirs()/readGitHubTokens() in src/auth/index.ts.
copilot_creds_present() {
  local dirs=() dir f path
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then dirs+=("$XDG_CONFIG_HOME/github-copilot"); fi
  dirs+=("$HOME/.config/github-copilot")
  for dir in "${dirs[@]}"; do
    for f in apps.json hosts.json; do
      path="$dir/$f"
      [ -f "$path" ] || continue
      if grep -Eq '"oauth_token"[[:space:]]*:[[:space:]]*"[^"]' "$path" 2>/dev/null; then
        return 0
      fi
    done
  done
  return 1
}

# Sign in before the service starts. Skips when usable creds already exist (the
# oauth_token is long-lived and the bearer auto-refreshes). Non-fatal: on failure
# the install continues with a warning.
ensure_login() {
  local node_bin="$1"
  if copilot_creds_present; then
    info "GitHub Copilot credentials already present — skipping login"
    return
  fi
  info "no GitHub Copilot credentials found; starting sign-in before the service launches"
  if "$node_bin" "$DIST_ENTRY" login; then
    info "GitHub Copilot sign-in complete"
  else
    warn "sign-in did not complete; the service will start but return 401 until you run:
    ai-bridge login
    then restart the service (see 'Manage the service' below)."
  fi
}

# =============================================================================
# uninstall
# =============================================================================
uninstall() {
  case "$OS" in
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now "${SERVICE_NAME}.service" 2>/dev/null || true
      fi
      rm -f "$UNIT_FILE"
      systemctl --user daemon-reload 2>/dev/null || true
      info "removed systemd unit $UNIT_FILE"
      ;;
    Darwin)
      launchctl unload -w "$PLIST_FILE" 2>/dev/null || true
      rm -f "$PLIST_FILE"
      info "removed LaunchAgent $PLIST_FILE"
      ;;
    *)
      warn "unsupported OS '$OS' — only removing the CLI wrapper"
      ;;
  esac
  rm -f "$WRAPPER"
  info "removed CLI wrapper $WRAPPER"
  info "ai-bridge uninstalled. (Build output in dist/ and config in ~/.claude were left in place.)"
}

# =============================================================================
# preflight: node >= 22 and npm
# =============================================================================
preflight() {
  command -v node >/dev/null 2>&1 || die "node not found on PATH. Install Node.js >= 22 first."
  command -v npm  >/dev/null 2>&1 || die "npm not found on PATH. Install Node.js >= 22 first."

  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 22 ]; then
    die "Node.js >= 22 required, found $(node -v). Upgrade Node and re-run."
  fi
  info "using $(node -v) at $(command -v node)"
}

# =============================================================================
# release build
# =============================================================================
build() {
  info "installing dependencies"
  ( cd "$REPO_DIR" && { npm ci || npm install; } )

  info "building release output (npm run build)"
  ( cd "$REPO_DIR" && npm run build )

  [ -f "$DIST_ENTRY" ] || die "build did not produce $DIST_ENTRY"
  info "built $DIST_ENTRY"
}

# =============================================================================
# CLI wrapper on PATH
# =============================================================================
install_wrapper() {
  local node_bin="$1"
  mkdir -p "$BIN_DIR"
  cat >"$WRAPPER" <<EOF
#!/usr/bin/env bash
# ai-bridge CLI wrapper (generated by install.sh). Runs the release build.
exec "$node_bin" "$DIST_ENTRY" "\$@"
EOF
  chmod +x "$WRAPPER"
  info "installed CLI wrapper at $WRAPPER"

  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:
    export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
}

# =============================================================================
# Linux: systemd --user unit
# =============================================================================
install_systemd() {
  local node_bin="$1"
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found; this Linux install path requires systemd."

  # Proxy lines in systemd `Environment=` form, or empty when no proxy is in use.
  local proxy_env=""
  if [ -n "$PROXY_URL" ]; then
    proxy_env="Environment=HTTPS_PROXY=$PROXY_URL
Environment=HTTP_PROXY=$PROXY_URL
Environment=NO_PROXY=$NO_PROXY_VAL"
  fi

  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=ai-bridge — Claude Code to GitHub Copilot bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$node_bin $DIST_ENTRY
WorkingDirectory=$REPO_DIR
Environment=NODE_ENV=production
$proxy_env
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  info "wrote systemd unit $UNIT_FILE"

  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.service"

  # Start at boot without an active login session. Needs no sudo on most
  # distros; non-fatal if it is not permitted.
  if loginctl enable-linger "$USER" 2>/dev/null; then
    info "enabled linger for $USER (service starts at boot)"
  else
    warn "could not enable linger; the service will start on your next login instead.
    To enable boot start: sudo loginctl enable-linger $USER"
  fi

  info "service status:"
  systemctl --user --no-pager --lines=0 status "${SERVICE_NAME}.service" || true
}

# =============================================================================
# macOS: LaunchAgent
# =============================================================================
install_launchd() {
  local node_bin="$1"
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

  # Proxy entries as plist <key>/<string> pairs, or empty when no proxy is in use.
  local proxy_env=""
  if [ -n "$PROXY_URL" ]; then
    proxy_env="        <key>HTTPS_PROXY</key>
        <string>$PROXY_URL</string>
        <key>HTTP_PROXY</key>
        <string>$PROXY_URL</string>
        <key>NO_PROXY</key>
        <string>$NO_PROXY_VAL</string>"
  fi

  cat >"$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node_bin</string>
        <string>$DIST_ENTRY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
$proxy_env
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/launchd.err.log</string>
</dict>
</plist>
EOF
  info "wrote LaunchAgent $PLIST_FILE"

  launchctl unload -w "$PLIST_FILE" 2>/dev/null || true
  launchctl load -w "$PLIST_FILE"
  info "loaded LaunchAgent $PLIST_LABEL"
}

# =============================================================================
# main
# =============================================================================
main() {
  if [ "${1:-}" = "uninstall" ] || [ "${1:-}" = "--uninstall" ]; then
    uninstall
    return
  fi

  preflight
  build
  detect_proxy

  local node_bin
  node_bin="$(command -v node)"

  install_wrapper "$node_bin"

  # Sign in before registering the service. A service started without creds
  # caches the empty credential set and answers 401 until restarted, so a later
  # login alone would not recover it.
  ensure_login "$node_bin"

  case "$OS" in
    Linux)  install_systemd "$node_bin" ;;
    Darwin) install_launchd "$node_bin" ;;
    *)      die "unsupported OS '$OS'. install.sh supports Linux and macOS; use install.ps1 on Windows." ;;
  esac

  cat <<EOF

$(info "ai-bridge installed and running at http://127.0.0.1:11500")

Next steps:
  1. (optional) re-run sign-in:    ai-bridge login   (only if the service 401s)
  2. (optional) pick a model:      ai-bridge model
  3. Run Claude Code as usual:     claude

Manage the service:
EOF
  case "$OS" in
    Linux)
      cat <<EOF
  status:  systemctl --user status $SERVICE_NAME
  stop:    systemctl --user stop $SERVICE_NAME
  start:   systemctl --user start $SERVICE_NAME
  logs:    journalctl --user -u $SERVICE_NAME -f   (app logs: $LOG_DIR)
  remove:  ./install.sh uninstall
EOF
      ;;
    Darwin)
      cat <<EOF
  status:  launchctl list | grep $PLIST_LABEL
  stop:    launchctl unload -w $PLIST_FILE
  start:   launchctl load -w $PLIST_FILE
  logs:    tail -f $LOG_DIR/launchd.err.log   (app logs: $LOG_DIR)
  remove:  ./install.sh uninstall
EOF
      ;;
  esac
}

main "$@"
