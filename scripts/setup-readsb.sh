#!/bin/bash
# Install + configure readsb (wiedehopf's build, with RTL-SDR support).
#
# Background: the Debian-packaged `readsb` ships without librtlsdr support
# (only modesbeast/gnshulc/ifile/none are linked in), and FlightAware's
# package URL changed for the 2026 release cycle. wiedehopf's installer
# is the de-facto standard for Pi ADS-B receivers — it builds readsb with
# full RTL support, sets up the systemd unit, and writes JSON to a path
# jafo-web already knows about.
#
# Bound to the RTL-SDR with serial 00000001 (the new dongle). JSON is
# written every second to /run/readsb/aircraft.json — jafo-web's
# /api/aircraft endpoint detects it and reports data_source=readsb-local.
#
# Run with: sudo bash ~/jafo/scripts/setup-readsb.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "must be run with sudo: sudo bash $0"
    exit 1
fi

echo "==> stop any prior decoder so it doesn't fight for the dongle"
systemctl stop readsb dump1090 dump1090-fa dump1090-mutability 2>/dev/null || true
systemctl disable readsb dump1090 dump1090-fa dump1090-mutability 2>/dev/null || true

echo
echo "==> remove the broken Debian readsb (no RTL support) so wiedehopf's can take its place"
apt remove -y readsb 2>/dev/null || true

echo
echo "==> run wiedehopf's readsb installer (builds with RTL support, ~3-5 min)"
# The installer is interactive by default but supports answers via env vars.
# We feed it: rtlsdr device, serial 00000001, gain auto (-10), no tar1090
# web UI (port 8080 is gunicorn). Don't worry about lat/lon — we'll set
# those after via the config file.
export READSB_INSTALL_INTERACTIVE=no
bash -c "$(wget -nv -O - https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh)"

echo
echo "==> configuring /etc/default/readsb"
# Override whatever the installer wrote — point at our specific dongle by
# serial number, not by index, so we don't fight with future RTL additions.
cat > /etc/default/readsb <<'CONFIG'
RECEIVER_OPTIONS="--device-type rtlsdr --device 00000001 --gain -10 --ppm 0"
DECODER_OPTIONS="--max-range 360"
NET_OPTIONS="--net --net-heartbeat 60 --net-ro-size 1280 --net-ro-interval 0.2 --net-ri-port 30001 --net-ro-port 30002 --net-sbs-port 30003 --net-bi-port 30004,30104 --net-bo-port 30005"
JSON_OPTIONS="--write-json /run/readsb --write-json-every 1 --json-location-accuracy 2"
CONFIG

echo
echo "==> add pi to readsb group so jafo-web can read /run/readsb/"
if getent group readsb > /dev/null; then
    usermod -aG readsb pi || true
fi

echo
echo "==> restart"
systemctl enable readsb
systemctl restart readsb
sleep 7
systemctl is-active readsb || {
    echo
    echo "readsb still failed. last log:"
    journalctl -u readsb --no-pager --since "60 seconds ago" | tail -25
    exit 1
}

echo
echo "==> verify aircraft.json"
JSON=/run/readsb/aircraft.json
if [[ -f $JSON ]]; then
    sz=$(stat -c %s "$JSON")
    age=$(( $(date +%s) - $(stat -c %Y "$JSON") ))
    n=$(python3 -c "import json; d=json.load(open('$JSON')); print(len(d.get('aircraft',[])))" 2>/dev/null || echo "?")
    echo "    $JSON: ${sz} bytes, ${age}s old, ${n} aircraft visible"
else
    echo "    $JSON not present yet — give it 30s for the first scan and re-check"
fi

echo
echo "==> done. /api/aircraft should now report data_source=readsb-local."
echo "    quick test:"
echo "      curl -s http://localhost:8080/api/aircraft?region=rgv | python3 -c 'import sys,json; d=json.load(sys.stdin); print(\"source:\", d.get(\"data_source\"), \"count:\", d.get(\"count\"))'"
