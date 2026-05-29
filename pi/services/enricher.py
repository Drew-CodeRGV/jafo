#!/usr/bin/env python3
"""
jafo-enricher — extracts structured incidents from transcripts.

Two interchangeable backends, selected by JAFO_LLM_BACKEND in .env:

  ollama     — local Ollama HTTP server (default; $0 per call)
               Set JAFO_LLM_MODEL (default "gemma2:2b") and
               JAFO_LLM_HOST (default "http://127.0.0.1:11434").

  anthropic  — Claude Haiku via api.anthropic.com (paid, premium quality)
               Used when JAFO_LLM_BACKEND=anthropic and ANTHROPIC_API_KEY set.

Polls calls where transcript IS NOT NULL AND incident_json IS NULL,
sends transcript + context to the chosen LLM, parses JSON, stores fields.
"""

from __future__ import annotations

import json
import os
import sys
import time

import requests

from common import (
    ANTHROPIC_API_KEY, GROQ_API_KEY, REGION, db_connect, setup_logging,
)

log = setup_logging("jafo-enricher")

# -----------------------------------------------------------------------------
# Backend config
# -----------------------------------------------------------------------------
BACKEND     = os.environ.get("JAFO_LLM_BACKEND", "ollama").strip().lower()
LLM_MODEL   = os.environ.get("JAFO_LLM_MODEL", "gemma2:2b").strip()
LLM_HOST    = os.environ.get("JAFO_LLM_HOST", "http://127.0.0.1:11434").strip().rstrip("/")
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
GROQ_CHAT_MODEL = os.environ.get("JAFO_GROQ_CHAT_MODEL", "llama-3.1-8b-instant").strip()

# Dual-run / shadow Ollama (corpus building for distillation evaluation).
# When enabled, the enricher runs each call through Ollama IN ADDITION to the
# primary backend, storing its output in shadow columns. Primary stays the
# user-visible result. Off by default; only meaningful when BACKEND != ollama.
DUAL_RUN = os.environ.get("JAFO_LLM_DUAL_RUN", "").strip().lower() in ("1", "true", "yes")
SHADOW_BATCH_SIZE = 2  # don't starve primary; small bites between primary cycles

POLL_INTERVAL_SEC = 10
BATCH_SIZE = 3            # was 10 — smaller bites prevent pile-up when ollama is slow under load
MAX_TOKENS = 400

# Ollama inference on a Pi 5, CPU-contested by trunk-recorder + faster-whisper,
# can take 60-180s for a small prompt. A short timeout causes cascading failures
# while ollama is still working — the next request hits a busy server and also
# times out. 300s gives ollama room to finish.
OLLAMA_REQUEST_TIMEOUT_SEC = 300

# When the system is already under heavy load, don't pile more enrichment on top.
# 1-minute load avg above this threshold = back off and let the queue drain.
# Pi 5 has 4 cores, so loadavg > 6 means ~50%+ over-subscribed.
LOAD_AVG_BACKOFF_THRESHOLD = 6.0
LOAD_AVG_BACKOFF_SLEEP_SEC = 30

SYSTEM_PROMPT = f"""You are an analyst extracting structured incident information from short \
public-safety radio dispatch transcripts. The region is {REGION}.

You receive one short radio transmission at a time. Many will be fragmentary \
("10-4", "show me en route", "copy"). Some will be substantive (a call being dispatched, \
a status update on an incident). Many will involve units like patrol cars, fire \
apparatus, or EMS responding to addresses or intersections.

Your job: extract structured fields. If a field cannot be determined from the \
transcript, use null. Do not invent details. Brief acks like "10-4 copy" should \
return type="Radio Chatter" with everything else null.

Respond with ONLY a JSON object — no preamble, no commentary, no markdown fences.

Schema:
{{
  "type": string,           // short category: "Traffic Stop", "MVA", "Disturbance", "Medical", "Fire", "Suspicious Person", "Welfare Check", "Domestic", "Theft", "Burglary", "Pursuit", "Arrest", "Status Update", "Radio Chatter", "Other", or similar
  "summary": string|null,   // one-line plain-English summary, max 100 chars
  "location": string|null,  // street, intersection, business name, or landmark as said
  "units": [string],        // unit IDs heard, e.g. ["247", "316-Adam"]. Empty array if none.
  "severity": string,       // "low" | "medium" | "high" | "critical" | "unknown"
  "persons_mentioned": [string],  // names if any. Empty array if none.
  "vehicles": [string]      // vehicles described. Empty array if none.
}}
"""


# -----------------------------------------------------------------------------
# DB helpers
# -----------------------------------------------------------------------------
def get_pending_calls(conn, limit: int):
    cur = conn.execute("""
        SELECT id, transcript, talkgroup_tag, duration_sec
        FROM calls
        WHERE transcript IS NOT NULL
          AND incident_json IS NULL
          AND enrich_error IS NULL
        ORDER BY transcript_at ASC
        LIMIT ?
    """, (limit,))
    return cur.fetchall()


