#!/usr/bin/env bash
#
# jafo — push the local repo to GitHub from the Pi.
#
# Usage:
#   bash ~/jafo/scripts/push-to-github.sh ["commit message"]
#
# Uses SSH key auth (~/.ssh/id_ed25519). One-time setup:
#   1. Run this script once — it prints the public key if GitHub isn't reachable.
#   2. Add that key at https://github.com/settings/keys
#   3. Run again — works forever, no token prompts.
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()   { echo -e "${GREEN}[push]${NC} $*"; }
warn()   { echo -e "${YELLOW}[push]${NC} $*"; }
fail()   { echo -e "${RED}[push]${NC} $*" >&2; exit 1; }

REMOTE_URL_SSH="git@github.com:Drew-CodeRGV/jafo.git"
BRANCH="${JAFO_BRANCH:-main}"
COMMIT_MSG="${1:-jafo: update}"

REPO_DIR="${INSTALL_DIR:-/home/pi/jafo}"
cd "$REPO_DIR" || fail "Cannot cd to $REPO_DIR"

info "Working in: $PWD"
info "Remote:     $REMOTE_URL_SSH"
info "Branch:     $BRANCH"

# ----------------------------------------------------------------------------
# Sanity: required tools
# ----------------------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git not installed."

# ----------------------------------------------------------------------------
# Sanity: SSH key exists
# ----------------------------------------------------------------------------
if [[ ! -f ~/.ssh/id_ed25519 ]]; then
  fail "No SSH key at ~/.ssh/id_ed25519. Run: ssh-keygen -t ed25519 -C jafo@pi.local"
fi

# ----------------------------------------------------------------------------
# Sanity: don't commit secrets
# ----------------------------------------------------------------------------
if [[ -f .env ]]; then
  if ! grep -q "^\.env$" .gitignore 2>/dev/null; then
    fail ".env exists but isn't in .gitignore. Aborting to prevent secret leak."
  fi
  info ".env is gitignored ✓"
fi

# ----------------------------------------------------------------------------
# Init or re-use existing git repo
# ----------------------------------------------------------------------------
if [[ -d .git ]]; then
  CURRENT_REMOTE="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -z "$CURRENT_REMOTE" ]]; then
    info "Adding remote origin..."
    git remote add origin "$REMOTE_URL_SSH"
  elif [[ "$CURRENT_REMOTE" != "$REMOTE_URL_SSH" ]]; then
    warn "Updating remote: $CURRENT_REMOTE → $REMOTE_URL_SSH"
    git remote set-url origin "$REMOTE_URL_SSH"
  fi
else
  info "Initializing new git repo..."
  git init -q
  git remote add origin "$REMOTE_URL_SSH"
fi

# ----------------------------------------------------------------------------
# Configure committer if not already set
# ----------------------------------------------------------------------------
if ! git config user.email >/dev/null 2>&1; then
  git config user.email "jafo@local.dev"
  git config user.name "jafo"
fi

# ----------------------------------------------------------------------------
# Stage + commit (skip if nothing changed)
# ----------------------------------------------------------------------------
info "Staging files..."
git add -A

STAGED_COUNT="$(git diff --cached --name-only | wc -l | xargs)"
if [[ "$STAGED_COUNT" -eq 0 ]]; then
  warn "Nothing staged — no changes to commit."
else
  info "$STAGED_COUNT file(s) staged."
  info "Committing: $COMMIT_MSG"
  git commit -q -m "$COMMIT_MSG"
  echo "  ✓ $(git log -1 --oneline)"
fi

# ----------------------------------------------------------------------------
# Set branch
# ----------------------------------------------------------------------------
git branch -M "$BRANCH" 2>/dev/null || true

# ----------------------------------------------------------------------------
# Verify SSH auth before pushing
# ----------------------------------------------------------------------------
info "Verifying SSH access to GitHub..."
SSH_OUT="$(ssh -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 || true)"
if ! echo "$SSH_OUT" | grep -q "successfully authenticated"; then
  echo ""
  echo "============================================================"
  echo "  ${BOLD}SSH key not yet authorized on GitHub${NC}"
  echo "============================================================"
  echo ""
  echo "  Add this public key at https://github.com/settings/keys"
  echo ""
  cat ~/.ssh/id_ed25519.pub
  echo ""
  fail "Add the key to GitHub, then re-run this script."
fi
info "SSH auth OK ✓"

# ----------------------------------------------------------------------------
# Push
# ----------------------------------------------------------------------------
info "Pushing to $REMOTE_URL_SSH ($BRANCH)..."
if git push origin "$BRANCH" --force; then
  info "Push succeeded."
else
  fail "Push failed."
fi

echo ""
echo "============================================================"
echo "  ${BOLD}Pushed to https://github.com/Drew-CodeRGV/jafo${NC}"
echo "============================================================"
echo ""
echo "  To install on another Pi:"
echo "    curl -fsSL https://raw.githubusercontent.com/Drew-CodeRGV/jafo/main/bootstrap.sh | bash"
echo ""
