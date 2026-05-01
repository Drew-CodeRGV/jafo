#!/usr/bin/env bash
#
# jafo — install SDRplay API + SoapySDRPlay3 driver.
#
# Only runs if an SDRplay device was detected during install.
#
# Two-step process:
#   1. Download SDRplay's .run installer (NOT install.sh — that one now installs
#      SDRconnect, the GUI app, not the API). The .run installs the proprietary
#      API library, blacklists msi2500, and registers the sdrplay systemd service.
#   2. Build SoapySDRPlay3 from source against the installed API.
#
# Idempotent — safe to re-run. If API is already installed, only builds/checks
# SoapySDRPlay3.
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[jafo-sdrplay]${NC} $*"; }
warn()  { echo -e "${YELLOW}[jafo-sdrplay]${NC} $*"; }
fail()  { echo -e "${RED}[jafo-sdrplay]${NC} $*" >&2; exit 1; }

# ----------------------------------------------------------------------------
# 1. SDRplay API
# ----------------------------------------------------------------------------
# Direct .run installer URL. This is the proprietary API that lets userspace
# apps talk to SDRplay devices via /opt/sdrplay_api/sdrplay_apiService.
#
# IMPORTANT: do NOT use https://www.sdrplay.com/software/install.sh — as of
# late 2025, that URL installs SDRconnect (the desktop GUI app), not the API.
# The .run URL below has remained stable for years.
SDRPLAY_API_VERSION="${SDRPLAY_API_VERSION:-3.15.2}"
SDRPLAY_RUN_URL="https://www.sdrplay.com/software/SDRplay_RSP_API-Linux-${SDRPLAY_API_VERSION}.run"

API_LIB="/usr/local/lib/libsdrplay_api.so"
API_LIB_VERSIONED="$(ls /usr/local/lib/libsdrplay_api.so.* 2>/dev/null | head -1)"

if [[ -f "$API_LIB" ]] && [[ -n "$API_LIB_VERSIONED" ]] && \
   systemctl list-unit-files 2>/dev/null | grep -q '^sdrplay\.service'; then
  CURRENT_VER="${API_LIB_VERSIONED##*libsdrplay_api.so.}"
  info "SDRplay API already installed (version $CURRENT_VER) — skipping installer."
else
  info "Downloading SDRplay API ${SDRPLAY_API_VERSION} installer..."
  cd /tmp
  RUN_FILE="SDRplay_RSP_API-Linux-${SDRPLAY_API_VERSION}.run"
  curl -fsSLO "$SDRPLAY_RUN_URL" || fail "Could not download SDRplay API. Check internet."
  chmod +x "$RUN_FILE"

  info "Running SDRplay API installer..."
  info "  (it will scroll license text — press space to page through, then 'y' to accept)"
  info "  (then 'y' to confirm install location)"
  echo ""

  # The .run installer is a self-extracting shell script with interactive
  # prompts. We run it interactively so the user can answer.
  sudo ./"$RUN_FILE"

  # Verify the install actually completed
  if [[ ! -f "$API_LIB" ]]; then
    fail "SDRplay API install did not complete. Check installer output."
  fi

  sudo systemctl daemon-reload
  sudo systemctl enable sdrplay.service 2>/dev/null || true
  sudo systemctl restart sdrplay.service 2>/dev/null || true
  sudo ldconfig

  info "SDRplay API installed and service started."
fi

# ----------------------------------------------------------------------------
# 2. msi2500 blacklist (defense in depth — installer should do this too)
# ----------------------------------------------------------------------------
if ! grep -rq "blacklist msi2500" /etc/modprobe.d/ 2>/dev/null; then
  info "Adding msi2500 blacklist..."
  sudo tee -a /etc/modprobe.d/blacklist-rtl.conf >/dev/null <<'EOF'
# SDRplay — msi2500 driver fights with the SDRplay API
blacklist msi2500
blacklist sdr_msi3101
EOF
  for mod in msi2500 sdr_msi3101; do
    sudo modprobe -r "$mod" 2>/dev/null || true
  done
fi

# ----------------------------------------------------------------------------
# 3. Verify API is responsive before building SoapySDRPlay3
# ----------------------------------------------------------------------------
sleep 1
if ! systemctl is-active --quiet sdrplay.service; then
  warn "sdrplay.service not active. SoapySDRPlay3 will still build but the"
  warn "device may not work until you reboot:"
  warn "  sudo systemctl status sdrplay.service"
fi

# ----------------------------------------------------------------------------
# 4. Build SoapySDRPlay3 from source
# ----------------------------------------------------------------------------
BUILD_DIR="/home/pi/src/SoapySDRPlay3"

# Detect existing module install across either modules0.7 or modules0.8 path
if ls /usr/local/lib/SoapySDR/modules*/libsdrPlaySupport.so 2>/dev/null | grep -q .; then
  if [[ "${FORCE_REBUILD_SOAPY_SDRPLAY3:-0}" != "1" ]]; then
    info "SoapySDRPlay3 module already installed — skipping rebuild."
    info "  (set FORCE_REBUILD_SOAPY_SDRPLAY3=1 to force rebuild)"
    REBUILD=0
  else
    REBUILD=1
  fi
else
  REBUILD=1
fi

if [[ "${REBUILD:-0}" == "1" ]]; then
  info "Building SoapySDRPlay3 from source..."
  mkdir -p /home/pi/src

  if [[ -d "$BUILD_DIR/.git" ]]; then
    cd "$BUILD_DIR"
    # Use fetch + reset rather than pull (works in detached HEAD state)
    git fetch origin --quiet
    if git symbolic-ref --short HEAD >/dev/null 2>&1; then
      CURRENT_BRANCH="$(git symbolic-ref --short HEAD)"
      git reset --hard "origin/$CURRENT_BRANCH" --quiet || warn "reset failed — using local copy"
    fi
  else
    # Either doesn't exist or is a non-git directory. Wipe and re-clone.
    rm -rf "$BUILD_DIR"
    git clone https://github.com/pothosware/SoapySDRPlay3.git "$BUILD_DIR"
    cd "$BUILD_DIR"
  fi

  rm -rf build
  mkdir build && cd build
  cmake .. -DCMAKE_BUILD_TYPE=Release
  make -j"$(nproc)"
  sudo make install
  sudo ldconfig
  info "SoapySDRPlay3 built and installed."
fi

# ----------------------------------------------------------------------------
# 5. Smoke test — can SoapySDR see the SDRplay?
# ----------------------------------------------------------------------------
info "Verifying SoapySDR can find the SDRplay..."
if SoapySDRUtil --find 2>/dev/null | grep -qi sdrplay; then
  info "  ✓ SDRplay visible via SoapySDR"
else
  warn "  ✗ SoapySDR does not see the SDRplay yet."
  warn "    Common causes:"
  warn "      - sdrplay.service needs a moment after install (try again in 30s)"
  warn "      - msi2500 blacklist requires reboot to take effect"
  warn "      - RSP not connected via powered USB hub"
  warn "    After fixing, verify with: SoapySDRUtil --find"
fi
