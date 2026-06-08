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
    fin = os.path.join(OUTPUT_DIR, f"final_{job_id}.mp4")
    if os.path.isfile(fin):
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

        # Save a copy to the output folder (named by job id), then mark done
        final = os.path.join(OUTPUT_DIR, f"final_{job_id}.mp4")
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
                    "media_type": req.media_type}
    threading.Thread(target=_run_job, args=(job_id, req.text), daemon=True).start()
    return {"job_id": job_id}


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
