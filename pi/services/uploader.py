#!/usr/bin/env python3
"""
jafo-uploader — pushes captured calls from this Pi node to the central hub.

Replaces local transcriber + enricher when running as a remote node feeding
jafo.live. The processor still writes opus + DB rows locally; this service
takes those rows and POSTs them to the hub.

Env (read from .env via common.py):
  JAFO_HUB_URL        - e.g. https://jafo.live  (default: https://jafo.live)
  JAFO_NODE_SLUG      - this node's slug, must match the hub's nodes table
  JAFO_NODE_TOKEN     - bearer token (raw; hub stores sha256(token))
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

from common import (
    CALLS_DIR, db_connect, setup_logging,
)

log = setup_logging("jafo-uploader")

HUB_URL = os.environ.get("JAFO_HUB_URL", "https://jafo.live").rstrip("/")
NODE_TOKEN = os.environ.get("JAFO_NODE_TOKEN", "").strip()
NODE_SLUG = os.environ.get("JAFO_NODE_SLUG", "").strip()
POLL_INTERVAL_SEC = 5
BATCH_SIZE = 5
RETRY_BACKOFF_SEC = 5


def get_pending(conn, limit: int):
    """Calls ready to upload: kept + transcribed (or transcript_error set, so we
    don't block forever on a stuck row). Local transcriber runs ahead of us."""
    return conn.execute("""
        SELECT id, opus_path, talkgroup, talkgroup_tag, start_time,
               duration_sec, speech_sec, status, processed_at, metadata_json,
               transcript, transcript_model, transcript_at, transcript_error
        FROM calls
        WHERE status = 'kept'
          AND opus_path IS NOT NULL
          AND audio_deleted = 0
          AND uploaded_at IS NULL
          AND (
              transcript IS NOT NULL
           OR transcript_error IS NOT NULL
           OR processed_at < strftime('%s','now','-90 second')
          )
        ORDER BY processed_at ASC
        LIMIT ?
    """, (limit,)).fetchall()


def upload_one(call) -> tuple[bool, str | dict]:
    opus_full = CALLS_DIR / call["opus_path"]
    if not opus_full.exists():
        return False, {"permanent": True, "reason": f"audio file missing: {opus_full}"}
    try:
        if opus_full.stat().st_size == 0:
            return False, {"permanent": True, "reason": f"audio file empty: {opus_full}"}
    except OSError as e:
        return False, {"permanent": True, "reason": f"audio stat failed: {e}"}

    payload = {
        "talkgroup":        call["talkgroup"],
        "talkgroup_tag":    call["talkgroup_tag"],
        "start_time":       call["start_time"],
        "duration_sec":     call["duration_sec"],
        "speech_sec":       call["speech_sec"],
        "status":           call["status"],
        "processed_at":     call["processed_at"],
        "node_slug":        NODE_SLUG,
        "metadata_json":    call["metadata_json"],
        # Edge-side transcript — hub stores as-is, only re-runs Groq if missing
        "transcript":       call["transcript"],
        "transcript_model": call["transcript_model"],
        "transcript_at":    call["transcript_at"],
        "transcript_error": call["transcript_error"],
    }

    headers = {"Authorization": f"Bearer {NODE_TOKEN}"}

    with open(opus_full, "rb") as f:
        files = {"audio": (opus_full.name, f, "audio/ogg")}
        data = {"metadata": json.dumps(payload)}
        r = requests.post(
            f"{HUB_URL}/api/ingest",
            headers=headers, files=files, data=data,
            timeout=60,
        )

    if r.status_code == 200:
        try:
            return True, r.json()
        except Exception:
            return True, {"ok": True}

    body = r.text[:200]
    # Hub-side permanent rejections — mark audio_deleted so we stop retrying.
    permanent = (
        r.status_code == 400 and "empty audio" in body
    ) or r.status_code in (413, 415)
    return False, {
        "permanent": permanent,
        "reason": f"HTTP {r.status_code}: {body}",
    }


def main() -> None:
    if not NODE_TOKEN:
        log.error("JAFO_NODE_TOKEN not set; aborting")
        sys.exit(1)
    if not NODE_SLUG:
        log.error("JAFO_NODE_SLUG not set; aborting")
        sys.exit(1)

    log.info("Starting jafo-uploader. hub=%s node=%s", HUB_URL, NODE_SLUG)
    conn = db_connect()

    while True:
        try:
            calls = get_pending(conn, BATCH_SIZE)
        except Exception as e:
            log.exception("DB query failed: %s", e)
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if not calls:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        for call in calls:
            try:
                t0 = time.time()
                ok, info = upload_one(call)
                dt = time.time() - t0

                if ok:
                    conn.execute(
                        "UPDATE calls SET uploaded_at = ? WHERE id = ?",
                        (int(time.time()), call["id"]),
                    )
                    conn.commit()
                    if isinstance(info, dict):
                        log.info("OK   id=%s tag=%s (%.2fs) → call_id=%s deduped=%s",
                                 call["id"], call["talkgroup_tag"], dt,
                                 info.get("call_id"), info.get("deduped", False))
                    else:
                        log.info("OK   id=%s (%.2fs)", call["id"], dt)
                else:
                    permanent = isinstance(info, dict) and info.get("permanent")
                    reason = info.get("reason") if isinstance(info, dict) else info
                    if permanent:
                        conn.execute(
                            "UPDATE calls SET audio_deleted = 1 WHERE id = ?",
                            (call["id"],),
                        )
                        conn.commit()
                        log.warning("DROP id=%s (permanent): %s", call["id"], reason)
                    else:
                        log.warning("FAIL id=%s: %s", call["id"], reason)
                        time.sleep(RETRY_BACKOFF_SEC)
            except requests.exceptions.RequestException as e:
                log.warning("Network error id=%s: %s", call["id"], e)
                time.sleep(RETRY_BACKOFF_SEC)
            except Exception as e:
                log.exception("Unexpected error id=%s: %s", call["id"], e)
                time.sleep(RETRY_BACKOFF_SEC)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Interrupted, exiting.")
        sys.exit(0)
