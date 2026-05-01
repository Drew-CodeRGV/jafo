#!/usr/bin/env python3
"""
jafo — pipeline stats.
Run on the Pi:  ~/jafo/pi/services/stats.py
"""

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import CALLS_DIR, db_connect


def fmt_n(n): return f"{n:>6,}"
def fmt_sec(s): return f"{s:>8,.0f}s" if s else "       -"


def main() -> None:
    conn = db_connect()

    print("=" * 64)
    print(" jafo — pipeline stats")
    print("=" * 64)

    # --- Last 24h: filter outcomes ---
    print("\n--- Last 24 hours: capture filter ---")
    cur = conn.execute("""
        SELECT status, COALESCE(skip_reason, '-') AS reason,
               COUNT(*) AS n, COALESCE(SUM(duration_sec), 0) AS total
        FROM calls
        WHERE processed_at > strftime('%s', 'now', '-1 day')
        GROUP BY status, reason
        ORDER BY n DESC
    """)
    for r in cur:
        print(f"  {r['status']:10s} {r['reason']:20s} {fmt_n(r['n'])}  {fmt_sec(r['total'])}")

    # --- Pipeline progression ---
    print("\n--- Pipeline (kept calls only) ---")
    cur = conn.execute("""
        SELECT
          SUM(1) AS captured,
          SUM(CASE WHEN transcript IS NOT NULL THEN 1 ELSE 0 END) AS transcribed,
          SUM(CASE WHEN incident_json IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
          SUM(CASE WHEN transcript_error IS NOT NULL THEN 1 ELSE 0 END) AS xc_errors,
          SUM(CASE WHEN enrich_error IS NOT NULL THEN 1 ELSE 0 END) AS en_errors
        FROM calls WHERE status = 'kept'
    """)
    r = cur.fetchone()
    print(f"  Captured (kept):       {fmt_n(r['captured'] or 0)}")
    print(f"  Transcribed:           {fmt_n(r['transcribed'] or 0)}    "
          f"(errors: {r['xc_errors'] or 0})")
    print(f"  Enriched:              {fmt_n(r['enriched'] or 0)}    "
          f"(errors: {r['en_errors'] or 0})")

    # --- Backlogs ---
    print("\n--- Backlogs (waiting in pipeline) ---")
    cur = conn.execute("""
        SELECT
          SUM(CASE WHEN transcript IS NULL AND transcript_error IS NULL
                       AND audio_deleted = 0 THEN 1 ELSE 0 END) AS xc_pending,
          SUM(CASE WHEN transcript IS NOT NULL AND incident_json IS NULL
                       AND enrich_error IS NULL THEN 1 ELSE 0 END) AS en_pending
        FROM calls WHERE status = 'kept'
    """)
    r = cur.fetchone()
    print(f"  Awaiting transcription: {r['xc_pending'] or 0}")
    print(f"  Awaiting enrichment:    {r['en_pending'] or 0}")

    # --- Top talkgroups ---
    print("\n--- Top 10 talkgroups (kept, last 24h) ---")
    cur = conn.execute("""
        SELECT talkgroup_tag, talkgroup, COUNT(*) AS n, SUM(duration_sec) AS total
        FROM calls
        WHERE status='kept' AND processed_at > strftime('%s', 'now', '-1 day')
        GROUP BY talkgroup ORDER BY n DESC LIMIT 10
    """)
    for r in cur:
        label = r["talkgroup_tag"] if r["talkgroup_tag"] else f"tg-{r['talkgroup']}"
        print(f"  {label:30s} {fmt_n(r['n'])}  {fmt_sec(r['total'])}")

    # --- Top incident types ---
    print("\n--- Top incident types (last 24h) ---")
    cur = conn.execute("""
        SELECT incident_type, COUNT(*) AS n
        FROM calls
        WHERE incident_type IS NOT NULL
          AND enriched_at > strftime('%s', 'now', '-1 day')
        GROUP BY incident_type ORDER BY n DESC LIMIT 10
    """)
    for r in cur:
        print(f"  {r['incident_type']:30s} {fmt_n(r['n'])}")

    # --- Disk ---
    print("\n--- Disk ---")
    if CALLS_DIR.exists():
        total = 0
        count = 0
        for f in CALLS_DIR.rglob("*.opus"):
            try:
                total += f.stat().st_size
                count += 1
            except FileNotFoundError:
                pass
        print(f"  Opus files on disk:    {count:>6,}  ({total/1_000_000:.1f} MB)")
        usage = shutil.disk_usage(CALLS_DIR)
        print(f"  Disk free:             {usage.free / 1_000_000_000:.1f} GB / "
              f"{usage.total / 1_000_000_000:.1f} GB")

    print()


if __name__ == "__main__":
    main()
