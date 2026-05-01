# Claude Code — jafo project context

> *Just Another F\*\*\*ing Observer* — Pi-based passive observer for the
> Lower Rio Grande Valley Regional Radio System (LRGVRRS).

When you start a new session in this repo, also read **HANDOFF.md** for the
full backstory and the rationale behind every weird-looking choice. This file
is the short, action-oriented summary.

---

## What this is

A 5-service pipeline running on a Raspberry Pi 5:

```
SDR(s) ──► trunk-recorder ──► processor ──► transcriber ──► enricher ──► web
                              (Silero VAD,    (Groq         (Claude        (Flask)
                               opus encode)    Whisper)      Haiku)
```

All five services are systemd units (`jafo-recorder`, `jafo-processor`,
`jafo-transcriber`, `jafo-enricher`, `jafo-web`). Single SQLite DB at
`~/jafo-data/jafo.db` with FTS5 search.

---

## Quick orientation

| Path | What lives here |
|---|---|
| `~/jafo/` | This repo (code) |
| `~/jafo-data/` | All runtime state (writable) |
| `~/jafo-data/recordings/` | Raw WAVs from trunk-recorder (transient) |
| `~/jafo-data/calls/YYYY-MM-DD/` | Filtered Opus archive (kept N days) |
| `~/jafo-data/jafo.db` | SQLite — calls, transcripts, incidents |
| `~/jafo-data/config/config.json` | Active trunk-recorder config |
| `~/jafo-data/config/talkgroups.csv` | Active talkgroups (RR export) |
| `~/jafo/.env` | API keys + node config (gitignored) |
| `~/jafo/config/profiles/*.json` | SDR profile templates (read-only source) |
| `~/jafo/pi/services/*.py` | The 4 Python services |
| `~/jafo/pi/web/` | Flask app + static frontend |

---

## Common tasks

### Restart services after editing code

```bash
sudo systemctl restart jafo-web              # web changes
sudo systemctl restart jafo-processor        # VAD/Opus changes
sudo systemctl restart jafo-transcriber      # Groq/Whisper changes
sudo systemctl restart jafo-enricher         # Claude prompt changes
sudo systemctl restart jafo-recorder         # config.json or talkgroups.csv changes
```

### Watch live activity

```bash
sudo journalctl -u jafo-recorder -f          # decoder + capture
sudo journalctl -u jafo-processor -f         # VAD filtering, opus encode
sudo journalctl -u jafo-transcriber -f       # transcripts as they arrive
sudo journalctl -u jafo-enricher -f          # Claude incident extraction
sudo journalctl -u jafo-web -f               # web requests
```

### Check pipeline health

```bash
~/jafo-data/venv-services/bin/python ~/jafo/pi/services/stats.py
```

### Inspect the DB

```bash
sqlite3 ~/jafo-data/jafo.db
.schema calls
SELECT id, talkgroup_tag, transcript FROM calls ORDER BY id DESC LIMIT 10;
```

The schema's primary key column is `id`, **not** `call_id`. The view layer
maps it to `id` in JSON responses too.

---

## Conventions and gotchas

### 1. Use the user-prefix venvs

The services run in dedicated venvs to keep their dependency graphs separate
from the system Python:

- `~/jafo-data/venv-services/` for processor/transcriber/enricher/stats
- `~/jafo-data/venv-web/` for the Flask web app

Always invoke Python via these venvs:

```bash
~/jafo-data/venv-services/bin/python ~/jafo/pi/services/stats.py
```

Don't `pip install` into the system Python — Bookworm rejects it without
`--break-system-packages` and that's a footgun.

### 2. trunk-recorder config rules

- **Sample rate must be a multiple of 24000.** Common valid values:
  `2,400,000` (RTL on control), `7,968,000` (HackRF voice), `9,984,000`
  (single-SDR HackRF wide). Setting an arbitrary rate like `2,000,000`
  fails with `OsmoSDR must have a sample rate that is a multiple of 24000`.
