"""
jafo-web — Flask app exposing the SQLite database as a JSON API + the SPA.

Endpoints:
  GET  /                       → HTML SPA
  GET  /api/health             → liveness
  GET  /api/stats              → pipeline counters
  GET  /api/calls              → paginated calls list with filters
  GET  /api/calls/<id>         → single call detail
  GET  /api/talkgroups         → distinct talkgroup tags with counts (+ tag/category if CSV available)
  GET  /api/talkgroup-groups   → talkgroups grouped by service-type or city
  GET  /api/incident-types     → distinct incident types with counts
  GET  /api/search?q=...       → FTS over transcripts/summaries
  GET  /audio/<path>           → range-supported Opus streaming with proper MIME

Designed to be served behind nginx as the upstream.
"""

from __future__ import annotations

import csv
import os
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file

sys.path.insert(0, str(Path(__file__).parent.parent / "services"))
from common import CALLS_DIR, DATA_DIR, DB_PATH, db_connect, NODE_NAME

app = Flask(__name__, static_folder="static", template_folder="templates")

# -----------------------------------------------------------------------------
# Talkgroup metadata loaded at startup from the trunk-recorder CSV.
#
# The CSV has these columns (per RadioReference export):
#   Decimal | Hex | Alpha Tag | Mode | Description | Tag | Category | Priority
#
# We use:
#   Tag      → "service type" (e.g. "Law Dispatch", "Fire-Tac", "EMS Dispatch")
#   Category → "city/agency" (e.g. "Hidalgo County", "Cameron County", "Schools")
#
# This metadata is reloaded on every /api/talkgroup-groups call, so editing
# the CSV is reflected without a service restart.
# -----------------------------------------------------------------------------
TALKGROUPS_CSV = DATA_DIR / "config" / "talkgroups.csv"


def load_talkgroup_metadata() -> dict[int, dict]:
    """Return {tg_decimal: {tag, category, alpha_tag, description}}.

    Empty dict if CSV missing or unreadable.
    """
    out: dict[int, dict] = {}
    if not TALKGROUPS_CSV.exists():
        return out
    try:
        with open(TALKGROUPS_CSV, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Trunk-recorder is forgiving but the parser keys are case-sensitive
                # in different RR exports. Normalize.
                norm = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
                try:
                    decimal = int(norm.get("decimal", "") or "0")
                except ValueError:
                    continue
                if not decimal:
                    continue
                out[decimal] = {
                    "alpha_tag": norm.get("alpha tag", ""),
                    "description": norm.get("description", ""),
                    "tag": norm.get("tag", ""),  # service type
                    "category": norm.get("category", ""),  # city/agency
                    "mode": norm.get("mode", ""),
                }
    except Exception as e:
        print(f"Failed to load talkgroups CSV: {e}", file=sys.stderr)
    return out


# -----------------------------------------------------------------------------
# DB helper
# -----------------------------------------------------------------------------
def get_db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        db_connect().close()
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn


def call_row_to_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "talkgroup": r["talkgroup"],
        "talkgroup_tag": r["talkgroup_tag"],
        "start_time": r["start_time"],
        "duration_sec": r["duration_sec"],
        "speech_sec": r["speech_sec"],
        "status": r["status"],
        "skip_reason": r["skip_reason"],
        "audio_available": (
            r["status"] == "kept"
            and not r["audio_deleted"]
            and r["opus_path"] is not None
        ),
        "opus_path": r["opus_path"],
        "transcript": r["transcript"],
        "transcript_at": r["transcript_at"],
        "transcript_error": r["transcript_error"],
        "incident_type": r["incident_type"],
        "incident_summary": r["incident_summary"],
        "incident_location": r["incident_location"],
        "incident_units": (r["incident_units"] or "").split(",") if r["incident_units"] else [],
        "incident_severity": r["incident_severity"],
        "enriched_at": r["enriched_at"],
        "enrich_error": r["enrich_error"],
    }


# -----------------------------------------------------------------------------
# UI
# -----------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html", node_name=NODE_NAME)


# -----------------------------------------------------------------------------
# Health + stats
# -----------------------------------------------------------------------------
@app.route("/api/health")
def health():
    return jsonify({"ok": True, "node": NODE_NAME, "ts": int(time.time())})


@app.route("/api/stats")
def stats():
    conn = get_db()
    out = {"node": NODE_NAME, "now": int(time.time())}

    cur = conn.execute("""
        SELECT
          SUM(CASE WHEN status='kept' THEN 1 ELSE 0 END) AS kept_total,
          SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped_total,
          SUM(CASE WHEN transcript IS NOT NULL THEN 1 ELSE 0 END) AS transcribed,
          SUM(CASE WHEN incident_json IS NOT NULL THEN 1 ELSE 0 END) AS enriched
        FROM calls
    """)
    out["totals"] = dict(cur.fetchone())

    cur = conn.execute("""
        SELECT
          SUM(CASE WHEN status='kept' THEN 1 ELSE 0 END) AS kept_24h,
          SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped_24h
        FROM calls
        WHERE processed_at > strftime('%s', 'now', '-1 day')
    """)
    out["last_24h"] = dict(cur.fetchone())

    cur = conn.execute("""
        SELECT
          SUM(CASE WHEN status = 'kept' AND transcript IS NULL
                   AND transcript_error IS NULL AND audio_deleted = 0
                   THEN 1 ELSE 0 END) AS transcribe_pending,
          SUM(CASE WHEN transcript IS NOT NULL AND incident_json IS NULL
                   AND enrich_error IS NULL THEN 1 ELSE 0 END) AS enrich_pending
        FROM calls
    """)
    out["backlog"] = dict(cur.fetchone())

    conn.close()
    return jsonify(out)


