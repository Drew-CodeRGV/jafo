#!/usr/bin/env bash
#
# jafo — prepare an SD card for autoboot installation
#
# Run this on your laptop/desktop AFTER flashing Pi OS Lite (64-bit, Bookworm)
# to the SD card with the Raspberry Pi Imager.
#
# What it does:
#   1. Copies jafo-autoboot.sh to the boot partition
#   2. Modifies cmdline.txt to run jafo-autoboot.sh on first boot
#   3. Verifies SSH is enabled (so you can monitor progress remotely)
#
# After running this, eject the SD card, put it in the Pi, power on, and
# walk away. The Pi will install everything over ~30 minutes and reboot
# into the running jafo system.
#
# Usage:
#   ./prepare-sdcard.sh /path/to/bootfs
#
# Where the boot partition is mounted:
#   macOS:   /Volumes/bootfs
#   Linux:   /run/media/$USER/bootfs   (or /media/$USER/bootfs)
#   Windows: use Git Bash with the drive letter, e.g. /e or //e/
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[jafo-prep]${NC} $*"; }
warn()  { echo -e "${YELLOW}[jafo-prep]${NC} $*"; }
fail()  { echo -e "${RED}[jafo-prep]${NC} $*" >&2; exit 1; }

# ----------------------------------------------------------------------------
# Args
# ----------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  cat <<EOF
${BOLD}jafo SD card preparation${NC}

Usage: $0 <path-to-bootfs>

Examples:
  macOS:   $0 /Volumes/bootfs
  Linux:   $0 /run/media/\$USER/bootfs
  Windows: $0 /e   (in Git Bash, where E: is the boot partition)

Make sure you've already:
  1. Flashed Raspberry Pi OS Lite (64-bit, Bookworm) with the Imager
  2. Set hostname, user (must be 'pi'), password, WiFi, and enabled SSH
     in the Imager's Advanced Options
  3. The SD card is still in your machine and the boot partition is mounted
EOF
  exit 1
fi

BOOT="$1"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# ----------------------------------------------------------------------------
# Sanity: is this actually a Pi boot partition?
# ----------------------------------------------------------------------------
[[ -d "$BOOT" ]] || fail "$BOOT does not exist or isn't a directory."

if [[ ! -f "$BOOT/cmdline.txt" ]]; then
  fail "No cmdline.txt found in $BOOT — that doesn't look like a Pi boot partition.
