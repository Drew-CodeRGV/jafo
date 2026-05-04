#!/bin/bash
# Idempotent launcher for jafo-uploader (since we can't yet install it as systemd).
# - Kills any prior instance
# - Starts a fresh detached one with setsid
# - Logs to /home/pi/jafo-data/logs/uploader.log

set -u
LOG=/home/pi/jafo-data/logs/uploader.log
mkdir -p "$(dirname "$LOG")"

pkill -f "pi/services/uploader.py" 2>/dev/null
sleep 1

setsid /home/pi/jafo-data/venv-services/bin/python -u \
  /home/pi/jafo/pi/services/uploader.py \
  >> "$LOG" 2>&1 < /dev/null &

# Don't wait — exit clean
exit 0
