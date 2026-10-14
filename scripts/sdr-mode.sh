#!/bin/bash
# Switch the shared RTL-SDR between ADS-B, ACARS, and VOICE (VHF rail).
#
# The Pi has one RTL-SDR; it can do only one of these at a time. The Airspy R2
# keeps doing P25 (LRGVRRS) throughout.
#
#   sudo bash ~/jafo/scripts/sdr-mode.sh adsb    # RTL -> ADS-B 1090 MHz (readsb)
#   sudo bash ~/jafo/scripts/sdr-mode.sh acars   # RTL -> ACARS ~131 MHz (acarsdec)
#   sudo bash ~/jafo/scripts/sdr-mode.sh voice   # RTL -> VHF rail into trunk-recorder
#   bash ~/jafo/scripts/sdr-mode.sh status
#
# VOICE mode adds the RTL to trunk-recorder as a conventional FM system, so rail
# calls flow into the normal transcribe/enrich/feed pipeline. Leaving voice mode
# restores the P25-only trunk-recorder config.
set -euo pipefail

mode="${1:-status}"
DATA="$HOME/jafo-data/config"
REPO="$HOME/jafo"
BAK="$DATA/config.json.bak-sdrmode"

active() { systemctl is-active "$1" 2>/dev/null || true; }

# If we're currently in voice mode (backup present), put the P25-only config
# back and restart the recorder.
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
  acars)
    leave_voice
    echo "→ ACARS mode: releasing RTL from ADS-B…"
    sudo systemctl stop jafo-adsb-serve.service readsb.service 2>/dev/null || true
    sleep 1
    sudo systemctl start jafo-acars.service
    echo "   jafo-acars started. Watch: journalctl -u jafo-acars -f"
    ;;
  adsb)
    leave_voice
    echo "→ ADS-B mode: stopping ACARS…"
    sudo systemctl stop jafo-acars.service 2>/dev/null || true
    sleep 1
    sudo systemctl start readsb.service jafo-adsb-serve.service
    echo "   ADS-B resumed."
    ;;
  voice)
    echo "→ VOICE mode: RTL → VHF rail (P25 stays on the Airspy)…"
    sudo systemctl stop jafo-acars.service jafo-adsb-serve.service readsb.service 2>/dev/null || true
    sleep 1
    [ -f "$BAK" ] || cp "$DATA/config.json" "$BAK"          # back up P25-only config once
    cp "$REPO/config/profiles/airspy-p25-rtl-rail.json" "$DATA/config.json"
    cp "$REPO/config/talkgroups-rail.csv" "$DATA/rail-talkgroups.csv"
    sudo systemctl restart jafo-recorder
    echo "   jafo-recorder restarted with P25 + rail. Watch: journalctl -u jafo-recorder -f"
    echo "   Rail traffic will appear in the call feed under 'Railroad'."
    ;;
  status)
    echo "readsb (ADS-B):   $(active readsb.service)"
    echo "jafo-adsb-serve:  $(active jafo-adsb-serve.service)"
    echo "jafo-acars:       $(active jafo-acars.service)"
    echo "jafo-recorder:    $(active jafo-recorder.service)"
    echo "voice mode:       $([ -f "$BAK" ] && echo ACTIVE || echo off)"
    ;;
  *)
    echo "usage: sdr-mode.sh {adsb|acars|voice|status}" >&2
    exit 1
    ;;
esac
