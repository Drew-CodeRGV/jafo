# jafo — Architecture

## Overview

Five services, one SQLite database, one web tier. All on a single Raspberry Pi 5.

```
                   ┌──────────────┐
RTL-SDR ──────────▶│              │
                   │ jafo-recorder│ → ~/jafo-data/recordings/*.wav
HackRF  ──────────▶│              │   ~/jafo-data/recordings/*.json
                   └──────┬───────┘
                          │ trunk-recorder writes WAV+JSON sidecars
                          ▼
                   ┌──────────────┐
                   │              │ - VAD speech detection
                   │ jafo-processor│ - Filter: encrypted, short, silent
                   │              │ - Trim, encode Opus 16kbps
                   │              │ - INSERT into calls table
                   └──────┬───────┘
                          │
                          ▼
                   ┌──────────────────────────────────────┐
                   │ SQLite (~/jafo-data/jafo.db, WAL)    │
                   │   calls table — one row per call     │
                   │   FTS5 index on transcripts          │
                   └──────┬─────────────────────┬─────────┘
                          │                     │
                          ▼                     ▼
                  ┌──────────────┐      ┌──────────────┐
                  │              │      │              │
                  │jafo-transcrib│      │ jafo-enricher│
                  │              │      │              │
                  │ → Groq API   │      │ → Anthropic  │
                  │   Whisper    │      │   Haiku 4.5  │
                  │              │      │              │
                  │ UPDATE calls │      │ UPDATE calls │
                  │ SET transcrip│      │ SET incident_│
                  └──────────────┘      └──────────────┘
                          ▲
                          │
                  ┌──────────────┐
                  │              │ Flask + Gunicorn
                  │   jafo-web   │ ┌──────────┐
                  │              │ │  nginx   │ → http://jafo.local
                  │ /api/calls   │ │  :80     │
                  │ /api/search  │ │          │
                  │ /audio/*     │ └──────────┘
                  └──────────────┘
```

## Data flow per call

A single call propagates through the table over a few seconds:

| t   | Stage              | Columns set                                                     |
|-----|--------------------|----------------------------------------------------------------|
| 0s  | trunk-recorder     | (none yet — files only)                                         |
| +5s | processor          | wav_path, opus_path, talkgroup, ..., status='kept', metadata    |
| +6s | transcriber picks  | transcript, transcript_model, transcript_at                     |
| +8s | enricher picks     | incident_type, incident_summary, incident_location, incident_*  |
| +∞  | web reads          | (no writes)                                                     |
| +30d| processor sweep    | audio_deleted=1 (file removed; row stays)                       |

## Why SQLite

- Production-grade for hundreds of concurrent reads on a single Pi
- WAL mode handles our 4-writer setup (processor, transcriber, enricher are infrequent writes; web is read-only)
- File-based: backups are `cp jafo.db backups/`. No service to manage.
- FTS5 built in for full-text search

If/when this grows beyond a single Pi (multi-node deployment), Postgres is a one-day swap. Until then, SQLite is the right tool.

## Why poll instead of event-driven

The Pi runs everything; queue infrastructure (Redis, RabbitMQ, etc.) would be overhead with no real benefit. Each worker polls SQLite every 5-10s for "rows where my stage's column is NULL." Simple, robust, easy to reason about. If a worker crashes, it picks up where it left off after restart — the DB is the queue.

## API key handling

API keys live in `~/jafo/.env`, mode 600, owned by `pi`. The systemd units use `EnvironmentFile=` to load them — they never appear in `ps`, never get logged, never leave the Pi.

If keys are missing, the relevant worker logs a warning and sleeps. The pipeline still works — you just don't get transcripts/incidents until you add keys and restart that worker.

## Web stack

- **nginx** on :80 — handles static files, reverse-proxies dynamic routes, supports byte-range requests for audio
- **Gunicorn** with 2 workers × 4 threads — plenty for this scale
- **Flask** — minimal API surface (~10 endpoints)
- **Vanilla JS frontend** — no build step, no framework, no npm. Loads in <50ms over LAN.

## Storage

| Item                | Each   | Daily (300 calls) | Yearly  |
|---------------------|--------|-------------------|---------|
| Opus call           | ~30 KB | ~9 MB             | ~3 GB   |
| JSON sidecar        | ~1 KB  | ~300 KB           | ~110 MB |
| DB row (full)       | ~3 KB  | ~900 KB           | ~330 MB |

Audio auto-deleted after `AUDIO_RETENTION_DAYS` (default 30). DB rows kept forever — cheap and useful for trend analysis.

## Paths

| Path                                | What |
|-------------------------------------|------|
| `~/jafo/`                           | Cloned repo (code) |
| `~/jafo-data/`                      | All working data |
| `~/jafo-data/recordings/`           | Transient WAVs (deleted after processing) |
| `~/jafo-data/calls/YYYY-MM-DD/`     | Filtered Opus archive |
| `~/jafo-data/jafo.db`               | SQLite |
| `~/jafo-data/config/`               | Live trunk-recorder config + talkgroups |
| `~/jafo-data/logs/`                 | trunk-recorder logs |
| `~/jafo-data/venv-services/`        | Python venv: processor + transcriber + enricher |
| `~/jafo-data/venv-web/`             | Python venv: Flask + Gunicorn |
| `/etc/nginx/sites-enabled/jafo`     | nginx config (symlink) |
| `/etc/systemd/system/jafo-*.service`| 5 systemd units |

The split (code in `~/jafo`, data in `~/jafo-data`) means `git pull` never touches your data.