# -----------------------------------------------------------------------------
# Calls list
# -----------------------------------------------------------------------------
@app.route("/api/calls")
def calls_list():
    conn = get_db()

    talkgroup = request.args.get("talkgroup", type=int)
    talkgroup_tag = request.args.get("talkgroup_tag")
    incident_type = request.args.get("incident_type")
    severity = request.args.get("severity")
    since = request.args.get("since", type=int)
    until = request.args.get("until", type=int)
    only_kept = request.args.get("only_kept", default="1") == "1"
    only_with_transcript = request.args.get("only_with_transcript", default="0") == "1"
    limit = min(request.args.get("limit", default=100, type=int), 500)
    offset = request.args.get("offset", default=0, type=int)

    # Group filter — match any talkgroup whose Tag or Category matches the value.
    # This requires loading metadata to find member talkgroups.
    service_tag_filter = request.args.get("service_tag")  # e.g. "Law Dispatch"
    category_filter = request.args.get("category")  # e.g. "Hidalgo County"

    where = []
    params: list = []
    if only_kept:
        where.append("status = 'kept'")
    if only_with_transcript:
        where.append("transcript IS NOT NULL AND transcript != ''")
    if talkgroup is not None:
        where.append("talkgroup = ?")
        params.append(talkgroup)
    if talkgroup_tag:
        where.append("talkgroup_tag = ?")
        params.append(talkgroup_tag)
    if incident_type:
        where.append("incident_type = ?")
        params.append(incident_type)
    if severity:
        where.append("incident_severity = ?")
        params.append(severity)
    if since:
        where.append("start_time >= ?")
        params.append(since)
    if until:
        where.append("start_time <= ?")
        params.append(until)

    # Service-type / category filtering: expand to a list of talkgroup IDs
    if service_tag_filter or category_filter:
        meta = load_talkgroup_metadata()
        matching_tgs = [
            tg for tg, m in meta.items()
            if (not service_tag_filter or m["tag"] == service_tag_filter)
            and (not category_filter or m["category"] == category_filter)
        ]
        if matching_tgs:
            placeholders = ",".join("?" * len(matching_tgs))
            where.append(f"talkgroup IN ({placeholders})")
            params.extend(matching_tgs)
        else:
            # No talkgroups match → force an empty result
            where.append("0 = 1")

    where_sql = " WHERE " + " AND ".join(where) if where else ""

    cur = conn.execute(
        f"SELECT * FROM calls {where_sql} ORDER BY start_time DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    )
    rows = [call_row_to_dict(r) for r in cur]

    cur = conn.execute(f"SELECT COUNT(*) AS n FROM calls {where_sql}", params)
    total = cur.fetchone()["n"]

    conn.close()
    return jsonify({"calls": rows, "total": total, "limit": limit, "offset": offset})


@app.route("/api/calls/<int:call_id>")
def call_detail(call_id: int):
    conn = get_db()
    cur = conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,))
    row = cur.fetchone()
    conn.close()
    if not row:
        abort(404)
    return jsonify(call_row_to_dict(row))


# -----------------------------------------------------------------------------
# Talkgroups
# -----------------------------------------------------------------------------
@app.route("/api/talkgroups")
def talkgroups():
    """Flat list of talkgroups with counts. Used for backwards compat."""
    conn = get_db()
    cur = conn.execute("""
        SELECT talkgroup, talkgroup_tag, COUNT(*) AS n
        FROM calls
        WHERE status = 'kept' AND processed_at > strftime('%s', 'now', '-7 day')
        GROUP BY talkgroup, talkgroup_tag
        ORDER BY n DESC
    """)
    out = [dict(r) for r in cur]
    conn.close()
    return jsonify({"talkgroups": out})


