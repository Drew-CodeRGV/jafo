# jafo — Handoff to a fresh Claude session

> If you're a Claude Code instance reading this for the first time, this
> document gives you everything you need to continue working on jafo without
> Drew having to re-explain the project. Pair this with `CLAUDE.md` (which
> has the conventions/gotchas) — together they should bring you up to speed
> in about 5 minutes.

---

## Who is the user

**Drew Lentz** — Senior Solutions Architect at eero (Amazon). Career in
wireless infrastructure: Comcast Business (Distinguished SA), Meta (TPM),
Cisco (PM). Side ventures: WifiStand Inc, Frontera Consulting, Rioplex
Broadband (early WISP in the Rio Grande Valley).

Based in McAllen, Texas. Deeply embedded in RGV civic tech — president of
South Texas's largest tech nonprofit, executive director of the South Texas
Community Arts Foundation (TEDx organizer), licensed ham radio operator
(callsign **KE5ZJO**), hosts the *Waves* podcast since 2005.

His voice on technical topics is **practitioner, not marketer**. Always
answers "so what?" for the working person. Avoid corporate-speak, passive
voice, credential flexing. Short, direct, useful.

He's used Claude extensively for content creation, technical research,
automation design, and business document production. Familiar with the
tool. Doesn't need hand-holding on basics.

---

## What jafo is and why it exists

jafo is a single-Pi, self-hosted observatory for unencrypted public-safety
radio in the Rio Grande Valley. The active system is the **Lower Rio Grande
Valley Regional Radio System (LRGVRRS)** — a P25 Phase 1 trunked radio
system used by Hidalgo, Cameron, Willacy, Starr, and Brooks Counties.

**System ID 0x2B5, WACN 0xBEE00.**

Drew built jafo to:

1. **Hear what's happening in the RGV in real time** — fire, EMS, schools,
   constables, public works. Not police voice (encrypted) but their *traffic
   patterns* (when, what talkgroup, what unit) which is itself useful intel.
2. **Demonstrate civic-tech AI plumbing** — Whisper for transcription
   (handles bilingual English/Spanish out of the box), Claude Haiku for
   structured incident extraction, all on a $200 Pi.
3. **Build advocacy material** for asking the City of McAllen to publish a
   public CAD feed (which would replace this whole stack with an actual
   data feed and put jafo out of a job, which is the goal).

