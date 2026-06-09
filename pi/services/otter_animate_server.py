#!/usr/bin/env python3
"""
otter_animate_server.py  —  News Otter render service (fully animated, CPU-only)

LINUX HUB PORT of the original Windows renderer. Same HTTP contract, so the n8n
"News Otter - Auto Video Pipeline" workflow is unchanged:

    POST /render     {"text","title","caption","media_type"}  -> {"job_id": "..."}
    GET  /status/ID                  -> {"status": "queued|processing|done|error", ...}
    GET  /video/ID                   -> the finished mp4

Pipeline per request:
    script text -> Piper TTS -> Rhubarb (mouth-shape timings) ->
    swap mouth PNG per cue -> ffmpeg assembles frames + audio -> mp4

CPU-only. No GPU, no per-render cost, no length limit.

--------------------------------------------------------------------------
Runs on the jafo.live hub as the `jafo-otter` systemd unit, in the dedicated
venv at /var/jafo/venv-otter. All paths/config below are overridable via
environment (the systemd unit sets them). Defaults target /var/jafo/otter.

Bound to 127.0.0.1 by default: n8n reaches it over loopback, so the service is
never exposed to the internet.
--------------------------------------------------------------------------
"""

import os, sys, uuid, json, subprocess, threading, shutil, time, re
import urllib.request, urllib.parse, urllib.error
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from PIL import Image, ImageDraw, ImageFont

