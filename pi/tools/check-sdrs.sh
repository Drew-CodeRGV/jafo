#!/usr/bin/env bash
# jafo — SDR pre-flight check.
# Tests detection, kernel modules, USB power, and per-device responsiveness
# for HackRF, RTL-SDR, and SDRplay RSP series.
#
set -uo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
bad()  { echo -e "  ${RED}✗${NC} $*"; }
warn() { echo -e "  ${YELLOW}!${NC} $*"; }
hdr()  { echo -e "\n${BOLD}$*${NC}"; }

PROBLEMS=0

# ----------------------------------------------------------------------------
# Use lsusb to know what we *expect* to find — only flag missing devices that
# are physically plugged in.
# ----------------------------------------------------------------------------
LSUSB="$(lsusb 2>/dev/null || true)"
EXPECT_HACKRF=false
EXPECT_RSP=false
EXPECT_RTL=false
echo "$LSUSB" | grep -qi "1d50:6089"          && EXPECT_HACKRF=true
echo "$LSUSB" | grep -qiE "1df7:(2500|3000|3010|3020|3030|2700)" && EXPECT_RSP=true
echo "$LSUSB" | grep -qiE "0bda:283[28]"      && EXPECT_RTL=true

hdr "0. USB devices (via lsusb)"
$EXPECT_HACKRF && ok "HackRF One present on USB" || warn "HackRF not plugged in (skipping HackRF tests)"
$EXPECT_RSP    && ok "SDRplay RSP present on USB" || warn "SDRplay RSP not plugged in (skipping RSP tests)"
$EXPECT_RTL    && ok "RTL-SDR present on USB"     || warn "RTL-SDR not plugged in (skipping RTL tests)"

# ----------------------------------------------------------------------------
hdr "1. SoapySDR detection"
SOAPY="$(SoapySDRUtil --find 2>/dev/null || true)"
if $EXPECT_HACKRF; then
  echo "$SOAPY" | grep -qi hackrf && ok "HackRF visible to SoapySDR" \
    || { bad "HackRF NOT visible to SoapySDR"; PROBLEMS=$((PROBLEMS+1)); }
fi
if $EXPECT_RSP; then
  echo "$SOAPY" | grep -qi sdrplay && ok "SDRplay visible to SoapySDR" \
    || { bad "SDRplay NOT visible to SoapySDR (driver not installed?)"; PROBLEMS=$((PROBLEMS+1)); }
fi
if $EXPECT_RTL; then
  echo "$SOAPY" | grep -qi rtl && ok "RTL-SDR visible to SoapySDR" \
    || { bad "RTL-SDR NOT visible to SoapySDR"; PROBLEMS=$((PROBLEMS+1)); }
fi

# ----------------------------------------------------------------------------
if $EXPECT_HACKRF; then
  hdr "2. HackRF native tool"
  if command -v hackrf_info >/dev/null 2>&1; then
    HACKRF_INFO="$(hackrf_info 2>&1 | head -20 || true)"
    if echo "$HACKRF_INFO" | grep -qi "Serial number"; then
      SERIAL="$(echo "$HACKRF_INFO" | grep -i serial | head -1 | awk -F: '{print $2}' | xargs)"
      ok "HackRF responsive  (serial: $SERIAL)"
    else
      bad "HackRF unresponsive"; PROBLEMS=$((PROBLEMS+1))
    fi
  else
    bad "hackrf_info not installed"; PROBLEMS=$((PROBLEMS+1))
  fi
fi

# ----------------------------------------------------------------------------
if $EXPECT_RTL; then
  hdr "3. RTL-SDR native tool"
  if command -v rtl_test >/dev/null 2>&1; then
    RTL_OUTPUT="$(timeout 3 rtl_test -t 2>&1 | head -20 || true)"
    if echo "$RTL_OUTPUT" | grep -qi "Found"; then
      ok "RTL-SDR responsive  ($(echo "$RTL_OUTPUT" | grep -i Found | head -1))"
    else
      bad "RTL-SDR unresponsive"; PROBLEMS=$((PROBLEMS+1))
    fi
  else
    bad "rtl_test not installed"; PROBLEMS=$((PROBLEMS+1))
  fi
fi

# ----------------------------------------------------------------------------
if $EXPECT_RSP; then
  hdr "4. SDRplay API + service"
  if [[ -f /usr/local/lib/libsdrplay_api.so ]]; then
    ok "libsdrplay_api.so installed"
  else
    bad "SDRplay API not installed (libsdrplay_api.so missing)"
    warn "Run: bash ~/jafo/pi/build-sdrplay.sh"
    PROBLEMS=$((PROBLEMS+1))
  fi
  if systemctl is-active --quiet sdrplay.service 2>/dev/null; then
    ok "sdrplay.service running"
  else
    bad "sdrplay.service not running"
    warn "Try: sudo systemctl restart sdrplay.service"
    PROBLEMS=$((PROBLEMS+1))
  fi
  # Probe deeper via SoapySDR
  PROBE="$(SoapySDRUtil --probe='driver=sdrplay' 2>&1 | head -30 || true)"
  if echo "$PROBE" | grep -qi "hardware="; then
    HW="$(echo "$PROBE" | grep -i 'hardware=' | head -1)"
    ok "SDRplay probe successful  ($HW)"
  else
    bad "SDRplay probe failed"
    warn "Output:"
    echo "$PROBE" | head -10 | sed 's/^/    /'
    PROBLEMS=$((PROBLEMS+1))
  fi
