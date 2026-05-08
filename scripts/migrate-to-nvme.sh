#!/usr/bin/env bash
# Migrate ~/jafo-data from the SD card to the unused 1 TB NVMe SSD.
#
# Idempotent: refuses to wipe an NVMe that already has partitions, so a
# re-run after success can't damage the migrated data.
#
# What it does:
#   1. Stops all jafo services.
#   2. Wipes signatures, partitions /dev/nvme0n1 (single GPT partition),
#      formats ext4.
#   3. Mounts the new partition at a temp mountpoint.
#   4. rsyncs ~/jafo-data/ onto the NVMe (owner-preserving, xattrs/ACLs).
#   5. Renames the old SD copy to ~/jafo-data.sd-backup (kept for rollback;
#      delete manually after you're satisfied).
#   6. Adds an fstab entry by UUID and mounts the NVMe at ~/jafo-data.
#   7. Restarts all jafo services.
#
# Run with:  sudo bash ~/jafo/scripts/migrate-to-nvme.sh

set -euo pipefail

SD_PATH="/home/pi/jafo-data"
BACKUP_PATH="/home/pi/jafo-data.sd-backup"
TMP_MOUNT="/mnt/jafo-nvme"
NVME_DEV="/dev/nvme0n1"
NVME_PART="/dev/nvme0n1p1"
JAFO_USER="pi"
JAFO_GROUP="pi"

