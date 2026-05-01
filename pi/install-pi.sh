#!/usr/bin/env bash
#
# jafo Pi installer — full stack with SDR auto-detection.
#
# Detects whichever SDRs are plugged in (HackRF, RTL-SDR, SDRplay RSP)
# and configures trunk-recorder accordingly. Only installs the SDRplay
# proprietary driver if an RSP is detected.
#
# Idempotent. Safe to re-run.
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[jafo-install]${NC} $*"; }
warn()  { echo -e "${YELLOW}[jafo-install]${NC} $*"; }
fail()  { echo -e "${RED}[jafo-install]${NC} $*" >&2; exit 1; }

INSTALL_DIR="/home/pi/jafo"
DATA_DIR="/home/pi/jafo-data"

cd "$INSTALL_DIR"
[[ -f .env ]] || fail ".env not found. Run bootstrap.sh first."

# Source .env, but defensively. If sourcing fails (e.g. unquoted comma),
# log the line and bail rather than silently skip it.
set -a
if ! source .env 2>/tmp/jafo-env-err; then
  cat /tmp/jafo-env-err >&2
  fail "Failed to source .env. Most common cause: unquoted comma or special character in a value. Edit ~/jafo/.env and quote any values that contain commas, spaces, or special characters."
fi
set +a

# ============================================================================
# 1. APT packages
# ============================================================================
info "Installing system packages (5-10 min)..."
sudo apt-get update -qq

# Build essentials
sudo apt-get install -y -qq \
  build-essential cmake pkg-config git curl jq ca-certificates avahi-daemon \
  usbutils

# Audio + codecs
sudo apt-get install -y -qq \
  libssl-dev libcurl4-openssl-dev libsoxr-dev \
  libsndfile1-dev libsox-fmt-all sox \
  ffmpeg libopus-dev libopusfile-dev

# Boost — trunk-recorder uses many components (log, log_setup, random, etc).
# libboost-all-dev pulls them all in. Don't try to itemize — Pi OS sometimes
# splits things into surprise packages and we end up chasing missing components.
info "Installing Boost (all dev packages)..."
sudo apt-get install -y -qq libboost-all-dev

# GNU Radio + osmocom
info "Installing GNU Radio + SDR support..."
sudo apt-get install -y -qq \
  gnuradio gnuradio-dev gr-osmosdr \
  libosmosdr-dev libuhd-dev uhd-host

# All apt-available SDR drivers (HackRF + RTL-SDR; SDRplay handled separately)
info "Installing HackRF + RTL-SDR drivers..."
sudo apt-get install -y -qq \
  libhackrf-dev hackrf \
  rtl-sdr librtlsdr-dev \
  libsoapysdr-dev soapysdr-tools \
  soapysdr-module-rtlsdr soapysdr-module-hackrf soapysdr-module-uhd \
  libusb-1.0-0-dev

# Python + DB
sudo apt-get install -y -qq \
  python3 python3-pip python3-venv python3-soapysdr sqlite3

info "Installing nginx..."
sudo apt-get install -y -qq nginx

# ============================================================================
# 2. Kernel module fixes
# ============================================================================
info "Blacklisting conflicting kernel modules..."
sudo tee /etc/modprobe.d/blacklist-rtl.conf >/dev/null <<'EOF'
# RTL-SDR — DVB-T driver fights for the device
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
blacklist rtl2838

# SDRplay — msi2500 driver fights with the SDRplay API
blacklist msi2500
blacklist sdr_msi3101
EOF

for mod in dvb_usb_rtl28xxu rtl2832 rtl2830 rtl2838 msi2500 sdr_msi3101; do
  sudo modprobe -r "$mod" 2>/dev/null || true
done

sudo udevadm control --reload-rules || true
sudo udevadm trigger || true
sudo usermod -aG plugdev pi || true

# ============================================================================
# 3. Auto-detect SDRs
# ============================================================================
info "Auto-detecting SDRs..."
PROFILE="$(bash "$INSTALL_DIR/pi/tools/detect-sdrs.sh")"
info "Selected profile: $PROFILE"

