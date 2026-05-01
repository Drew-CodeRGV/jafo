#!/usr/bin/env bash
#
# jafo — build trunk-recorder from source.
#
# Idempotent. Safe to re-run after partial builds, after detached-HEAD
# checkouts of release tags, etc.
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[jafo-build]${NC} $*"; }
warn()  { echo -e "${YELLOW}[jafo-build]${NC} $*"; }

REPO_URL="https://github.com/robotastic/trunk-recorder.git"
BUILD_DIR="/home/pi/src/trunk-recorder"

mkdir -p /home/pi/src

# ----------------------------------------------------------------------------
# Get / refresh the source tree.
#
# Why not `git pull`? Because if a previous build left the repo on a tag
# (detached HEAD), `git pull` fails with:
#   "You are not currently on a branch."
# Using `git fetch --tags` works in any state.
# ----------------------------------------------------------------------------
if [[ -d "$BUILD_DIR/.git" ]]; then
  info "Repo exists at $BUILD_DIR — fetching latest tags."
  cd "$BUILD_DIR"
  git fetch origin --tags --quiet
elif [[ -d "$BUILD_DIR" ]]; then
  warn "$BUILD_DIR exists but isn't a git repo — wiping and re-cloning."
  rm -rf "$BUILD_DIR"
  git clone "$REPO_URL" "$BUILD_DIR"
  cd "$BUILD_DIR"
else
  info "Cloning trunk-recorder repo..."
  git clone "$REPO_URL" "$BUILD_DIR"
  cd "$BUILD_DIR"
fi

# ----------------------------------------------------------------------------
# Check out the latest release tag (more stable than master).
# ----------------------------------------------------------------------------
LATEST_TAG="$(git describe --tags --abbrev=0 origin/master 2>/dev/null || git describe --tags --abbrev=0 2>/dev/null || true)"
if [[ -n "$LATEST_TAG" ]]; then
  info "Checking out latest tag: $LATEST_TAG"
  git -c advice.detachedHead=false checkout "$LATEST_TAG"
fi

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
mkdir -p build
cd build

# If we're re-running after a successful install, skip ahead unless forced.
if [[ "${FORCE_REBUILD_TRUNK_RECORDER:-0}" != "1" ]] && \
   command -v trunk-recorder >/dev/null 2>&1 && \
   [[ -f "$BUILD_DIR/build/trunk-recorder" ]]; then
  info "trunk-recorder already built and installed — skipping."
  info "  (set FORCE_REBUILD_TRUNK_RECORDER=1 to rebuild)"
  exit 0
fi

info "Running cmake..."
cmake .. -DCMAKE_BUILD_TYPE=Release

info "Compiling ($(nproc) cores)..."
make -j"$(nproc)"

info "Installing..."
sudo make install
sudo ldconfig

info "Done. Verifying:"
trunk-recorder --version || true
