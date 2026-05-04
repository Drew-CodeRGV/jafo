#!/usr/bin/env python3
"""
jafo-transcriber — hybrid Groq + local faster-whisper.

Tries Groq first (fast, free-tier or paid). Falls back to local
faster-whisper base (multilingual) on any Groq error: rate-limit, network
failure, 5xx, no API key, etc. Either path stores text + the model that
produced it in `transcript_model`.

Local model is lazy-loaded — no RAM spent until the first fallback.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from common import (
    CALLS_DIR, GROQ_API_KEY, db_connect, setup_logging,
)

log = setup_logging("jafo-transcriber")

GROQ_MODEL = "whisper-large-v3-turbo"
LOCAL_MODEL_NAME = "base"           # multilingual; bilingual EN/ES traffic
LOCAL_COMPUTE = "int8"
LOCAL_CPU_THREADS = 2               # leave 2 cores for trunk-recorder + processor
POLL_INTERVAL_SEC = 10
BATCH_SIZE = 5

# Whisper context prompt — primes the model for our domain
INITIAL_PROMPT = (
    "Police, fire, and EMS radio dispatch in McAllen and Hidalgo County, Texas. "
    "Common agencies: HCSO, MPD, McAllen Fire, Hidalgo EMS, DPS, Border Patrol. "
    "Common terms: dispatch, copy, en route, code 3, signal 50, MVA, "
    "complainant, RP, subject, 10-4, 10-50, 10-7, 10-8, 10-97, "
    "ambulance, supervisor, on scene."
)


# -----------------------------------------------------------------------------
# Local backend (faster-whisper) — lazy-loaded
# -----------------------------------------------------------------------------
_local_model = None

def get_local_model():
    global _local_model
    if _local_model is not None:
        return _local_model
    log.info("Loading local faster-whisper '%s' (%s, %d threads)...",
             LOCAL_MODEL_NAME, LOCAL_COMPUTE, LOCAL_CPU_THREADS)
    from faster_whisper import WhisperModel
    _local_model = WhisperModel(
        LOCAL_MODEL_NAME,
        device="cpu",
        compute_type=LOCAL_COMPUTE,
        cpu_threads=LOCAL_CPU_THREADS,
        num_workers=1,
    )
    log.info("Local model ready.")
    return _local_model


def transcribe_via_local(opus_path: Path) -> tuple[str, str]:
    """Returns (text, model_label). Auto-detects language."""
    model = get_local_model()
    segments, info = model.transcribe(
        str(opus_path),
        beam_size=1,                # fastest
        language=None,              # auto: EN or ES
        initial_prompt=INITIAL_PROMPT,
        vad_filter=False,           # processor.py already VAD-filtered
        temperature=0.0,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    label = f"faster-whisper-{LOCAL_MODEL_NAME}/{info.language}"
    return text, label


# -----------------------------------------------------------------------------
# Groq backend
# -----------------------------------------------------------------------------
def make_groq_client():
    if not GROQ_API_KEY:
        return None
    from groq import Groq
    # max_retries=0 — we want immediate failure on 429 so we can fall through
    # to local. Default SDK retries with Retry-After (~45s) which would defeat
    # the point of the fallback.
    return Groq(api_key=GROQ_API_KEY, max_retries=0)


def transcribe_via_groq(client, opus_path: Path) -> tuple[str, str]:
    with open(opus_path, "rb") as f:
        result = client.audio.transcriptions.create(
            file=(opus_path.name, f.read()),
            model=GROQ_MODEL,
            prompt=INITIAL_PROMPT,
            response_format="verbose_json",
            temperature=0.0,
        )
    return (result.text or "").strip(), GROQ_MODEL


# -----------------------------------------------------------------------------
# DB
# -----------------------------------------------------------------------------
def get_pending_calls(conn, limit: int):
    cur = conn.execute("""
        SELECT id, opus_path, talkgroup_tag, duration_sec
        FROM calls
        WHERE status = 'kept'
          AND audio_deleted = 0
          AND opus_path IS NOT NULL
          AND transcript IS NULL
          AND transcript_error IS NULL
        ORDER BY processed_at ASC
        LIMIT ?
    """, (limit,))
    return cur.fetchall()


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------
def transcribe_one(groq_client, opus_path: Path) -> tuple[str, str]:
    """Try Groq, fall back to local. Returns (text, model_label)."""
    if groq_client is not None:
        try:
            return transcribe_via_groq(groq_client, opus_path)
        except Exception as e:
            # Any Groq failure — rate limit, network, key invalid, 5xx — falls
            # through to local. We log it so we can see the pattern over time.
            log.info("Groq failed (%s: %s) — falling back to local",
                     type(e).__name__, str(e)[:120])
    return transcribe_via_local(opus_path)


def main() -> None:
    groq_client = make_groq_client()
    if groq_client is None:
        log.warning("GROQ_API_KEY not set — running local-only.")
    else:
        log.info("Starting jafo-transcriber. primary=groq:%s fallback=faster-whisper-%s",
                 GROQ_MODEL, LOCAL_MODEL_NAME)

    conn = db_connect()

    while True:
        try:
            calls = get_pending_calls(conn, BATCH_SIZE)
        except Exception as e:
            log.exception("DB query failed: %s", e)
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if not calls:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        for call in calls:
            opus_full = CALLS_DIR / call["opus_path"]
            if not opus_full.exists():
                msg = f"Opus file gone before transcription: {opus_full}"
                log.warning(msg)
                conn.execute(
                    "UPDATE calls SET transcript_error = ?, transcript_at = ? WHERE id = ?",
                    (msg, int(time.time()), call["id"]),
                )
                conn.commit()
                continue

            try:
                t0 = time.time()
                text, model_used = transcribe_one(groq_client, opus_full)
                elapsed = time.time() - t0

                if not text:
                    text = ""
                    log.info("EMPTY id=%s tag=%s dur=%.1fs (%.2fs %s)",
                             call["id"], call["talkgroup_tag"],
                             call["duration_sec"], elapsed, model_used)
                else:
                    log.info("OK    id=%s tag=%s dur=%.1fs (%.2fs %s): %s",
                             call["id"], call["talkgroup_tag"],
                             call["duration_sec"], elapsed, model_used,
                             text[:80] + ("..." if len(text) > 80 else ""))

                conn.execute("""
                    UPDATE calls
                    SET transcript = ?, transcript_model = ?,
                        transcript_at = ?, transcript_error = NULL
                    WHERE id = ?
                """, (text, model_used, int(time.time()), call["id"]))
                conn.commit()

            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                log.error("FAIL  id=%s: %s", call["id"], err)
                conn.execute("""
                    UPDATE calls
                    SET transcript_error = ?, transcript_at = ?
                    WHERE id = ?
                """, (err[:500], int(time.time()), call["id"]))
                conn.commit()
                time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Interrupted, exiting.")
        sys.exit(0)
