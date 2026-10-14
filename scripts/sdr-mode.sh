#!/bin/bash
# Switch the shared RTL-SDR between ADS-B and ACARS.
#
# The Pi has one RTL-SDR; ADS-B (readsb @ 1090 MHz) and ACARS (acarsdec @ ~131
# MHz) can't both use it at once. This flips between them cleanly.
#
#   sudo bash ~/jafo/scripts/sdr-mode.sh acars   # ADS-B pauses, ACARS starts
#   sudo bash ~/jafo/scripts/sdr-mode.sh adsb    # ACARS stops, ADS-B resumes
#   bash ~/jafo/scripts/sdr-mode.sh status
set -euo pipefail

mode="${1:-status}"

active() { systemctl is-active "$1" 2>/dev/null || true; }

case "$mode" in
  acars)
    echo "→ ACARS mode: releasing RTL from ADS-B…"
    sudo systemctl stop jafo-adsb-serve.service readsb.service 2>/dev/null || true
    sleep 1
    sudo systemctl start jafo-acars.service
    echo "   ADS-B paused, jafo-acars started. Watch: journalctl -u jafo-acars -f"
    ;;
  adsb)
    echo "→ ADS-B mode: stopping ACARS…"
    sudo systemctl stop jafo-acars.service 2>/dev/null || true
    sleep 1
    sudo systemctl start readsb.service jafo-adsb-serve.service
    echo "   jafo-acars stopped, ADS-B resumed."
    ;;
  status)
    echo "readsb (ADS-B):   $(active readsb.service)"
    echo "jafo-adsb-serve:  $(active jafo-adsb-serve.service)"
    echo "jafo-acars:       $(active jafo-acars.service)"
    ;;
  *)
    echo "usage: sdr-mode.sh {acars|adsb|status}" >&2
    exit 1
    ;;
esac
