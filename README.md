# jafo

> *You can hear a mouse fart at 2000 ft.*

A passive observer for the Lower Rio Grande Valley Regional Radio System (LRGVRRS). Captures unencrypted public-safety radio, transcribes it, classifies it, and gives you a searchable web UI — all running on a single Raspberry Pi 5.

```
RTL-SDR + HackRF
      │
      ▼
trunk-recorder ──► VAD filter / Opus encode ──► SQLite
                                                  │
                                                  ▼
                                       Groq Whisper API
                                                  │
                                                  ▼
                                       Claude Haiku API
                                                  │
                                                  ▼
                                       Flask + nginx web UI
                                       (timeline + map + search)
```

Everything in one box. Two paid APIs (Groq for transcription, Anthropic for enrichment). No cloud servers. ~$3-8/month all in.

## What you get

- **Live capture** of unencrypted P25 traffic on LRGVRRS — McAllen and Pharr sites supported out of the box, easy to add others
- **Smart filtering** that drops 80-90% of junk (encrypted, blips, dead air) before sending anything to a paid API
- **Transcripts** for every kept call (Groq Whisper large-v3-turbo, ~1 sec latency, handles bilingual English/Spanish out of the box)
- **Structured incidents** auto-extracted by Claude Haiku — type, location, units, severity, one-line summary
- **Web UI** with timeline, talkgroup filter, full-text search, audio playback, map view
- **All local**: SQLite database, audio files on disk, web served by nginx → Flask. No cloud sync, no S3.

## What you need

**Hardware (one-time, ~$200-400):**
- Raspberry Pi 5 (8GB)
- Official 27W USB-C PSU
- Active cooler
- **Powered USB hub** — non-negotiable
- 800 MHz antenna mounted high
- 256GB+ SSD on NVMe HAT
- One or more SDRs (auto-detected at install time):
  - **HackRF One** + **RTL-SDR** — the standard configuration
  - **HackRF One** + **SDRplay RSP1/RSP1A/RSPdx** — better dynamic range
  - **HackRF One** alone — single-SDR mode
  - **SDRplay RSP** alone — single-SDR mode
  - All three — RTL handles control, HackRF handles voice, RSP held in reserve

The bootstrap detects whichever SDRs are plugged in and configures everything automatically. See `docs/SDR_PROFILES.md` for details.

