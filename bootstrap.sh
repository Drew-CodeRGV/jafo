#!/usr/bin/env bash
#
# jafo — Pi bootstrap (full stack: capture + transcribe + enrich + web)
# Run on a fresh Raspberry Pi OS Lite (64-bit, Bookworm) install.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Drew-CodeRGV/jafo/main/bootstrap.sh | bash
#
# OR, if you've already scp'd a tar of this repo onto the Pi:
#   tar -xzf jafo.tar.gz -C ~/jafo
#   cd ~/jafo && bash bootstrap.sh
#
# This script is idempotent. It detects three states:
#   1. Files already present (e.g. extracted from tar) → use them, no clone
#   2. Repo already cloned (.git exists) → fetch + reset to origin/main
#   3. Nothing yet → clone fresh
#

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Drew-CodeRGV/jafo.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/home/pi/jafo}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[jafo]${NC} $*"; }
warn()  { echo -e "${YELLOW}[jafo]${NC} $*"; }
fail()  { echo -e "${RED}[jafo]${NC} $*" >&2; exit 1; }

cat <<'BANNER'

       _        __
      (_) __ _ / _| ___
      | |/ _` | |_ / _ \
      | | (_| |  _| (_) |
     _/ |\__,_|_|  \___/
    |__/    Just Another F***ing Observer

         "You can hear a mouse fart at 2000 ft."

BANNER

[[ "$(id -un)" == "pi" ]] || fail "Run as the 'pi' user. Current user: $(id -un)"
[[ "$(uname -m)" == "aarch64" ]] || warn "Not aarch64 — built for Pi 5 (64-bit). Continuing."

# ----------------------------------------------------------------------------
# Make sure we have basic tools (git + curl)
# ----------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  info "Installing git + curl..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq git curl ca-certificates
fi

# ----------------------------------------------------------------------------
# Resolve the install directory (3 states: files-present, git-repo, nothing)
# ----------------------------------------------------------------------------
SELF_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd 2>/dev/null || echo "" )"

if [[ -f "$INSTALL_DIR/pi/install-pi.sh" ]]; then
  # Project files are already there. Could be from a tar extract or a previous clone.
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Repo already at $INSTALL_DIR with git history — fetching latest."
    cd "$INSTALL_DIR"
    # Fetch is safe in any state (detached HEAD, branch, tag).
    git fetch origin --tags --quiet || warn "git fetch failed — using local copy."
    # Try to land on the requested branch cleanly. Don't merge if local has changes.
    if git symbolic-ref --short HEAD >/dev/null 2>&1; then
      # On a branch — try fast-forward
      git pull --ff-only origin "$REPO_BRANCH" 2>/dev/null \
        || warn "git pull --ff-only failed — using local copy."
    else
      # Detached (likely from a tag checkout) — leave it alone, user knows what they're doing
      warn "In detached HEAD state — leaving local checkout as-is."
    fi
  else
    info "Repo files present at $INSTALL_DIR (no .git — extracted from archive). Using as-is."
  fi
elif [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
  # Directory exists with stuff in it but no install-pi.sh — looks wrong
  warn "$INSTALL_DIR exists but doesn't look like a jafo project."
  warn "Contents: $(ls "$INSTALL_DIR" | head -5 | tr '\n' ' ')"
  warn "Backing it up to $INSTALL_DIR.bak.$(date +%s) and cloning fresh."
  mv "$INSTALL_DIR" "$INSTALL_DIR.bak.$(date +%s)"
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
else
  info "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ----------------------------------------------------------------------------
# .env — copy from template if missing
# ----------------------------------------------------------------------------
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  info "Created .env from template. Edit later: nano ~/jafo/.env"
else
  info ".env already exists — preserved."
fi

# ----------------------------------------------------------------------------
# Make scripts executable. Tolerate missing files (e.g. older clones).
# ----------------------------------------------------------------------------
for f in bootstrap.sh \
         pi/install-pi.sh \
         pi/build-trunk-recorder.sh \
         pi/build-sdrplay.sh \
         scripts/update-pi.sh \
         scripts/push-to-github.sh; do
  [[ -f "$INSTALL_DIR/$f" ]] && chmod +x "$INSTALL_DIR/$f"
done
chmod +x "$INSTALL_DIR"/pi/tools/*.sh 2>/dev/null || true
chmod +x "$INSTALL_DIR"/pi/services/*.py 2>/dev/null || true

# ----------------------------------------------------------------------------
# Hand off to the main installer
# ----------------------------------------------------------------------------
exec bash "$INSTALL_DIR/pi/install-pi.sh"