@app.route("/api/talkgroup-groups")
def talkgroup_groups():
    """Talkgroups grouped by service-type (Tag) or city/agency (Category).

    Query params:
      group_by    = 'service' (default) | 'category' | 'flat'
      sort        = 'count' (default) | 'alpha'
      window_days = how many days back to count from (default 7)
    """
    group_by = request.args.get("group_by", default="service")
    sort = request.args.get("sort", default="count")
    window_days = max(1, min(request.args.get("window_days", default=7, type=int), 365))

    if group_by not in ("service", "category", "flat"):
        group_by = "service"
    if sort not in ("count", "alpha"):
        sort = "count"

    meta = load_talkgroup_metadata()
    conn = get_db()
    cur = conn.execute(
        """
        SELECT talkgroup, talkgroup_tag, COUNT(*) AS n
        FROM calls
        WHERE status = 'kept' AND processed_at > strftime('%s', 'now', ?)
        GROUP BY talkgroup, talkgroup_tag
        """,
        (f"-{window_days} day",),
    )
    rows = [dict(r) for r in cur]
    conn.close()

    # Decorate each row with metadata
    decorated = []
    for r in rows:
        m = meta.get(r["talkgroup"], {})
        decorated.append({
            "talkgroup": r["talkgroup"],
            "talkgroup_tag": r["talkgroup_tag"] or m.get("alpha_tag") or f"tg-{r['talkgroup']}",
            "tag": m.get("tag", ""),  # service type
            "category": m.get("category", ""),  # city/agency
            "description": m.get("description", ""),
            "mode": m.get("mode", ""),
            "n": r["n"],
        })

    # Sort within group
    def sort_key(item):
        if sort == "alpha":
            return (item["talkgroup_tag"] or "").lower()
        return -item["n"]  # descending count

    if group_by == "flat":
        decorated.sort(key=sort_key)
        return jsonify({
            "groups": [{
                "name": "All",
                "key": "all",
                "total": sum(d["n"] for d in decorated),
                "talkgroups": decorated,
            }],
            "group_by": group_by,
            "sort": sort,
        })

    field = "tag" if group_by == "service" else "category"
    buckets: dict[str, list] = defaultdict(list)
    for d in decorated:
        key = d[field] or "(uncategorized)"
        buckets[key].append(d)

    # Sort talkgroups within each bucket
    groups = []
    for name, items in buckets.items():
        items.sort(key=sort_key)
        groups.append({
            "name": name,
            "key": name,
            "total": sum(i["n"] for i in items),
            "talkgroups": items,
        })

    # Sort the buckets themselves
    if sort == "alpha":
        groups.sort(key=lambda g: (g["name"] == "(uncategorized)", g["name"].lower()))
    else:
        groups.sort(key=lambda g: -g["total"])

    return jsonify({"groups": groups, "group_by": group_by, "sort": sort})


@app.route("/api/incident-types")
def incident_types():
    conn = get_db()
    cur = conn.execute("""
        SELECT incident_type, COUNT(*) AS n
        FROM calls
        WHERE incident_type IS NOT NULL
          AND enriched_at > strftime('%s', 'now', '-7 day')
        GROUP BY incident_type
        ORDER BY n DESC
    """)
    out = [dict(r) for r in cur]
    conn.close()
    return jsonify({"incident_types": out})


# -----------------------------------------------------------------------------
# Search — FTS5
# -----------------------------------------------------------------------------
@app.route("/api/search")
def search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"calls": [], "total": 0, "query": ""})

    limit = min(request.args.get("limit", default=50, type=int), 200)

    conn = get_db()
    safe = q.replace('"', '""')
    fts_q = f'"{safe}"' if " " in safe else safe

    try:
        cur = conn.execute("""
            SELECT calls.*, bm25(calls_fts) AS rank
            FROM calls_fts
            JOIN calls ON calls.id = calls_fts.rowid
            WHERE calls_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (fts_q, limit))
        rows = [call_row_to_dict(r) for r in cur]
    except sqlite3.OperationalError:
        like = f"%{q}%"
        cur = conn.execute("""
            SELECT * FROM calls
            WHERE transcript LIKE ? OR incident_summary LIKE ? OR incident_location LIKE ?
            ORDER BY start_time DESC LIMIT ?
        """, (like, like, like, limit))
        rows = [call_row_to_dict(r) for r in cur]

    conn.close()
    return jsonify({"calls": rows, "total": len(rows), "query": q})


# -----------------------------------------------------------------------------
# Audio streaming
#
# Bug fix: opus files must be served with the right MIME type or browsers
# (especially Chrome/Edge) refuse to seek and cut playback off mid-file.
# Our .opus files are actually OGG-container Opus, so the correct MIME is
# "audio/ogg" with codec hint. Some browsers also need conditional=True for
# byte-range requests so the audio element can scrub correctly.
# -----------------------------------------------------------------------------
@app.route("/audio/<path:rel_path>")
def audio(rel_path: str):
    if ".." in rel_path or rel_path.startswith("/"):
        abort(400)
    full = (CALLS_DIR / rel_path).resolve()
    try:
        full.relative_to(CALLS_DIR.resolve())
    except ValueError:
        abort(400)
    if not full.exists():
        abort(404)

    # OGG-container Opus — works in every modern browser, supports range seeks.
    response = send_file(
        full,
        mimetype="audio/ogg",
        conditional=True,  # honor If-Range / Range headers
        as_attachment=False,
    )
    # Hint the browser this is seekable
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


# -----------------------------------------------------------------------------
# Dev entrypoint
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    host = os.environ.get("JAFO_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("JAFO_WEB_PORT", "8080"))
    app.run(host=host, port=port, debug=True)
