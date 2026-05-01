#!/usr/bin/env bash
#
# install-claude-code.sh — Set up Claude Code on the jafo Pi.
#
# Pi-aware: uses the npm method with a user-prefix (no sudo), since the
# native installer had an aarch64 detection bug for a while. npm install
# is the most reliable on a Pi 5 running Bookworm.
#
# Run as the 'pi' user, not root:
#   bash ~/jafo/scripts/install-claude-code.sh
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[claude-code]${NC} $*"; }
warn()  { echo -e "${YELLOW}[claude-code]${NC} $*"; }
fail()  { echo -e "${RED}[claude-code]${NC} $*" >&2; exit 1; }

[[ "$(id -un)" == "pi" ]] || fail "Run as the 'pi' user, not root or sudo."
[[ "$(uname -m)" == "aarch64" ]] || warn "Not aarch64 — built for Pi 5 (64-bit). Continuing."

# ----------------------------------------------------------------------------
# 1. Node.js — Claude Code needs >=18. Bookworm ships an old Node, so add
#    NodeSource's repo for Node 20 LTS.
# ----------------------------------------------------------------------------
NEED_NODE=false
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v | sed 's/^v//;s/\..*//')"
  if [[ "$NODE_VERSION" -lt 18 ]]; then
    warn "Node.js v$NODE_VERSION is too old (need >=18)."
    NEED_NODE=true
  else
    info "Node.js $(node -v) ✓"
  fi
else
  warn "Node.js not installed."
  NEED_NODE=true
fi

if $NEED_NODE; then
  info "Installing Node.js 20 LTS from NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  info "Node.js $(node -v) installed."
fi

# ----------------------------------------------------------------------------
# 2. User-level npm prefix — avoids needing sudo and keeps things tidy.
# ----------------------------------------------------------------------------
NPM_GLOBAL="$HOME/.npm-global"
mkdir -p "$NPM_GLOBAL"
npm config set prefix "$NPM_GLOBAL"

# Add to PATH if not already there
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$NPM_GLOBAL/bin"; then
  if ! grep -q "\.npm-global/bin" "$HOME/.bashrc" 2>/dev/null; then
    info "Adding ~/.npm-global/bin to PATH in ~/.bashrc"
    echo "" >> "$HOME/.bashrc"
    echo "# Added by jafo install-claude-code.sh" >> "$HOME/.bashrc"
    echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"
  fi
  export PATH="$NPM_GLOBAL/bin:$PATH"
fi

# ----------------------------------------------------------------------------
# 3. Install Claude Code
# ----------------------------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  info "Claude Code already installed: $(claude --version 2>/dev/null || echo 'unknown version')"
  read -rp "Reinstall / update? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    info "Updating..."
    npm install -g @anthropic-ai/claude-code
  fi
else
  info "Installing @anthropic-ai/claude-code (this may take a minute)..."
  npm install -g @anthropic-ai/claude-code
fi

# ----------------------------------------------------------------------------
# 4. Verify
# ----------------------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  fail "Claude Code installed but 'claude' isn't in PATH yet. Run: source ~/.bashrc && claude --version"
fi

info "Installed: $(claude --version 2>/dev/null || echo '(version check failed)')"

# ----------------------------------------------------------------------------
# 5. Authentication guidance
# ----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  ${BOLD}Claude Code installed.${NC}"
echo "============================================================"
echo ""
echo "  Authenticate one of two ways:"
echo ""
echo "  Option A — Use your existing ANTHROPIC_API_KEY from .env:"
echo ""
echo "    cd ~/jafo"
echo "    set -a && source .env && set +a"
echo "    claude"
echo ""
echo "    (Claude Code reads ANTHROPIC_API_KEY from the environment.)"
echo ""
echo "  Option B — Browser OAuth (preferred if you have a Pro/Max plan):"
echo ""
echo "    claude login"
echo ""
echo "    It'll print a URL. Copy it, open in any browser on your"
echo "    network, sign in to Anthropic, paste the resulting token"
echo "    back into the terminal."
echo ""
echo "  ${BOLD}Then start a session in the jafo project:${NC}"
echo ""
echo "    cd ~/jafo"
echo "    claude"
echo ""
echo "  Claude Code will read CLAUDE.md and HANDOFF.md from the repo"
echo "  root automatically — full project context, no re-explaining."
echo ""
echo "============================================================"