def shortcut_chatter(conn, call_id: int) -> None:
    payload = {
        "type": "Radio Chatter",
        "summary": None,
        "location": None,
        "units": [],
        "severity": "low",
        "persons_mentioned": [],
        "vehicles": [],
    }
    conn.execute("""
        UPDATE calls SET
            incident_type = ?, incident_summary = ?, incident_location = ?,
            incident_units = ?, incident_severity = ?,
            incident_json = ?, enriched_at = ?, enrich_error = NULL
        WHERE id = ?
    """, (
        payload["type"], payload["summary"], payload["location"],
        ",".join(payload["units"]), payload["severity"],
        json.dumps(payload), int(time.time()), call_id,
    ))
    conn.commit()


def get_shadow_pending_calls(conn, limit: int):
    """Calls already primary-enriched but not yet shadow-enriched."""
    return conn.execute("""
        SELECT id, transcript, talkgroup_tag
        FROM calls
        WHERE transcript IS NOT NULL
          AND incident_json IS NOT NULL
          AND incident_json_ollama IS NULL
          AND shadow_enrich_error IS NULL
          AND length(transcript) >= 8
        ORDER BY enriched_at DESC
        LIMIT ?
    """, (limit,)).fetchall()


def write_shadow_incident(conn, call_id: int, payload: dict, model_label: str) -> None:
    conn.execute("""
        UPDATE calls SET
            incident_type_ollama     = ?,
            incident_severity_ollama = ?,
            incident_json_ollama     = ?,
            transcript_model_ollama  = ?,
            enriched_at_ollama       = ?,
            shadow_enrich_error      = NULL
        WHERE id = ?
    """, (
        payload.get("type"),
        payload.get("severity") or "unknown",
        json.dumps(payload),
        model_label,
        int(time.time()),
        call_id,
    ))
    conn.commit()


def write_incident(conn, call_id: int, payload: dict) -> None:
    units = payload.get("units") or []
    if not isinstance(units, list):
        units = []
    units_str = ",".join(str(u) for u in units)

    conn.execute("""
        UPDATE calls SET
            incident_type = ?, incident_summary = ?, incident_location = ?,
            incident_units = ?, incident_severity = ?,
            incident_json = ?, enriched_at = ?, enrich_error = NULL
        WHERE id = ?
    """, (
        payload.get("type"),
        payload.get("summary"),
        payload.get("location"),
        units_str,
        payload.get("severity") or "unknown",
        json.dumps(payload),
        int(time.time()),
        call_id,
    ))
    conn.commit()


# -----------------------------------------------------------------------------
# Backends
# -----------------------------------------------------------------------------
def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.rsplit("```", 1)[0].strip()
    return text


def enrich_via_anthropic(client, transcript: str, talkgroup_tag: str) -> dict:
    user_message = f"Talkgroup: {talkgroup_tag or 'unknown'}\nTranscript: {transcript}"
    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )
    text = "".join(b.text for b in resp.content if hasattr(b, "text"))
    return json.loads(_strip_fences(text))


def enrich_via_groq(client, transcript: str, talkgroup_tag: str) -> dict:
    """Hit Groq's OpenAI-compatible chat endpoint with JSON-mode."""
    user_message = f"Talkgroup: {talkgroup_tag or 'unknown'}\nTranscript: {transcript}"
    resp = client.chat.completions.create(
        model=GROQ_CHAT_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_message},
        ],
        response_format={"type": "json_object"},
        temperature=0,
        max_tokens=MAX_TOKENS,
    )
    text = resp.choices[0].message.content or ""
    return json.loads(_strip_fences(text))


