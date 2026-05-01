# Troubleshooting

## First thing to try

```bash
~/jafo/pi/tools/check-sdrs.sh
```

Tests SoapySDR detection, native HackRF/RTL-SDR tools, kernel module conflicts, USB power, group membership, trunk-recorder, GNU Radio. Prints clear ✓/✗ for each.

## Service status at a glance

```bash
sudo systemctl status 'jafo-*'
```

All five should be `active (running)`. If any are `failed`:
```bash
sudo journalctl -u jafo-<name> -n 100 --no-pager
```

## SDRs not detected

1. Use a powered USB hub (not Pi USB direct)
2. Reboot (DVB / msi2500 blacklist needs it)
3. Try a different USB cable
4. `dmesg | tail -50` and look for under-voltage / descriptor errors

## SDRplay-specific issues

**Symptom:** `lsusb` shows the RSP, but `SoapySDRUtil --find` doesn't list it.

Most likely the SDRplay API service isn't running, or `SoapySDRPlay3` wasn't built against the installed API:

```bash
# Is the API installed?
ls -la /usr/local/lib/libsdrplay_api.so

# Is the service running?
systemctl status sdrplay.service

# Is SoapySDRPlay3 installed?
ls /usr/local/lib/SoapySDR/modules*/libsdrPlaySupport.so

# Restart the service
sudo systemctl restart sdrplay.service
sleep 2
SoapySDRUtil --find
```

If `libsdrPlaySupport.so` is missing, rebuild it:
```bash
FORCE_REBUILD_SOAPY_SDRPLAY3=1 bash ~/jafo/pi/build-sdrplay.sh
```

If `msi2500` is loaded (`lsmod | grep msi`), reboot — the blacklist needs that to take effect.

**Symptom:** RSP is detected but trunk-recorder can't open it.

Check the gain — SDRplay devices need different gain values than RTL-SDR. The default profiles use `gain: 40` with AGC. If decode rate is poor, try lowering to 30 or raising to 50, restart, and watch the log.

**Symptom:** SDRplay worked yesterday, doesn't work today.

A system update may have re-installed `msi2500` or updated the kernel. Run:
```bash
~/jafo/pi/tools/check-sdrs.sh
```

The check will flag the issue. Most fixes:
- `sudo systemctl restart sdrplay.service`
- Reboot (re-applies blacklist)
- Re-run installer (re-detects, re-installs if API was wiped by an update)

## Switching SDR profiles