# ====================== CONFIG (env-overridable) ======================
OTTER_ROOT  = os.environ.get("JAFO_OTTER_ROOT", "/var/jafo/otter")
ASSETS_DIR  = os.environ.get("JAFO_OTTER_ASSETS",  os.path.join(OTTER_ROOT, "assets"))      # body.png + mouths/*.png
PIPER_VOICE = os.environ.get("JAFO_OTTER_VOICE",   os.path.join(OTTER_ROOT, "voices/en_US-ryan-high.onnx"))
RHUBARB_BIN = os.environ.get("JAFO_OTTER_RHUBARB", os.path.join(OTTER_ROOT, "rhubarb/Rhubarb-Lip-Sync-1.14.0-Linux/rhubarb"))
WORK_DIR    = os.environ.get("JAFO_OTTER_WORK",    os.path.join(OTTER_ROOT, "jobs"))
OUTPUT_DIR  = os.environ.get("JAFO_OTTER_OUTPUT",  os.path.join(OTTER_ROOT, "output"))
FONT        = os.environ.get("JAFO_OTTER_FONT",    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
FPS         = int(os.environ.get("JAFO_OTTER_FPS", "25"))            # base frame rate before interpolation
SMOOTH      = os.environ.get("JAFO_OTTER_SMOOTH", "1") == "1"        # motion-interpolate jerky mouth swaps
SMOOTH_FPS  = int(os.environ.get("JAFO_OTTER_SMOOTH_FPS", "60"))     # target fps when SMOOTH is on
LOWER_THIRD = os.environ.get("JAFO_OTTER_LOWER_THIRD", "1") == "1"   # red headline banner overlay
LOWER_THIRD_Y = float(os.environ.get("JAFO_OTTER_LOWER_THIRD_Y", "0.28"))  # bar BOTTOM edge, fraction of canvas height up from the bottom (higher = banner sits higher)
BIND        = os.environ.get("JAFO_OTTER_BIND", "127.0.0.1")
PORT        = int(os.environ.get("JAFO_OTTER_PORT", "8000"))
# The python interpreter used to invoke `-m piper` (this venv by default).
PIPER_PY    = os.environ.get("JAFO_OTTER_PIPER_PY", sys.executable)
# Disk hygiene: a rendered clip's job dir + output mp4 are deleted either by the
# n8n workflow right after it posts (DELETE /video/<id>) or, as a safety net,
# automatically once they're older than TTL_HOURS (covers errored/never-posted
# jobs). The reaper never touches the _frames shape cache.
TTL_HOURS         = float(os.environ.get("JAFO_OTTER_TTL_HOURS", "12"))
REAP_INTERVAL_MIN = float(os.environ.get("JAFO_OTTER_REAP_INTERVAL_MIN", "30"))

# --- Wav2Lip backend (optional, for the hourly rundown / featured Reels) ---
# OFF by default: when disabled the renderer behaves exactly as before (Piper ->
# Rhubarb visemes -> mouth-PNG swap). When JAFO_OTTER_WAV2LIP=1, jobs whose
# media_type is in JAFO_OTTER_WAV2LIP_MEDIA are lip-synced with Wav2Lip against a
# fixed 1080x1920 otter still instead, then sharpened + given synthetic breathing
# and the SAME lower-third banner. CPU-heavy (~minutes/clip) so scope it narrow.
W2L_ENABLE = os.environ.get("JAFO_OTTER_WAV2LIP", "0") == "1"
W2L_MEDIA  = {m.strip().upper() for m in
             os.environ.get("JAFO_OTTER_WAV2LIP_MEDIA", "REELS").split(",") if m.strip()}
W2L_PY     = os.environ.get("JAFO_OTTER_W2L_PY",   "/var/jafo/otter/wav2lip/venv-w2l/bin/python")
W2L_DIR    = os.environ.get("JAFO_OTTER_W2L_DIR",  "/var/jafo/otter/wav2lip/Wav2Lip")
W2L_CKPT   = os.environ.get("JAFO_OTTER_W2L_CKPT", "/var/jafo/otter/wav2lip/Wav2Lip/checkpoints/wav2lip_gan.pth")
W2L_BASE   = os.environ.get("JAFO_OTTER_W2L_BASE", "/var/jafo/otter/w2l-assets/base.png")
W2L_BOX    = os.environ.get("JAFO_OTTER_W2L_BOX",  "540 862 405 690")  # top bottom left right @1080x1920
W2L_BATCH  = os.environ.get("JAFO_OTTER_W2L_BATCH", "16")  # mel batch; 128 default ≈ ~1.9GB, 16 ≈ much less
# Only ONE Wav2Lip render at a time — each holds ~1.9 GB and two would OOM the
# 3.7 GB hub. A second concurrent render waits here instead of running in parallel.
_W2L_LOCK = threading.Lock()

# Direct Instagram Graph API publishing (replaces upload-post.com). Meta fetches
# the video from a public URL (JAFO_IG_PUBLIC_BASE/<filename>), so the rendered
# clip must be reachable there (nginx serves the output dir). Token via env only.
IG_USER_ID     = os.environ.get("JAFO_IG_USER_ID", "").strip()
IG_TOKEN       = os.environ.get("JAFO_IG_ACCESS_TOKEN", "").strip()
IG_GRAPH       = os.environ.get("JAFO_IG_GRAPH_VERSION", "v21.0").strip()
IG_PUBLIC_BASE = os.environ.get("JAFO_IG_PUBLIC_BASE", "").rstrip("/")
# ======================================================================

os.makedirs(WORK_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
app = FastAPI(title="News Otter Animation Service")
JOBS = {}

# Pre-composite body+mouth once per shape at startup (fast, cached on disk).
# Guarded: if assets aren't installed yet, the service still starts and reports
# the problem via / and 503s on /render, instead of crashing on import.
BODY = None
ASSETS_OK = False
ASSETS_ERR = None
FRAME_CACHE = os.path.join(WORK_DIR, "_frames")
os.makedirs(FRAME_CACHE, exist_ok=True)
SHAPES = {}


def load_assets():
    """(Re)load the otter body + mouth shapes. Safe to call repeatedly."""
    global BODY, ASSETS_OK, ASSETS_ERR, SHAPES
    SHAPES = {}
    try:
        BODY = Image.open(os.path.join(ASSETS_DIR, "body.png")).convert("RGBA")
        for shape in "ABCDEFGHX":
            mp = os.path.join(ASSETS_DIR, "mouths", f"{shape}.png")
            if not os.path.exists(mp):
                continue
            out = os.path.join(FRAME_CACHE, f"{shape}.png")
            Image.alpha_composite(BODY, Image.open(mp).convert("RGBA")).convert("RGB").save(out)
            SHAPES[shape] = out
        if "X" not in SHAPES:
            raise RuntimeError("missing required rest mouth shape: mouths/X.png")
        ASSETS_OK = True
        ASSETS_ERR = None
    except Exception as e:
        BODY = None
        ASSETS_OK = False
        ASSETS_ERR = str(e)


load_assets()
if ASSETS_OK:
    print(f"[news-otter] assets={ASSETS_DIR}  body={BODY.size}  shapes={sorted(SHAPES)}  "
          f"lower_third={LOWER_THIRD}  smooth={SMOOTH}  bind={BIND}:{PORT}", flush=True)
else:
    print(f"[news-otter] WARNING: assets not loaded ({ASSETS_ERR}). "
          f"Service is up but /render will 503 until {ASSETS_DIR}/body.png + mouths/*.png exist.",
          flush=True)


def make_lower_third(title, path):
    """Render a red broadcast lower-third with the headline, scaled to the canvas."""
    W, H = BODY.size
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    clean = "".join(ch for ch in (title or "") if ord(ch) < 0x2190).strip()  # drop leading emoji/symbols
    if not clean:
        clean = "The News Otter"
    fsize = max(28, int(W * 0.042))
    try:
        font = ImageFont.truetype(FONT, fsize)
    except Exception:
        font = ImageFont.load_default()
    pad = int(W * 0.035)
    maxw = W - pad * 2
    words, lines, cur = clean.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=font) <= maxw:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur:
        lines.append(cur)
    lines = lines[:3]
    lh = int(fsize * 1.25)
    barh = int(fsize * 0.6) + lh * len(lines)
    bary = H - barh - int(H * LOWER_THIRD_Y)                            # higher = banner sits higher (JAFO_OTTER_LOWER_THIRD_Y)
    d.rectangle([0, bary, W, bary + barh], fill=(200, 16, 46, 235))     # broadcast red
    d.rectangle([0, bary, int(W * 0.014), bary + barh], fill=(255, 255, 255, 255))  # white accent
    y = bary + int(fsize * 0.3)
    for ln in lines:
        d.text((pad, y), ln, font=font, fill=(255, 255, 255, 255))
        y += lh
    img.save(path)


_HEX = re.compile(r"\A[0-9a-fA-F]+\Z")


def _safe_job(job_id: str) -> bool:
    """Job ids are uuid4 hex; reject anything else so a delete can't traverse."""
    return bool(_HEX.match(job_id or ""))


def _purge_job(job_id: str) -> list[str]:
    """Delete a single job's working dir + its output mp4. Returns paths removed."""
    removed = []
    jdir = os.path.join(WORK_DIR, job_id)
    if os.path.isdir(jdir):
        shutil.rmtree(jdir, ignore_errors=True)
        removed.append(jdir)
    # delete the actual stored output (slug-named) AND the legacy job-id name
    stored = (JOBS.get(job_id, {}) or {}).get("path")
    for fin in {stored, os.path.join(OUTPUT_DIR, f"final_{job_id}.mp4")}:
        if fin and os.path.isfile(fin):
            try:
                os.remove(fin); removed.append(fin)
            except FileNotFoundError:
                pass
    JOBS.pop(job_id, None)
    return removed


def _reap_once() -> list[str]:
    """Delete job dirs + output clips older than TTL_HOURS. Skips the frame cache."""
    cutoff = time.time() - TTL_HOURS * 3600
    removed = []
    for name in os.listdir(WORK_DIR):
        if name == "_frames":
            continue
        p = os.path.join(WORK_DIR, name)
        try:
            if os.path.isdir(p) and os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
                removed.append(p)
                JOBS.pop(name, None)
        except FileNotFoundError:
            pass
    for name in os.listdir(OUTPUT_DIR):
        p = os.path.join(OUTPUT_DIR, name)
        try:
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
                removed.append(p)
        except FileNotFoundError:
            pass
    return removed


def _reaper_loop():
    while True:
        try:
            r = _reap_once()
            if r:
                print(f"[news-otter] reaper removed {len(r)} item(s) older than {TTL_HOURS}h", flush=True)
        except Exception as e:
            print(f"[news-otter] reaper error: {e}", flush=True)
        time.sleep(REAP_INTERVAL_MIN * 60)


@app.on_event("startup")
def _start_reaper():
    threading.Thread(target=_reaper_loop, daemon=True).start()
    print(f"[news-otter] reaper started: TTL={TTL_HOURS}h interval={REAP_INTERVAL_MIN}m", flush=True)


class RenderReq(BaseModel):
    text: str
    title: str = "The News Otter"
    caption: str = ""
    media_type: str = "REELS"
    slug: str = ""           # name the output mp4 for its intended upload slot


def _final_path(job_id: str) -> str:
    """Path for the finished mp4. Named for the intended upload slot when the
    caller passed a slug (e.g. 'REELS_20260609-1400') so a human / the reaper can
    see at a glance what each clip is; falls back to the job id."""
    slug = (JOBS.get(job_id, {}) or {}).get("slug", "") or ""
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", slug.strip())
    return os.path.join(OUTPUT_DIR, f"final_{safe or job_id}.mp4")


def _wav2lip_render(job_id, wav, jdir):
    """Lip-sync the fixed otter still to `wav` with Wav2Lip (CPU, low priority),
    then sharpen + add synthetic breathing + the same lower-third banner. Returns
    the finished mp4 path; raises on failure so _run_job marks the job errored."""
    raw = os.path.join(jdir, "w2l_raw.mp4")
    cmd = ["nice", "-n", "15", "ionice", "-c", "3",
           W2L_PY, "inference.py",
           "--checkpoint_path", W2L_CKPT,
           "--face", W2L_BASE, "--audio", wav,
           "--static", "True", "--fps", str(FPS),
           "--wav2lip_batch_size", W2L_BATCH,   # default 128 is RAM-hungry; smaller batch ≈ lower peak RAM
           "--box"] + W2L_BOX.split() + ["--nosmooth", "--outfile", raw]
    p = subprocess.run(cmd, cwd=W2L_DIR, capture_output=True)
    if p.returncode != 0 or not os.path.exists(raw):
        raise RuntimeError("Wav2Lip failed: " + p.stderr.decode()[:500])
    out = os.path.join(jdir, "out.mp4")
    # sharpen + denoise, gentle synthetic breathing/sway, then the SAME banner.
    vf = ("[0:v]unsharp=5:5:0.7:5:5:0.0,hqdn3d=1.5:1.5:6:6,scale=iw*1.06:ih*1.06,"
          "zoompan=z='1.04+0.018*sin(on/25*1.1)':d=1:"
          "x='iw/2-(iw/zoom/2)+21*sin(on/25*0.5)':"
          "y='ih/2-(ih/zoom/2)+15*sin(on/25*0.8)':s=1080x1920:fps=" + str(FPS) + "[ob]")
    inputs = ["-i", raw]
    if LOWER_THIRD:
        lt = os.path.join(jdir, "lower_third.png")
        make_lower_third(JOBS[job_id]["title"], lt)
        inputs += ["-i", lt]
        filt = vf + ";[ob][1:v]overlay=0:0[v]"
    else:
        filt = vf[:-4] + "[v]"
    cmd2 = (["ffmpeg", "-y"] + inputs +
            ["-filter_complex", filt, "-map", "[v]", "-map", "0:a",
             "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", out])
    p = subprocess.run(cmd2, capture_output=True)
    if p.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("Wav2Lip compositing failed: " + p.stderr.decode()[:600])
    return out


def _run_job(job_id: str, text: str):
    try:
        JOBS[job_id]["status"] = "processing"
        jdir = os.path.join(WORK_DIR, job_id); os.makedirs(jdir, exist_ok=True)
        wav  = os.path.join(jdir, "voice.wav")
        cues = os.path.join(jdir, "cues.json")
        txt  = os.path.join(jdir, "dialog.txt")
        lst  = os.path.join(jdir, "frames.txt")
        out  = os.path.join(jdir, "out.mp4")
        open(txt, "w", encoding="utf-8").write(text)

        # 1) Piper TTS (invoked as a module; text on stdin)
        p = subprocess.run([PIPER_PY, "-m", "piper", "--model", PIPER_VOICE, "--output_file", wav],
                           input=text.encode(), capture_output=True)
        if p.returncode != 0:
            raise RuntimeError("Piper failed: " + p.stderr.decode()[:400])

        # 1b) Optional Wav2Lip backend for selected media types (e.g. REELS
        #     rundown). When it applies, lip-sync the fixed otter still and skip
        #     the Rhubarb viseme path entirely. Serialize with _W2L_LOCK: each
        #     render holds ~1.9 GB, so two at once would OOM the 3.7 GB box — the
        #     lock queues a second render instead of running it concurrently.
        if W2L_ENABLE and JOBS[job_id].get("media_type", "").upper() in W2L_MEDIA:
            with _W2L_LOCK:
                out = _wav2lip_render(job_id, wav, jdir)
            final = _final_path(job_id)
            shutil.copy(out, final)
            JOBS[job_id].update(status="done", path=final)
            return

        # 2) Rhubarb -> mouth cues (dialog file improves accuracy)
        p = subprocess.run([RHUBARB_BIN, "-f", "json", "--extendedShapes", "GHX",
                            "--dialogFile", txt, "-o", cues, wav], capture_output=True)
        if p.returncode != 0:
            raise RuntimeError("Rhubarb failed: " + p.stderr.decode()[:400])
        mouth_cues = json.load(open(cues))["mouthCues"]

        # 3) Build ffmpeg concat list: one cached frame per cue, held for its duration
        with open(lst, "w") as f:
            for c in mouth_cues:
                img = SHAPES.get(c["value"], SHAPES.get("X"))
                dur = max(0.04, c["end"] - c["start"])
                f.write("file '%s'\n" % img.replace("\\", "/"))
                f.write(f"duration {dur:.3f}\n")
            f.write("file '%s'\n" % SHAPES.get("X").replace("\\", "/"))  # concat needs final file line

        # 4) Build the lower-third banner (headline), then encode:
        #    concat -> base fps -> overlay banner -> optional motion-interpolation.
        inputs = ["-f", "concat", "-safe", "0", "-i", lst, "-i", wav]
        parts = [f"[0:v]fps={FPS}[s0]"]
        prev = "s0"
        if LOWER_THIRD:
            lt = os.path.join(jdir, "lower_third.png")
            make_lower_third(JOBS[job_id]["title"], lt)
            inputs += ["-i", lt]
            parts.append(f"[{prev}][2:v]overlay=0:0[s1]")
            prev = "s1"
        if SMOOTH:
            parts.append(f"[{prev}]minterpolate=fps={SMOOTH_FPS}:mi_mode=blend[s2]")
            prev = "s2"
        filt = ";".join(parts)
        cmd = (["ffmpeg", "-y"] + inputs +
               ["-filter_complex", filt, "-map", f"[{prev}]", "-map", "1:a",
                "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", out])
        p = subprocess.run(cmd, capture_output=True)
        if p.returncode != 0 or not os.path.exists(out):
            raise RuntimeError("ffmpeg failed: " + p.stderr.decode()[:600])

        # Save a copy to the output folder (named for its upload slot), mark done
        final = _final_path(job_id)
        shutil.copy(out, final)
        JOBS[job_id].update(status="done", path=final)
    except Exception as e:
        JOBS[job_id].update(status="error", error=str(e))


@app.post("/render")
def render(req: RenderReq):
    if not ASSETS_OK:
        raise HTTPException(503, f"otter assets not installed: {ASSETS_ERR}")
    if not req.text.strip():
        raise HTTPException(400, "empty text")
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "queued", "error": None, "path": None,
                    "title": req.title, "caption": req.caption or req.title,
                    "media_type": req.media_type, "slug": req.slug}
    threading.Thread(target=_run_job, args=(job_id, req.text), daemon=True).start()
    return {"job_id": job_id}


