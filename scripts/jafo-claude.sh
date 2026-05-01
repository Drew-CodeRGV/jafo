#!/usr/bin/env bash
#
# jafo-claude — Launch Claude Code in the jafo project with the right env.
#
# Usage:
#   jafo-claude          # interactive session
#   jafo-claude -p "..."  # one-shot prompt mode
#
# Sources ~/jafo/.env so ANTHROPIC_API_KEY is available, then runs `claude`
# in the jafo directory so CLAUDE.md and HANDOFF.md are auto-loaded as
# project context.
#
# Tip: symlink this into your PATH for shorter invocation:
#   ln -s ~/jafo/scripts/jafo-claude.sh ~/.npm-global/bin/jafo-claude
#

set -euo pipefail

JAFO_DIR="${JAFO_DIR:-/home/pi/jafo}"
ENV_FILE="$JAFO_DIR/.env"

if [[ ! -d "$JAFO_DIR" ]]; then
  echo "jafo dir not found at $JAFO_DIR" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Warning: ANTHROPIC_API_KEY not set. Claude Code will prompt for browser login." >&2
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed. Run: bash ~/jafo/scripts/install-claude-code.sh" >&2
  exit 1
fi

cd "$JAFO_DIR"
exec claude "$@"