Make sure you're pointing at the FAT32 boot partition (called 'bootfs' on Bookworm),
not the larger Linux root partition (which Windows/Mac can't read anyway)."
fi

if ! grep -q "raspberrypi\|console=tty\|root=PARTUUID" "$BOOT/cmdline.txt" 2>/dev/null; then
  warn "cmdline.txt exists but doesn't look like a stock Pi cmdline."
  warn "Continuing anyway — but double-check this is the right partition."
fi

info "Boot partition looks good: $BOOT"

# ----------------------------------------------------------------------------
# Sanity: did the user run Imager's Advanced Options?
# ----------------------------------------------------------------------------
if [[ ! -f "$BOOT/firstrun.sh" ]] && [[ ! -f "$BOOT/userconf.txt" ]] && [[ ! -f "$BOOT/userconf" ]]; then
  warn "No firstrun.sh / userconf detected. This usually means you didn't"
  warn "set the user/password/SSH/WiFi in the Pi Imager's Advanced Options."
  warn "If you didn't, the Pi will boot but you won't be able to log into it."
  warn ""
  read -rp "Continue anyway? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || exit 1
fi

# ----------------------------------------------------------------------------
# Find our autoboot script (next to this script)
# ----------------------------------------------------------------------------
AUTOBOOT_SRC="$SCRIPT_DIR/jafo-autoboot.sh"
[[ -f "$AUTOBOOT_SRC" ]] || fail "Cannot find $AUTOBOOT_SRC — is the repo intact?"

# ----------------------------------------------------------------------------
# Copy autoboot script to boot partition
# ----------------------------------------------------------------------------
info "Copying jafo-autoboot.sh to $BOOT/"
cp "$AUTOBOOT_SRC" "$BOOT/jafo-autoboot.sh"
# FAT32 doesn't track Unix permissions, but it doesn't matter — we'll chmod
# it on the Pi side before executing.

# ----------------------------------------------------------------------------
# Modify cmdline.txt
# ----------------------------------------------------------------------------
CMDLINE="$BOOT/cmdline.txt"
CMDLINE_BACKUP="$BOOT/cmdline.txt.jafo-backup"

if grep -q "jafo-autoboot" "$CMDLINE"; then
  info "cmdline.txt already references jafo-autoboot — skipping edit."
else
  info "Backing up cmdline.txt → cmdline.txt.jafo-backup"
  cp "$CMDLINE" "$CMDLINE_BACKUP"

  # Pi cmdline is a single line. We need to chain commands.
  # Imager's firstrun.sh uses: systemd.run=/boot/firstrun.sh systemd.run_success_action=reboot
  # We need to run AFTER Imager's firstrun.sh finishes and the Pi is fully set up.
  # Cleanest approach: add a flag to cmdline that our autoboot logic checks, AND
  # add a systemd.run that copies our script to the rootfs and creates a oneshot
  # systemd service that runs on next boot.
  #
  # The mechanism: replace "systemd.run=/boot/firstrun.sh" with a short bootstrap
  # that runs both Imager's firstrun.sh AND our autoboot installer.

  if grep -q "systemd.run=/boot/firstrun.sh" "$CMDLINE"; then
    # Imager's firstrun mechanism is in place. We need to run AFTER it.
    # Strategy: rewrite firstrun.sh to call our installer at the end.
    info "Hooking into Imager's firstrun.sh..."

    if [[ ! -f "$BOOT/firstrun.sh" ]]; then
      fail "cmdline.txt references firstrun.sh but it doesn't exist on disk."
    fi

    if grep -q "jafo-autoboot" "$BOOT/firstrun.sh"; then
      info "firstrun.sh already hooks into jafo-autoboot — skipping."
    else
      # Insert our installer just before the final reboot in Imager's firstrun.sh.
      # Imager's script ends with `rm -f /boot/firstrun.sh ... exit 0`.
      # We add a small stanza that copies our autoboot script to /boot/firmware
      # and installs a systemd unit that runs it on the next boot.
      info "Patching firstrun.sh to schedule jafo-autoboot for next boot..."
      # Back it up
      cp "$BOOT/firstrun.sh" "$BOOT/firstrun.sh.jafo-backup"
      # Insert our hook just before the `exit 0` at the end
      python3 - "$BOOT/firstrun.sh" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()

hook = '''
# === jafo autoboot hook ===
# Schedule jafo-autoboot.sh to run after the next boot (when networking is up)
if [ -f /boot/firmware/jafo-autoboot.sh ]; then
  cp /boot/firmware/jafo-autoboot.sh /usr/local/sbin/jafo-autoboot.sh
  chmod +x /usr/local/sbin/jafo-autoboot.sh
  cat > /etc/systemd/system/jafo-autoboot.service <<'UNITEOF'
[Unit]
Description=jafo autoboot installer (one-shot)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/boot/firmware/jafo-autoboot.sh

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/jafo-autoboot.sh
RemainAfterExit=no
StandardOutput=journal+console
StandardError=journal+console
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNITEOF
  systemctl enable jafo-autoboot.service
fi
# === end jafo autoboot hook ===

'''

# Insert hook before the closing 'exit 0' (case-insensitive, last match)
import re
match = list(re.finditer(r'^\s*exit\s+0\s*$', content, re.MULTILINE))
if match:
    pos = match[-1].start()
    content = content[:pos] + hook + content[pos:]
else:
    # No 'exit 0' — just append
    content = content.rstrip() + '\n' + hook + 'exit 0\n'

with open(path, 'w') as f:
    f.write(content)
print("[jafo-prep] firstrun.sh patched.")
PYEOF
    fi
  else
    # No firstrun.sh in cmdline.txt — user did not configure via Imager.
    # In this case we have to add our own systemd.run= to cmdline.
    info "No firstrun.sh hook in cmdline.txt; adding jafo's directly..."
    # Remove trailing newline, append our params, single line.
    CURRENT="$(cat "$CMDLINE" | tr -d '\n')"

    # Write a tiny bootstrap that lives on the boot partition that systemd.run can call.
    cat > "$BOOT/jafo-cmdline-bootstrap.sh" <<'EOF'
#!/bin/bash
set +e
if [ -f /boot/firmware/jafo-autoboot.sh ]; then
  cp /boot/firmware/jafo-autoboot.sh /usr/local/sbin/jafo-autoboot.sh
  chmod +x /usr/local/sbin/jafo-autoboot.sh
  cat > /etc/systemd/system/jafo-autoboot.service <<'UNITEOF'
[Unit]
Description=jafo autoboot installer (one-shot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/jafo-autoboot.sh
RemainAfterExit=no
StandardOutput=journal+console
StandardError=journal+console
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNITEOF
  systemctl enable jafo-autoboot.service
fi
exit 0
EOF
    echo "$CURRENT systemd.run=/boot/firmware/jafo-cmdline-bootstrap.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target" > "$CMDLINE"
  fi
fi

# ----------------------------------------------------------------------------
# Done
# ----------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  ${BOLD}SD card prep complete.${NC}"
echo "============================================================"
echo ""
echo "  Files placed on boot partition ($BOOT):"
ls -la "$BOOT"/jafo-* 2>/dev/null | awk '{printf "    %s\n", $NF}'
[[ -f "$BOOT/cmdline.txt.jafo-backup" ]] && echo "    cmdline.txt.jafo-backup (original cmdline)"
[[ -f "$BOOT/firstrun.sh.jafo-backup" ]] && echo "    firstrun.sh.jafo-backup (original firstrun)"
echo ""
echo "  Next steps:"
echo "    1. Eject the SD card (safely!)"
echo "    2. Insert it into the Pi 5"
echo "    3. Power on the Pi"
echo "    4. Wait ~30-40 minutes for installation to complete"
echo ""
echo "  Watch progress (after Pi gets WiFi/Ethernet, ~2 min in):"
echo "    ssh pi@<pi-hostname>.local"
echo "    sudo journalctl -u jafo-autoboot -f"
echo ""
echo "  When complete, the web UI will be at:"
echo "    http://<pi-hostname>.local"
echo ""
echo "============================================================"