JAFO_UNITS=(jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web jafo-uploader)

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\n\033[36m▶ %s\033[0m\n' "$*"; }

# --- 0. Sanity --------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  red "Must run as root (sudo bash $0)"; exit 1
fi
if [[ ! -b "$NVME_DEV" ]]; then
  red "$NVME_DEV not present"; exit 1
fi
if [[ ! -d "$SD_PATH" ]]; then
  red "$SD_PATH not found — nothing to migrate"; exit 1
fi
if findmnt -n "$SD_PATH" >/dev/null 2>&1; then
  yellow "$SD_PATH is already a mountpoint — aborting (looks already migrated)"
  findmnt "$SD_PATH"
  exit 0
fi
# Refuse to format an NVMe that already has partitions.
if lsblk -no NAME "$NVME_DEV" | grep -q "${NVME_DEV##*/}p[0-9]"; then
  red "$NVME_DEV already has partitions — refusing to wipe."
  red "If a previous run partially completed, inspect manually:"
  lsblk "$NVME_DEV"
  exit 1
fi

step "Pre-flight summary"
df -h /
echo
du -sh "$SD_PATH" 2>/dev/null || true
echo
lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS,MODEL "$NVME_DEV" "$(df / --output=source | tail -1)" 2>/dev/null || true
echo
green "OK — proceeding with migration."

# --- 1. Stop services -------------------------------------------------------
step "Stopping jafo services"
for unit in "${JAFO_UNITS[@]}"; do
  if systemctl list-unit-files --no-legend "${unit}.service" | grep -q "$unit"; then
    systemctl stop "$unit" || true
    echo "  stopped $unit"
  else
    echo "  (skip — $unit not installed)"
  fi
done

# --- 2. Partition + format --------------------------------------------------
step "Wiping signatures and partitioning $NVME_DEV"
wipefs -a "$NVME_DEV"
parted -s "$NVME_DEV" mklabel gpt
parted -s "$NVME_DEV" mkpart primary ext4 1MiB 100%
# Allow kernel to register the partition node
sleep 1
partprobe "$NVME_DEV" || true
udevadm settle
[[ -b "$NVME_PART" ]] || { red "$NVME_PART didn't appear after partprobe"; exit 1; }

step "Formatting $NVME_PART as ext4"
mkfs.ext4 -L jafo-data -F "$NVME_PART"
NVME_UUID=$(blkid -s UUID -o value "$NVME_PART")
[[ -n "$NVME_UUID" ]] || { red "could not read UUID from $NVME_PART"; exit 1; }
echo "  UUID=$NVME_UUID"

# --- 3. Mount temp + rsync --------------------------------------------------
step "Mounting NVMe at $TMP_MOUNT and copying data"
mkdir -p "$TMP_MOUNT"
mount "$NVME_PART" "$TMP_MOUNT"

# rsync with progress; -a preserves perms+owner+symlinks+timestamps,
# -A keeps ACLs, -X keeps xattrs, --numeric-ids avoids any uid remap surprises.
rsync -aAX --numeric-ids --info=progress2 "$SD_PATH/" "$TMP_MOUNT/"

# Sanity: same size?
SD_BYTES=$(du -sb "$SD_PATH"      | awk '{print $1}')
NV_BYTES=$(du -sb "$TMP_MOUNT"    | awk '{print $1}')
echo "  source bytes:      $SD_BYTES"
echo "  destination bytes: $NV_BYTES"
# Allow a small slop for filesystem metadata differences
DIFF=$(( SD_BYTES > NV_BYTES ? SD_BYTES - NV_BYTES : NV_BYTES - SD_BYTES ))
if (( DIFF > SD_BYTES / 100 + 10*1024*1024 )); then
  red "size mismatch >1% (diff ${DIFF}B) — refusing to swap. Inspect $TMP_MOUNT vs $SD_PATH"
  exit 1
fi

# Make sure the new root is owned by pi:pi (it inherits whatever the rsync
# preserved, but defensively reset top-level ownership).
chown "$JAFO_USER:$JAFO_GROUP" "$TMP_MOUNT"

# --- 4. Swap the old SD-side directory aside --------------------------------
step "Renaming $SD_PATH → $BACKUP_PATH and remounting NVMe at $SD_PATH"
umount "$TMP_MOUNT"

# Defensive: if BACKUP_PATH already exists from a previous attempt, refuse.
if [[ -e "$BACKUP_PATH" ]]; then
  red "$BACKUP_PATH already exists — refusing to overwrite. Move/delete it first."
  exit 1
fi

mv "$SD_PATH" "$BACKUP_PATH"
mkdir -p "$SD_PATH"
chown "$JAFO_USER:$JAFO_GROUP" "$SD_PATH"

# fstab entry by UUID. Replace any stale jafo-data line first.
sed -i.bak '/[[:space:]]\/home\/pi\/jafo-data[[:space:]]/d' /etc/fstab
echo "UUID=$NVME_UUID  $SD_PATH  ext4  defaults,noatime,nofail,x-systemd.device-timeout=10  0  2" >> /etc/fstab

systemctl daemon-reload
mount "$SD_PATH"

if ! findmnt -n "$SD_PATH" >/dev/null 2>&1; then
  red "$SD_PATH did not mount — check /etc/fstab"
  exit 1
fi

# --- 5. Restart services ----------------------------------------------------
step "Restarting jafo services"
for unit in "${JAFO_UNITS[@]}"; do
  if systemctl list-unit-files --no-legend "${unit}.service" | grep -q "$unit"; then
    systemctl start "$unit" && echo "  started $unit"
  fi
done

# --- 6. Summary -------------------------------------------------------------
step "Done. Verification:"
df -h / "$SD_PATH"
echo
findmnt "$SD_PATH"
echo
green "Migration complete."
echo
yellow "Rollback path (only if something is wrong):"
echo "  sudo systemctl stop ${JAFO_UNITS[*]}"
echo "  sudo umount $SD_PATH"
echo "  sudo sed -i '/[[:space:]]\\/home\\/pi\\/jafo-data[[:space:]]/d' /etc/fstab"
echo "  sudo rmdir $SD_PATH"
echo "  sudo mv $BACKUP_PATH $SD_PATH"
echo "  sudo systemctl start ${JAFO_UNITS[*]}"
echo
yellow "Once you've verified the system is happy on NVMe (e.g. tomorrow),"
yellow "you can reclaim the SD copy with:"
echo "  sudo rm -rf $BACKUP_PATH"