The naming: **JAFO** = Just Another F\*\*\*ing Observer. The callsign for
the spotter in *Blue Thunder* (1983). Passive role, sees everything, only
speaks when there's something worth saying.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Hardware                                                         │
│  ├─ Raspberry Pi 5 (8GB) + Active Cooler + 27W PSU               │
│  ├─ HackRF One  ──► voice channels (851-856 MHz, 7.968 MS/s)     │
│  ├─ SDRplay RSP1 ──► control channel (~851 MHz, 2.4 MS/s)        │
│  └─ Powered USB hub (non-negotiable; SDRs draw too much for Pi)  │
│                                                                   │
│  Antenna: separate antennas per SDR (currently indoor mag-mount   │
│  on metal cookie sheet near a window facing NE). Outdoor antenna  │
│  is on Drew's TODO list — would add 20+ dB of headroom.           │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Service: jafo-recorder         ($0/month)                       │
│  ─────────────────────────                                       │
│  trunk-recorder (compiled from source, v5.2.x)                   │
│  Reads ~jafo-data/config/config.json                             │
│  Decodes P25 control channel, captures voice channels as WAVs    │
│  Writes raw WAVs to ~/jafo-data/recordings/                      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Service: jafo-processor        ($0/month)                       │
│  ─────────────────────────                                       │
│  Watches ~/jafo-data/recordings/ for new .wav files              │
│  Runs Silero VAD — drops calls with no speech / too short        │
│  Encodes survivors to Opus (16 kHz mono, 32 kbps, voip mode)     │
│  Inserts SQLite row in `calls` table with metadata               │
│  Moves Opus to ~/jafo-data/calls/YYYY-MM-DD/                     │
│  Filters out ~80-90% of trunk-recorder output as junk            │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Service: jafo-transcriber      (~$1-3/month at 300 calls/day)   │
│  ─────────────────────────                                       │
│  Polls DB for calls with status=kept and transcript IS NULL      │
│  Sends Opus to Groq Whisper API (whisper-large-v3-turbo)         │
│  Writes transcript + transcript_at back to row                   │
│  ~0.3-1.0 sec wall-clock latency per call                        │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Service: jafo-enricher         (~$2-5/month at 300 calls/day)   │
│  ─────────────────────────                                       │
│  Polls DB for calls with transcript and incident_json IS NULL    │
│  Sends transcript to Anthropic API (claude-haiku-4-5)            │
│  Asks for structured JSON: type, summary, location, units, sev   │
│  Region context from JAFO_REGION in .env helps geocoding         │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Service: jafo-web              ($0/month)                       │
│  ─────────────────────────                                       │
│  Flask app on 127.0.0.1:8080, fronted by nginx on :80            │
│  Reads from same SQLite DB                                       │
│  Talkgroup grouping by Tag (service) or Category (city)          │
│  FTS5 search across transcripts/summaries                        │
│  Range-supported audio streaming (audio/ogg)                     │
│  Polls every 10s (stats), 15s (calls), 60s (sidebar)             │
└──────────────────────────────────────────────────────────────────┘
```

**Single SQLite database** (`~/jafo-data/jafo.db`) is the system's spine.
Every service reads/writes to the `calls` table. WAL mode + busy_timeout
makes this safe across processes.

A row evolves through stages:

1. processor inserts: `id, talkgroup, opus_path, status, ...`
2. transcriber updates: `transcript, transcript_at`
3. enricher updates: `incident_*, enriched_at`

NULL columns mean "stage not yet done." Each stage is a poll loop that
queries for "rows where my output column is NULL and the previous stage
finished." Crash any service and it picks up where it left off when restarted.

---

## What it cost to build

In total, building jafo across one weekend hit these bumps. They're
all documented in `docs/TROUBLESHOOTING.md` but here's the chronological
journey so you understand why certain things look the way they do:

### Round 1: file transfer hell
- Initial repo only had a README. No way to bootstrap from `curl bash`
  because the actual code lived only in chat with Claude.ai.
- File attachments in chat had to be **right-click → Save link as**, not
  left-click. Took multiple tries to figure that out.
- We landed on: tar.gz the repo on Claude side, scp from Windows to Pi,
  extract, run `bootstrap.sh`. (`scripts/push-to-github.sh` now exists
  to break that cycle for good.)

### Round 2: install bugs we hit on the live Pi
- `.env` had unquoted comma in `JAFO_REGION` → bash sourcing crashed.
  **Fix:** quote anything with commas/spaces.
- `bootstrap.sh` did `git clone` even when files were already extracted from
  the tar. **Fix:** detect 3 states (files-present-no-git, repo-cloned, nothing)
- SDRplay's `https://www.sdrplay.com/software/install.sh` URL **now installs
  SDRconnect** (the GUI desktop app), not the API. Took us a while to spot.
  **Fix:** use direct `.run` URL: `SDRplay_RSP_API-Linux-3.15.2.run`.
- Boost.Log + Boost.Random missing from Pi OS → trunk-recorder cmake fails.
  **Fix:** `sudo apt-get install libboost-all-dev` (the meta-package).
- `git pull` on trunk-recorder repo fails in detached HEAD state (which it's
  in after `git checkout v5.2.1`). **Fix:** use `git fetch --tags` instead
  of `pull`.
- `torch<2.6` impossible on Pi OS Bookworm — Python 3.13 wheels for torch
  start at 2.6.0. **Fix:** dropped the upper bound in requirements.txt.

### Round 3: getting it to actually decode
- Default sample rates `2_000_000` and `8_000_000` aren't multiples of
  24000 → trunk-recorder errors out. **Fix:** use 2,400,000 and 7,968,000.
- HackRF gain config: setting `gain: 40` fails because HackRF's RF stage
  only takes 0 or 14. **Fix:** three-stage gain ladder
  (`gain=14, ifGain=40, bbGain=40`).
