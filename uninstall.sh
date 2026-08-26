#!/usr/bin/env bash
#
# uninstall.sh — stop and remove the ai-bridge service and CLI wrapper.
#
# Build output in dist/ and Claude Code config in ~/.claude are left untouched.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
exec "$SCRIPT_DIR/install.sh" uninstall
