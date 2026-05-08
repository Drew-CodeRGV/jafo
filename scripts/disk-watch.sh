#!/bin/bash
# jafo disk-space watchdog — emits a warning to the journal when any monitored
# mountpoint is over THRESHOLD_PCT full, so we don't get blindsided like
# 2026-05-08 when the SD card filled up and the system crashed.
# Designed to run from /etc/cron.hourly. No external deps.

set -u
THRESHOLD_PCT=85
MOUNTS=( "/" "/home/pi/jafo-data" )

for mp in "${MOUNTS[@]}"; do
    if ! mountpoint -q "$mp" && [[ "$mp" != "/" ]]; then
        continue
    fi
    USED_PCT=$(df -P "$mp" | awk 'NR==2 { gsub("%",""); print $5 }')
    [[ -z "$USED_PCT" ]] && continue
    if (( USED_PCT >= THRESHOLD_PCT )); then
        AVAIL=$(df -h "$mp" | awk 'NR==2 { print $4 }')
        logger -t jafo-disk -p user.warning \
            "$mp ${USED_PCT}% full (only ${AVAIL} free) — clean up before crash"
    fi
done