def enrich_via_ollama(transcript: str, talkgroup_tag: str) -> dict:
    """Hit Ollama's /api/chat with format: 'json' for guaranteed JSON output."""
    user_message = f"Talkgroup: {talkgroup_tag or 'unknown'}\nTranscript: {transcript}"
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_message},
        ],
        "format": "json",
        "stream": False,
        "options": {
            "temperature": 0,
            "num_predict": MAX_TOKENS,
        },
    }
    r = requests.post(f"{LLM_HOST}/api/chat", json=payload, timeout=OLLAMA_REQUEST_TIMEOUT_SEC)
    r.raise_for_status()
    body = r.json()
    text = body.get("message", {}).get("content", "")
    return json.loads(_strip_fences(text))


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------
def main() -> None:
    anthropic_client = None
    groq_client = None

    if BACKEND == "anthropic":
        if not ANTHROPIC_API_KEY:
            log.warning("BACKEND=anthropic but ANTHROPIC_API_KEY not set — sleeping.")
            while True:
                time.sleep(60)
        from anthropic import Anthropic
        anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)
        log.info("Starting jafo-enricher. backend=anthropic model=%s region=%s", CLAUDE_MODEL, REGION)
    elif BACKEND == "groq":
        if not GROQ_API_KEY:
            log.warning("BACKEND=groq but GROQ_API_KEY not set — sleeping.")
            while True:
                time.sleep(60)
        from groq import Groq
        # max_retries=2 lets the SDK back off if we ever brush a rate-limit
        groq_client = Groq(api_key=GROQ_API_KEY, max_retries=2)
        log.info("Starting jafo-enricher. backend=groq model=%s region=%s", GROQ_CHAT_MODEL, REGION)
    else:  # ollama (default)
        try:
            r = requests.get(f"{LLM_HOST}/api/version", timeout=5)
            r.raise_for_status()
            log.info("Starting jafo-enricher. backend=ollama model=%s host=%s region=%s",
                     LLM_MODEL, LLM_HOST, REGION)
        except Exception as e:
            log.warning("Ollama unreachable at %s (%s) — will keep trying", LLM_HOST, e)

    conn = db_connect()

    if DUAL_RUN and BACKEND != "ollama":
        log.info("DUAL_RUN enabled — Ollama will shadow-enrich %s primary calls (model=%s)",
                 BACKEND, LLM_MODEL)

    while True:
        # System-load backpressure: if the Pi is already over-subscribed
        # (trunk-recorder + faster-whisper + processor all churning), an
        # ollama inference will hang for minutes and queue up more requests
        # behind it. Wait for headroom before grabbing more work.
        if BACKEND == "ollama":
            load1 = os.getloadavg()[0]
            if load1 > LOAD_AVG_BACKOFF_THRESHOLD:
                log.info("BACKOFF load=%.2f > %.1f — sleeping %ds",
                         load1, LOAD_AVG_BACKOFF_THRESHOLD, LOAD_AVG_BACKOFF_SLEEP_SEC)
                time.sleep(LOAD_AVG_BACKOFF_SLEEP_SEC)
                continue

        try:
            calls = get_pending_calls(conn, BATCH_SIZE)
        except Exception as e:
            log.exception("DB query failed: %s", e)
            time.sleep(POLL_INTERVAL_SEC)
            continue

        # Shadow pass — only when DUAL_RUN is on AND primary isn't already
        # ollama (running ollama twice would be silly). Runs only after
        # primary has work-or-not so primary always gets first crack.
        shadow_did_work = False
        if DUAL_RUN and BACKEND != "ollama":
            try:
                shadow_calls = get_shadow_pending_calls(conn, SHADOW_BATCH_SIZE)
            except Exception as e:
                log.exception("shadow DB query failed: %s", e)
                shadow_calls = []
            for sc in shadow_calls:
                shadow_did_work = True
                try:
                    t0 = time.time()
                    s_payload = enrich_via_ollama((sc["transcript"] or "").strip(),
                                                  sc["talkgroup_tag"] or "")
                    write_shadow_incident(conn, sc["id"], s_payload,
                                          f"ollama:{LLM_MODEL}")
                    log.info("SHDW  id=%s tag=%s type=%s sev=%s (%.1fs)",
                             sc["id"], sc["talkgroup_tag"],
                             s_payload.get("type"), s_payload.get("severity"),
                             time.time() - t0)
                except Exception as e:
                    err = f"{type(e).__name__}: {str(e)[:200]}"
                    log.warning("SHDW-FAIL id=%s: %s", sc["id"], err)
                    conn.execute("""
                        UPDATE calls SET shadow_enrich_error = ?, enriched_at_ollama = ?
                        WHERE id = ?
                    """, (err[:500], int(time.time()), sc["id"]))
                    conn.commit()

        if not calls:
            if not shadow_did_work:
                time.sleep(POLL_INTERVAL_SEC)
            continue

        for call in calls:
            transcript = (call["transcript"] or "").strip()

            if len(transcript) < 8:
                shortcut_chatter(conn, call["id"])
                log.info("CHAT  id=%s tag=%s (trivial: %r)",
                         call["id"], call["talkgroup_tag"], transcript)
                continue

            try:
                t0 = time.time()
                if BACKEND == "anthropic":
                    payload = enrich_via_anthropic(anthropic_client, transcript, call["talkgroup_tag"] or "")
                elif BACKEND == "groq":
                    payload = enrich_via_groq(groq_client, transcript, call["talkgroup_tag"] or "")
                else:
                    payload = enrich_via_ollama(transcript, call["talkgroup_tag"] or "")
                elapsed = time.time() - t0
                write_incident(conn, call["id"], payload)
                log.info("OK    id=%s tag=%s type=%s sev=%s (%.2fs)",
                         call["id"], call["talkgroup_tag"],
                         payload.get("type"), payload.get("severity"), elapsed)
            except json.JSONDecodeError as e:
                err = f"json_parse: {e}"
                log.error("FAIL  id=%s: %s", call["id"], err)
                conn.execute("""
                    UPDATE calls SET enrich_error = ?, enriched_at = ? WHERE id = ?
                """, (err[:500], int(time.time()), call["id"]))
                conn.commit()
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                log.error("FAIL  id=%s: %s", call["id"], err)
                conn.execute("""
                    UPDATE calls SET enrich_error = ?, enriched_at = ? WHERE id = ?
                """, (err[:500], int(time.time()), call["id"]))
                conn.commit()
                time.sleep(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Interrupted, exiting.")
        sys.exit(0)
