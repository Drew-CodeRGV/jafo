# jafo — Autoboot SD Card Setup

Two scripts in this folder turn a fresh Pi OS SD card into a fully-self-installing jafo system. Flash, drop one file, walk away. ~30-40 minutes later the Pi is running.

## What you need

- A Mac, Linux box, or Windows machine with Git Bash
- A 32+ GB SD card (or NVMe SSD)
- The Raspberry Pi Imager: https://www.raspberrypi.com/software/
- The cloned `jafo` repo on your laptop

## Step 1 — Flash with Pi Imager

1. Insert SD card into your laptop
2. Open Raspberry Pi Imager
3. **Choose Device:** Raspberry Pi 5
4. **Choose OS:** Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)**
5. **Choose Storage:** your SD card
6. Click **Next** → click **EDIT SETTINGS** when it asks about OS customisation
7. In the **General** tab:
   - **Set hostname:** `jafo` (or whatever you want)
   - **Set username and password:** username MUST be `pi`, password is your choice
   - **Configure wireless LAN:** your WiFi network + password
   - **Set locale settings:** your timezone
8. In the **Services** tab:
   - **Enable SSH** ✓
   - Use password authentication (or set up SSH key — your call)
9. Click **Save** → **Yes** to apply customisations → **Yes** to erase
10. Wait for the flash to complete (~3-5 minutes)

**Don't eject the card yet.** You need it still mounted for step 2.

## Step 2 — Run the prep script

When the imager finishes, the SD card's boot partition will auto-mount. It's called `bootfs`.

From your laptop, in this folder (`sdcard-prep/`):

### macOS

```bash
./prepare-sdcard.sh /Volumes/bootfs
```

### Linux

```bash
./prepare-sdcard.sh /run/media/$USER/bootfs
# or sometimes:
./prepare-sdcard.sh /media/$USER/bootfs
```

### Windows (Git Bash)

```bash
# Find the drive letter assigned to bootfs (typically E: or F:)
./prepare-sdcard.sh /e
```

The script:
- Copies `jafo-autoboot.sh` onto the boot partition
- Patches `firstrun.sh` to install a systemd one-shot unit on first boot
- Backs up everything it changes (`*.jafo-backup`)

It's idempotent — safe to re-run.

## Step 3 — Boot the Pi

1. **Eject the SD card** safely from your laptop
2. Plug it into the Pi 5
3. Connect both SDRs (HackRF + RTL-SDR or RSP1) via the powered USB hub
4. Connect the antenna
5. Plug in the Pi 5's official 27W USB-C power supply

The Pi will:
1. **Boot 1** (~30 seconds): Pi Imager's `firstrun.sh` runs — sets up your user, hostname, WiFi, SSH, then reboots
2. **Boot 2** (~30 minutes): `jafo-autoboot.service` runs — installs everything, configures, starts services, then disables itself

## Step 4 — Watch progress

After ~2 minutes, the Pi will be on the network. From your laptop:

```bash
ssh pi@jafo.local

# Watch the install live:
sudo journalctl -u jafo-autoboot -f

# Or read the log:
sudo tail -f /var/log/jafo-autoboot.log
```

Estimated phases:
- 0-2 min: APT installs (system packages, GNU Radio, ffmpeg, nginx)
- 2-12 min: SDRplay API + SoapySDRPlay3 build (only if RSP1 detected)
- 12-30 min: trunk-recorder build from source
- 30-32 min: Python venvs + service setup + first start

## Step 5 — Add API keys (optional but recommended)

Once installed, jafo runs without API keys but only does capture (no transcription, no enrichment). To enable those:

```bash
ssh pi@jafo.local
nano ~/jafo/.env
# Set GROQ_API_KEY and ANTHROPIC_API_KEY
sudo systemctl restart jafo-transcriber jafo-enricher
```

## Step 6 — Open the web UI

```
http://jafo.local
```

(Or whatever hostname you set in step 1.)

## What if something goes wrong?

The autoboot service is a oneshot — if it fails, it won't auto-retry. Manually retry:

```bash
sudo systemctl start jafo-autoboot.service
sudo journalctl -u jafo-autoboot -f
```

If you need to fully restart from scratch, delete the done marker and re-run:

```bash
sudo rm /var/lib/jafo-autoboot.done
sudo rm -rf /home/pi/jafo /home/pi/jafo-data /home/pi/src/trunk-recorder
sudo systemctl start jafo-autoboot.service
```

## What if I don't want autoboot?

Just don't run `prepare-sdcard.sh`. Boot the Pi normally, SSH in, and run the bootstrap by hand:

```bash
curl -fsSL https://raw.githubusercontent.com/Drew-CodeRGV/jafo/main/bootstrap.sh | bash
```

That's the same install, just triggered manually.
