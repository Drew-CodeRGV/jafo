#!/usr/bin/env python3
"""
jafo-transcriber — local-first faster-whisper, optional Groq fallback.

Default behavior: every call gets transcribed locally with faster-whisper-base
(int8, 2 cpu threads). The transcript stays on the Pi until the uploader
ships it to jafo.live alongside the audio. The hub's cloud transcriber acts
as a backup-of-backup for calls that arrive without a transcript.

Set JAFO_TRANSCRIBE_GROQ_FALLBACK=true in .env to use Groq when the local
engine fails (rare — model is robust). Off by default to keep edges
self-contained, no API keys at the edge, predictable monthly spend.
"""

from __future__ import annotations

import os
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

GROQ_FALLBACK_ENABLED = os.environ.get("JAFO_TRANSCRIBE_GROQ_FALLBACK", "").strip().lower() in ("1", "true", "yes")
# Primary backend: "local" (default) tries faster-whisper first; "groq" tries
# Groq's hosted Whisper first and falls back to local on Groq errors. "groq"
# is what you want on a cloud node with the Groq paid tier — it's an order of
# magnitude faster than local CPU inference.
TRANSCRIBE_BACKEND = os.environ.get("JAFO_TRANSCRIBE_BACKEND", "local").strip().lower()
if TRANSCRIBE_BACKEND not in ("local", "groq"):
    TRANSCRIBE_BACKEND = "local"
# Backlog-driven auto-escalation: when JAFO_TRANSCRIBE_GROQ_THRESHOLD > 0 and
# the pending-call count rises above it, the transcriber temporarily routes
# through Groq to catch up — then drops back to the configured primary once
# the backlog clears. Useful on the Pi where local CPU is fine for steady
# state but falls behind during burst activity. 0 (default) = disabled.
TRANSCRIBE_GROQ_THRESHOLD = max(0, int(os.environ.get("JAFO_TRANSCRIBE_GROQ_THRESHOLD", "0")))
_groq_override_active = False  # mutated by main() before each batch

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
    """Backend-selected primary; falls back to the other on errors.
    Returns (text, model_label)."""
    use_groq_primary = (
        (TRANSCRIBE_BACKEND == "groq" and groq_client is not None)
        or (_groq_override_active and groq_client is not None)
    )
    if use_groq_primary:
        try:
            return transcribe_via_groq(groq_client, opus_path)
        except Exception as e:
            log.warning("Groq transcribe failed (%s: %s) — falling back to local",
                        type(e).__name__, str(e)[:120])
            return transcribe_via_local(opus_path)
    # local primary (default): try faster-whisper, optional Groq fallback on err
    try:
        return transcribe_via_local(opus_path)
    except Exception as e:
        log.warning("Local transcribe raised (%s: %s)", type(e).__name__, str(e)[:120])
        if groq_client is not None and GROQ_FALLBACK_ENABLED:
            log.info("falling back to Groq")
            return transcribe_via_groq(groq_client, opus_path)
        raise


def _pending_count(conn) -> int:
    """How many kept calls still need a transcript (audio not yet expired)."""
    cur = conn.execute("""
        SELECT COUNT(*) FROM calls
        WHERE status = 'kept' AND audio_deleted = 0 AND transcript IS NULL
    """)
    return cur.fetchone()[0]


def main() -> None:
    global _groq_override_active
    # Build the Groq client when ANY mode would need it: primary=groq, legacy
    # local-primary fallback flag, or backlog auto-escalation threshold.
    needs_groq = (
        TRANSCRIBE_BACKEND == "groq"
        or GROQ_FALLBACK_ENABLED
        or TRANSCRIBE_GROQ_THRESHOLD > 0
    )
    groq_client = make_groq_client() if needs_groq else None
    if TRANSCRIBE_BACKEND == "groq" and groq_client is None:
        log.warning("JAFO_TRANSCRIBE_BACKEND=groq but GROQ_API_KEY not set — silently downgrading to local.")
    if GROQ_FALLBACK_ENABLED and groq_client is None and TRANSCRIBE_BACKEND != "groq":
        log.warning("JAFO_TRANSCRIBE_GROQ_FALLBACK=true but GROQ_API_KEY not set — local-only.")
    if TRANSCRIBE_GROQ_THRESHOLD > 0 and groq_client is None:
        log.warning("JAFO_TRANSCRIBE_GROQ_THRESHOLD=%d but GROQ_API_KEY not set — escalation disabled.",
                    TRANSCRIBE_GROQ_THRESHOLD)
    log.info("Starting jafo-transcriber. backend=%s primary_model=%s groq_available=%s threshold=%d",
             TRANSCRIBE_BACKEND,
             GROQ_MODEL if TRANSCRIBE_BACKEND == "groq" else f"faster-whisper-{LOCAL_MODEL_NAME}",
             "yes" if groq_client else "no",
             TRANSCRIBE_GROQ_THRESHOLD)

    conn = db_connect()

    while True:
        # Backlog-driven escalation: check pending count and flip _groq_override_active
        # so transcribe_one() routes through Groq while we're behind.
        if TRANSCRIBE_GROQ_THRESHOLD > 0 and groq_client is not None:
            try:
                pending = _pending_count(conn)
            except Exception:
                pending = 0
            new_override = pending >= TRANSCRIBE_GROQ_THRESHOLD
            if new_override != _groq_override_active:
                log.info("Backlog %d %s threshold %d → switching primary to %s",
                         pending, ">=" if new_override else "<", TRANSCRIBE_GROQ_THRESHOLD,
                         "Groq" if new_override else "local")
                _groq_override_active = new_override

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
