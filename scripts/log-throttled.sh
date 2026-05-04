#!/bin/bash
# Log vcgencmd get_throttled output every cron tick.
# The throttled register has sticky "X has occurred" bits (16,17,18,19) that
# survive until reboot — so if the Pi crashes, the LAST log line before death
# tells us whether undervoltage / thermal soft-cap fired.
#
# We rotate at 1 MB to keep this bounded. Lines are tiny (~50 bytes) so this
# easily holds days of history.

set -u
LOG=/home/pi/jafo-data/logs/throttled.log
mkdir -p "$(dirname "$LOG")"

THROTTLED=$(vcgencmd get_throttled 2>/dev/null || echo "throttled=ERR")
TEMP=$(vcgencmd measure_temp 2>/dev/null | sed 's/temp=//;s/.$//' || echo "?")
LOAD=$(awk '{print $1}' /proc/loadavg)
MEM=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)

# Decode flag bits
HEX=$(echo "$THROTTLED" | sed 's/.*=0x//')
if [ "$HEX" = "0" ] || [ -z "$HEX" ]; then
    FLAGS="ok"
else
    DEC=$((16#$HEX))
    F=()
    [ $((DEC & 0x1))     -ne 0 ] && F+=("UNDERVOLT_NOW")
    [ $((DEC & 0x2))     -ne 0 ] && F+=("THROTTLED_NOW")
    [ $((DEC & 0x4))     -ne 0 ] && F+=("CAPPED_NOW")
    [ $((DEC & 0x10000)) -ne 0 ] && F+=("UNDERVOLT_HAS_OCCURRED")
    [ $((DEC & 0x20000)) -ne 0 ] && F+=("THROTTLED_HAS_OCCURRED")
    [ $((DEC & 0x40000)) -ne 0 ] && F+=("CAPPED_HAS_OCCURRED")
    [ $((DEC & 0x80000)) -ne 0 ] && F+=("SOFT_TEMP_LIMIT_HAS_OCCURRED")
    FLAGS="${F[*]:-?}"
fi

printf "%s temp=%s load=%s mem_avail_kB=%s %s flags=%s\n" \
    "$(date -Iseconds)" "$TEMP" "$LOAD" "$MEM" "$THROTTLED" "$FLAGS" >> "$LOG"

# Rotate at 1 MB
SIZE=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
if [ "$SIZE" -gt 1048576 ]; then
    mv "$LOG" "$LOG.1"
fi