case "$PROFILE" in
  none)
    warn "No SDRs detected. Continuing — capture services will be configured"
    warn "but won't capture until SDRs are plugged in."
    warn "After plugging in, re-run: bash ~/jafo/pi/install-pi.sh"
    SDR_OK=false
    NEEDS_SDRPLAY=false
    ;;
  rtl-only)
    warn "Only RTL-SDR detected — it can decode the control channel but"
    warn "lacks the bandwidth for voice channels. Add a HackRF or SDRplay RSP."
    SDR_OK=false
    NEEDS_SDRPLAY=false
    ;;
  hackrf-rtl)
    info "HackRF + RTL-SDR — the standard configuration."
    SDR_OK=true
    NEEDS_SDRPLAY=false
    ;;
  hackrf-only)
    info "HackRF only — single-SDR mode (10 MS/s sample rate)."
    SDR_OK=true
    NEEDS_SDRPLAY=false
    ;;
  hackrf-rsp1)
    info "HackRF + SDRplay RSP — high-quality config (RSP on control channel)."
    SDR_OK=true
    NEEDS_SDRPLAY=true
    ;;
  rsp1-rtl)
    info "RSP + RTL-SDR — RSP handles voice, RTL handles control."
    SDR_OK=true
    NEEDS_SDRPLAY=true
    ;;
  rsp1-only)
    info "SDRplay RSP only — single-SDR mode (8 MS/s sample rate)."
    SDR_OK=true
    NEEDS_SDRPLAY=true
    ;;
  rsp1-hackrf-rtl)
    info "All three SDRs detected — using RTL+HackRF (RSP held in reserve)."
    SDR_OK=true
    NEEDS_SDRPLAY=true
    ;;
  *)
    warn "Unknown profile '$PROFILE' — defaulting to hackrf-rtl"
    PROFILE="hackrf-rtl"
    SDR_OK=false
    NEEDS_SDRPLAY=false
    ;;
esac

# ============================================================================
# 4. SDRplay API + SoapySDRPlay3 (only if RSP detected)
# ============================================================================
if $NEEDS_SDRPLAY; then
  info "RSP detected — running SDRplay driver installer..."
  bash "$INSTALL_DIR/pi/build-sdrplay.sh"
fi

# ============================================================================
# 5. Build trunk-recorder
# ============================================================================
if command -v trunk-recorder >/dev/null 2>&1 && [[ "${FORCE_REBUILD_TRUNK_RECORDER:-0}" != "1" ]]; then
  info "trunk-recorder already installed at $(command -v trunk-recorder)"
else
  info "Building trunk-recorder from source (15-20 min)..."
  bash "$INSTALL_DIR/pi/build-trunk-recorder.sh"
fi

# ============================================================================
# 6. Data directories
# ============================================================================
info "Creating jafo data directories..."
mkdir -p "$DATA_DIR"/{recordings,calls,logs,config}

# ============================================================================
# 7. Install trunk-recorder config from selected profile
# ============================================================================
PROFILE_FILE="$INSTALL_DIR/config/profiles/$PROFILE.json"
if [[ -f "$PROFILE_FILE" ]]; then
  info "Installing trunk-recorder config: profiles/$PROFILE.json"
  cp "$PROFILE_FILE" "$DATA_DIR/config/config.json"
else
  warn "No profile file for '$PROFILE' — falling back to hackrf-rtl"
  cp "$INSTALL_DIR/config/profiles/hackrf-rtl.json" "$DATA_DIR/config/config.json"
fi

# Talkgroups CSV — only install starter if missing (preserve user-curated copy)
if [[ ! -f "$DATA_DIR/config/talkgroups.csv" ]]; then
  cp "$INSTALL_DIR/config/talkgroups-monitored.csv" "$DATA_DIR/config/talkgroups.csv"
  warn ""
  warn "Installed PLACEHOLDER talkgroups.csv at $DATA_DIR/config/talkgroups.csv"
  warn "Replace with the real LRGVRRS export from RadioReference,"
  warn "OR temporarily set 'recordUnknown': true in config.json to test."
  warn ""
