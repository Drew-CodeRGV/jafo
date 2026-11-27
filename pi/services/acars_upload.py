#!/usr/bin/env python3
"""
jafo-acars-upload — push locally decoded ACARS messages to the hub.

The edge decodes ACARS into its own acars_messages table (acars.py). This loop
sends new rows to the hub's POST /api/ingest/acars (Bearer JAFO_NODE_TOKEN) in
batches, remembering the last uploaded row id in DATA_DIR/acars-upload.state.
First run backfills everything. Duplicates are ignored hub-side.
"""

from __future__ import annotations

import os
import sys
import time

import requests

from common import DATA_DIR, db_connect, setup_logging

log = setup_logging("jafo-acars-upload")

HUB = os.environ.get("JAFO_HUB_URL", "").strip().rstrip("/")
TOKEN = os.environ.get("JAFO_NODE_TOKEN", "").strip()
STATE = DATA_DIR / "acars-upload.state"
BATCH = 1000
INTERVAL = 60


def _last_id() -> int:
    try:
        return int(STATE.read_text().strip() or 0)
    except (OSError, ValueError):
        return 0


def main() -> None:
    if not HUB or not TOKEN:
        log.warning("JAFO_HUB_URL / JAFO_NODE_TOKEN not set — nothing to do.")
        while True:
            time.sleep(3600)
    conn = db_connect()
    log.info("Starting jafo-acars-upload → %s (from id %d)", HUB, _last_id())
    while True:
        try:
            last = _last_id()
            rows = conn.execute("""SELECT id, received_at, freq_mhz, channel, mode, tail, flight, label,
                                          block_id, msg_no, text
                                   FROM acars_messages WHERE id > ? ORDER BY id LIMIT ?""",
                                (last, BATCH)).fetchall()
            if not rows:
                time.sleep(INTERVAL)
                continue
            msgs = [{k: r[k] for k in r.keys() if k != "id"} for r in rows]
            resp = requests.post(f"{HUB}/api/ingest/acars", json={"messages": msgs},
                                 headers={"Authorization": f"Bearer {TOKEN}"}, timeout=60)
            resp.raise_for_status()
            STATE.write_text(str(rows[-1]["id"]))
            log.info("uploaded %d (inserted %s) up to id %d", len(rows), resp.json().get("inserted"), rows[-1]["id"])
            if len(rows) < BATCH:
                time.sleep(INTERVAL)
        except Exception as e:
            log.warning("upload failed: %s", e)
            time.sleep(INTERVAL * 2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
