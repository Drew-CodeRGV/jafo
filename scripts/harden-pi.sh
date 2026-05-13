#!/usr/bin/env bash
# harden-pi.sh — make a Raspberry Pi a single-purpose jafo capture station.
#
# Idempotent. Safe to re-run. Designed for fresh and existing Pi nodes.
#
# What it does, in order:
#   1. Disables every service that has no business on a capture station
#      (lightdm, bluetooth, cups, NFS, sdrplay, wayvnc, tar1090, cloud-init,
#      etc.). Services are *disabled + stopped*, not purged, so they can be
#      restored if needed.
#   2. Optionally purges desktop bloat packages with --purge (chromium,
#      firefox, vlc, hplip, libreoffice-*, geany, etc.). Default off.
#   3. Moves systemd-journal off the SD card onto the NVMe at
#      /home/pi/jafo-data/journal, capped at 500 MB, with rate-limiting so
#      a misbehaving service can't pin the disk.
#   4. Masks man-db.timer (was triggering nightly freezes) and gives the
#      remaining nightly maintenance timers idle CPU + IO priority.
#   5. Tunes sysctl for our workload (low swappiness, longer TCP keepalive,
#      bigger inotify watches, etc.).
#   6. Installs / reinstalls all hardened jafo systemd units, enables them,
#      and starts them.
#   7. Verifies every jafo-* service is active at the end.
#
# Usage:
#     sudo bash ~/jafo/scripts/harden-pi.sh             # disable bloat services
#     sudo bash ~/jafo/scripts/harden-pi.sh --purge     # also apt-purge GUI bloat
#     sudo bash ~/jafo/scripts/harden-pi.sh --dry-run   # show actions, change nothing

set -euo pipefail

PURGE=0
DRY=0
for arg in "$@"; do
    case "$arg" in
        --purge)   PURGE=1 ;;
        --dry-run) DRY=1 ;;
        -h|--help)
            sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'
            exit 0 ;;
        *) echo "unknown arg: $arg"; exit 1 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "Must run as root: sudo bash $0" >&2
    exit 1
fi

REPO=/home/pi/jafo
DATA=/home/pi/jafo-data
PI_USER=pi
PI_GROUP=pi

