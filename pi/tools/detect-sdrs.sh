#!/usr/bin/env bash
#
# jafo — SDR auto-detection.
#
# Probes lsusb (works without any SDR drivers installed) and outputs a
# single profile name on stdout. All status info goes to stderr.
#
# Profiles emitted:
#   hackrf-rsp1     — HackRF + SDRplay RSP1 (ideal: best dynamic range)
#   hackrf-rtl      — HackRF + RTL-SDR (the default)
#   rsp1-hackrf-rtl — All three present (overkill, uses HackRF + RSP1)
#   hackrf-only     — HackRF only (RSP1 takes voice, no dedicated control SDR)
#   rsp1-only       — RSP1 only (rare, no HackRF)
#   rtl-only        — RTL-SDR only (control channel only, no voice capture)
#   none            — nothing detected
#
# Used by:
#   - bootstrap.sh  → decides whether to run pi/build-sdrplay.sh
#   - install-pi.sh → decides which trunk-recorder.json profile to copy
#

set -euo pipefail

LSUSB="$(lsusb 2>/dev/null || true)"

# USB IDs
HAS_HACKRF=false
HAS_RSP1=false
HAS_RSP1A=false
HAS_RSPDX=false
HAS_RSPDUO=false
HAS_RTL=false

# HackRF: 1d50:6089 (Great Scott Gadgets HackRF One)
echo "$LSUSB" | grep -qi "1d50:6089"  && HAS_HACKRF=true

# SDRplay RSPs (vendor 1df7):
#   RSP1     1df7:2500
#   RSP1A    1df7:3000
#   RSP1B    1df7:3000  (same product ID as 1A)
#   RSP2     1df7:2700
#   RSPduo   1df7:3010
#   RSPdx    1df7:3020
#   RSPdx-R2 1df7:3030
echo "$LSUSB" | grep -qi "1df7:2500"  && HAS_RSP1=true
echo "$LSUSB" | grep -qi "1df7:3000"  && HAS_RSP1A=true
echo "$LSUSB" | grep -qi "1df7:3010"  && HAS_RSPDUO=true
echo "$LSUSB" | grep -qi "1df7:3020\|1df7:3030"  && HAS_RSPDX=true

# Treat any RSP as "RSP-class" for profile selection
HAS_RSP=false
if $HAS_RSP1 || $HAS_RSP1A || $HAS_RSPDUO || $HAS_RSPDX; then
  HAS_RSP=true
fi

# RTL-SDR: most common IDs
#   2832: 0bda:2832  (Realtek RTL2832U)
#   2838: 0bda:2838  (most common — RTL2838UHIDIR / generic dongle)
echo "$LSUSB" | grep -qiE "0bda:283[28]" && HAS_RTL=true

# --- Status to stderr ---
echo "[detect-sdrs] USB devices:" >&2
$HAS_HACKRF && echo "  ✓ HackRF One" >&2
$HAS_RSP1   && echo "  ✓ SDRplay RSP1" >&2
$HAS_RSP1A  && echo "  ✓ SDRplay RSP1A / RSP1B" >&2
$HAS_RSPDUO && echo "  ✓ SDRplay RSPduo" >&2
$HAS_RSPDX  && echo "  ✓ SDRplay RSPdx / RSPdx-R2" >&2
$HAS_RTL    && echo "  ✓ RTL-SDR" >&2
$HAS_HACKRF || $HAS_RSP || $HAS_RTL || echo "  (none detected)" >&2

# --- Profile selection logic ---
# Preference order for control channel: RTL-SDR > RSP > HackRF
#   RTL-SDR is rock-solid for narrow control channel decode and frees the
#   better radios for voice. RSP1 is a fine fallback.
# Preference order for voice: HackRF > RSP > RTL-SDR
#   HackRF has the widest bandwidth (8+ MHz) needed to span all voice freqs.
#   RSP1 maxes around 8-10 MHz, also usable.
#   RTL-SDR maxes around 2.4 MHz — too narrow for voice on this system.

if   $HAS_HACKRF && $HAS_RTL && $HAS_RSP; then
  echo "rsp1-hackrf-rtl"
elif $HAS_HACKRF && $HAS_RTL; then
  echo "hackrf-rtl"
elif $HAS_HACKRF && $HAS_RSP; then
  echo "hackrf-rsp1"
elif $HAS_RSP && $HAS_RTL; then
  echo "rsp1-rtl"
elif $HAS_HACKRF; then
  echo "hackrf-only"
elif $HAS_RSP; then
  echo "rsp1-only"
elif $HAS_RTL; then
  echo "rtl-only"
else
  echo "none"
fi