def _graph(method: str, path: str, params: dict, timeout: int = 60) -> dict:
    """Minimal Graph API call (stdlib only). Token goes in the Authorization
    header, never the URL/params, so it can't leak into logs."""
    url = f"https://graph.facebook.com/{IG_GRAPH}/{path}"
    hdr = {"Authorization": f"Bearer {IG_TOKEN}"}
    if method == "GET":
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=hdr, method="GET")
    else:
        body = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(url, data=body, headers=hdr, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"error": {"message": f"HTTP {e.code}"}}
    except Exception as e:
        return {"error": {"message": str(e)[:200]}}


class PublishReq(BaseModel):
    job_id: str
    caption: str = ""
    media_type: str = "REELS"
    dry_run: bool = False        # build + process the container but skip publish


@app.post("/publish")
def publish(req: PublishReq):
    """Publish a finished render straight to Instagram via the Graph API:
    create container (REELS/STORIES) from the public video URL -> poll until
    FINISHED -> media_publish. Blocks until published (~30-90s)."""
    if not (IG_USER_ID and IG_TOKEN and IG_PUBLIC_BASE):
        raise HTTPException(503, "instagram publishing not configured")
    j = JOBS.get(req.job_id)
    if not j or not j.get("path") or not os.path.isfile(j["path"]):
        raise HTTPException(404, "rendered video not found for that job_id")
    fname = os.path.basename(j["path"])
    video_url = f"{IG_PUBLIC_BASE}/{fname}"
    mt = "STORIES" if (req.media_type or "").upper() == "STORIES" else "REELS"

    # 1) create the media container
    params = {"media_type": mt, "video_url": video_url}
    if mt == "REELS" and req.caption:
        params["caption"] = req.caption[:2200]      # IG caption hard limit
    cj = _graph("POST", f"{IG_USER_ID}/media", params)
    cid = cj.get("id")
    if not cid:
        raise HTTPException(502, f"container error: {cj.get('error')}")

    # 2) poll until Instagram has fetched + processed the video
    status = None
    for _ in range(45):                              # ~6 min ceiling
        st = _graph("GET", cid, {"fields": "status_code"}, timeout=30)
        status = st.get("status_code")
        if status == "FINISHED":
            break
        if status in ("ERROR", "EXPIRED"):
            raise HTTPException(502, f"media processing {status}: {st}")
        time.sleep(8)
    if status != "FINISHED":
        raise HTTPException(504, f"media not ready in time (last status {status})")

    if req.dry_run:
        # plumbing validated (Meta fetched + processed our public URL); don't post
        print(f"[ig] DRY-RUN ok {mt} {fname} container {cid} FINISHED", flush=True)
        return {"ok": True, "dry_run": True, "container_id": cid, "video_url": video_url}

    # 3) publish
    pub = _graph("POST", f"{IG_USER_ID}/media_publish", {"creation_id": cid})
    pid = pub.get("id")
    if not pid:
        raise HTTPException(502, f"publish error: {pub.get('error')}")
    print(f"[ig] published {mt} {fname} -> media {pid}", flush=True)
    return {"ok": True, "ig_post_id": pid, "media_type": mt}


