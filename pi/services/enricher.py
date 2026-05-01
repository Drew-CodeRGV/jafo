#!/usr/bin/env python3
"""
jafo-enricher — sends transcripts to Claude Haiku, stores structured incidents.

Polls for calls where transcript IS NOT NULL AND transcript != '' AND incident_json IS NULL.
Sends transcript + context to Claude, parses JSON response, stores fields.

Cost: Haiku at ~$0.80/M input, $4/M output. Each call ~600 input + 200 output tokens.
At 300 calls/day: ~$0.30/month. Cheap.
"""

from __future__ import annotations

import json
import sys
import time

from common import (
    ANTHROPIC_API_KEY, REGION, db_connect, setup_logging,
)

log = setup_logging("jafo-enricher")

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
POLL_INTERVAL_SEC = 10
BATCH_SIZE = 10
MAX_TOKENS = 400

SYSTEM_PROMPT = f"""You are an analyst extracting structured incident information from short \
public-safety radio dispatch transcripts. The region is {REGION}.

You receive one short radio transmission at a time. Many will be fragmentary \
("10-4", "show me en route", "copy"). Some will be substantive (a call being dispatched, \
a status update on an incident). Many will involve units like patrol cars, fire \
apparatus, or EMS responding to addresses or intersections.

Your job: extract structured fields. If a field cannot be determined from the \
transcript, use null. Do not invent details. Brief acks like "10-4 copy" should \
return type="radio_chatter" with everything else null.

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


def get_pending_calls(conn, limit: int):
    """Find transcribed calls that haven't been enriched yet.

    Skip empty transcripts and 'too short to bother' transcripts (<10 chars
    of actual content like 'ok' or '10-4'). Mark those as enriched with a
    radio_chatter type so we don't keep looking at them.
    """
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
    """Mark a too-short / empty transcript as radio_chatter without an API call."""
    payload = {
        "type": "radio_chatter",
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


def enrich_one(client, transcript: str, talkgroup_tag: str) -> dict:
    """Call Claude, parse JSON. Raises on parse failure."""
    user_message = (
        f"Talkgroup: {talkgroup_tag or 'unknown'}\n"
        f"Transcript: {transcript}"
    )
    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )
    text = "".join(block.text for block in resp.content if hasattr(block, "text")).strip()

    # Strip markdown fences if Claude added them despite instructions
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.rsplit("```", 1)[0].strip()

    return json.loads(text)


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


def main() -> None:
    if not ANTHROPIC_API_KEY:
        log.warning("ANTHROPIC_API_KEY not set — sleeping. Add to .env and restart.")
        while True:
            time.sleep(60)

    from anthropic import Anthropic
    client = Anthropic(api_key=ANTHROPIC_API_KEY)
    conn = db_connect()
    log.info("Starting jafo-enricher. model=%s region=%s", CLAUDE_MODEL, REGION)

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
            transcript = (call["transcript"] or "").strip()

            # Shortcut: empty or trivial transcripts skip the API
            if len(transcript) < 8:
                shortcut_chatter(conn, call["id"])
                log.info("CHAT  id=%s tag=%s (trivial: %r)",
                         call["id"], call["talkgroup_tag"], transcript)
                continue

            try:
                t0 = time.time()
                payload = enrich_one(client, transcript, call["talkgroup_tag"] or "")
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
