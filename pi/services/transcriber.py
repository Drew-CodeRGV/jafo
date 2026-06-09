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
# faster-whisper size, env-tunable. base = light/fast (safe on a 4GB box but weak
# on Spanish); small = much better bilingual EN/ES, ~3x RAM + ~2-3x slower (fine on
# an 8GB box). medium/large need more RAM+cores than this hardware has.
LOCAL_MODEL_NAME = os.environ.get("JAFO_LOCAL_WHISPER_MODEL", "base").strip()
LOCAL_COMPUTE = os.environ.get("JAFO_LOCAL_WHISPER_COMPUTE", "int8").strip()
LOCAL_CPU_THREADS = int(os.environ.get("JAFO_LOCAL_WHISPER_THREADS", "2"))  # bump to 4 on a 4-vCPU box
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

# News-grade re-transcription (HUB ONLY). When JAFO_NEWS_RETRANSCRIBE=true, kept
# calls that arrived with a weak edge-model transcript get re-run through Groq
# large-v3-turbo so the news pipeline is built on the best possible text. The
# original (edge) transcript is preserved in transcript_original. Runs at low
# priority — only when the primary pending queue is empty — and re-nulls
# incident_json so the enricher re-extracts from the upgraded transcript.
NEWS_RETRANSCRIBE = os.environ.get("JAFO_NEWS_RETRANSCRIBE", "").strip().lower() in ("1", "true", "yes")
NEWS_RETRANSCRIBE_BATCH = 3
NEWS_RETRANSCRIBE_MIN_SPEECH = 1.0   # seconds of detected speech to bother upgrading
# Hard age bound — only upgrade RECENT calls. Without this the candidate query
# would eventually walk the entire historical corpus during idle periods,
# blowing up Groq cost and re-enriching everything. News only needs ~last day.
NEWS_RETRANSCRIBE_MAX_AGE_SEC = int(os.environ.get("JAFO_NEWS_RETRANSCRIBE_MAX_AGE_SEC", str(24 * 3600)))

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


def transcribe_via_local(opus_path: Path) -> tuple[str, str, dict]:
    """Returns (text, model_label, meta). Auto-detects language.

    meta = {confidence: mean segment avg_logprob, no_speech: max segment
    no_speech_prob, lang: detected language}. The threshold params below drop
    hallucinated segments (the "25-25-25..." repeat loops and confident-nonsense
    Whisper invents from noise) rather than emitting them as fake text.
    """
    model = get_local_model()
    segments, info = model.transcribe(
        str(opus_path),
        beam_size=1,                # fastest
        language=None,              # auto: EN or ES
        initial_prompt=INITIAL_PROMPT,
        vad_filter=False,           # processor.py already VAD-filtered
        temperature=0.0,
        condition_on_previous_text=False,   # stops repeat-loop hallucinations
        compression_ratio_threshold=2.4,    # drop gibberish-dense segments
        log_prob_threshold=-1.0,             # drop low-confidence segments
        no_speech_threshold=0.6,             # drop silence/noise segments
    )
    seg_list = list(segments)
    text = " ".join(seg.text.strip() for seg in seg_list).strip()
    logprobs = [s.avg_logprob for s in seg_list if s.avg_logprob is not None]
    nospeech = [s.no_speech_prob for s in seg_list if s.no_speech_prob is not None]
    meta = {
        "confidence": (sum(logprobs) / len(logprobs)) if logprobs else None,
        "no_speech":  max(nospeech) if nospeech else None,
        "lang":       info.language,
    }
    label = f"faster-whisper-{LOCAL_MODEL_NAME}/{info.language}"
    return text, label, meta


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


def transcribe_via_groq(client, opus_path: Path) -> tuple[str, str, dict]:
    """Returns (text, model_label, meta). verbose_json carries per-segment
    avg_logprob / no_speech_prob — we parse it for the confidence gate instead
    of discarding it."""
    with open(opus_path, "rb") as f:
        result = client.audio.transcriptions.create(
            file=(opus_path.name, f.read()),
            model=GROQ_MODEL,
            prompt=INITIAL_PROMPT,
            response_format="verbose_json",
            temperature=0.0,
        )
    # Groq returns a pydantic-ish object; segments may be dicts or attr objects.
    segs = getattr(result, "segments", None) or []
    def _g(s, k):
        return s.get(k) if isinstance(s, dict) else getattr(s, k, None)
    logprobs = [_g(s, "avg_logprob") for s in segs if _g(s, "avg_logprob") is not None]
    nospeech = [_g(s, "no_speech_prob") for s in segs if _g(s, "no_speech_prob") is not None]
    meta = {
        "confidence": (sum(logprobs) / len(logprobs)) if logprobs else None,
        "no_speech":  max(nospeech) if nospeech else None,
        "lang":       getattr(result, "language", None),
    }
    return (result.text or "").strip(), GROQ_MODEL, meta


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