step()   { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()     { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip()   { printf '  \033[33m·\033[0m %s\n' "$*"; }
warn()   { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()    { printf '  \033[31m✗\033[0m %s\n' "$*"; }

run() {
    if (( DRY )); then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

# ---------------------------------------------------------------------------
# 1. Disable services that have no business on a capture station
# ---------------------------------------------------------------------------
step "Disabling non-essential services"

# Each line is a unit to mask (mask = disabled + can't be started even by
# socket activation). Use mask not disable so something doesn't accidentally
# re-enable them.
MASK_UNITS=(
    lightdm.service                  # display manager (we're headless)
    bluetooth.service                # no Bluetooth use case
    cups.service                     # printing? on a capture station? no
    cups.socket
    cups.path
    cups-browsed.service
    # avahi-daemon — KEEP. jafo.local mDNS is how we reach the Pi from a browser.
    nfs-blkmap.service               # NFS client bits we don't use
    rpcbind.service
    rpcbind.socket
    rpc-statd.service
    udisks2.service                  # auto-mount daemon (desktop-only)
    accounts-daemon.service          # GUI user-accounts daemon
    polkit.service                   # only needed when GUI/Polkit clients exist
    wayvnc-control.service           # VNC
    sdrplay.service                  # SDRplay daemon — no longer using SDRplay
    tar1090.service                  # ADS-B web UI — we have /dashboard
    glamor-test.service              # one-shot boot test
    rp1-test.service                 # one-shot boot test
    sshswitch.service                # SSH first-boot helper
    regenerate_ssh_host_keys.service # one-shot, already ran
    rpi-eeprom-update.service        # runs only at boot, not service-y
    serial-getty@ttyAMA10.service    # serial console (re-enable if debugging)
    getty@tty1.service               # console login on tty1 (we're SSH-only)
    cloud-init.service               # cloud-init not used on bare Pi
    cloud-init-local.service
    cloud-init-network.service
    cloud-init-main.service
    cloud-config.service
    cloud-final.service
    cloud-init-hotplugd.socket
    e2scrub_all.timer                # fs scrub — we have ext4 on NVMe, low value
    e2scrub_reap.service
    apt-daily.timer                  # downloads apt indices daily (use idle-IO if kept)
    apt-daily-upgrade.timer          # auto-installs security updates (manual instead)
    man-db.timer                     # rebuilds man-db nightly — the freeze trigger
    fwupd-refresh.timer              # firmware metadata refresh
    fwupd.service
)
for unit in "${MASK_UNITS[@]}"; do
    if systemctl list-unit-files --no-legend "$unit" 2>/dev/null | grep -q "$unit"; then
        run systemctl disable --now "$unit" 2>/dev/null || true
        run systemctl mask "$unit" 2>/dev/null || true
        ok "masked $unit"
    else
        skip "$unit (not present)"
    fi
done

# ---------------------------------------------------------------------------
# 2. Optionally purge desktop / GUI / printing / browser bloat
# ---------------------------------------------------------------------------
if (( PURGE )); then
    step "Purging desktop / GUI bloat packages (--purge)"
    PURGE_PKGS=(
        chromium chromium-common chromium-l10n chromium-sandbox
        firefox firefox-esr
        vlc vlc-bin vlc-data vlc-plugin-*
        libreoffice libreoffice-*
        hplip hplip-data printer-driver-* cups cups-* cups-daemon
        bluez bluez-firmware bluez-tools
        labwc lightdm lightdm-gtk-greeter
        pcmanfm pi-package pi-package-data pi-package-session
        piclone piwiz rpi-imager
        geany geany-common
        gnome-desktop3-data gnome-keyring
        sense-hat
        wayvnc
        tar1090
        sdrplay-api
        snapd
    )
    # Translate to a real list (only purge ones actually installed)
    INSTALLED=()
    for p in "${PURGE_PKGS[@]}"; do
        if dpkg -l "$p" 2>/dev/null | awk 'NR==6 {print $1}' | grep -q '^ii$'; then
            INSTALLED+=("$p")
        fi
    done
    if [[ ${#INSTALLED[@]} -gt 0 ]]; then
        run apt-get -y --purge remove "${INSTALLED[@]}" || warn "apt purge had issues"
        run apt-get -y autoremove --purge
        run apt-get -y clean
        ok "purged: ${#INSTALLED[@]} packages"
    else
        skip "nothing in purge list is installed"
    fi
fi

# ---------------------------------------------------------------------------
# 3. Move systemd-journal onto NVMe with sane caps + rate limit
# ---------------------------------------------------------------------------
step "Relocating systemd journal to NVMe + rate-limiting"

run install -d -o root -g systemd-journal -m 2755 "$DATA/journal"

run mkdir -p /etc/systemd/journald.conf.d
if (( DRY )); then
    printf '  [dry-run] would write /etc/systemd/journald.conf.d/jafo.conf\n'
else
    cat > /etc/systemd/journald.conf.d/jafo.conf <<'CONF'
[Journal]
Storage=persistent
SystemMaxUse=500M
SystemKeepFree=2G
RuntimeMaxUse=64M
RateLimitIntervalSec=30s
RateLimitBurst=2000
ForwardToSyslog=no
ForwardToWall=no
CONF
fi

if ! mountpoint -q /var/log/journal 2>/dev/null; then
    run mkdir -p /var/log/journal
    run mount --bind "$DATA/journal" /var/log/journal
    if ! grep -q "$DATA/journal /var/log/journal" /etc/fstab; then
        run bash -c "echo '$DATA/journal /var/log/journal none bind 0 0' >> /etc/fstab"
    fi
    ok "journal bind-mounted SD→NVMe + persisted in fstab"
else
    skip "/var/log/journal already a mountpoint"
fi

run systemctl restart systemd-journald
ok "journald restarted"

# ---------------------------------------------------------------------------
# 4. Idle-class the remaining nightly maintenance timers (logrotate, fstrim,
#    dpkg-db-backup) so they yield to the recorder pipeline.
# ---------------------------------------------------------------------------
step "Idle-class for nightly maintenance"
for t in logrotate dpkg-db-backup fstrim; do
    if systemctl list-unit-files --no-legend "${t}.timer" 2>/dev/null | grep -q "${t}"; then
        run mkdir -p "/etc/systemd/system/${t}.service.d"
        if (( DRY )); then
            printf '  [dry-run] would write idle-io.conf for %s\n' "$t"
        else
            cat > "/etc/systemd/system/${t}.service.d/idle-io.conf" <<'CONF'
[Service]
Nice=19
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
CONF
        fi
        ok "idle-class: $t"
    else
        skip "$t.timer (not present)"
    fi
done

# ---------------------------------------------------------------------------
# 5. sysctl tunings for a capture station
# ---------------------------------------------------------------------------
step "Kernel tunings"
if (( DRY )); then
    printf '  [dry-run] would write /etc/sysctl.d/99-jafo.conf\n'
else
    cat > /etc/sysctl.d/99-jafo.conf <<'CONF'
# jafo capture-station tuning

# Use swap reluctantly; prefer dropping page cache
vm.swappiness=10
# Don't OOM-kill until truly necessary
vm.overcommit_memory=0
# Bigger pipe buffers for trunk-recorder ZMQ-ish IPC
fs.pipe-max-size=8388608
# Many WAV file watches when trunk-recorder is busy
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=1024
# Network: be polite to long-lived TCP to jafo.live (HTTPS keepalive)
net.ipv4.tcp_keepalive_time=300
net.ipv4.tcp_keepalive_intvl=30
net.ipv4.tcp_keepalive_probes=5
# Disable IPv6 for the modem path (the modem only does v4 reliably anyway)
# (commented — re-enable if your link is v6-capable)
# net.ipv6.conf.all.disable_ipv6=1
CONF
fi
run sysctl --system >/dev/null
ok "sysctl applied"

# ---------------------------------------------------------------------------
# 6. Install hardened jafo systemd units from repo
# ---------------------------------------------------------------------------
step "Installing jafo systemd units"
JAFO_UNITS=(
    jafo-recorder
    jafo-processor
    jafo-transcriber
    jafo-enricher
    jafo-uploader
    jafo-web
    jafo-cellmon
    ollama
)
for unit in "${JAFO_UNITS[@]}"; do
    src="$REPO/pi/systemd/${unit}.service"
    dst="/etc/systemd/system/${unit}.service"
    if [[ -f "$src" ]]; then
        run install -m 0644 "$src" "$dst"
        ok "installed $unit.service"
    else
        warn "$src missing — skipping"
    fi
done
run systemctl daemon-reload

# Decide which units to enable. Ollama is opt-in: only enable if a model
# is already pulled (otherwise it'd start but be useless).
TO_ENABLE=(jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-uploader jafo-web jafo-cellmon)
if [[ -d /home/pi/.ollama/models/manifests ]] && \
   find /home/pi/.ollama/models/manifests -mindepth 1 -name latest 2>/dev/null | grep -q .; then
    TO_ENABLE+=(ollama)
    ok "ollama: model present, will enable"
else
    skip "ollama: no models pulled, leaving disabled"
fi

for unit in "${TO_ENABLE[@]}"; do
    run systemctl enable "$unit" 2>/dev/null || true
done

# ---------------------------------------------------------------------------
# 7. Restart all jafo services and verify
# ---------------------------------------------------------------------------
step "Restarting jafo services"
for unit in "${TO_ENABLE[@]}"; do
    run systemctl restart "$unit" || warn "$unit failed to restart"
done

sleep 3

step "Health check"
ALL_OK=1
for unit in "${TO_ENABLE[@]}"; do
    if systemctl is-active --quiet "$unit"; then
        ok "$unit active"
    else
        err "$unit NOT active"
        ALL_OK=0
    fi
done

step "Summary"
echo "  enabled jafo units: ${#TO_ENABLE[@]}"
echo "  masked bloat units: ${#MASK_UNITS[@]}"
echo "  journal location:   $(findmnt -no SOURCE /var/log/journal 2>/dev/null || echo 'SD card')"
echo "  free RAM:           $(awk '/MemAvailable/ {printf "%d MB", $2/1024}' /proc/meminfo)"
echo "  disk used (root):   $(df -h / | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')"
echo "  disk used (data):   $(df -h $DATA | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')"

if (( ALL_OK )); then
    printf '\n\033[1;32m✓ Pi hardened and running.\033[0m\n'
else
    printf '\n\033[1;31m! Some services failed to start — inspect with: journalctl -u <unit> -n 50\033[0m\n'
    exit 1
fi