fi

# ----------------------------------------------------------------------------
hdr "5. Kernel modules"
DVB_LOADED="$(lsmod | grep -E 'dvb_usb_rtl|rtl283' || true)"
if [[ -z "$DVB_LOADED" ]]; then
  ok "DVB-T modules not loaded (good for RTL-SDR)"
else
  bad "DVB-T modules ARE loaded — they fight RTL-SDR:"
  echo "$DVB_LOADED" | sed 's/^/    /'
  warn "Fix: ensure /etc/modprobe.d/blacklist-rtl.conf has the entries, then reboot."
  PROBLEMS=$((PROBLEMS+1))
fi
MSI_LOADED="$(lsmod | grep -E 'msi2500|sdr_msi' || true)"
if [[ -z "$MSI_LOADED" ]]; then
  ok "msi2500 not loaded (good for SDRplay)"
else
  bad "msi2500 IS loaded — it fights with the SDRplay API:"
  echo "$MSI_LOADED" | sed 's/^/    /'
  warn "Fix: blacklist file should already include msi2500. Reboot."
  PROBLEMS=$((PROBLEMS+1))
fi

# ----------------------------------------------------------------------------
hdr "6. USB power state"
DMESG_RECENT="$(dmesg -T 2>/dev/null | tail -50 || sudo dmesg -T 2>/dev/null | tail -50 || true)"
if echo "$DMESG_RECENT" | grep -qiE "under.?voltage|undervolt"; then
  bad "Recent under-voltage warnings:"
  echo "$DMESG_RECENT" | grep -iE "under.?voltage|undervolt" | tail -3 | sed 's/^/    /'
  warn "Use the official Pi 5 27W PSU + powered USB hub."
  PROBLEMS=$((PROBLEMS+1))
else
  ok "No under-voltage warnings"
fi
if echo "$DMESG_RECENT" | grep -qiE "device descriptor read.*error|low.?speed device"; then
  bad "USB errors detected:"
  echo "$DMESG_RECENT" | grep -iE "device descriptor read.*error|low.?speed device" | tail -3 | sed 's/^/    /'
  warn "All SDRs need a powered USB hub. Pi USB direct often fails."
  PROBLEMS=$((PROBLEMS+1))
else
  ok "No USB descriptor errors"
fi

# ----------------------------------------------------------------------------
hdr "7. Group membership"
if id -nG pi 2>/dev/null | grep -qw plugdev; then
  ok "User 'pi' is in plugdev group"
else
  warn "User 'pi' NOT in plugdev group. Fix: sudo usermod -aG plugdev pi (then log out/in)"
fi

# ----------------------------------------------------------------------------
hdr "8. trunk-recorder"
if command -v trunk-recorder >/dev/null 2>&1; then
  ok "trunk-recorder installed: $(trunk-recorder --version 2>&1 | head -1)"
else
  bad "trunk-recorder not installed"; PROBLEMS=$((PROBLEMS+1))
fi

# ----------------------------------------------------------------------------
hdr "9. GNU Radio"
if command -v gnuradio-config-info >/dev/null 2>&1; then
  ok "GNU Radio installed: $(gnuradio-config-info --version 2>/dev/null)"
else
  bad "GNU Radio not installed"; PROBLEMS=$((PROBLEMS+1))
fi

# ----------------------------------------------------------------------------
hdr "10. Active jafo profile"
if [[ -f /home/pi/jafo-data/config/.active-profile ]]; then
  PROFILE="$(cat /home/pi/jafo-data/config/.active-profile)"
  EXPECTED="$(bash /home/pi/jafo/pi/tools/detect-sdrs.sh 2>/dev/null | tail -1)"
  ok "Active profile: $PROFILE"
  if [[ "$PROFILE" != "$EXPECTED" ]]; then
    warn "USB devices now suggest profile '$EXPECTED' — re-run installer to switch:"
    warn "  bash ~/jafo/pi/install-pi.sh"
  fi
else
  warn "No active profile recorded. Re-run installer."
fi

# ----------------------------------------------------------------------------
echo ""
echo "============================================================"
if [[ $PROBLEMS -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}ALL CHECKS PASSED${NC} — jafo is ready."
else
  echo -e "  ${RED}${BOLD}$PROBLEMS problem(s) found.${NC} See above."
fi
echo "============================================================"
echo ""
exit $PROBLEMS