- Even with everything fixed, decode rate stayed at 0/sec. Spectrum analysis
  showed signal at the right frequencies but very weak. Spent a couple hours
  chasing PPM correction, modulation (QPSK vs FSK4), gain combinations,
  cookie sheet under antenna.
- **Real cause:** McAllen LRGVRRS site wasn't reachable from Drew's first-
  floor location. The **Pharr site** (851.0675c, 851.3375c) was. Pulled
  RR data, switched control channels to Pharr — decoded immediately.
  WACN: 0xBEE00, NAC: 2B1.
  **Lesson baked into all profiles:** list multiple sites' control channels
  and let trunk-recorder lock onto the strongest.
- After decode worked, calls weren't being recorded — placeholder talkgroups
  CSV had IDs in 1000-9999 range, real LRGVRRS IDs are 60000-65000 range.
  Set `recordUnknown: true` to record everything, then loaded the real
  RadioReference CSV (~406 talkgroups). Names started showing up:
  *Metro McAllen*, *McAllen PD3 Info*, *LoneStarEMS McAl*, etc.

### Round 4: web UI polish
- nginx (running as www-data) couldn't traverse `/home/pi` → 403 on every
  static file. **Fix:** `chmod o+x /home/pi`. Baked into installer.
- Audio playback cut off mid-file in Chrome. **Cause:** served as `audio/opus`
  MIME, no explicit OGG container header. **Fix:** changed MIME to `audio/ogg`,
  added `-f ogg` to ffmpeg, switched to native `<audio controls>`.
- Talkgroups sidebar was a flat list of 30+ items. Drew asked for grouping
  by service type (Police/Fire/EMS) and by city. CSV's `Tag` column = service,
  `Category` column = city. Web app now reads the CSV at runtime and
  provides `/api/talkgroup-groups?group_by={service|category|flat}&sort={count|alpha}`.

---

## Important design decisions and rationale

### Why SQLite + FTS5 instead of Postgres / Elasticsearch?

Single Pi. Single writer per table. ~300 calls/day. SQLite + FTS5 is
genuinely the right answer at this scale. WAL mode handles the reader-
writer concurrency between services fine. We'd add latency and operational
complexity for no benefit by moving to a server.

### Why Silero VAD instead of just sending all audio to Whisper?

Whisper costs money per second of audio. ~80% of trunk-recorder output
is garbage (encrypted bursts captured for metadata, sub-second blips,
dead air after PTT release). Filtering before the API saves real money
and reduces noise in the UI. Silero is small (~14 MB), fast on Pi 5
(~10x realtime), and stupid-reliable.

### Why Groq for Whisper instead of OpenAI?

Groq's Whisper inference is ~10x faster than OpenAI's at similar accuracy
and lower cost. Free tier covers 14,400 minutes/month — way more than
this system will use. If Groq pricing changes, swapping to OpenAI is a
30-line edit in `transcriber.py`.

### Why Haiku for enrichment instead of Sonnet/Opus?

Haiku is plenty for the task: extract structured fields from a 1-2
sentence transcript. Sonnet would cost ~5x more for marginal accuracy
gains. If/when we want better summaries (multi-call incident threading,
deeper context), Sonnet is a one-line change.

### Why systemd units instead of Docker / k8s?

This is a Pi. systemd is what's there. Docker on a Pi is fine but adds
overhead and complexity. We have 5 services with simple lifecycles
(restart on failure, depend on each other for startup ordering).
systemd does this in 10 lines per service vs hundreds of YAML.

### Why Flask instead of FastAPI / something async?

Flask + nginx with sync workers is genuinely easier to reason about
and easier to debug. Our QPS is in the single digits. The benefit of
async would be invisible. If we ever need WebSockets for realtime push
to the browser (instead of 15-second polling), we'd revisit.

### Why vanilla JS for the frontend instead of React?

The frontend is one HTML file, one JS file, one CSS file. Total code is
~750 lines. React would more than triple that without buying us anything
that matters. The page polls every 15 seconds; full-page rerender on each
poll would be fine. We don't need a virtual DOM at this complexity.

