# News Otter — animated video pipeline (jafo.live hub)

Turns each verified news story/digest into an animated-otter anchor video and
posts it to Instagram. Runs entirely on the **cloud hub** (not the Pi).

```
n8n workflow ──► otter renderer (127.0.0.1:8000) ──► mp4 ──► upload-post.com ──► Instagram
 (triggers,       Piper TTS → Rhubarb lip-sync                                   (Reels/Stories)
  fetch news)      → ffmpeg (lower-third + smoothing)
```

## Renderer service — `jafo-otter`

- Code: `pi/services/otter_animate_server.py` (FastAPI, CPU-only).
- Unit: `pi/systemd/jafo-otter.service` → installed at `/etc/systemd/system/`.
- venv: `/var/jafo/venv-otter` (`fastapi uvicorn piper-tts pillow`).
- Bound to `127.0.0.1:8000` — reached by n8n over loopback, never exposed.

Runtime tree under `/var/jafo/otter/`:

| Path | What |
|---|---|
| `assets/body.png`, `assets/mouths/{A..H,X}.png` | otter art (only on Drew's PC originally; uploaded here) |
| `voices/en_US-ryan-high.onnx` | Piper voice |
| `rhubarb/Rhubarb-Lip-Sync-1.14.0-Linux/rhubarb` | lip-sync binary |
| `jobs/<id>/` | per-render scratch (`_frames/` is the shared shape cache — never reaped) |
| `output/final_<id>.mp4` | finished clip |

### HTTP contract (n8n depends on these)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/render` | `{text,title,caption,media_type}` → `{job_id}` |
| `GET`  | `/status/<job_id>` | `queued\|processing\|done\|error` (+ caption, media_type) |
| `GET`  | `/video/<job_id>` | the finished mp4 |
| `DELETE` | `/video/<job_id>` | delete the clip's scratch + output (called after posting) |
| `POST` | `/reload-assets` | re-scan `assets/` without a restart |
| `GET`  | `/`, `/healthz` | status / asset health |

### Disk hygiene

Clips are deleted two ways (belt + suspenders):
1. The n8n **Cleanup Video** node calls `DELETE /video/<id>` right after the post.
2. A background reaper deletes any job dir / output older than
   `JAFO_OTTER_TTL_HOURS` (default **12h**) — covers errored / never-posted jobs.

Config via env (`JAFO_OTTER_*`); the systemd unit sets voice, rhubarb, bind, TTL.

## Wav2Lip backend (optional, for Reels)

The default animation is Piper → Rhubarb visemes → mouth-PNG swap (fast, the
flat 2D otter). A **Wav2Lip** neural lip-sync backend is available for the
hourly rundown / featured **Reels** only — it animates a fixed **3D otter still**
and is **CPU-heavy (~minutes/clip)**, so it is intentionally scoped narrow and is
**OFF by default**.

- Toggle: `JAFO_OTTER_WAV2LIP=1` (and `JAFO_OTTER_WAV2LIP_MEDIA=REELS`, the
  default). Jobs with that `media_type` take the Wav2Lip path; everything else
  stays on the fast viseme renderer. The HTTP contract and n8n are unchanged.
- Engine lives outside the repo at `/var/jafo/otter/wav2lip/` (its own
  `venv-w2l`, Python 3.10, `Wav2Lip/checkpoints/wav2lip_gan.pth` + `s3fd.pth`
  from the camenduru HF mirror). Runs `nice`/`ionice` low-priority.
- Fixed base still + calibrated mouth box (Wav2Lip's face detector can't find the
  otter, so the box is supplied manually):
  - `JAFO_OTTER_W2L_BASE` = `/var/jafo/otter/w2l-assets/base.png` — a **1080×1920**
    otter frame with a **slightly-open** mouth (closed = invisible movement; a
    self-talking source = out-of-sync gapes, so use a still, not a clip).
  - `JAFO_OTTER_W2L_BOX` = `540 862 405 690` (`top bottom left right`) — must hug
    **only the mouth incl. teeth**; too low paints a phantom chin-mouth, too high
    smears the nose.
- Output is sharpened, given synthetic breathing/sway (static base = no real
  blink), and gets the same lower-third banner.

Rebuild the base still from a source video frame, e.g.:
`ffmpeg -ss <t> -i src.mp4 -frames:v 1 f.png` then scale to 1080×1920; pick a
frame with a gently-parted mouth. Scale the box ×1.5 if measured at 720×1280.

## n8n workflow

Exported to `n8n/news-otter-pipeline.workflow.json` (no secrets — every node calls
either `127.0.0.1:8000` or the public `jafo.live` API). Triggers: webhook, manual
backfill, a `:30` Stories schedule, a `:00` Posts schedule, and a manual test form
— all funnel into `Render Submit → Wait → Status → Done? → Publish to Instagram →
Cleanup Video`.

**Publishing goes direct to the Meta / Instagram Graph API** (as of 2026-06-09),
replacing the retired upload-post.com service. The `Publish to Instagram` node just
POSTs `{job_id, caption, media_type}` to the renderer's `POST /publish`; the
renderer (`otter_animate_server.py`) builds the media container, polls it to
`FINISHED`, and publishes. The IG token + IDs live in `/var/jafo/.env.instagram`
(chmod 600, outside the repo), loaded into `jafo-otter` via a systemd
`EnvironmentFile` drop-in. Meta fetches the rendered MP4 over HTTPS from
`https://jafo.live/m/<file>` (nginx `location /m/` → `/var/jafo/otter/output/`).

> ⚠️ **n8n 2.x runs the PUBLISHED workflow version, not the editor draft.** Editing
> the workflow rows in `~/.n8n/database.sqlite` directly (or `n8n import:workflow`)
> changes only the draft — the engine keeps executing the snapshot pointed to by
> `workflow_entity.activeVersionId` (a row in `workflow_history`). **Always change
> this workflow in the n8n UI and hit Save/Publish** (or use the REST API); a bare
> `systemctl restart n8n` does **not** republish. This bit us hard on 2026-06-09
> (renders kept posting via the dead upload-post node for hours). See
> TROUBLESHOOTING.md → "Otter renders every hour but Instagram never updates."

**Importing:** import the JSON in the n8n UI, then **Save/Publish** it (don't just
flip it active in the DB). Confirm `Publish to Instagram` is wired after `Done?`,
then run one end-to-end test before relying on the schedule.

## One-time hub setup (already done; recorded for rebuilds)

```bash
python3 -m venv /var/jafo/venv-otter
/var/jafo/venv-otter/bin/pip install fastapi uvicorn piper-tts pillow
/var/jafo/venv-otter/bin/python -m piper.download_voices en_US-ryan-high --data-dir /var/jafo/otter/voices
# Rhubarb (Linux): download Rhubarb-Lip-Sync-*-Linux.zip from the project's GitHub
#   releases and unzip into /var/jafo/otter/rhubarb/
# Upload assets/body.png + assets/mouths/*.png into /var/jafo/otter/assets/
sudo cp pi/systemd/jafo-otter.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now jafo-otter
```