fi

echo "$PROFILE" > "$DATA_DIR/config/.active-profile"

# ============================================================================
# 8. Python venvs
# ============================================================================
info "Setting up Python venv for services..."
SVC_VENV="$DATA_DIR/venv-services"
if [[ ! -d "$SVC_VENV" ]]; then
  python3 -m venv "$SVC_VENV"
fi
"$SVC_VENV/bin/pip" install --quiet --upgrade pip
"$SVC_VENV/bin/pip" install --quiet -r "$INSTALL_DIR/pi/services/requirements.txt"

info "Setting up Python venv for web..."
WEB_VENV="$DATA_DIR/venv-web"
if [[ ! -d "$WEB_VENV" ]]; then
  python3 -m venv "$WEB_VENV"
fi
"$WEB_VENV/bin/pip" install --quiet --upgrade pip
"$WEB_VENV/bin/pip" install --quiet -r "$INSTALL_DIR/pi/web/requirements.txt"

# ============================================================================
# 9. nginx config
# ============================================================================
info "Configuring nginx..."
sudo cp "$INSTALL_DIR/pi/tools/nginx-jafo.conf" /etc/nginx/sites-available/jafo
sudo ln -sf /etc/nginx/sites-available/jafo /etc/nginx/sites-enabled/jafo
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  sudo rm /etc/nginx/sites-enabled/default
fi

# nginx (running as www-data) needs traverse permission on /home/pi to reach
# the static files. Without this, every CSS/JS/asset request returns 403.
chmod o+x /home/pi 2>/dev/null || true
chmod -R o+rX "$INSTALL_DIR/pi/web/static/" 2>/dev/null || true

sudo nginx -t
sudo systemctl reload nginx || sudo systemctl restart nginx

# ============================================================================
# 10. Systemd services
# ============================================================================
info "Installing systemd services..."
for svc in jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web; do
  sudo cp "$INSTALL_DIR/pi/systemd/$svc.service" /etc/systemd/system/
done
sudo systemctl daemon-reload
sudo systemctl enable jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web

# ============================================================================
# 11. Start services
# ============================================================================
if $SDR_OK; then
  info "Starting all services..."
  sudo systemctl restart jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web
  sleep 3
else
  warn "Not starting capture (SDRs not ready). Starting other services..."
  sudo systemctl restart jafo-processor jafo-transcriber jafo-enricher jafo-web
fi

# ============================================================================
# 12. Final report
# ============================================================================
HOSTNAME="$(hostname).local"
IP="$(hostname -I | awk '{print $1}')"

echo ""
echo "============================================================"
echo "  jafo install complete."
echo "============================================================"
echo ""
echo "  Profile:          $PROFILE"
echo ""
echo "  Services:"
for svc in jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web; do
  STATUS="$(systemctl is-active $svc.service 2>/dev/null || echo inactive)"
  printf "    %-22s %s\n" "$svc" "$STATUS"
done
echo ""
echo "  Web UI:           http://$HOSTNAME    (or http://$IP)"
echo "  Live capture log: sudo journalctl -u jafo-recorder -f"
echo "  Stats:            ~/jafo/pi/services/stats.py"
echo "  SDR check:        ~/jafo/pi/tools/check-sdrs.sh"
echo ""
if [[ -z "${GROQ_API_KEY:-}" ]] || [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "  ⚠ API keys missing. Capture works but no transcription/enrichment."
  echo "    Add them: nano ~/jafo/.env"
  echo "    Then:     sudo systemctl restart jafo-transcriber jafo-enricher"
  echo ""
fi
if ! $SDR_OK; then
  echo "  ⚠ SDR situation needs attention. After fixing (often: reboot):"
  echo "    ~/jafo/pi/tools/check-sdrs.sh"
  echo "    bash ~/jafo/pi/install-pi.sh    # re-run to re-detect + reconfigure"
  echo ""
fi
echo "============================================================"