If you change SDR hardware (e.g. plug in an RSP1 you didn't have before, or remove an SDR), re-run the installer to re-detect and reconfigure:

```bash
bash ~/jafo/pi/install-pi.sh
```

It's idempotent — it will skip everything already installed and just regenerate the trunk-recorder config from the new detection result. To see the currently active profile:

```bash
cat ~/jafo-data/config/.active-profile
```

To force a specific profile manually (overriding detection):

```bash
cp ~/jafo/config/profiles/<profile>.json ~/jafo-data/config/config.json
sudo systemctl restart jafo-recorder
```

Available profiles are in `~/jafo/config/profiles/`.

## Web UI not loading

```bash
# Is nginx up?
sudo systemctl status nginx
# Is the web service up?
sudo systemctl status jafo-web
# Test Flask directly:
curl http://127.0.0.1:8080/api/health
# Test through nginx:
curl http://127.0.0.1/api/health
```

## Web UI loads but no calls show

If the UI loads but shows "No calls match the current filters":
1. Check that capture is working: `sudo journalctl -u jafo-recorder -f`
2. Check that the processor is keeping calls: `~/jafo/pi/services/stats.py`
3. If everything is being filtered out, see "Processor skipping everything" below.

## Control channel not decoding

`Control Channel Timeout` or low decode rate:
1. **Antenna.** Try a different one or move it.
2. **Gain.** Edit `~/jafo-data/config/config.json`, change `gain` (try 30, 35, 40, 45). Restart: `sudo systemctl restart jafo-recorder`
3. **PPM drift.** Try `"error": 50` for the RTL-SDR source.
4. **Recorder is dead.** Check `sudo journalctl -u jafo-recorder -n 50`.

## Processor skipping everything as "no_speech"

Usually means the audio is noise, not voice. Listen to a sample:
```bash
ls /home/pi/jafo-data/recordings/*/lrgvrrs/*.wav | head -1 | xargs sox - -d
```
If it sounds like noise → fix capture quality (gain, antenna).
If it sounds like voice → loosen `MIN_SPEECH_RATIO` in `pi/services/processor.py` from 0.25 to 0.15.

## Transcriber not running

```bash
sudo journalctl -u jafo-transcriber -n 50
```
- "GROQ_API_KEY not set" → add it to `.env`, restart
- Network errors → check Pi's internet
- Rate limit errors → Groq free tier has limits; check console.groq.com

## Enricher not running

```bash
sudo journalctl -u jafo-enricher -n 50
```
- "ANTHROPIC_API_KEY not set" → add it to `.env`, restart
- "json_parse" errors → Claude returned non-JSON (rare, retry-safe)

## Disk filling up

```bash
df -h ~/jafo-data
du -sh ~/jafo-data/*
```

The retention sweep should run hourly. Check it's running:
```bash
sudo journalctl -u jafo-processor | grep -i retention
```

If it never runs, the processor is stuck. Restart it.

## Pi reboots / undervoltage

`dmesg | grep -i volt` shows under-voltage warnings → use the official Pi 5 27W USB-C PSU. Most other PSUs don't negotiate the right voltage.

## Updating after pushing changes

```bash
cd ~/jafo && ./scripts/update-pi.sh
```

## Wiping and starting over (nuclear)

```bash
sudo systemctl stop jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web
sudo systemctl disable jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web
sudo rm /etc/systemd/system/jafo-*.service
sudo rm /etc/nginx/sites-enabled/jafo /etc/nginx/sites-available/jafo
rm -rf ~/jafo ~/jafo-data ~/src/trunk-recorder
sudo systemctl daemon-reload
```

Then re-run bootstrap.

## Install errors we've actually hit

### `Hidalgo: command not found` when sourcing .env

Cause: a value in `.env` contains an unquoted comma. Bash sees `JAFO_REGION=McAllen, Hidalgo County, Texas` and tries to execute `Hidalgo County, Texas` as a command after assigning `McAllen,` to `JAFO_REGION`.

Fix: quote the value.

```bash
sed -i 's|^JAFO_REGION=.*|JAFO_REGION="McAllen, Hidalgo County, Texas"|' ~/jafo/.env
```

### `[ERROR] Licence not accepted` from SDRplay installer

Cause: the URL `https://www.sdrplay.com/software/install.sh` now installs **SDRconnect** (the GUI desktop app), not the **API** (the userspace daemon SoapySDRPlay3 needs). The two are different products from the same vendor.

Fix: use the direct `.run` installer URL. The current `pi/build-sdrplay.sh` already does this, but if you ran an older version, install manually:

```bash
cd /tmp
curl -fsSLO https://www.sdrplay.com/software/SDRplay_RSP_API-Linux-3.15.2.run
chmod +x SDRplay_RSP_API-Linux-3.15.2.run
sudo ./SDRplay_RSP_API-Linux-3.15.2.run
# (page through the license with space, then 'y' to accept and 'y' to install)
```

### `git pull` fails with "You are not currently on a branch"

Cause: a previous build left the trunk-recorder repo in detached HEAD state on a release tag. Plain `git pull` doesn't work in detached state.

Fix: nuke and re-clone, or use `git fetch --tags` instead of `pull`. Current `pi/build-trunk-recorder.sh` does the latter. If stuck:

```bash
rm -rf /home/pi/src/trunk-recorder
bash ~/jafo/pi/install-pi.sh
```

### CMake error: `Could not find a package configuration file provided by "boost_log_setup"` (or `boost_random`, etc.)

Cause: not all Boost dev packages are installed. The `apt-get install libboost-log-dev` only installs that one component; trunk-recorder needs many.

Fix: install the meta-package:

```bash
sudo apt-get install -y libboost-all-dev
```

Then re-run install. Current `pi/install-pi.sh` does this automatically.

### Pip error: `No matching distribution found for torch<2.6`

Cause: Pi OS Bookworm now ships Python 3.13. PyTorch wheels for 3.13 start at version 2.6.0. If `requirements.txt` constrains torch to `<2.6`, no wheel is available.

Fix: the current `pi/services/requirements.txt` has been updated to `torch>=2.2` (no upper bound). If you have an older copy:

```bash
sed -i 's|^torch.*|torch>=2.2|' ~/jafo/pi/services/requirements.txt
~/jafo-data/venv-services/bin/pip install -r ~/jafo/pi/services/requirements.txt
```

### `bootstrap.sh: destination path '/home/pi/jafo' already exists`

Cause: the bootstrap was trying to git-clone into a directory that already had files (e.g. extracted from a tar). The current `bootstrap.sh` handles this — if files are present, it uses them as-is. If you have an older copy that fails:

```bash
# Just run install-pi.sh directly, skipping bootstrap's clone step
cd ~/jafo
chmod +x pi/install-pi.sh
bash pi/install-pi.sh
```

## Runtime errors we've actually hit

### `OsmoSDR must have a sample rate that is a multiple of 24000`

trunk-recorder's GR-OsmoSDR backend requires sample rates that divide cleanly by 24000 (the P25 symbol rate × decimation). Common valid rates:

| Use case | Valid rate | Calculation |
|---|---|---|
| RTL-SDR control channel | 2,400,000 | 100 × 24000 |
| HackRF voice (8 MHz spread) | 7,968,000 | 332 × 24000 |
| HackRF single-SDR (10 MHz) | 9,984,000 | 416 × 24000 |
| RSP1 single-SDR | 7,968,000 | same as HackRF voice |

If the install is using profiles from this repo, this is already handled. Custom configs need to use these exact values.

### `Requested Gain of 40 not supported, driver using: 14` (HackRF)

HackRF doesn't have a single "gain" knob — it has three stages with discrete values:

- **`gain`** (RF amp): only `0` or `14` (the preamp). Set to `14` to enable preamp.
- **`ifGain`** (LNA stage): `0, 8, 16, 24, 32, 40` (8 dB steps, 0-40)
- **`bbGain`** (VGA stage): `0, 2, 4, 6, ..., 62` (2 dB steps, 0-62)

For weak signals: `gain=14, ifGain=40, bbGain=40`. For strong signals where you're getting overload distortion, drop `bbGain` first (e.g. 32 or 24).

### Trunk-recorder decoding cleanly but `Not Recording: TG not in Talkgroup File`

Means the talkgroups CSV is loaded but the active talkgroup IDs don't match anything in it. Two fixes:

**Quick:** allow recording of all talkgroups by setting `recordUnknown: true` in the system config:

```bash
python3 -c "
import json
with open('/home/pi/jafo-data/config/config.json') as f: c = json.load(f)
c['systems'][0]['recordUnknown'] = True
with open('/home/pi/jafo-data/config/config.json', 'w') as f: json.dump(c, f, indent=2)
"
sudo systemctl restart jafo-recorder
```

**Proper:** download the actual talkgroups CSV from RadioReference and replace `~/jafo-data/config/talkgroups.csv`. RR exports work directly — no editing needed.

### Web UI shows raw HTML / 403 errors on style.css and app.js

nginx (running as `www-data`) doesn't have permission to traverse `/home/pi`. Fix:

```bash
chmod o+x /home/pi
chmod -R o+rX /home/pi/jafo/pi/web/static/
sudo systemctl reload nginx
```

Then hard-refresh the browser (Ctrl+Shift+R). The current installer does this automatically.

### Decode rate stays at 0/sec despite signal being present

The signal you're hearing might not be the LRGVRRS site you think it is. LRGVRRS has multiple sites (McAllen, Pharr, La Joya, Brownsville, Harlingen, etc.) — each with different control channel frequencies. The site closer to you (or with better line-of-sight) may not be the one in your config.

The shipped profiles include control channels from McAllen AND Pharr. trunk-recorder will auto-pick whichever decodes. If you're outside Hidalgo County, edit `~/jafo-data/config/config.json` and set `control_channels` for your nearest site (look it up at https://www.radioreference.com/db/sid/6742).

### SDRplay installer extracts SDRconnect (the GUI app) instead of API

SDRplay's `https://www.sdrplay.com/software/install.sh` URL was changed in late 2025 to install SDRconnect (the desktop application) instead of the API daemon. The current `pi/build-sdrplay.sh` uses the direct `.run` URL for the API:

```
https://www.sdrplay.com/software/SDRplay_RSP_API-Linux-3.15.2.run
```

If you have an older version of `build-sdrplay.sh` that still uses `install.sh`, replace it with the version in this repo or run the API installer manually:

```bash
cd /tmp
curl -fsSLO https://www.sdrplay.com/software/SDRplay_RSP_API-Linux-3.15.2.run
chmod +x SDRplay_RSP_API-Linux-3.15.2.run
sudo ./SDRplay_RSP_API-Linux-3.15.2.run
# Press space to scroll license, type 'y' to accept and 'y' to install
```
