#!/bin/bash
# Switch the shared RTL-SDR between ADS-B, ACARS, VOICE (VHF rail), and NOAA.
#
# The Pi has one RTL-SDR; it can do only one of these at a time. The Airspy R2
# keeps doing P25 (LRGVRRS) throughout (except VOICE adds rail to trunk-recorder).
#
#   sudo bash ~/jafo/scripts/sdr-mode.sh adsb    # RTL -> ADS-B 1090 (readsb)
#   sudo bash ~/jafo/scripts/sdr-mode.sh acars   # RTL -> ACARS ~131 (acarsdec)
#   sudo bash ~/jafo/scripts/sdr-mode.sh voice   # RTL -> VHF rail into trunk-recorder
#   sudo bash ~/jafo/scripts/sdr-mode.sh noaa    # RTL -> 162.400 SAME weather alerts
#   bash ~/jafo/scripts/sdr-mode.sh status       # prints current mode (machine-readable last line)
#
# Paths are derived from the script's location so it works under sudo (root).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
DATA="$(dirname "$REPO")/jafo-data/config"
BAK="$DATA/config.json.bak-sdrmode"

mode="${1:-status}"
active() { systemctl is-active "$1" 2>/dev/null || true; }

stop_all_rtl() {
  sudo systemctl stop jafo-acars.service jafo-noaa.service jafo-adsb-serve.service readsb.service 2>/dev/null || true
}

# Restore the P25-only trunk-recorder config if we're currently in voice mode.
leave_voice() {
  if [ -f "$BAK" ]; then
    echo "  restoring P25-only trunk-recorder config…"
    cp "$BAK" "$DATA/config.json"
    rm -f "$BAK"
    sudo systemctl restart jafo-recorder
    sleep 2
  fi
}

case "$mode" in
  adsb)
    leave_voice; stop_all_rtl; sleep 1
    sudo systemctl start readsb.service jafo-adsb-serve.service
    echo "→ ADS-B mode (RTL → 1090 MHz)."
    ;;
  acars)
    leave_voice; stop_all_rtl; sleep 1
    sudo systemctl start jafo-acars.service
    echo "→ ACARS mode (RTL → ~131 MHz)."
    ;;
  noaa)
    leave_voice; stop_all_rtl; sleep 1
    sudo systemctl start jafo-noaa.service
    echo "→ NOAA mode (RTL → 162.400 MHz SAME alerts)."
    ;;
  voice)
    stop_all_rtl; sleep 1
    [ -f "$BAK" ] || cp "$DATA/config.json" "$BAK"
    cp "$REPO/config/profiles/airspy-p25-rtl-rail.json" "$DATA/config.json"
    cp "$REPO/config/talkgroups-rail.csv" "$DATA/rail-talkgroups.csv"
    sudo systemctl restart jafo-recorder
    echo "→ VOICE mode (RTL → VHF rail into trunk-recorder; P25 stays on Airspy)."
    ;;
  status)
    cur="unknown"
    if [ -f "$BAK" ]; then cur="voice"
    elif [ "$(active jafo-acars.service)" = "active" ]; then cur="acars"
    elif [ "$(active jafo-noaa.service)" = "active" ]; then cur="noaa"
    elif [ "$(active readsb.service)" = "active" ]; then cur="adsb"
    fi
    echo "readsb:$(active readsb.service) acars:$(active jafo-acars.service) noaa:$(active jafo-noaa.service) recorder:$(active jafo-recorder.service)"
    echo "MODE=$cur"
    ;;
  *)
    echo "usage: sdr-mode.sh {adsb|acars|voice|noaa|status}" >&2
    exit 1
    ;;
esac