- **HackRF gain is three stages.** Use `gain` (RF amp, only `0` or `14`),
  `ifGain` (LNA, 0-40 step 8), `bbGain` (VGA, 0-62 step 2). Don't put `40`
  in the `gain` field — that crashes with "Requested Gain of 40 not supported".
- **Multiple control channels are listed for redundancy.** Pharr +
  McAllen sites in one array. trunk-recorder picks the strongest. Don't
  collapse to one frequency unless you know which site you can hear.

### 3. .env values must be quoted if they contain commas/spaces

```
JAFO_REGION="McAllen, Hidalgo County, Texas"   # right
JAFO_REGION=McAllen, Hidalgo County, Texas     # WRONG — bash sourcing fails
```

systemd's `EnvironmentFile=` parses this slightly differently from bash, but
quote anyway — both backends are happy with quoted values.

### 4. Audio files are Ogg-container Opus

Served as `audio/ogg` MIME, **not** `audio/opus`. The frontend uses
`<audio><source type="audio/ogg; codecs=opus"></audio>`. If you change the
encoder, keep `-f ogg` in the ffmpeg command — without explicit container,
some browsers truncate playback.

### 5. nginx and `/home/pi`

nginx runs as `www-data` and needs traverse permission on `/home/pi`:

```bash
chmod o+x /home/pi
chmod -R o+rX /home/pi/jafo/pi/web/static/
```

The installer does this automatically. If you ever see 403 on `/static/*`,
this is why.

### 6. Talkgroups CSV lives in two places

- `~/jafo/config/talkgroups-monitored.csv` — **starter** (committed to repo,
  ~25 example rows)
- `~/jafo-data/config/talkgroups.csv` — **active** (the real RR export, ~400
  rows, never commit)

The web app reads the active file at runtime to provide the Service/City
groupings. Updating it doesn't require a service restart for the sidebar — the
Flask endpoint re-reads on each call. Trunk-recorder DOES need a restart
to pick up new talkgroups.

### 7. Don't commit secrets

`.env` is `.gitignore`d. The `scripts/push-to-github.sh` script verifies
this before allowing a push.

### 8. Don't commit Pi-specific runtime state

Anything under `~/jafo-data/` is Pi-local. The repo only contains source.

---

## Frequencies of LRGVRRS sites (System ID 0x2B5, WACN 0xBEE00)

| Site | Control channels (MHz) |
|---|---|
| McAllen | 851.075, 851.3125, 852.9625 |
| Pharr | 851.0675, 851.3375 |
| La Joya | 852.6875, 853.950 |
| Brownsville | 851.9125, 852.9125, 853.9125 |
| Olmito | 854.8625, 856.7875 |
| San Manuel-Linn | 853.4625, 853.9875 |
| Raymondville | 852.0375, 853.5375 |
| Harlingen | 851.9875, 856.6375, 857.0875 |

Default profiles list McAllen + Pharr in one array. For other locations,
pick the closest 2-3 sites' control channels and put them in the profile's
`control_channels` array.

---

## Where to look for what

| Question | File |
|---|---|
| How does VAD filter calls? | `pi/services/processor.py` |
| How is Whisper called? | `pi/services/transcriber.py` |
| What prompt do we send Claude? | `pi/services/enricher.py` |
| What columns does a `call` have? | `pi/services/common.py` (SCHEMA) |
| How are talkgroups grouped in UI? | `pi/web/app.py` (`/api/talkgroup-groups`) |
| Why did we hit X bug? | `docs/TROUBLESHOOTING.md` |
| Why this SDR config? | `docs/SDR_PROFILES.md` |
| What was Drew thinking? | `HANDOFF.md` |

---

## When in doubt

- **Read HANDOFF.md** for context and history.
- **Look at the systemd unit** in `pi/systemd/*.service` to see how each
  service is invoked.
- **Run `stats.py`** to see if the pipeline is healthy before debugging.
- **Don't sudo install Python packages.** Use the venvs.
- **Don't reformat the talkgroups CSV.** Trunk-recorder is picky.
- **Ask Drew before pushing breaking changes.** This is a working capture
  station as of last commit; preserve that.
