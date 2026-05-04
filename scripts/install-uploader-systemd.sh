#!/bin/bash
# Promote jafo-uploader from cron @reboot → systemd service.
# Run once with sudo:
#     sudo /home/pi/jafo/scripts/install-uploader-systemd.sh
#
# What this does (idempotent — safe to re-run):
#   1. Drops a /etc/sudoers.d/jafo-uploader so pi can manage the unit
#      with the same NOPASSWD pattern as the other jafo services.
#   2. Copies the unit file into /etc/systemd/system and daemon-reloads.
#   3. Strips the cron @reboot + */5 watchdog lines for uploader from
#      pi's crontab (the throttled-logger cron stays).
#   4. Kills the cron-launched uploader so systemd takes over cleanly.
#   5. enable --now jafo-uploader, then prints status.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Must run as root: sudo $0" >&2
    exit 1
fi

REPO=/home/pi/jafo
UNIT_SRC=$REPO/pi/systemd/jafo-uploader.service
UNIT_DST=/etc/systemd/system/jafo-uploader.service
SUDOERS=/etc/sudoers.d/jafo-uploader

if [ ! -f "$UNIT_SRC" ]; then
    echo "ERROR: $UNIT_SRC not found." >&2
    exit 1
fi

echo "[1/6] writing $SUDOERS ..."
cat > "$SUDOERS" <<'EOF'
pi ALL=(root) NOPASSWD: /bin/systemctl restart jafo-uploader
pi ALL=(root) NOPASSWD: /bin/systemctl start jafo-uploader
pi ALL=(root) NOPASSWD: /bin/systemctl stop jafo-uploader
pi ALL=(root) NOPASSWD: /bin/systemctl status jafo-uploader
pi ALL=(root) NOPASSWD: /bin/systemctl is-active jafo-uploader
pi ALL=(root) NOPASSWD: /bin/systemctl is-failed jafo-uploader
pi ALL=(root) NOPASSWD: /bin/journalctl -u jafo-uploader *
EOF
chmod 0440 "$SUDOERS"
visudo -cf "$SUDOERS" >/dev/null
echo "    sudoers: ok"

echo "[2/6] installing unit ..."
install -m 0644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload

echo "[3/6] cleaning pi crontab ..."
sudo -u pi bash -c '
  ( crontab -l 2>/dev/null | grep -v -E "uploader\.py|start-uploader\.sh" ) | crontab -
'

echo "[4/6] killing cron-launched uploader ..."
pkill -f "pi/services/uploader.py" || true
sleep 2

echo "[5/6] enable + start jafo-uploader ..."
systemctl enable --now jafo-uploader
sleep 3

echo ""
echo "[6/6] DONE."
echo "─────────────────────────────────────"
systemctl status jafo-uploader --no-pager | head -15
echo "─────────────────────────────────────"
echo ""
echo "pi crontab now:"
sudo -u pi crontab -l
echo ""
echo "Recent uploader log lines:"
journalctl -u jafo-uploader -n 5 --no-pager
