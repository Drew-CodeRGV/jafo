#!/usr/bin/env python3
"""
Backfill / replay enricher v2 (incidents + units) over a time window, in
chronological order so incident linking sees the same context it would have
seen live.

  ~/jafo-data/venv-services/bin/python pi/services/backfill_incidents.py --hours 6
  ... --hours 24 --limit 500 --dry-run      # print decisions, write to DB anyway (use a copy!)

Respects JAFO_DATA_DIR, so point it at a DB copy for experiments:
  JAFO_DATA_DIR=/tmp/jafo-copy python backfill_incidents.py --hours 2
"""

from __future__ import annotations

import argparse
import time

from common import ANTHROPIC_API_KEY, db_connect, setup_logging
import incidents as inc

log = setup_logging("jafo-backfill")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=6)
    ap.add_argument("--until-hours-ago", type=float, default=0,
                    help="stop at calls this many hours old (default: now)")
    ap.add_argument("--limit", type=int, default=100000)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    from anthropic import Anthropic
    client = Anthropic(api_key=ANTHROPIC_API_KEY or None)
    conn = db_connect()

    now = int(time.time())
    start = int(now - args.hours * 3600)
    stop = int(now - args.until_hours_ago * 3600)
    rows = conn.execute("""
        SELECT id, transcript, talkgroup, talkgroup_tag, start_time, metadata_json, region_id
        FROM calls
        WHERE transcript IS NOT NULL AND enriched_v2_at IS NULL AND status = 'kept'
          AND start_time >= ? AND start_time <= ?
        ORDER BY start_time ASC LIMIT ?
    """, (start, stop, args.limit)).fetchall()
    log.info("backfill: %d calls between %s and %s", len(rows), inc.fmt_local(start), inc.fmt_local(stop))

    done = fails = 0
    last_sweep = 0
    t0 = time.time()
    for call in rows:
        # sweep as of the call's own time so replayed history closes incidents realistically
        if call["start_time"] - last_sweep > 120:
            inc.sweep(conn, now=call["start_time"])
            last_sweep = call["start_time"]
        try:
            iid = inc.enrich_call(conn, client, call)
            done += 1
            if args.verbose:
                r = conn.execute("SELECT call_line FROM calls WHERE id = ?", (call["id"],)).fetchone()
                log.info("%s #%s -> inc %s | %s", inc.fmt_local(call["start_time"]), call["id"], iid,
                         r["call_line"])
        except Exception as e:
            fails += 1
            log.warning("FAIL %s: %s: %s", call["id"], type(e).__name__, str(e)[:200])
            conn.execute("UPDATE calls SET enrich_v2_error = ?, enriched_v2_at = ? WHERE id = ?",
                         (f"{type(e).__name__}: {e}"[:500], int(time.time()), call["id"]))
            conn.commit()
        if done % 50 == 0 and done:
            log.info("... %d done, %d failed (%.1f calls/s)", done, fails, done / (time.time() - t0))
    inc.sweep(conn)
    log.info("backfill complete: %d ok, %d failed", done, fails)


if __name__ == "__main__":
    main()