@app.get("/")
def root():
    return {"server": "news-otter v2-linux (lower-third + captions + media_type)",
            "assets_dir": ASSETS_DIR, "assets_ok": ASSETS_OK, "assets_error": ASSETS_ERR,
            "body_size": list(BODY.size) if BODY else None,
            "shapes": sorted(SHAPES), "lower_third": LOWER_THIRD,
            "smooth": SMOOTH, "fps": FPS}


@app.get("/healthz")
def healthz():
    return {"ok": True, "assets_ok": ASSETS_OK}


@app.post("/reload-assets")
def reload_assets():
    """Re-scan ASSETS_DIR after dropping in body.png/mouths without a restart."""
    load_assets()
    return {"assets_ok": ASSETS_OK, "assets_error": ASSETS_ERR, "shapes": sorted(SHAPES)}


@app.get("/status/{job_id}")
def status(job_id: str):
    j = JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "unknown job")
    return {"status": j["status"], "error": j["error"],
            "title": j["title"], "caption": j["caption"], "media_type": j["media_type"]}


@app.get("/video/{job_id}")
def video(job_id: str):
    j = JOBS.get(job_id)
    if not j or j["status"] != "done":
        raise HTTPException(409, "not ready")
    return FileResponse(j["path"], media_type="video/mp4", filename=f"{job_id}.mp4")


@app.delete("/video/{job_id}")
def delete_video(job_id: str):
    """Free disk for a clip the workflow has finished posting. Idempotent."""
    if not _safe_job(job_id):
        raise HTTPException(400, "bad job id")
    removed = _purge_job(job_id)
    return {"deleted": bool(removed), "removed": removed}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=BIND, port=PORT)
