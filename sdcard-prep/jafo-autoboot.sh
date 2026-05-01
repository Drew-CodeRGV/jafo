#!/usr/bin/env bash
#
# jafo-autoboot.sh
# Runs ONCE on the Pi after first boot, via the jafo-autoboot.service
# systemd unit that prepare-sdcard.sh installed.
#
# Job: clone the jafo repo, run bootstrap, mark itself done so it never
# runs again. Idempotent — if it gets restarted partway through, it picks
# up where it left off.
#

set -euo pipefail

REPO_URL="${JAFO_REPO_URL:-https://github.com/Drew-CodeRGV/jafo.git}"
REPO_BRANCH="${JAFO_REPO_BRANCH:-main}"
INSTALL_DIR="/home/pi/jafo"
LOG="/var/log/jafo-autoboot.log"
DONE_MARKER="/var/lib/jafo-autoboot.done"

# ----------------------------------------------------------------------------
# Logging — everything goes to journal AND a logfile we can SSH in to read
# ----------------------------------------------------------------------------
exec > >(tee -a "$LOG") 2>&1
echo ""
echo "================================================================"
echo "  jafo-autoboot starting at $(date)"
echo "================================================================"

# ----------------------------------------------------------------------------
# Already done? Self-disable and exit.
# ----------------------------------------------------------------------------
if [[ -f "$DONE_MARKER" ]]; then
  echo "[jafo-autoboot] Already completed at $(cat "$DONE_MARKER"). Disabling service."
  systemctl disable jafo-autoboot.service 2>/dev/null || true
  exit 0
fi

# ----------------------------------------------------------------------------
# Wait for network — systemd's network-online.target is sometimes optimistic
# ----------------------------------------------------------------------------
echo "[jafo-autoboot] Verifying internet connectivity..."
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 https://github.com >/dev/null 2>&1; then
    echo "[jafo-autoboot] ✓ Network reachable."
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "[jafo-autoboot] ✗ No network after 5 minutes. Retrying on next boot."
    exit 1   # systemd will retry; oneshot with Restart=on-failure semantics not used here
  fi
  echo "[jafo-autoboot] Waiting for network... (attempt $i/60)"
  sleep 5
done

# ----------------------------------------------------------------------------
# Make sure git is installed (it usually is, but Pi OS Lite is minimal)
# ----------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "[jafo-autoboot] Installing git..."
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates
fi

# ----------------------------------------------------------------------------
# Clone (or pull) the repo
# ----------------------------------------------------------------------------
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "[jafo-autoboot] Repo already exists at $INSTALL_DIR — pulling latest."
  cd "$INSTALL_DIR"
  sudo -u pi git fetch origin
  sudo -u pi git checkout "$REPO_BRANCH"
  sudo -u pi git pull origin "$REPO_BRANCH"
else
  echo "[jafo-autoboot] Cloning $REPO_URL → $INSTALL_DIR"
  sudo -u pi git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# Set up .env from template if not present
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  sudo -u pi cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  sudo -u pi chmod 600 "$INSTALL_DIR/.env"
  echo "[jafo-autoboot] Created .env from template (no API keys yet)."
fi

sudo -u pi chmod +x bootstrap.sh pi/install-pi.sh pi/build-trunk-recorder.sh \
                    pi/build-sdrplay.sh scripts/update-pi.sh \
                    pi/tools/*.sh pi/services/*.py 2>/dev/null || true

# ----------------------------------------------------------------------------
# Run the installer as the pi user
# ----------------------------------------------------------------------------
echo "[jafo-autoboot] Handing off to pi/install-pi.sh ..."
echo "[jafo-autoboot] (This will take 25-40 minutes. Output → $LOG and journal.)"

# Run as pi (the installer uses sudo internally for system bits)
sudo -u pi -H bash "$INSTALL_DIR/pi/install-pi.sh"

# ----------------------------------------------------------------------------
# Mark done, disable self
# ----------------------------------------------------------------------------
echo "$(date)" > "$DONE_MARKER"
echo ""
echo "================================================================"
echo "  jafo-autoboot complete at $(date)"
echo "  jafo is installed and running."
echo "  Web UI: http://$(hostname).local"
echo "================================================================"

# Disable the unit so it doesn't run again on subsequent reboots.
systemctl disable jafo-autoboot.service 2>/dev/null || true

# Optional: remove the script from /boot/firmware so the SD card is "clean"
rm -f /boot/firmware/jafo-autoboot.sh 2>/dev/null || true

exit 0
