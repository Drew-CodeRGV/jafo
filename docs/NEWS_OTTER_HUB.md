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

## n8n workflow

Exported (secret-scrubbed) to `n8n/news-otter-pipeline.workflow.json`. Triggers:
webhook, manual backfill, a 20-min Stories schedule, a 30-min Posts schedule, and
a manual test form — all funnel into `Render Submit → Wait → Status → Done? →
Get Video → Post to Upload-Post → Cleanup Video`.

**Importing:** replace `__UPLOAD_POST_API_KEY__` in the `Post to Upload-Post`
node's `Authorization` header with the real upload-post.com Apikey (kept out of
git). Keep the workflow inactive until an end-to-end test passes.

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