---

## Current state of the world

As of last successful capture session:

- **Decoder is locked on Pharr site** (NAC 0x2B1)
- **Real talkgroups CSV is loaded** (406 entries from RadioReference)
- **All five services healthy** (`jafo-*` all `active (running)`)
- **API keys present in .env** (Groq + Anthropic)
- **Web UI accessible at http://jafo.local**
- **Talkgroup grouping works** — Service/City/Flat with Active/A-Z sort
- **Audio plays end-to-end** (after the OGG container fix)
- **Real calls flowing through** — Metro McAllen, LoneStarEMS,
  HCISD schools, Spanish-language EMS, fire/HazMat traffic

The system was actively transcribing real RGV public safety radio when
Drew last looked. Don't break it.

---

## Open TODOs Drew has mentioned

Not blocking, but in the back of his mind:

- **Outdoor antenna** would dramatically improve decode quality. Current
  indoor mag-mount on cookie sheet near window works but is marginal.
  A Diamond D-130J discone or an 800 MHz vertical on the roof would
  give 20-30 dB more SNR and let the system hear La Joya, Brownsville,
  and other RGV sites that currently aren't reachable.
- **NVMe storage** — there's a 1TB WD NVMe in a 52Pi RS-P11 rackmount
  HAT that wasn't recognized at install time. Diagnosed as a power
  issue (RS-P11 needs separate USB-C power, not the Pi's). Not blocking
  for now since SD card has plenty of room. Worth revisiting later.
- **Map view** in the web UI — the data has location strings extracted
  by Claude. Geocoding + plotting on a leaflet map would be a real
  shipping feature.
- **Push to OpenMHz / Broadcastify Calls** — trunk-recorder has plugins
  for both. Would make jafo a contributor to public archives, not just
  a private listening post.
- **Multi-Pi mesh** — Drew mentioned interest in eventually running
  jafo nodes in different parts of the RGV (each hearing different
  LRGVRRS sites better) and federating them. Current single-Pi setup
  is fine for now.
- **CAD feed advocacy** — the eventual goal. Once jafo is producing
  enough useful output, take it to McAllen city commissioners with a
  case for "publish your CAD feed publicly so we don't have to do
  this." Drew has political capital with at least one commissioner.

---

## Drew's communication style

When responding to him in Claude Code:

- **Be direct.** No "I'd be happy to help with that!" preamble.
- **Show, don't explain.** Run the command, paste the output, summarize
  in one sentence.
- **Practitioner voice.** "Trunk-recorder requires sample rates that are
  multiples of 24000" not "It's important to note that the trunk-recorder
  application has specific requirements regarding sample rates."
- **Honest about uncertainty.** If you don't know if a fix will work, say
  so. Don't pretend confidence.
- **Conversational technical authority.** Drew has 25+ years in wireless.
  Don't over-explain RF basics, but also don't assume he's seen every
  software wrinkle.
- **Push back when you should.** If he's about to do something that will
  break the running system, say so before doing it.
- **Conference framework when relevant:** *What's New / What's Now /
  What's Next* — this is how he structures podcast segments and likes
  technical breakdowns.

---

## When you start a session

1. Read `CLAUDE.md` (you probably already did)
2. Read this file (you're reading it)
3. `cd ~/jafo && git status` to see what state the repo is in
4. `~/jafo-data/venv-services/bin/python ~/jafo/pi/services/stats.py` to see
   if the pipeline is healthy
5. Ask Drew what he wants to work on. Don't assume.

When you're done with a session that involved real changes:

1. Test on the live Pi (the services run there, restart them, watch the
   logs for 30 seconds)
2. `bash ~/jafo/scripts/push-to-github.sh` to push the changes
3. Update HANDOFF.md or CLAUDE.md if you learned something new about the
   system that the next session would benefit from

---

## Final note

This project went from zero to running in roughly one weekend of grinding.
The codebase is small, the dependencies are reasonable, the architecture is
not over-engineered. Resist the temptation to "improve" things that aren't
actually broken. Drew built jafo as a working tool, not a portfolio piece.
Keep it that way.
