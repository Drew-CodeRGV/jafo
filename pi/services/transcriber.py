#!/usr/bin/env python3
"""
jafo-transcriber — sends kept calls to Groq Whisper, stores text in SQLite.

Polls for calls where status='kept' AND transcript IS NULL AND transcript_error IS NULL
(i.e. not yet attempted). Sends Opus to Groq, stores text. On error, stores
the error so we don't infinite-loop on bad audio.

Costs roughly: large-v3-turbo at $0.04/hr of audio. ~24 min/day = $0.02/day.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from common import (
    CALLS_DIR, GROQ_API_KEY, db_connect, setup_logging,
)

log = setup_logging("jafo-transcriber")

WHISPER_MODEL = "whisper-large-v3-turbo"
POLL_INTERVAL_SEC = 10
BATCH_SIZE = 5  # process up to N calls per loop tick

# Whisper context prompt — primes the model for our domain
INITIAL_PROMPT = (
    "Police, fire, and EMS radio dispatch in McAllen and Hidalgo County, Texas. "
    "Common agencies: HCSO, MPD, McAllen Fire, Hidalgo EMS, DPS, Border Patrol. "
    "Common terms: dispatch, copy, en route, code 3, signal 50, MVA, "
    "complainant, RP, subject, 10-4, 10-50, 10-7, 10-8, 10-97, "
    "ambulance, supervisor, on scene."
)


def get_pending_calls(conn, limit: int):
    """Find kept calls with audio still on disk and no transcript attempted yet."""
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


def transcribe_one(groq_client, opus_path: Path) -> dict:
    """Send one Opus file to Groq. Returns dict with text or raises."""
    with open(opus_path, "rb") as f:
        result = groq_client.audio.transcriptions.create(
            file=(opus_path.name, f.read()),
            model=WHISPER_MODEL,
            prompt=INITIAL_PROMPT,
            response_format="verbose_json",
            language="en",
            temperature=0.0,
        )
    text = (result.text or "").strip()
    return {"text": text}


def main() -> None:
    if not GROQ_API_KEY:
        log.warning("GROQ_API_KEY not set — sleeping. Add to .env and restart.")
        while True:
            time.sleep(60)

    from groq import Groq
    groq_client = Groq(api_key=GROQ_API_KEY)
    conn = db_connect()
    log.info("Starting jafo-transcriber. model=%s", WHISPER_MODEL)

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
                result = transcribe_one(groq_client, opus_full)
                elapsed = time.time() - t0
                text = result["text"]

                if not text:
                    # Whisper returned empty — store as empty string, not NULL,
                    # so we don't try again. Treat as "no useful speech."
                    text = ""
                    log.info("EMPTY id=%s tag=%s dur=%.1fs (%.2fs elapsed)",
                             call["id"], call["talkgroup_tag"],
                             call["duration_sec"], elapsed)
                else:
                    log.info("OK    id=%s tag=%s dur=%.1fs (%.2fs elapsed): %s",
                             call["id"], call["talkgroup_tag"],
                             call["duration_sec"], elapsed,
                             text[:80] + ("..." if len(text) > 80 else ""))

                conn.execute("""
                    UPDATE calls
                    SET transcript = ?, transcript_model = ?,
                        transcript_at = ?, transcript_error = NULL
                    WHERE id = ?
                """, (text, WHISPER_MODEL, int(time.time()), call["id"]))
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
                # back off briefly on error so we don't hammer the API
                time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Interrupted, exiting.")
        sys.exit(0)