**API keys (free to get, then pay-as-you-go):**
- [Groq API key](https://console.groq.com) — for Whisper transcription (~$1-3/month at this scale)
- [Anthropic API key](https://console.anthropic.com) — for Claude enrichment (~$2-5/month)

If you don't provide the keys, the system still works — you just won't get transcripts or enrichment. Capture and storage run regardless.

## Install — two options

### Option A — Autoboot (recommended, fully unattended)

Flash, drop one file, walk away. The Pi installs everything itself on first boot. See [`sdcard-prep/README.md`](sdcard-prep/README.md) for full instructions.

In short:

1. Flash Pi OS Lite (64-bit, Bookworm) with the Pi Imager — set hostname, user (`pi`), WiFi, SSH in Advanced Options
2. While the SD card is still mounted on your laptop, from this repo run:
   ```bash
   ./sdcard-prep/prepare-sdcard.sh /Volumes/bootfs   # macOS
   # or /run/media/$USER/bootfs (Linux), /e (Windows Git Bash)
   ```
3. Eject SD card, plug it into the Pi, power on
4. Wait ~30-40 minutes
5. Open `http://jafo.local`

### Option B — Manual install

If you'd rather drive the install interactively:

### 1. Image the Pi

Use Raspberry Pi Imager. Pick **Raspberry Pi OS Lite (64-bit, Bookworm)**. In advanced options:
- Hostname: `jafo`
- User: **`pi`** with a password
- Enable SSH
- Configure WiFi (or plug in Ethernet)

### 2. Wire it up

- All SDRs into the **powered USB hub** (not direct on Pi)
- Hub into a Pi 5 USB 3.0 port (blue)
- Antenna into the SDR
- Boot the Pi

### 3. Bootstrap

SSH in as `pi` and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Drew-CodeRGV/jafo/main/bootstrap.sh | bash
```

The script will:
1. Install OS packages (GNU Radio, SDR libs, ffmpeg, Python, nginx) — ~5-10 min
2. Blacklist conflicting kernel modules (DVB-T for RTL-SDR, msi2500 for SDRplay)
3. **Auto-detect which SDRs are plugged in** and select the right config profile
4. If an SDRplay RSP is detected, install the proprietary SDRplay API + build SoapySDRPlay3 (~5-10 min more)
5. Build trunk-recorder from source — ~15-20 min
6. Set up Python venvs for processor + web
7. Install + start 5 systemd services
8. Configure nginx
9. Run pre-flight SDR check

Total time: ~25-35 minutes (longer if SDRplay needs setting up), mostly unattended.

### 4. Add API keys

```bash
nano ~/jafo/.env
```

Set `GROQ_API_KEY` and `ANTHROPIC_API_KEY`. Save. Restart the workers:

```bash
sudo systemctl restart jafo-transcriber jafo-enricher
```

### 5. Replace the placeholder talkgroups with the real ones

The starter `talkgroups.csv` has ~25 example LRGVRRS entries — enough to verify decode works, but not the full ~400 talkgroup list. To get friendly agency names showing up in the web UI:

1. Sign in to [RadioReference](https://www.radioreference.com/db/sid/6742) (premium subscription required for CSV export)
2. Click "Trunked System Data" → CSV export
3. Either scp the file to your Pi, or open it locally and paste the contents into the file:

```bash
nano ~/jafo-data/config/talkgroups.csv
# paste the RR export, save with Ctrl+O / Ctrl+X
sudo systemctl restart jafo-recorder
```

After restart you should see talkgroups identified by name (e.g. `Metro McAllen`, `LoneStarEMS McAl`, `McAllen PD3 Info`) in the recorder logs.

If you don't have an RR subscription, the system runs fine with `recordUnknown: true` in the config (which is the default) — calls just show by talkgroup ID instead of agency name.

### 6. Open the UI

From any device on your network:

```
http://jafo.local
```

Or use the Pi's IP. You should see the live timeline within a minute or two of the first call.

## Verify

```bash
# Pre-flight check
~/jafo/pi/tools/check-sdrs.sh

# Service status
sudo systemctl status 'jafo-*'

# Live logs
sudo journalctl -u jafo-recorder -f       # capture
sudo journalctl -u jafo-processor -f      # filtering
sudo journalctl -u jafo-transcriber -f    # Whisper
sudo journalctl -u jafo-enricher -f       # Claude
sudo journalctl -u jafo-web -f            # web service

# Stats summary
~/jafo/pi/services/stats.py
```

## Where things live

| Path | What |
|------|------|
| `~/jafo/` | Code (cloned repo) |
| `~/jafo-data/` | All working data |
| `~/jafo-data/recordings/` | Raw WAVs from trunk-recorder (transient) |
| `~/jafo-data/calls/YYYY-MM-DD/` | Filtered Opus archive (kept N days) |
| `~/jafo-data/jafo.db` | SQLite — calls, transcripts, incidents |
| `~/jafo-data/logs/` | trunk-recorder logs |

## Storage

- Filtered Opus calls: ~30 KB each → ~9 MB/day at 300 calls
- DB: ~3 KB per fully-enriched call → ~900 KB/day
- Audio files auto-deleted after `AUDIO_RETENTION_DAYS` (default 30)
- DB rows kept forever — they're tiny

A 256 GB SSD lasts essentially forever.

## Updating

```bash
cd ~/jafo && ./scripts/update-pi.sh
```

## Develop on the Pi with Claude Code

Once the system is running, the easiest way to iterate on it is to install
[Claude Code](https://docs.claude.com/en/docs/claude-code) directly on the
Pi. That way you can SSH in, ask Claude to read service logs and propose a
fix, and have the changes applied + services restarted in one session — no
file shuffling between your laptop and the Pi.

```bash
bash ~/jafo/scripts/install-claude-code.sh
```

The installer will:
- Install Node.js 20 LTS if needed (Bookworm ships an older Node)
- Set up a user-level npm prefix (`~/.npm-global`) so no `sudo` is needed
- Install `@anthropic-ai/claude-code` globally
- Show you the auth options

Then to start a session in the jafo project:

```bash
bash ~/jafo/scripts/jafo-claude.sh
```

That wrapper sources `.env` (so `ANTHROPIC_API_KEY` is picked up automatically)
and launches Claude in the repo root. Claude Code reads `CLAUDE.md` and
`HANDOFF.md` from the repo root automatically — full project context, no
need to re-explain.

Tip: symlink for a shorter command:

```bash
ln -s ~/jafo/scripts/jafo-claude.sh ~/.npm-global/bin/jafo-claude
# Then anywhere:
jafo-claude
```

## Publishing your changes back to GitHub

If you've tweaked things on the Pi (custom talkgroups, region, prompt edits, etc.) and want to push your fork back to GitHub:

```bash
bash ~/jafo/scripts/push-to-github.sh
```

The script will prompt for a GitHub Personal Access Token (get one at https://github.com/settings/tokens with `repo` scope), then force-push the entire repo. Your `.env` is gitignored, so API keys don't leak.

## Naming

JAFO — *Just Another F\*\*\*ing Observer*. The callsign for the spotter in *Blue Thunder* (1983). Passive role, sees everything, only speaks when there's something worth saying.

## License

MIT. In Texas, receiving public safety radio for personal use is legal. Republishing is a separate conversation — check your local rules.