def get_news_retranscribe_candidates(conn, limit: int):
    """HUB-only: kept calls with a weak (non-large-v3) transcript and enough
    speech to be worth upgrading, that haven't already been upgraded. Newest
    first — recent calls are the ones that feed live news."""
    cur = conn.execute("""
        SELECT id, opus_path, talkgroup_tag, duration_sec
        FROM calls
        WHERE status = 'kept'
          AND audio_deleted = 0
          AND opus_path IS NOT NULL
          AND transcript IS NOT NULL
          AND transcript_original IS NULL
          AND (transcript_model IS NULL OR transcript_model NOT LIKE 'whisper-large-v3%')
          AND COALESCE(speech_sec, duration_sec, 0) >= ?
          AND start_time >= ?
        ORDER BY start_time DESC
        LIMIT ?
    """, (NEWS_RETRANSCRIBE_MIN_SPEECH, int(time.time()) - NEWS_RETRANSCRIBE_MAX_AGE_SEC, limit))
    return cur.fetchall()


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------
def transcribe_one(groq_client, opus_path: Path) -> tuple[str, str, dict]:
    """Backend-selected primary; falls back to the other on errors.
    Returns (text, model_label, meta)."""
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


def retranscribe_news_batch(conn, groq_client) -> int:
    """HUB-only news upgrade. Re-run weak transcripts through Groq large-v3,
    preserving the original and re-queuing the call for enrichment. Returns the
    number upgraded this batch. Best-effort: any single failure is logged and
    skipped without disturbing the call's existing transcript."""
    if not (NEWS_RETRANSCRIBE and groq_client is not None):
        return 0
    try:
        cands = get_news_retranscribe_candidates(conn, NEWS_RETRANSCRIBE_BATCH)
    except Exception as e:
        log.warning("news-retranscribe query failed: %s", e)
        return 0
    n = 0
    for call in cands:
        opus_full = CALLS_DIR / call["opus_path"]
        if not opus_full.exists():
            continue
        try:
            text, model_used, meta = transcribe_via_groq(groq_client, opus_full)
            if not text:
                continue
            # Preserve the edge transcript and install the large-v3 upgrade.
            # We do NOT re-null the enrichment: the news script reads the
            # (now-better) transcript directly, and keeping the existing
            # incident_json avoids flooding the enricher with thousands of
            # re-enrichment jobs (which previously stalled the whole feed).
            conn.execute("""
                UPDATE calls
                SET transcript_original       = COALESCE(transcript_original, transcript),
                    transcript_original_model = COALESCE(transcript_original_model, transcript_model),
                    transcript = ?, transcript_model = ?,
                    transcript_confidence = ?, transcript_no_speech = ?, transcript_lang = ?
                WHERE id = ?
            """, (text, model_used,
                  meta.get("confidence"), meta.get("no_speech"), meta.get("lang"),
                  call["id"]))
            conn.commit()
            n += 1
            log.info("UPGRADE id=%s tag=%s → %s: %s",
                     call["id"], call["talkgroup_tag"], model_used,
                     text[:60] + ("..." if len(text) > 60 else ""))
        except Exception as e:
            log.warning("news-retranscribe id=%s failed (%s) — keeping original",
                        call["id"], str(e)[:100])
    return n


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
            # Primary queue is empty — spend idle cycles upgrading weak
            # transcripts to large-v3 for the news pipeline (hub only).
            upgraded = retranscribe_news_batch(conn, groq_client)
            time.sleep(1 if upgraded else POLL_INTERVAL_SEC)
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
                text, model_used, meta = transcribe_one(groq_client, opus_full)
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
                        transcript_at = ?, transcript_error = NULL,
                        transcript_confidence = ?, transcript_no_speech = ?,
                        transcript_lang = ?
                    WHERE id = ?
                """, (text, model_used, int(time.time()),
                      meta.get("confidence"), meta.get("no_speech"), meta.get("lang"),
                      call["id"]))
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
