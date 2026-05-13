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
import fcntl
import hashlib
import json
import math
import os
import sqlite3
import sys
import threading
import time
from collections import defaultdict
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, render_template, request, send_file

sys.path.insert(0, str(Path(__file__).parent.parent / "services"))
from common import (
    ANTHROPIC_API_KEY, CALLS_DIR, DATA_DIR, DB_PATH, db_connect, NODE_NAME, REGION,
)

app = Flask(__name__, static_folder="static", template_folder="templates")

# -----------------------------------------------------------------------------
# Static-asset cache busting.
# Browsers (especially mobile) hold onto /static/style.css and /static/app.js
# aggressively; there's no reliable hard-reload on iOS/Android Safari. Append
# ?v=<mtime> so any change to the file changes the URL and forces a fresh
# download. Computed once at boot, refreshed only on file mtime change.
# -----------------------------------------------------------------------------
_STATIC_VERSION_CACHE: dict[str, str] = {}

def _static_version(filename: str) -> str:
    static_dir = Path(__file__).parent / "static"
    p = static_dir / filename
    try:
        m = int(p.stat().st_mtime)
    except OSError:
        m = int(time.time())
    return str(m)

@app.context_processor
def _inject_static_helper():
    def static_v(filename: str) -> str:
        if filename not in _STATIC_VERSION_CACHE:
            _STATIC_VERSION_CACHE[filename] = _static_version(filename)
        else:
            # Always re-stat so live edits during dev/restart bust correctly.
            _STATIC_VERSION_CACHE[filename] = _static_version(filename)
        return f"/static/{filename}?v={_STATIC_VERSION_CACHE[filename]}"
    return dict(static_v=static_v)


@app.after_request
def _add_no_cache_for_html(resp):
    """HTML pages must not be cached — they reference versioned static URLs,
    so a stale HTML would point at a stale version. Static files keep their
    long cache lifetime; only the document itself becomes uncacheable."""
    ctype = resp.headers.get("Content-Type", "")
    if ctype.startswith("text/html"):
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
    return resp

# -----------------------------------------------------------------------------
# Rio Grande Valley city/area coordinates for the live map.
#
# Used to plot calls when no per-call lat/lng exists. The lookup is fuzzy:
# (1) exact match on the Category column from the talkgroups CSV,
# (2) substring match on any city key,
# (3) fall back to the RGV centroid so unknowns still appear (just clustered).
# -----------------------------------------------------------------------------
RGV_CENTER = (26.20, -98.00)
RGV_BOUNDS = ((25.80, -98.90), (26.55, -97.10))  # SW, NE

CITY_COORDS: dict[str, tuple[float, float]] = {
    "mcallen":           (26.2034, -98.2300),
    "pharr":             (26.1948, -98.1836),
    "edinburg":          (26.3017, -98.1633),
    "mission":           (26.2159, -98.3253),
    "hidalgo":           (26.0993, -98.2618),
    "weslaco":           (26.1595, -97.9908),
    "mercedes":          (26.1503, -97.9119),
    "donna":             (26.1670, -98.0530),
    "elsa":              (26.2940, -97.9842),
    "san juan":          (26.1893, -98.1547),
    "alamo":             (26.1828, -98.1167),
    "la joya":           (26.2503, -98.4856),
    "sullivan city":     (26.2745, -98.5697),
    "penitas":           (26.2370, -98.4506),
    "palmview":          (26.2398, -98.3689),
    "brownsville":       (25.9018, -97.4975),
    "harlingen":         (26.1906, -97.6961),
    "san benito":        (26.1325, -97.6311),
    "olmito":            (26.0270, -97.5408),
    "raymondville":      (26.4798, -97.7780),
    "rio grande city":   (26.3793, -98.8203),
    "roma":              (26.4076, -99.0145),
    "los fresnos":       (26.0712, -97.4769),
    "port isabel":       (26.0729, -97.2086),
    "south padre":       (26.1106, -97.1681),
    "hidalgo county":    (26.40, -98.18),
    "cameron county":    (26.15, -97.50),
    "willacy county":    (26.50, -97.80),
    "starr county":      (26.55, -98.75),
    "schools":           RGV_CENTER,  # bucketed; resolved to specific city via override
}


def lookup_city_coord(city_text: str) -> tuple[tuple[float, float], str]:
    """Return ((lat, lng), matched_key). Falls back to RGV center."""
    if not city_text:
        return RGV_CENTER, ""
    key = city_text.strip().lower()
    if key in CITY_COORDS:
        return CITY_COORDS[key], key
    for city_key in CITY_COORDS:
        if city_key in key:
            return CITY_COORDS[city_key], city_key
    return RGV_CENTER, ""


# -----------------------------------------------------------------------------
# Talkgroup overrides: editable layer on top of the read-only RR CSV.
#
# CSV stays untouched (so refreshes from RadioReference don't blow away edits).
# Overrides are merged at API time and win on conflict.
# -----------------------------------------------------------------------------
OVERRIDES_DDL = """
CREATE TABLE IF NOT EXISTS talkgroup_overrides (
    talkgroup     INTEGER PRIMARY KEY,
    display_name  TEXT,
    city          TEXT,
    service_type  TEXT,
    icon          TEXT,
    logo_url      TEXT,
    link_url      TEXT,
    lat           REAL,
    lng           REAL,
    notes         TEXT,
    updated_at    INTEGER
);
"""


def ensure_overrides_table() -> None:
    conn = get_db()
    conn.executescript(OVERRIDES_DDL)
    # Idempotent column adds for older installs
    for col in ("icon TEXT", "logo_url TEXT", "link_url TEXT"):
        try:
            conn.execute(f"ALTER TABLE talkgroup_overrides ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass  # already exists
    conn.commit()
    conn.close()


# Curated icon set for the editor dropdown. Keep it tight — too many choices
# defeats the point. Keys are stable identifiers; values are emoji + label.
ICON_CHOICES = [
    ("police",      "🚔", "Police / Law"),
    ("fire",        "🚒", "Fire"),
    ("ems",         "🚑", "EMS / Medical"),
    ("school",      "🏫", "School"),
    ("utility",     "🔧", "Utility / Public Works"),
    ("water",       "💧", "Water"),
    ("power",       "⚡", "Power / Electric"),
    ("transit",     "🚌", "Transit / Bus"),
    ("government",  "🏛️", "City / County / Govt"),
    ("dispatch",    "📞", "Dispatch"),
    ("traffic",     "🚧", "Traffic / Roads"),
    ("hazmat",      "☢️", "HazMat"),
    ("rescue",      "🛟", "Search & Rescue"),
    ("air",         "🚁", "Air / Helicopter"),
    ("aviation",    "✈️", "Aviation / Airport"),
    ("marine",      "⚓", "Marine / Port"),
    ("hospital",    "🏥", "Hospital"),
    ("construction","🏗️", "Construction"),
    ("k9",          "🐕", "K9 / Animal Control"),
    ("park",        "🌲", "Parks"),
    ("emergency",   "⚠️", "Emergency / Alert"),
    ("weather",     "🌪️", "Weather"),
    ("radio",       "📡", "Radio (generic)"),
]


def load_overrides() -> dict[int, dict]:
    conn = get_db()
    cur = conn.execute("SELECT * FROM talkgroup_overrides")
    out = {r["talkgroup"]: dict(r) for r in cur}
    conn.close()
    return out

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
# Additional non-trunked CSVs (e.g. conventional systems like GMRS). Loaded
# alongside the main talkgroups.csv so the sidebar/grouping endpoints see
# every system, not just the trunked one. Conventional channels use small
# sequential TG IDs (trunk-recorder assigns 1..N from channel-array order),
# which won't collide with real LRGVRRS TGs (those are 60000+).
EXTRA_TALKGROUPS_CSVS = [
    DATA_DIR / "config" / "uhf-business-talkgroups.csv",
]


def _read_tg_csv(path) -> dict[int, dict]:
    out: dict[int, dict] = {}
    if not path.exists():
        return out
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
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
        print(f"Failed to load talkgroups CSV {path}: {e}", file=sys.stderr)
    return out


def load_talkgroup_metadata() -> dict[int, dict]:
    """Return {tg_decimal: {tag, category, alpha_tag, description}}.

    Merges the primary LRGVRRS talkgroups CSV with any additional
    conventional-system CSVs (EXTRA_TALKGROUPS_CSVS). Empty dict if all
    are missing or unreadable.
    """
    out = _read_tg_csv(TALKGROUPS_CSV)
    for extra in EXTRA_TALKGROUPS_CSVS:
        # Extra CSVs win on collision — but in practice we keep their TG IDs
        # in a non-overlapping range (1..30 for conventional vs 60000+ for trunked).
        out.update(_read_tg_csv(extra))
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


def call_row_to_dict(r: sqlite3.Row, tg_meta: dict | None = None,
                     overrides: dict[int, dict] | None = None) -> dict:
    tg = r["talkgroup"]
    csv_meta = (tg_meta or {}).get(tg, {}) if tg else {}
    ov = (overrides or {}).get(tg, {}) if tg else {}

    # Resolve city + service type: override > CSV
    city = ov.get("city") or csv_meta.get("category") or ""
    service_type = ov.get("service_type") or csv_meta.get("tag") or ""
    icon_id = ov.get("icon") or ""

    # Coords: explicit override coords > city lookup > RGV center
    if ov.get("lat") is not None and ov.get("lng") is not None:
        lat, lng = ov["lat"], ov["lng"]
    else:
        (lat, lng), _ = lookup_city_coord(city)

    return {
        "id": r["id"],
        "talkgroup": tg,
        "talkgroup_tag": ov.get("display_name") or r["talkgroup_tag"],
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
        "transcript_model": r["transcript_model"],
        "incident_type": r["incident_type"],
        "incident_summary": r["incident_summary"],
        "incident_location": r["incident_location"],
        "incident_units": (r["incident_units"] or "").split(",") if r["incident_units"] else [],
        "incident_severity": r["incident_severity"],
        "enriched_at": r["enriched_at"],
        "enrich_error": r["enrich_error"],
        # New: map + service-type fields
        "city": city,
        "service_type": service_type,
        "icon": icon_id,
        "link_url": ov.get("link_url") or "",
        "lat": lat,
        "lng": lng,
    }


# -----------------------------------------------------------------------------
# UI — fleet (root) + per-region + per-node + admin
# -----------------------------------------------------------------------------
def _is_edge_node() -> bool:
    """True if this Flask process is running on a Pi feeding a hub.
    The presence of JAFO_HUB_URL is the canonical signal — the hub
    itself doesn't have that variable set."""
    return bool(os.environ.get("JAFO_HUB_URL", "").strip())


def _hub_link_for_this_node() -> dict | None:
    """If we're an edge node (JAFO_HUB_URL + JAFO_NODE_SLUG set), return the
    public link to this node's page on the hub. None on the hub itself."""
    hub_url   = os.environ.get("JAFO_HUB_URL", "").strip().rstrip("/")
    node_slug = os.environ.get("JAFO_NODE_SLUG", "").strip()
    if not hub_url or not node_slug:
        return None
    conn = get_db()
    n = conn.execute("""
        SELECT n.slug, n.display_name, r.slug AS region_slug, r.name AS region_name
        FROM nodes n LEFT JOIN regions r ON r.id = n.region_id
        WHERE n.slug = ?
    """, (node_slug,)).fetchone()
    conn.close()
    if not n or not n["region_slug"]:
        return None
    return {
        "hub_url":      hub_url,
        "url":          f"{hub_url}/r/{n['region_slug']}/n/{n['slug']}",
        "region_url":   f"{hub_url}/r/{n['region_slug']}",
        "node_slug":    n["slug"],
        "region_slug":  n["region_slug"],
        "region_name":  n["region_name"] or n["region_slug"],
        "display_name": n["display_name"] or n["slug"],
    }


@app.route("/")
def index():
    """Root: fleet view if multiple regions exist, else just the regional dash."""
    conn = get_db()
    n_regions = conn.execute("SELECT COUNT(*) FROM regions").fetchone()[0]
    conn.close()
    if n_regions <= 1:
        return render_template("index.html", node_name=NODE_NAME,
                               region_slug=None, node_slug=None,
                               hub_link=_hub_link_for_this_node(),
                               is_hub=not _is_edge_node())
    return render_template("fleet.html", node_name=NODE_NAME)


@app.route("/dashboard")
def dashboard():
    """Briefing-first dashboard — designed for ambient awareness vs the
    enthusiast-density of /. Big map + LLM briefing card + severity-first
    call list. Uses the same underlying /api/* endpoints."""
    return render_template("dashboard.html", node_name=NODE_NAME,
                           hub_link=_hub_link_for_this_node(),
                           is_hub=not _is_edge_node())


@app.route("/editions")
def editions():
    """Regional landing — Texas map with each available edition highlighted.
    For now only the McAllen / RGV edition is live."""
    return render_template("editions.html", node_name=NODE_NAME)


@app.route("/r/<slug>")
def region_dashboard(slug: str):
    """Regional dashboard — same UI as root, but scoped to one region."""
    conn = get_db()
    r = conn.execute("SELECT slug, name FROM regions WHERE slug = ?", (slug,)).fetchone()
    conn.close()
    if not r:
        abort(404)
    return render_template("index.html", node_name=NODE_NAME,
                           region_slug=slug, region_name=r["name"], node_slug=None,
                           hub_link=_hub_link_for_this_node(),
                           is_hub=not _is_edge_node())


@app.route("/r/<slug>/n/<node_slug>")
def node_detail(slug: str, node_slug: str):
    """Single-node view — same UI but scoped to one node within a region."""
    conn = get_db()
    n = conn.execute("""
        SELECT n.slug, n.display_name, r.slug AS region_slug
        FROM nodes n JOIN regions r ON r.id = n.region_id
        WHERE n.slug = ? AND r.slug = ?
    """, (node_slug, slug)).fetchone()
    conn.close()
    if not n:
        abort(404)
    return render_template("index.html", node_name=NODE_NAME,
                           region_slug=slug, node_slug=node_slug,
                           node_display_name=n["display_name"],
                           hub_link=_hub_link_for_this_node(),
                           is_hub=not _is_edge_node())


@app.route("/talkgroups")
def talkgroups_editor():
    return render_template("talkgroups.html", node_name=NODE_NAME,
                           hub_link=_hub_link_for_this_node(),
                           is_hub=not _is_edge_node())


# -----------------------------------------------------------------------------
# Admin gate — JAFO_ADMIN_TOKEN env var, passed as ?token= or Bearer header
# -----------------------------------------------------------------------------
ADMIN_TOKEN = os.environ.get("JAFO_ADMIN_TOKEN", "").strip()


def _admin_ok(req) -> bool:
    if not ADMIN_TOKEN:
        return False  # no admin token configured = admin disabled
    qp = (req.args.get("token") or "").strip()
    if qp and qp == ADMIN_TOKEN:
        return True
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer ") and auth[7:].strip() == ADMIN_TOKEN:
        return True
    return False


@app.route("/admin")
def admin_page():
    if not _admin_ok(request):
        return ("<h1>jafo admin</h1>"
                "<p>Set <code>JAFO_ADMIN_TOKEN</code> on the hub and visit "
                "<code>/admin?token=YOUR_TOKEN</code>.</p>", 401)
    return render_template("admin.html", node_name=NODE_NAME)


@app.route("/api/admin/nodes")
def admin_nodes():
    if not _admin_ok(request):
        return jsonify({"error": "unauthorized"}), 401
    conn = get_db()
    rows = conn.execute("""
        SELECT n.id, n.slug, n.display_name, n.owner_email, n.lat, n.lng,
               n.status, n.created_at, n.last_seen_at, n.notes,
               r.slug AS region_slug, r.name AS region_name,
               (SELECT COUNT(*) FROM calls WHERE node_id = n.id) AS call_count,
               (SELECT MAX(start_time) FROM calls WHERE node_id = n.id) AS last_call_at,
               (SELECT COUNT(*) FROM calls WHERE node_id = n.id
                AND processed_at > strftime('%s','now','-1 day')) AS calls_24h
        FROM nodes n LEFT JOIN regions r ON r.id = n.region_id
        ORDER BY n.created_at
    """).fetchall()
    conn.close()
    return jsonify({"nodes": [dict(r) for r in rows]})


@app.route("/api/admin/regions")
def admin_regions():
    if not _admin_ok(request):
        return jsonify({"error": "unauthorized"}), 401
    conn = get_db()
    rows = conn.execute("""
        SELECT r.id, r.slug, r.name, r.description,
               r.default_lat, r.default_lng, r.default_zoom,
               (SELECT COUNT(*) FROM nodes WHERE region_id = r.id) AS node_count,
               (SELECT COUNT(*) FROM calls WHERE region_id = r.id) AS call_count
        FROM regions r ORDER BY r.created_at
    """).fetchall()
    conn.close()
    return jsonify({"regions": [dict(r) for r in rows]})


# -----------------------------------------------------------------------------
# LLM evaluation — compares primary backend's enrichment vs shadow Ollama
# enrichment. Used to spot where the local model is wrong, build a corpus
# for fine-tuning later.
# -----------------------------------------------------------------------------
@app.route("/admin/llm-eval")
def admin_llm_eval():
    if not _admin_ok(request):
        return ("<h1>jafo admin</h1>"
                "<p>Pass <code>?token=YOUR_TOKEN</code>.</p>", 401)
    return render_template("admin_llm_eval.html", node_name=NODE_NAME)


@app.route("/api/admin/llm-eval/summary")
def admin_llm_eval_summary():
    if not _admin_ok(request):
        return jsonify({"error": "unauthorized"}), 401
    conn = get_db()
    row = conn.execute("""
        SELECT
          COUNT(*) AS compared,
          SUM(CASE WHEN incident_type = incident_type_ollama THEN 1 ELSE 0 END)
            AS type_agree,
          SUM(CASE WHEN incident_severity = incident_severity_ollama THEN 1 ELSE 0 END)
            AS sev_agree,
          SUM(CASE WHEN shadow_enrich_error IS NOT NULL THEN 1 ELSE 0 END)
            AS shadow_errors
        FROM calls
        WHERE incident_json IS NOT NULL
          AND incident_json_ollama IS NOT NULL
    """).fetchone()
    pending_shadow = conn.execute("""
        SELECT COUNT(*) FROM calls
        WHERE incident_json IS NOT NULL
          AND incident_json_ollama IS NULL
          AND shadow_enrich_error IS NULL
          AND length(transcript) >= 8
    """).fetchone()[0]

    type_breakdown = conn.execute("""
        SELECT incident_type AS primary_type,
               incident_type_ollama AS ollama_type,
               COUNT(*) AS n
        FROM calls
        WHERE incident_json IS NOT NULL AND incident_json_ollama IS NOT NULL
          AND incident_type != incident_type_ollama
        GROUP BY incident_type, incident_type_ollama
        ORDER BY n DESC
        LIMIT 15
    """).fetchall()
    conn.close()

    return jsonify({
        "compared":      row["compared"] or 0,
        "type_agree":    row["type_agree"] or 0,
        "sev_agree":     row["sev_agree"] or 0,
        "shadow_errors": row["shadow_errors"] or 0,
        "pending":       pending_shadow,
        "type_disagreements": [dict(r) for r in type_breakdown],
    })


@app.route("/api/admin/llm-eval/disagreements")
def admin_llm_eval_disagreements():
    if not _admin_ok(request):
        return jsonify({"error": "unauthorized"}), 401
    limit = min(int(request.args.get("limit", 30)), 200)
    conn = get_db()
    rows = conn.execute("""
        SELECT id, talkgroup_tag, transcript,
               incident_type, incident_summary, incident_severity,
               incident_type_ollama, incident_severity_ollama,
               incident_json, incident_json_ollama
        FROM calls
        WHERE incident_json IS NOT NULL AND incident_json_ollama IS NOT NULL
          AND (incident_type != incident_type_ollama
               OR incident_severity != incident_severity_ollama)
        ORDER BY enriched_at DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return jsonify({"disagreements": [dict(r) for r in rows]})


@app.route("/api/admin/llm-eval/export.jsonl")
def admin_llm_eval_export():
    """Export training corpus as JSONL: {transcript, talkgroup_tag, label}.
    The 'label' is the primary (canonical) backend output — what we want
    Ollama to learn to produce."""
    if not _admin_ok(request):
        return jsonify({"error": "unauthorized"}), 401
    conn = get_db()
    rows = conn.execute("""
        SELECT transcript, talkgroup_tag, incident_json
        FROM calls
        WHERE incident_json IS NOT NULL
          AND length(transcript) >= 12
        ORDER BY enriched_at DESC
    """).fetchall()
    conn.close()

    def gen():
        for r in rows:
            try:
                label = json.loads(r["incident_json"])
            except Exception:
                continue
            yield json.dumps({
                "transcript":    r["transcript"],
                "talkgroup_tag": r["talkgroup_tag"] or "",
                "label":         label,
            }) + "\n"

    from flask import Response
    return Response(gen(), mimetype="application/jsonl",
                    headers={"Content-Disposition": "attachment; filename=jafo-enrich-corpus.jsonl"})


# -----------------------------------------------------------------------------
# Public fleet info (for the / fleet landing page when multi-region)
# -----------------------------------------------------------------------------
@app.route("/api/regions")
def api_regions():
    """Public: list of regions with node counts. Used by fleet landing."""
    conn = get_db()
    rows = conn.execute("""
        SELECT r.slug, r.name, r.description,
               r.default_lat, r.default_lng, r.default_zoom,
               (SELECT COUNT(*) FROM nodes WHERE region_id = r.id AND status='active') AS node_count,
               (SELECT COUNT(*) FROM calls WHERE region_id = r.id) AS call_count,
               (SELECT COUNT(*) FROM calls WHERE region_id = r.id
                AND processed_at > strftime('%s','now','-1 day')) AS calls_24h
        FROM regions r ORDER BY r.created_at
    """).fetchall()
    conn.close()
    return jsonify({"regions": [dict(r) for r in rows]})


@app.route("/api/fleet/nodes")
def api_fleet_nodes():
    """Public: nodes with location for the fleet map (no PII)."""
    conn = get_db()
    rows = conn.execute("""
        SELECT n.slug, n.display_name, n.lat, n.lng, n.status,
               r.slug AS region_slug, r.name AS region_name,
               n.last_seen_at,
               (SELECT COUNT(*) FROM calls WHERE node_id = n.id
                AND processed_at > strftime('%s','now','-1 day')) AS calls_24h
        FROM nodes n LEFT JOIN regions r ON r.id = n.region_id
        WHERE n.status = 'active'
    """).fetchall()
    conn.close()
    return jsonify({"nodes": [dict(r) for r in rows]})


# -----------------------------------------------------------------------------
# Health + stats
# -----------------------------------------------------------------------------
@app.route("/api/health")
def health():
    return jsonify({"ok": True, "node": NODE_NAME, "ts": int(time.time())})


def _read_cpu_temp() -> float | None:
    """Pi CPU temp in °C from kernel thermal zone. Returns None if unreadable."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read().strip()) / 1000.0
    except (OSError, ValueError):
        return None


@app.route("/api/stats")
def stats():
    conn = get_db()
    out = {"node": NODE_NAME, "now": int(time.time())}
    out["cpu_temp_c"] = _read_cpu_temp()

    # Optional scoping
    region_slug = request.args.get("region")
    node_slug = request.args.get("node")
    scope_sql = ""
    scope_params: list = []
    if region_slug:
        scope_sql += " AND region_id = (SELECT id FROM regions WHERE slug = ?)"
        scope_params.append(region_slug)
    if node_slug:
        scope_sql += " AND node_id = (SELECT id FROM nodes WHERE slug = ?)"
        scope_params.append(node_slug)
    out["scope"] = {"region": region_slug, "node": node_slug}

    cur = conn.execute(f"""
        SELECT
          SUM(CASE WHEN status='kept' THEN 1 ELSE 0 END) AS kept_total,
          SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped_total,
          SUM(CASE WHEN transcript IS NOT NULL THEN 1 ELSE 0 END) AS transcribed,
          SUM(CASE WHEN incident_json IS NOT NULL THEN 1 ELSE 0 END) AS enriched
        FROM calls WHERE 1=1 {scope_sql}
    """, scope_params)
    out["totals"] = dict(cur.fetchone())

    cur = conn.execute(f"""
        SELECT
          SUM(CASE WHEN status='kept' THEN 1 ELSE 0 END) AS kept_24h,
          SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped_24h
        FROM calls
        WHERE processed_at > strftime('%s', 'now', '-1 day') {scope_sql}
    """, scope_params)
    out["last_24h"] = dict(cur.fetchone())

    cur = conn.execute(f"""
        SELECT
          SUM(CASE WHEN status = 'kept' AND transcript IS NULL
                   AND transcript_error IS NULL AND audio_deleted = 0
                   THEN 1 ELSE 0 END) AS transcribe_pending,
          SUM(CASE WHEN transcript IS NOT NULL AND incident_json IS NULL
                   AND enrich_error IS NULL THEN 1 ELSE 0 END) AS enrich_pending
        FROM calls WHERE 1=1 {scope_sql}
    """, scope_params)
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

    # Multi-node filters (Phase 3): scope by region or node slug
    region_slug = request.args.get("region")
    node_slug   = request.args.get("node")

    # Group filter — match any talkgroup whose Tag or Category matches the value.
    # This requires loading metadata to find member talkgroups.
    service_tag_filter = request.args.get("service_tag")  # e.g. "Law Dispatch"
    category_filter = request.args.get("category")  # e.g. "Hidalgo County"

    where = []
    params: list = []
    if only_kept:
        where.append("status = 'kept'")
    if region_slug:
        where.append("region_id = (SELECT id FROM regions WHERE slug = ?)")
        params.append(region_slug)
    if node_slug:
        where.append("node_id = (SELECT id FROM nodes WHERE slug = ?)")
        params.append(node_slug)
    if only_with_transcript:
        where.append("transcript IS NOT NULL AND transcript != ''")
    if talkgroup is not None:
        where.append("talkgroup = ?")
        params.append(talkgroup)
    if talkgroup_tag:
        where.append("talkgroup_tag = ?")
        params.append(talkgroup_tag)
    # `talkgroups` (IDs) and `talkgroup_tags` (string tags) are OR'd together
    # so the favorites widget can mix trunked TGs with conventional channels
    # (which share TG ids like 1/2 across systems, making the tag the only
    # stable handle for things like the "misd-pd" conventional source).
    talkgroups_csv = request.args.get("talkgroups")
    tg_list: list[int] = []
    if talkgroups_csv:
        try:
            tg_list = [int(x) for x in talkgroups_csv.split(",") if x.strip()]
        except ValueError:
            tg_list = []
    talkgroup_tags_csv = request.args.get("talkgroup_tags")
    tag_list: list[str] = []
    if talkgroup_tags_csv:
        tag_list = [t.strip() for t in talkgroup_tags_csv.split(",") if t.strip()]
    if tg_list or tag_list:
        clauses = []
        if tg_list:
            clauses.append(f"talkgroup IN ({','.join('?' * len(tg_list))})")
            params.extend(tg_list)
        if tag_list:
            clauses.append(f"talkgroup_tag IN ({','.join('?' * len(tag_list))})")
            params.extend(tag_list)
        where.append("(" + " OR ".join(clauses) + ")")
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
    tg_meta = load_talkgroup_metadata()
    overrides = load_overrides()
    rows = [call_row_to_dict(r, tg_meta, overrides) for r in cur]

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
    return jsonify(call_row_to_dict(row, load_talkgroup_metadata(), load_overrides()))


# -----------------------------------------------------------------------------
# Enhance — re-run a single call's audio through Groq for higher-quality
# transcription. HUB-ONLY: edge nodes refuse this request and tell the
# caller to go to jafo.live. The original (local) transcript is preserved in
# transcript_original so we can always show what was replaced.
#
# Single shared Groq client — created lazily on first hit, reused across all
# subsequent /enhance requests in this gunicorn worker. No per-request client
# spin-up, no key passing through layers, one canonical integration point.
# -----------------------------------------------------------------------------
GROQ_PREMIUM_MODEL = "whisper-large-v3-turbo"
_GROQ_CLIENT = None


def _groq_client():
    """Lazy singleton — first caller wins, subsequent callers reuse."""
    global _GROQ_CLIENT
    if _GROQ_CLIENT is not None:
        return _GROQ_CLIENT
    from common import GROQ_API_KEY
    if not GROQ_API_KEY:
        return None
    from groq import Groq
    _GROQ_CLIENT = Groq(api_key=GROQ_API_KEY, max_retries=1)
    return _GROQ_CLIENT


def _ensure_enhance_columns(conn) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(calls)")}
    if "transcript_original" not in cols:
        conn.execute("ALTER TABLE calls ADD COLUMN transcript_original TEXT")
    if "transcript_original_model" not in cols:
        conn.execute("ALTER TABLE calls ADD COLUMN transcript_original_model TEXT")
    conn.commit()


@app.route("/api/calls/<int:call_id>/enhance", methods=["POST"])
def call_enhance(call_id: int):
    # Hub-only — edge nodes can't enhance (no Groq key, by design).
    if _is_edge_node():
        hub_url = os.environ.get("JAFO_HUB_URL", "").strip().rstrip("/")
        return jsonify({
            "error": "enhance is hub-only",
            "redirect": f"{hub_url}/api/calls/<id>/enhance" if hub_url else None,
            "hub_url": hub_url or None,
        }), 503

    client = _groq_client()
    if client is None:
        return jsonify({"error": "Groq API key not configured on this hub"}), 503

    conn = get_db()
    _ensure_enhance_columns(conn)

    row = conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
    if not row:
        conn.close()
        abort(404)

    if not row["opus_path"] or row["audio_deleted"]:
        conn.close()
        return jsonify({"error": "audio not available"}), 400

    opus_full = (CALLS_DIR / row["opus_path"]).resolve()
    try:
        opus_full.relative_to(CALLS_DIR.resolve())
    except ValueError:
        conn.close()
        return jsonify({"error": "invalid path"}), 400
    if not opus_full.exists():
        conn.close()
        return jsonify({"error": "audio file missing"}), 410

    # If already enhanced (transcript_model is the premium one), short-circuit
    if (row["transcript_model"] or "").startswith(GROQ_PREMIUM_MODEL):
        conn.close()
        return jsonify({
            "ok": True, "already_enhanced": True,
            "transcript": row["transcript"],
            "transcript_model": row["transcript_model"],
        })

    try:
        with open(opus_full, "rb") as f:
            result = client.audio.transcriptions.create(
                file=(opus_full.name, f.read()),
                model=GROQ_PREMIUM_MODEL,
                prompt=(
                    "Police, fire, and EMS radio dispatch. "
                    "Common terms: 10-4, 10-50, en route, code 3, dispatch, copy, on scene."
                ),
                response_format="verbose_json",
                temperature=0.0,
            )
        new_text = (result.text or "").strip()
    except Exception as e:
        conn.close()
        return jsonify({"error": f"Groq error: {type(e).__name__}: {e}"}), 502

    # Preserve the original (local) transcript before overwriting
    if row["transcript"] and not row["transcript_original"]:
        conn.execute("""
            UPDATE calls
            SET transcript_original = ?, transcript_original_model = ?
            WHERE id = ?
        """, (row["transcript"], row["transcript_model"], call_id))

    conn.execute("""
        UPDATE calls
        SET transcript = ?, transcript_model = ?, transcript_at = ?, transcript_error = NULL
        WHERE id = ?
    """, (new_text, GROQ_PREMIUM_MODEL, int(time.time()), call_id))
    conn.commit()
    conn.close()

    return jsonify({
        "ok": True,
        "call_id": call_id,
        "transcript": new_text,
        "transcript_model": GROQ_PREMIUM_MODEL,
        "previous_model": row["transcript_model"],
    })


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
    overrides = load_overrides()
    # TGs explicitly defined in the conventional CSVs (e.g. GMRS) — these
    # should appear in the sidebar even with n=0 so the user can see the
    # section is wired up before the first call lands.
    seeded_tgs: dict[int, dict] = {}
    for extra in EXTRA_TALKGROUPS_CSVS:
        seeded_tgs.update(_read_tg_csv(extra))

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

    # Decorate each row with metadata. User overrides win over the CSV — so
    # once someone names a previously-unknown talkgroup (e.g. tg-62037 → "RGV
    # K9 dispatch") via the editor, it leaves the "(uncategorized)" bucket
    # and appears under the assigned service type.
    decorated = []
    seen_tg_ids = set()
    for r in rows:
        m = meta.get(r["talkgroup"], {})
        ov = overrides.get(r["talkgroup"], {})
        seen_tg_ids.add(r["talkgroup"])
        display = ov.get("display_name") or r["talkgroup_tag"] or m.get("alpha_tag") or f"tg-{r['talkgroup']}"
        service = ov.get("service_type") or m.get("tag", "")
        city    = ov.get("city")         or m.get("category", "")
        decorated.append({
            "talkgroup": r["talkgroup"],
            "talkgroup_tag": display,
            "tag": service,    # service type
            "category": city,  # city/agency
            "description": m.get("description", ""),
            "mode": m.get("mode", ""),
            "n": r["n"],
        })

    # Seed conventional-CSV talkgroups (e.g. GMRS) that haven't yet been heard,
    # so the section appears immediately rather than waiting for the first call.
    for tg, m in seeded_tgs.items():
        if tg in seen_tg_ids:
            continue
        decorated.append({
            "talkgroup": tg,
            "talkgroup_tag": m.get("alpha_tag") or f"tg-{tg}",
            "tag": m.get("tag", ""),
            "category": m.get("category", ""),
            "description": m.get("description", ""),
            "mode": m.get("mode", ""),
            "n": 0,
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


@app.route("/api/talkgroups/all")
def talkgroups_all():
    """Full talkgroup roster for the editor: CSV defaults merged with overrides + counts."""
    csv_meta = load_talkgroup_metadata()
    overrides = load_overrides()

    # Per-talkgroup call counts (last 7 days, kept calls only)
    conn = get_db()
    cur = conn.execute("""
        SELECT talkgroup, COUNT(*) AS n, MAX(start_time) AS last_seen
        FROM calls
        WHERE status = 'kept' AND processed_at > strftime('%s', 'now', '-7 day')
        GROUP BY talkgroup
    """)
    counts = {r["talkgroup"]: dict(r) for r in cur}
    conn.close()

    # Union of all known talkgroups (CSV ∪ overrides ∪ ones we've seen on the air)
    all_tgs = set(csv_meta.keys()) | set(overrides.keys()) | set(counts.keys())

    out = []
    for tg in sorted(all_tgs):
        csv = csv_meta.get(tg, {})
        ov = overrides.get(tg, {})
        cnt = counts.get(tg, {})

        city = ov.get("city") or csv.get("category") or ""
        service_type = ov.get("service_type") or csv.get("tag") or ""

        if ov.get("lat") is not None and ov.get("lng") is not None:
            lat, lng = ov["lat"], ov["lng"]
        else:
            (lat, lng), matched = lookup_city_coord(city)
            if not matched:
                lat = lng = None  # signal "auto-derived to RGV center"

        out.append({
            "talkgroup": tg,
            "name": ov.get("display_name") or csv.get("alpha_tag") or f"tg-{tg}",
            "csv_alpha_tag": csv.get("alpha_tag", ""),
            "csv_category": csv.get("category", ""),
            "csv_tag": csv.get("tag", ""),
            "description": csv.get("description", ""),
            "mode": csv.get("mode", ""),
            "city": city,
            "service_type": service_type,
            "icon": ov.get("icon", "") or "",
            "link_url": ov.get("link_url", "") or "",
            "lat": lat,
            "lng": lng,
            "notes": ov.get("notes", ""),
            "is_overridden": tg in overrides,
            "calls_7d": cnt.get("n", 0),
            "last_seen": cnt.get("last_seen"),
        })

    return jsonify({
        "talkgroups": out,
        "available_cities": sorted(CITY_COORDS.keys()),
        "icon_choices": [
            {"id": k, "emoji": e, "label": l} for (k, e, l) in ICON_CHOICES
        ],
    })


@app.route("/api/talkgroups/<int:tg>", methods=["PUT"])
def talkgroups_update(tg: int):
    """Insert or update an override for one talkgroup."""
    body = request.get_json(force=True, silent=True) or {}
    fields = {
        "display_name": body.get("name") or None,
        "city":         body.get("city") or None,
        "service_type": body.get("service_type") or None,
        "icon":         body.get("icon") or None,
        "logo_url":     None,  # logo feature removed; always cleared
        "link_url":     (body.get("link_url") or "").strip() or None,
        "lat":          body.get("lat"),
        "lng":          body.get("lng"),
        "notes":        body.get("notes") or None,
    }

    # Basic URL hygiene — only allow http(s) so we don't open ourselves to javascript: URIs
    v = fields["link_url"]
    if v and not (v.startswith("http://") or v.startswith("https://")):
        fields["link_url"] = None

    # Coerce numeric-ish empty strings to None
    for k in ("lat", "lng"):
        v = fields[k]
        if v == "" or v is None:
            fields[k] = None
        else:
            try:
                fields[k] = float(v)
            except (TypeError, ValueError):
                fields[k] = None

    # If everything is None, delete the override row instead of writing empties
    conn = get_db()
    if all(v is None for v in fields.values()):
        conn.execute("DELETE FROM talkgroup_overrides WHERE talkgroup = ?", (tg,))
    else:
        conn.execute("""
            INSERT INTO talkgroup_overrides
              (talkgroup, display_name, city, service_type, icon, logo_url, link_url,
               lat, lng, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(talkgroup) DO UPDATE SET
              display_name = excluded.display_name,
              city         = excluded.city,
              service_type = excluded.service_type,
              icon         = excluded.icon,
              logo_url     = excluded.logo_url,
              link_url     = excluded.link_url,
              lat          = excluded.lat,
              lng          = excluded.lng,
              notes        = excluded.notes,
              updated_at   = excluded.updated_at
        """, (
            tg, fields["display_name"], fields["city"], fields["service_type"],
            fields["icon"], fields["logo_url"], fields["link_url"],
            fields["lat"], fields["lng"], fields["notes"], int(time.time()),
        ))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "talkgroup": tg})


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
    tg_meta = load_talkgroup_metadata()
    overrides = load_overrides()

    try:
        cur = conn.execute("""
            SELECT calls.*, bm25(calls_fts) AS rank
            FROM calls_fts
            JOIN calls ON calls.id = calls_fts.rowid
            WHERE calls_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (fts_q, limit))
        rows = [call_row_to_dict(r, tg_meta, overrides) for r in cur]
    except sqlite3.OperationalError:
        like = f"%{q}%"
        cur = conn.execute("""
            SELECT * FROM calls
            WHERE transcript LIKE ? OR incident_summary LIKE ? OR incident_location LIKE ?
            ORDER BY start_time DESC LIMIT ?
        """, (like, like, like, limit))
        rows = [call_row_to_dict(r, tg_meta, overrides) for r in cur]

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


# =============================================================================
# Ingest endpoint — Pi nodes POST captured calls here.
# Auth: Bearer <token>. Token's sha256 hash matches a row in `nodes`.
# Each upload: multipart with `audio` file + `metadata` JSON form field.
# Idempotent: dedup by (node_id, content_hash).
# =============================================================================
@app.route("/api/ingest/cell-sites", methods=["POST"])
def api_ingest_cell_sites():
    """Edge nodes POST a snapshot of their cell_sites table here every few
    minutes. The hub upserts each row, tagging it with the originating
    node_id so future multi-tenant filtering works out.

    Request body: JSON object {"sites": [<row>, ...]} where each row has
    the same shape as the edge's cell_sites table (site_key, rat, mcc,
    mnc, cell_id, pci, earfcn, band, operator, first_seen_at,
    last_seen_at, last_rsrp_dbm, obs_count, lat, lng, geo_source,
    asr_number, notes).

    Auth: Bearer <node token> — same scheme as /api/ingest for calls.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "missing bearer token"}), 401
    token = auth[7:].strip()
    if not token:
        return jsonify({"error": "empty token"}), 401
    token_hash = hashlib.sha256(token.encode()).hexdigest()

    try:
        body = request.get_json(force=True) or {}
    except Exception:
        return jsonify({"error": "body must be JSON"}), 400
    sites = body.get("sites") or []
    if not isinstance(sites, list):
        return jsonify({"error": "sites must be a list"}), 400

    conn = get_db()
    try:
        node = conn.execute(
            "SELECT id, status FROM nodes WHERE token_hash = ?", (token_hash,)
        ).fetchone()
        if not node:
            return jsonify({"error": "unknown token"}), 403
        if node["status"] != "active":
            return jsonify({"error": "node disabled"}), 403

        upserts = 0
        for s in sites:
            if not isinstance(s, dict) or not s.get("site_key"):
                continue
            existing = conn.execute(
                "SELECT id FROM cell_sites WHERE site_key = ? AND (node_id = ? OR node_id IS NULL)",
                (s["site_key"], node["id"])
            ).fetchone()
            if existing:
                conn.execute("""
                    UPDATE cell_sites
                    SET rat            = COALESCE(?, rat),
                        mcc            = COALESCE(?, mcc),
                        mnc            = COALESCE(?, mnc),
                        cell_id        = COALESCE(?, cell_id),
                        pci            = COALESCE(?, pci),
                        earfcn         = COALESCE(?, earfcn),
                        band           = COALESCE(?, band),
                        operator       = COALESCE(?, operator),
                        first_seen_at  = COALESCE(first_seen_at, ?),
                        last_seen_at   = MAX(COALESCE(last_seen_at, 0), COALESCE(?, 0)),
                        last_rsrp_dbm  = COALESCE(?, last_rsrp_dbm),
                        obs_count      = COALESCE(?, obs_count),
                        lat            = COALESCE(?, lat),
                        lng            = COALESCE(?, lng),
                        geo_source     = COALESCE(?, geo_source),
                        asr_number     = COALESCE(?, asr_number),
                        notes          = COALESCE(?, notes),
                        node_id        = ?
                    WHERE id = ?
                """, (s.get("rat"), s.get("mcc"), s.get("mnc"), s.get("cell_id"),
                      s.get("pci"), s.get("earfcn"), s.get("band"), s.get("operator"),
                      s.get("first_seen_at"), s.get("last_seen_at"),
                      s.get("last_rsrp_dbm"), s.get("obs_count"),
                      s.get("lat"), s.get("lng"),
                      s.get("geo_source"), s.get("asr_number"), s.get("notes"),
                      node["id"], existing["id"]))
            else:
                conn.execute("""
                    INSERT INTO cell_sites
                        (site_key, rat, mcc, mnc, cell_id, pci, earfcn, band,
                         operator, first_seen_at, last_seen_at, last_rsrp_dbm,
                         obs_count, lat, lng, geo_source, asr_number, notes, node_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (s.get("site_key"), s.get("rat"), s.get("mcc"), s.get("mnc"),
                      s.get("cell_id"), s.get("pci"), s.get("earfcn"), s.get("band"),
                      s.get("operator"), s.get("first_seen_at"), s.get("last_seen_at"),
                      s.get("last_rsrp_dbm"), s.get("obs_count"),
                      s.get("lat"), s.get("lng"),
                      s.get("geo_source"), s.get("asr_number"), s.get("notes"),
                      node["id"]))
            upserts += 1

        conn.execute("UPDATE nodes SET last_seen_at = ? WHERE id = ?",
                     (int(time.time()), node["id"]))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "upserts": upserts})


@app.route("/api/ingest", methods=["POST"])
def api_ingest():
    from datetime import datetime, timezone

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "missing bearer token"}), 401
    token = auth[7:].strip()
    if not token:
        return jsonify({"error": "empty token"}), 401

    token_hash = hashlib.sha256(token.encode()).hexdigest()

    audio_file = request.files.get("audio")
    metadata_str = request.form.get("metadata")
    if not audio_file or not metadata_str:
        return jsonify({"error": "missing audio or metadata"}), 400
    try:
        metadata = json.loads(metadata_str)
    except Exception:
        return jsonify({"error": "metadata not valid JSON"}), 400

    audio_bytes = audio_file.read()
    if not audio_bytes:
        return jsonify({"error": "empty audio"}), 400
    content_hash = hashlib.sha256(audio_bytes).hexdigest()

    conn = get_db()
    try:
        node = conn.execute(
            "SELECT id, slug, region_id, status FROM nodes WHERE token_hash = ?",
            (token_hash,)
        ).fetchone()
        if not node:
            return jsonify({"error": "unknown token"}), 403
        if node["status"] != "active":
            return jsonify({"error": "node disabled"}), 403

        region_row = conn.execute(
            "SELECT slug FROM regions WHERE id = ?", (node["region_id"],)
        ).fetchone()
        if not region_row:
            return jsonify({"error": "node has no region"}), 500

        # Dedup by (node, content_hash) — Pi can retry safely
        existing = conn.execute(
            "SELECT id FROM calls WHERE node_id = ? AND content_hash = ?",
            (node["id"], content_hash)
        ).fetchone()
        if existing:
            conn.execute("UPDATE nodes SET last_seen_at = ? WHERE id = ?",
                         (int(time.time()), node["id"]))
            conn.commit()
            return jsonify({"ok": True, "deduped": True, "call_id": existing["id"]})

        # Save audio under <region>/<node>/<YYYY-MM-DD>/<filename>
        start_time = int(metadata.get("start_time") or time.time())
        date_str = datetime.fromtimestamp(start_time, tz=timezone.utc).strftime("%Y-%m-%d")
        rel_dir = Path(region_row["slug"]) / node["slug"] / date_str
        full_dir = CALLS_DIR / rel_dir
        full_dir.mkdir(parents=True, exist_ok=True)

        tg = metadata.get("talkgroup", 0) or 0
        fname = f"{start_time}-{tg}-{content_hash[:8]}.opus"
        out_path = full_dir / fname
        out_path.write_bytes(audio_bytes)
        rel_path = str(rel_dir / fname)

        # Edge-supplied transcript (Phase 6: local-primary). The hub's
        # transcriber will only re-run Groq if transcript ends up NULL.
        edge_transcript       = metadata.get("transcript")
        edge_transcript_model = metadata.get("transcript_model")
        edge_transcript_at    = metadata.get("transcript_at")
        edge_transcript_error = metadata.get("transcript_error")

        cur = conn.execute("""
            INSERT INTO calls (
                opus_path, talkgroup, talkgroup_tag, start_time, duration_sec, speech_sec,
                status, processed_at, metadata_json,
                transcript, transcript_model, transcript_at, transcript_error,
                node_id, region_id, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            rel_path,
            metadata.get("talkgroup"),
            metadata.get("talkgroup_tag"),
            start_time,
            metadata.get("duration_sec"),
            metadata.get("speech_sec"),
            metadata.get("status") or "kept",
            int(time.time()),
            metadata.get("metadata_json") or metadata_str,
            edge_transcript,
            edge_transcript_model,
            edge_transcript_at,
            edge_transcript_error,
            node["id"],
            node["region_id"],
            content_hash,
        ))
        call_id = cur.lastrowid

        conn.execute("UPDATE nodes SET last_seen_at = ? WHERE id = ?",
                     (int(time.time()), node["id"]))
        conn.commit()

        return jsonify({
            "ok": True, "call_id": call_id, "deduped": False,
            "path": rel_path, "node": node["slug"], "region": region_row["slug"],
        })
    finally:
        conn.close()


# =============================================================================
# News-style story synthesis
#
# Cluster recently-enriched calls by (talkgroup, incident_type, 15-min bucket),
# rank, and use Claude Haiku to write a one-paragraph news brief per cluster.
# A background thread (one elected leader across all gunicorn workers via a
# file lock) refreshes every 5 minutes; the web endpoints just read the table.
# =============================================================================
STORIES_DDL = """
CREATE TABLE IF NOT EXISTS stories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_key       TEXT UNIQUE,
    title             TEXT,
    body              TEXT,
    severity          TEXT,
    talkgroup         INTEGER,
    talkgroup_tag     TEXT,
    primary_call_id   INTEGER,
    related_call_ids  TEXT,
    score             REAL,
    created_at        INTEGER,
    last_call_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stories_score   ON stories(score DESC, last_call_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at);
"""

STORY_REFRESH_INTERVAL_SEC = 300         # 5 min
STORY_LOOKBACK_HOURS       = 12
STORY_BUCKET_SEC           = 15 * 60     # 15-min cluster window
STORY_MAX_NEW_PER_PASS     = 6           # cap Claude calls per refresh
STORY_RETENTION_HOURS      = 14 * 24    # 14 days — share URLs stay alive this long
STORY_KEEP_MAX             = 16          # how many top stories to keep + serve
STORIES_LOCK_PATH          = "/tmp/jafo-stories-leader.lock"
STORY_MODEL                = "claude-haiku-4-5-20251001"

SEVERITY_WEIGHT = {"critical": 4.0, "high": 3.0, "medium": 2.0, "low": 1.0, "unknown": 0.5}
BORING_INCIDENT_TYPES = {
    "radio_chatter", "radio chatter", "Radio Chatter",
    "status_update", "Status Update",
}


def ensure_stories_table() -> None:
    conn = get_db()
    conn.executescript(STORIES_DDL)
    conn.commit()
    conn.close()


# Story-synth backend: same env vars as the enricher. Default 'ollama'.
_STORY_BACKEND = os.environ.get("JAFO_LLM_BACKEND", "ollama").strip().lower()
_STORY_MODEL_OLLAMA = os.environ.get("JAFO_LLM_MODEL", "gemma2:2b").strip()
_STORY_OLLAMA_HOST  = os.environ.get("JAFO_LLM_HOST", "http://127.0.0.1:11434").strip().rstrip("/")

_claude_client = None
def _claude():
    global _claude_client
    if _claude_client is not None:
        return _claude_client
    if not ANTHROPIC_API_KEY:
        return None
    try:
        from anthropic import Anthropic
        _claude_client = Anthropic(api_key=ANTHROPIC_API_KEY)
        return _claude_client
    except ImportError:
        return None


def _ollama_chat_json(system: str, user: str, model: str, num_predict: int = 400) -> dict | None:
    """Hit local Ollama with format='json'. Returns parsed dict or None on error."""
    import requests
    try:
        r = requests.post(
            f"{_STORY_OLLAMA_HOST}/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user},
                ],
                "format": "json",
                "stream": False,
                "options": {"temperature": 0, "num_predict": num_predict},
            },
            timeout=180,
        )
        r.raise_for_status()
        text = r.json().get("message", {}).get("content", "").strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:].strip()
        return json.loads(text)
    except Exception as e:
        print(f"ollama story synth failed: {e}", file=sys.stderr)
        return None


def _cluster_key(call: dict) -> str:
    bucket = (int(call["start_time"] or 0) // STORY_BUCKET_SEC) * STORY_BUCKET_SEC
    inc = (call.get("incident_type") or "").strip().lower() or "?"
    return f"{call['talkgroup']}-{bucket}-{inc}"


def _score_cluster(calls: list[dict]) -> float:
    sev = max(
        (SEVERITY_WEIGHT.get((c.get("incident_severity") or "unknown").lower(), 0.5) for c in calls),
        default=0.5,
    )
    count_w = math.log(len(calls) + 1)
    latest = max((c["start_time"] or 0) for c in calls)
    age_min = max(0.0, (time.time() - latest) / 60.0)
    recency = 1.0 / (1.0 + age_min / 60.0)  # half-life ~1 hour
    return sev * count_w * (0.4 + 0.6 * recency)


def _fetch_recent_enriched_calls(hours: int) -> list[dict]:
    cutoff = int(time.time()) - hours * 3600
    conn = get_db()
    cur = conn.execute("""
        SELECT id, talkgroup, talkgroup_tag, start_time, transcript,
               incident_type, incident_summary, incident_location,
               incident_units, incident_severity, opus_path
        FROM calls
        WHERE status = 'kept'
          AND audio_deleted = 0
          AND transcript IS NOT NULL
          AND incident_json IS NOT NULL
          AND start_time >= ?
          AND incident_type IS NOT NULL
        ORDER BY start_time ASC
    """, (cutoff,))
    rows = [dict(r) for r in cur if dict(r)["incident_type"] not in BORING_INCIDENT_TYPES]
    conn.close()
    return rows


# RGV-specific facts (cities, streets, hospitals, common Whisper
# transcription mishears) fed to the refiner LLM. Lazy-loaded + cached.
_RGV_CONTEXT_PATH = Path(__file__).parent / "rgv-context.txt"
_rgv_context_cache: str | None = None
def _load_rgv_context() -> str:
    global _rgv_context_cache
    if _rgv_context_cache is None:
        try:
            _rgv_context_cache = _RGV_CONTEXT_PATH.read_text(encoding="utf-8")
        except Exception as e:
            print(f"rgv-context.txt missing or unreadable: {e}", file=sys.stderr)
            _rgv_context_cache = ""
    return _rgv_context_cache


def _llm_json_call(system: str, user_msg: str, max_tokens: int = 400) -> dict | None:
    """One-shot JSON call using whichever story backend is configured.
    Centralized so the draft + refine passes share the same plumbing."""
    if _STORY_BACKEND == "anthropic":
        client = _claude()
        if not client:
            return None
        try:
            resp = client.messages.create(
                model=STORY_MODEL, max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user_msg}],
            )
            text = resp.content[0].text.strip()
            if text.startswith("```"):
                text = text.strip("`")
                if text.lower().startswith("json"):
                    text = text[4:].strip()
            return json.loads(text)
        except Exception as e:
            print(f"anthropic LLM call failed: {e}", file=sys.stderr)
            return None
    elif _STORY_BACKEND == "groq":
        from common import GROQ_API_KEY
        if not GROQ_API_KEY:
            return None
        try:
            from groq import Groq
            gclient = Groq(api_key=GROQ_API_KEY, max_retries=2)
            groq_chat_model = os.environ.get("JAFO_GROQ_CHAT_MODEL", "llama-3.1-8b-instant").strip()
            resp = gclient.chat.completions.create(
                model=groq_chat_model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user_msg},
                ],
                response_format={"type": "json_object"},
                temperature=0,
                max_tokens=max_tokens,
            )
            text = (resp.choices[0].message.content or "").strip()
            if text.startswith("```"):
                text = text.strip("`")
                if text.lower().startswith("json"):
                    text = text[4:].strip()
            return json.loads(text)
        except Exception as e:
            print(f"groq LLM call failed: {e}", file=sys.stderr)
            return None
    else:  # ollama default
        return _ollama_chat_json(system, user_msg, _STORY_MODEL_OLLAMA, num_predict=max_tokens)


def _refine_story(draft: dict, cluster: list[dict]) -> dict | None:
    """Second-pass refinement. The draft was written from raw Whisper
    transcripts, which mis-render proper nouns (street names, agencies,
    units). The refiner gets the draft + transcripts + an RGV facts
    block and is asked to correct obvious transcription errors and
    prefer vague-but-correct over specific-but-wrong.

    Returns the corrected {title, body} dict, or None on failure (caller
    falls back to the original draft)."""
    context = _load_rgv_context()
    if not context:
        return None  # no context file → skip refine, caller uses draft

    transcripts = "\n".join(
        f"[{time.strftime('%H:%M:%S', time.localtime(c['start_time']))}] {c['transcript'].strip()}"
        for c in cluster if c.get("transcript")
    ) or "(no transcripts)"

    user_msg = (
        f"RGV CONTEXT (geographic + operational facts):\n{context}\n"
        f"---\n"
        f"DRAFT STORY (written from raw transcripts; may contain errors):\n"
        f"Title: {draft.get('title', '')}\n"
        f"Body:  {draft.get('body', '')}\n"
        f"---\n"
        f"ORIGINAL TRANSCRIPTS:\n{transcripts}\n"
        f"---\n"
        f"Task: rewrite the story, correcting likely transcription errors using the\n"
        f"RGV context above. Specifically:\n"
        f"  - Replace garbled place names with their plausible RGV equivalent (e.g.\n"
        f"    'central medical oven' → 'a central medical center' or just 'a hospital').\n"
        f"  - Fix agency/unit names (e.g. 'VVICE' → 'a vice unit').\n"
        f"  - Drop or vague-up details you cannot verify against the context.\n"
        f"  - Never invent specifics that aren't in the transcripts.\n"
        f"  - Preserve any genuinely-clear facts (street names, agencies, units).\n"
        f"Output strict JSON only: {{\"title\": \"<6-10 word headline>\", "
        f"\"body\": \"<3-5 sentence paragraph>\"}}.\n"
        f"No markdown, no preamble, no commentary."
    )
    system = ("You are a copy editor for a small-market RGV news desk. You take "
              "draft briefs written from automated radio transcripts and correct "
              "the proper-noun mistakes those transcripts inevitably contain. "
              "When in doubt, choose vague-but-correct over specific-but-wrong. "
              "Output JSON only.")

    data = _llm_json_call(system, user_msg, max_tokens=400)
    if not data:
        return None
    title = (data.get("title") or "").strip()
    body  = (data.get("body")  or "").strip()
    if not title or not body:
        return None
    return {"title": title, "body": body}


def _synthesize_story(cluster: list[dict]) -> dict | None:
    """Write a one-paragraph news brief for a cluster of related calls.

    Two-pass:
      1. Draft from raw transcripts (existing prompt).
      2. Refine against RGV context to correct transcription errors.

    Backend selected by JAFO_LLM_BACKEND env var:
      ollama (default) — local Gemma 2B, $0
      anthropic — Claude Haiku, paid (premium quality)
      groq — Llama via Groq (paid, fast)
    Returns {"title", "body"} or None on failure.
    """
    primary = cluster[-1]  # most recent in cluster (calls are ASC)
    transcripts = "\n".join(
        f"[{time.strftime('%H:%M:%S', time.localtime(c['start_time']))}] {c['transcript'].strip()}"
        for c in cluster if c.get("transcript")
    ) or "(no transcripts)"

    units = sorted({u.strip() for c in cluster for u in (c.get("incident_units") or "").split(",") if u.strip()})

    user_msg = (
        f"Region: {REGION}\n"
        f"Talkgroup: {primary.get('talkgroup_tag') or primary.get('talkgroup')}\n"
        f"Incident type: {primary.get('incident_type')}\n"
        f"Severity: {primary.get('incident_severity') or 'unknown'}\n"
        f"Location (if known): {primary.get('incident_location') or 'unknown'}\n"
        f"Units involved: {', '.join(units) if units else 'unknown'}\n"
        f"Calls in cluster: {len(cluster)}\n"
        f"---\n"
        f"Transcripts (chronological):\n{transcripts}\n"
        f"---\n"
        f"Write ONE local-news brief about this cluster.\n"
        f"Output strict JSON only: {{\"title\": \"<6-10 word headline>\", \"body\": \"<3-5 sentence paragraph>\"}}.\n"
        f"Be factual; do not speculate beyond the transcripts. No markdown, no preamble."
    )
    system = ("You write tight, factual local-news briefs from public-safety radio "
              "transcripts. Output JSON only with 'title' and 'body' keys.")

    data = _llm_json_call(system, user_msg, max_tokens=400)
    if not data:
        return None
    draft = {
        "title": (data.get("title") or "").strip(),
        "body":  (data.get("body")  or "").strip(),
    }
    if not draft["title"] or not draft["body"]:
        return None

    # Second pass: refine against RGV context to correct transcription
    # errors and ground in real geography/agencies. Falls back to draft
    # on failure (e.g. context missing, LLM error) so we still ship
    # something rather than nothing.
    refined = _refine_story(draft, cluster)
    return refined or draft


def _refresh_stories_once() -> tuple[int, int]:
    """One pass. Returns (new_stories, skipped)."""
    calls = _fetch_recent_enriched_calls(STORY_LOOKBACK_HOURS)
    if not calls:
        return (0, 0)

    clusters: dict[str, list[dict]] = {}
    for c in calls:
        clusters.setdefault(_cluster_key(c), []).append(c)

    # Score and rank
    ranked = sorted(
        ((k, lst, _score_cluster(lst)) for k, lst in clusters.items()),
        key=lambda x: -x[2],
    )

    # Find which cluster_keys are already in stories table
    conn = get_db()
    existing_keys = {r["cluster_key"] for r in conn.execute("SELECT cluster_key FROM stories")}

    # Prune old stories beyond retention
    cutoff_old = int(time.time()) - STORY_RETENTION_HOURS * 3600
    conn.execute("DELETE FROM stories WHERE last_call_at < ?", (cutoff_old,))
    conn.commit()

    new_count = 0
    skipped = 0
    for key, lst, score in ranked:
        if new_count >= STORY_MAX_NEW_PER_PASS:
            break
        if key in existing_keys:
            skipped += 1
            continue

        primary = max(lst, key=lambda c: c["start_time"])
        synthesized = _synthesize_story(lst)
        if not synthesized:
            continue

        related_ids = [c["id"] for c in lst]
        try:
            conn.execute("""
                INSERT OR IGNORE INTO stories
                  (cluster_key, title, body, severity, talkgroup, talkgroup_tag,
                   primary_call_id, related_call_ids, score, created_at, last_call_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                key, synthesized["title"], synthesized["body"],
                (primary.get("incident_severity") or "unknown").lower(),
                primary.get("talkgroup"), primary.get("talkgroup_tag"),
                primary["id"], json.dumps(related_ids),
                score, int(time.time()), primary["start_time"],
            ))
            conn.commit()
            new_count += 1
        except sqlite3.Error as e:
            print(f"story insert failed: {e}", file=sys.stderr)

    # Trim to top STORY_KEEP_MAX
    conn.execute(f"""
        DELETE FROM stories
        WHERE id NOT IN (
            SELECT id FROM stories ORDER BY score DESC, last_call_at DESC LIMIT {STORY_KEEP_MAX}
        )
    """)
    conn.commit()
    conn.close()
    return (new_count, skipped)


def _stories_leader_loop():
    """Run only in the worker that holds the leader lock."""
    try:
        f = open(STORIES_LOCK_PATH, "w")
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError):
        return  # another worker is leader

    print("[stories] elected leader, starting refresh loop", file=sys.stderr)
    # First pass right away
    while True:
        try:
            new, skipped = _refresh_stories_once()
            if new or skipped:
                print(f"[stories] refresh: {new} new, {skipped} already cached",
                      file=sys.stderr)
        except Exception as e:
            print(f"[stories] refresh failed: {e}", file=sys.stderr)
        time.sleep(STORY_REFRESH_INTERVAL_SEC)


def _start_stories_thread():
    ensure_stories_table()
    t = threading.Thread(target=_stories_leader_loop, daemon=True, name="stories-leader")
    t.start()


_STORIES_PROXY_CACHE: dict = {"at": 0, "data": None}
_STORIES_PROXY_TTL_SEC = 30


def _proxy_stories_from_hub():
    """Edge-only: fetch the hub's stories list, cache 30s. The hub runs the
    real enricher (Groq) and stories synthesizer; the edge has at most a weak
    Ollama enrichment that classifies everything as 'Radio Chatter'."""
    now = int(time.time())
    cache = _STORIES_PROXY_CACHE
    if cache["data"] is not None and (now - cache["at"]) < _STORIES_PROXY_TTL_SEC:
        return cache["data"]

    hub_url = os.environ.get("JAFO_HUB_URL", "").strip().rstrip("/")
    if not hub_url:
        return None
    try:
        import requests as _r
        resp = _r.get(f"{hub_url}/api/stories", timeout=8)
        if resp.status_code != 200:
            return cache["data"]  # serve last-known on hub error
        data = resp.json()
    except Exception as e:
        print(f"[stories-proxy] hub fetch failed: {e}", file=sys.stderr)
        return cache["data"]
    cache["at"] = now
    cache["data"] = data
    return data


STORY_MAX_AGE_SEC = 12 * 3600  # only surface stories with activity in last 12h


@app.route("/api/stories")
def stories_list():
    """Top stories from the last 12 hours, ordered by score desc."""
    cutoff = int(time.time()) - STORY_MAX_AGE_SEC

    if _is_edge_node():
        data = _proxy_stories_from_hub()
        if data is not None:
            data["stories"] = [
                s for s in (data.get("stories") or [])
                if (s.get("last_call_at") or 0) >= cutoff
            ]
            return jsonify(data)
        # Hub unreachable — return empty list rather than serving stale May-3
        # rows from the local stories table.
        return jsonify({"stories": [], "now": int(time.time())})

    conn = get_db()
    cur = conn.execute(f"""
        SELECT id, title, body, severity, talkgroup, talkgroup_tag,
               primary_call_id, related_call_ids, score, last_call_at, created_at
        FROM stories
        WHERE last_call_at >= ?
        ORDER BY score DESC, last_call_at DESC
        LIMIT {STORY_KEEP_MAX}
    """, (cutoff,))
    out = []
    for r in cur:
        d = dict(r)
        try:
            d["related_call_ids"] = json.loads(d.get("related_call_ids") or "[]")
        except json.JSONDecodeError:
            d["related_call_ids"] = []
        out.append(d)

    # Aggregate cluster metadata (first/last time, units, address) per story
    # so the dashboard can show "First reported: HH:MM · Units: 12, 34 ·
    # Location: ..." without N extra round-trips. One SELECT per story is
    # cheap — even a busy hub has at most STORY_KEEP_MAX (16) stories.
    for d in out:
        ids = d["related_call_ids"]
        if not ids:
            d["meta"] = None
            continue
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(
            f"""SELECT start_time, duration_sec, incident_location, incident_units
                FROM calls WHERE id IN ({placeholders})
                ORDER BY start_time ASC""",
            ids,
        )
        rows = [dict(r) for r in cur]
        if not rows:
            d["meta"] = None
            continue
        first = rows[0]
        last  = rows[-1]
        last_end = (last.get("start_time") or 0) + (last.get("duration_sec") or 0)
        dur_sec = max(0, last_end - (first.get("start_time") or 0))
        unit_set: set[str] = set()
        for c in rows:
            for u in (c.get("incident_units") or "").split(","):
                u = u.strip()
                if u:
                    unit_set.add(u)
        # Address: pick the longest non-empty location across the cluster
        # (rough proxy for "most specific" — short tags like "scene" lose
        # to full street strings).
        locs = [(c.get("incident_location") or "").strip() for c in rows]
        locs = [x for x in locs if x]
        address = max(locs, key=len) if locs else ""
        d["meta"] = {
            "first_time":  first.get("start_time"),
            "last_time":   last.get("start_time"),
            "duration_sec": int(dur_sec),
            "call_count":  len(rows),
            "units":       sorted(unit_set),
            "address":     address,
        }
    conn.close()
    return jsonify({"stories": out, "now": int(time.time())})


@app.route("/api/stories/<int:story_id>")
def story_detail(story_id: int):
    """Full story + audio info for the related calls."""
    if _is_edge_node():
        hub_url = os.environ.get("JAFO_HUB_URL", "").strip().rstrip("/")
        if not hub_url:
            abort(503)
        try:
            import requests as _r
            resp = _r.get(f"{hub_url}/api/stories/{story_id}", timeout=8)
        except Exception as e:
            print(f"[stories-proxy] hub detail fetch failed: {e}", file=sys.stderr)
            abort(502)
        if resp.status_code != 200:
            return resp.text, resp.status_code, {"Content-Type": resp.headers.get("Content-Type", "application/json")}
        data = resp.json()
        # Audio lives on the hub (different filesystem than this Pi). Add an
        # absolute audio_url so the browser plays directly from jafo.live and
        # we don't have to mirror /audio/ on the edge.
        for c in data.get("calls") or []:
            if c.get("opus_path") and c.get("audio_available"):
                c["audio_url"] = f"{hub_url}/audio/{c['opus_path']}"
        return jsonify(data)

    conn = get_db()
    s = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
    if not s:
        conn.close()
        abort(404)
    s = dict(s)
    try:
        ids = json.loads(s.get("related_call_ids") or "[]")
    except json.JSONDecodeError:
        ids = []

    audio = []
    if ids:
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(
            f"""SELECT id, start_time, duration_sec, opus_path, audio_deleted,
                       talkgroup_tag, transcript, incident_summary,
                       incident_location, incident_units, incident_severity,
                       incident_type, enriched_at
                FROM calls WHERE id IN ({placeholders})
                ORDER BY start_time ASC""",
            ids,
        )
        for r in cur:
            d = dict(r)
            d["audio_available"] = bool(d["opus_path"]) and not d["audio_deleted"]
            audio.append(d)
    conn.close()
    s["calls"] = audio
    return jsonify(s)


# =============================================================================
# Social-share generation
# Generates a 1080x1080 card PNG (logo + agency + blurb) and an mp4 (card + audio).
# Caches under ~/jafo-data/share-cache/. Each piece is regenerated only if the
# source data has changed (cheap mtime check).
# =============================================================================
SHARE_CACHE_DIR = DATA_DIR / "share-cache"
SHARE_CACHE_TTL_SEC = 14 * 24 * 3600   # 14 days — match story DB retention
_SHARE_SWEEP_STATE = {"last": 0.0}
LOGO_PATH = Path(__file__).parent / "static" / "logo.png"
FONT_REG  = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def _sweep_share_cache() -> None:
    """Lazy GC: every hour at most, delete files in share-cache/ older than 14d."""
    now = time.time()
    if now - _SHARE_SWEEP_STATE["last"] < 3600:
        return
    _SHARE_SWEEP_STATE["last"] = now
    if not SHARE_CACHE_DIR.exists():
        return
    cutoff = now - SHARE_CACHE_TTL_SEC
    removed = 0
    for p in SHARE_CACHE_DIR.rglob("*"):
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            pass
    if removed:
        print(f"[share-cache] swept {removed} files older than 14 days", file=sys.stderr)

# Per-platform aspect ratios. Same content, three layouts.
SHARE_FORMATS = {
    "square":    {"w": 1080, "h": 1080},  # IG feed, FB feed
    "story":     {"w": 1080, "h": 1920},  # IG/FB story, Reels (9:16)
    "landscape": {"w": 1200, "h": 675},   # Twitter/X, FB link card (16:9)
}


def _wrap_text(draw, text: str, font, max_w: int) -> list[str]:
    """Naive word-wrap for Pillow."""
    words = (text or "").split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_card(out_path: Path, *, fmt: str, agency: str, city: str, service: str,
                blurb: str, severity: str, ts_str: str, icon_emoji: str = "") -> None:
    """Compose the social share card PNG. fmt is one of SHARE_FORMATS keys."""
    from PIL import Image, ImageDraw, ImageFont

    spec = SHARE_FORMATS.get(fmt, SHARE_FORMATS["square"])
    W, H = spec["w"], spec["h"]
    SHARE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    img = Image.new("RGB", (W, H), (13, 17, 23))
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, W, 6), fill=(88, 166, 255))  # accent top stripe

    sev = (severity or "unknown").lower()
    sev_colors = {
        "critical": (255, 107, 107), "high": (248, 81, 73),
        "medium":   (210, 153,  34), "low":  ( 63, 185, 80),
        "unknown":  (110, 118, 129),
    }
    sev_rgb = sev_colors.get(sev, sev_colors["unknown"])
    domain = "jafo.local"

    # Layout scales relative to the smaller dimension so things look right
    # in all three aspect ratios.
    if fmt == "story":
        # 1080x1920 portrait — Instagram Story / Reels
        margin = 70
        logo_h = 240
        f_brand   = ImageFont.truetype(FONT_BOLD, 80)
        f_node    = ImageFont.truetype(FONT_REG, 30)
        f_agency  = ImageFont.truetype(FONT_BOLD, 90)
        f_meta    = ImageFont.truetype(FONT_REG, 42)
        f_blurb   = ImageFont.truetype(FONT_REG, 52)
        f_foot    = ImageFont.truetype(FONT_BOLD, 34)
        f_foot_r  = ImageFont.truetype(FONT_REG, 28)
        f_emoji   = ImageFont.truetype(FONT_BOLD, 96)
        agency_y  = 700
        blurb_max_lines = 9
    elif fmt == "landscape":
        # 1200x675 — Twitter card / FB link
        margin = 50
        logo_h = 130
        f_brand   = ImageFont.truetype(FONT_BOLD, 42)
        f_node    = ImageFont.truetype(FONT_REG, 18)
        f_agency  = ImageFont.truetype(FONT_BOLD, 44)
        f_meta    = ImageFont.truetype(FONT_REG, 22)
        f_blurb   = ImageFont.truetype(FONT_REG, 26)
        f_foot    = ImageFont.truetype(FONT_BOLD, 20)
        f_foot_r  = ImageFont.truetype(FONT_REG, 17)
        f_emoji   = ImageFont.truetype(FONT_BOLD, 56)
        agency_y  = 200
        blurb_max_lines = 4
    else:
        # 1080x1080 square — IG/FB feed (default)
        margin = 60
        logo_h = 220
        f_brand   = ImageFont.truetype(FONT_BOLD, 56)
        f_node    = ImageFont.truetype(FONT_REG, 22)
        f_agency  = ImageFont.truetype(FONT_BOLD, 56)
        f_meta    = ImageFont.truetype(FONT_REG, 30)
        f_blurb   = ImageFont.truetype(FONT_REG, 36)
        f_foot    = ImageFont.truetype(FONT_BOLD, 26)
        f_foot_r  = ImageFont.truetype(FONT_REG, 22)
        f_emoji   = ImageFont.truetype(FONT_BOLD, 72)
        agency_y  = 360
        blurb_max_lines = 6

    # Logo top-left (with halo via dark background) — Pillow's pure-PIL alpha
    # composite is fine because the source PNG already has transparency.
    if LOGO_PATH.exists():
        logo = Image.open(LOGO_PATH).convert("RGBA")
        ratio = logo_h / logo.height
        logo = logo.resize((int(logo.width * ratio), logo_h), Image.LANCZOS)
        img.paste(logo, (margin, margin - 10), logo)

    # JAFO branding top-right
    txt = "JAFO"
    bw = draw.textlength(txt, font=f_brand)
    draw.text((W - margin - bw, margin + 12), txt, font=f_brand, fill=(230, 237, 243))
    sub_y = margin + int(f_brand.size * 1.1) + 6
    sub = NODE_NAME
    sw = draw.textlength(sub, font=f_node)
    draw.text((W - margin - sw, sub_y), sub, font=f_node, fill=(139, 148, 158))

    # Agency block
    y = agency_y
    if icon_emoji:
        try:
            draw.text((margin, y - 6), icon_emoji, font=f_emoji, fill=(230, 237, 243))
        except Exception:
            pass
        x_text = margin + int(f_emoji.size * 1.3)
    else:
        x_text = margin

    agency_lines = _wrap_text(draw, agency or "(unknown agency)", f_agency, W - x_text - margin)
    for line in agency_lines[:2]:
        draw.text((x_text, y), line, font=f_agency, fill=(230, 237, 243))
        y += int(f_agency.size * 1.25)
    y += 4

    meta_bits = [b for b in (city, service) if b]
    if meta_bits:
        draw.text((x_text, y), "  ·  ".join(meta_bits), font=f_meta, fill=(139, 148, 158))
        y += int(f_meta.size * 2.0)
    else:
        y += int(f_meta.size * 1.0)

    # Blurb
    blurb_lines = _wrap_text(draw, blurb or "", f_blurb, W - 2 * margin)
    for line in blurb_lines[:blurb_max_lines]:
        draw.text((margin, y), line, font=f_blurb, fill=(220, 230, 245))
        y += int(f_blurb.size * 1.35)

    # Footer
    fy = H - margin - int(f_foot.size * 2.2)
    draw.ellipse((margin, fy + 4, margin + 24, fy + 28), fill=sev_rgb)
    draw.text((margin + 36, fy), sev.upper(), font=f_foot, fill=(230, 237, 243))
    draw.text((margin + 36, fy + int(f_foot.size * 1.4)), ts_str, font=f_foot_r, fill=(139, 148, 158))
    dw = draw.textlength(domain, font=f_foot_r)
    draw.text((W - margin - dw, fy + int(f_foot.size * 1.4)), domain, font=f_foot_r, fill=(110, 118, 129))

    img.save(out_path, "PNG", optimize=True)


def make_video(card_png: Path, audio_files: list[Path], out_mp4: Path) -> None:
    """Combine the card image + audio (one or many opus files) into a square mp4."""
    import subprocess
    import tempfile
    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    if len(audio_files) == 1:
        audio_input_args = ["-i", str(audio_files[0])]
        filter_complex = []
    else:
        # Concat multiple audio files via ffconcat list
        list_path = SHARE_CACHE_DIR / f".concat-{out_mp4.stem}.txt"
        with open(list_path, "w") as f:
            f.write("ffconcat version 1.0\n")
            for a in audio_files:
                f.write(f"file '{a}'\n")
        audio_input_args = ["-f", "concat", "-safe", "0", "-i", str(list_path)]
        filter_complex = []

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-loop", "1", "-framerate", "1",
        "-i", str(card_png),
        *audio_input_args,
        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-shortest", "-movflags", "+faststart",
        str(out_mp4),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _emoji_for_call(call_dict: dict) -> str:
    """Server-side mirror of the JS serviceCategory → emoji table."""
    emoji_by_id = {
        "police": "🚔", "fire": "🚒", "ems": "🚑", "school": "🏫",
        "utility": "🔧", "water": "💧", "power": "⚡", "transit": "🚌",
        "government": "🏛", "dispatch": "📞", "traffic": "🚧", "hazmat": "☢",
        "rescue": "🛟", "air": "🚁", "aviation": "✈", "marine": "⚓",
        "hospital": "🏥", "construction": "🏗", "k9": "🐕", "park": "🌲",
        "emergency": "⚠", "weather": "🌪", "radio": "📡",
    }
    icon = (call_dict.get("icon") or "").strip()
    if icon in emoji_by_id:
        return emoji_by_id[icon]
    csv = (call_dict.get("service_type") or "").lower()
    alpha = (call_dict.get("talkgroup_tag") or "").lower()
    import re
    if re.search(r"law|corrections|police", csv) or re.search(r"\bpd\b|police|sheriff|constable", alpha): return "🚔"
    if re.search(r"fire", csv) or re.search(r"\bfire\b|\bfd\b", alpha): return "🚒"
    if re.search(r"ems|medical", csv) or re.search(r"\bems\b|medic|ambulance", alpha): return "🚑"
    if re.search(r"school", csv) or re.search(r"\bisd\b|school", alpha): return "🏫"
    if re.search(r"transit", csv) or re.search(r"\btransit\b|valley.?metro", alpha): return "🚌"
    return ""


def _share_paths(kind: str, id_: int, fmt: str) -> tuple[Path, Path, Path]:
    base = SHARE_CACHE_DIR / kind
    return (
        base / f"{id_}-{fmt}.png",
        base / f"{id_}-{fmt}.mp4",
        base / f"{id_}.mp3",  # audio is format-agnostic
    )


def _make_audio_mp3(opus_files: list[Path], out_mp3: Path) -> None:
    """Concatenate one-or-more opus calls into a single MP3 for share download."""
    import subprocess
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    if len(opus_files) == 1:
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-i", str(opus_files[0]),
               "-c:a", "libmp3lame", "-b:a", "128k",
               str(out_mp3)]
    else:
        list_path = SHARE_CACHE_DIR / f".audio-concat-{out_mp3.stem}.txt"
        with open(list_path, "w") as f:
            f.write("ffconcat version 1.0\n")
            for a in opus_files:
                f.write(f"file '{a}'\n")
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-f", "concat", "-safe", "0", "-i", str(list_path),
               "-c:a", "libmp3lame", "-b:a", "128k",
               str(out_mp3)]
    subprocess.run(cmd, check=True, capture_output=True)


def _build_call_share(call_id: int, fmt: str = "square") -> tuple[Path, Path | None, Path | None] | None:
    if fmt not in SHARE_FORMATS:
        fmt = "square"
    conn = get_db()
    row = conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
    conn.close()
    if not row:
        return None
    cd = call_row_to_dict(row, load_talkgroup_metadata(), load_overrides())

    card_png, video_mp4, audio_mp3 = _share_paths("calls", call_id, fmt)
    blurb = cd.get("incident_summary") or cd.get("transcript") or "(no summary available)"
    if len(blurb) > 360:
        blurb = blurb[:357].rstrip() + "…"
    ts_str = time.strftime("%b %d, %Y · %I:%M %p", time.localtime(cd["start_time"] or time.time()))

    render_card(
        card_png, fmt=fmt,
        agency=cd.get("talkgroup_tag") or f"tg-{cd.get('talkgroup')}",
        city=cd.get("city") or "",
        service=cd.get("service_type") or "",
        blurb=blurb,
        severity=cd.get("incident_severity") or "unknown",
        ts_str=ts_str,
        icon_emoji=_emoji_for_call(cd),
    )

    if cd.get("audio_available") and cd.get("opus_path"):
        audio = CALLS_DIR / cd["opus_path"]
        if audio.exists():
            if not video_mp4.exists() or video_mp4.stat().st_mtime < card_png.stat().st_mtime:
                try:
                    make_video(card_png, [audio], video_mp4)
                except Exception as e:
                    print(f"[share] video gen failed for call {call_id} ({fmt}): {e}", file=sys.stderr)
            if not audio_mp3.exists() or audio_mp3.stat().st_mtime < audio.stat().st_mtime:
                try:
                    _make_audio_mp3([audio], audio_mp3)
                except Exception as e:
                    print(f"[share] mp3 gen failed for call {call_id}: {e}", file=sys.stderr)

    return (
        card_png,
        video_mp4 if video_mp4.exists() else None,
        audio_mp3 if audio_mp3.exists() else None,
    )


def _build_story_share(story_id: int, fmt: str = "square") -> tuple[Path, Path | None, Path | None] | None:
    if fmt not in SHARE_FORMATS:
        fmt = "square"
    conn = get_db()
    s = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
    if not s:
        conn.close()
        return None
    s = dict(s)
    try:
        ids = json.loads(s.get("related_call_ids") or "[]")
    except json.JSONDecodeError:
        ids = []

    audios: list[Path] = []
    cd_for_meta = None
    if ids:
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(
            f"SELECT * FROM calls WHERE id IN ({placeholders}) ORDER BY start_time ASC",
            ids,
        )
        rows = list(cur)
        if rows:
            cd_for_meta = call_row_to_dict(rows[0], load_talkgroup_metadata(), load_overrides())
        for r in rows:
            d = dict(r)
            if d.get("opus_path") and not d.get("audio_deleted"):
                ap = CALLS_DIR / d["opus_path"]
                if ap.exists():
                    audios.append(ap)
    conn.close()

    card_png, video_mp4, audio_mp3 = _share_paths("stories", story_id, fmt)
    ts_str = time.strftime("%b %d, %Y · %I:%M %p", time.localtime(s.get("last_call_at") or s.get("created_at") or time.time()))
    render_card(
        card_png, fmt=fmt,
        agency=s.get("title") or "(untitled)",
        city=(cd_for_meta or {}).get("city") or "",
        service=(cd_for_meta or {}).get("service_type") or "",
        blurb=s.get("body") or "",
        severity=s.get("severity") or "unknown",
        ts_str=ts_str,
        icon_emoji=_emoji_for_call(cd_for_meta or {}),
    )
    if audios:
        if not video_mp4.exists() or video_mp4.stat().st_mtime < card_png.stat().st_mtime:
            try:
                make_video(card_png, audios, video_mp4)
            except Exception as e:
                print(f"[share] video gen failed for story {story_id} ({fmt}): {e}", file=sys.stderr)
        if not audio_mp3.exists():
            try:
                _make_audio_mp3(audios, audio_mp3)
            except Exception as e:
                print(f"[share] mp3 gen failed for story {story_id}: {e}", file=sys.stderr)

    return (
        card_png,
        video_mp4 if video_mp4.exists() else None,
        audio_mp3 if audio_mp3.exists() else None,
    )


def _fmt_arg() -> str:
    f = (request.args.get("format") or "square").lower()
    return f if f in SHARE_FORMATS else "square"


@app.route("/api/share/call/<int:call_id>/card.png")
def share_call_card(call_id: int):
    res = _build_call_share(call_id, _fmt_arg())
    if not res: abort(404)
    card, _, _ = res
    return send_file(card, mimetype="image/png")


@app.route("/api/share/call/<int:call_id>/video.mp4")
def share_call_video(call_id: int):
    fmt = _fmt_arg()
    res = _build_call_share(call_id, fmt)
    if not res: abort(404)
    _, video, _ = res
    if not video: abort(404, description="audio not available for this call")
    return send_file(video, mimetype="video/mp4", as_attachment=True,
                     download_name=f"jafo-call-{call_id}-{fmt}.mp4")


@app.route("/api/share/call/<int:call_id>/audio.mp3")
def share_call_audio(call_id: int):
    res = _build_call_share(call_id)
    if not res: abort(404)
    _, _, audio = res
    if not audio: abort(404, description="audio not available for this call")
    return send_file(audio, mimetype="audio/mpeg", as_attachment=True,
                     download_name=f"jafo-call-{call_id}.mp3")


@app.route("/api/share/story/<int:story_id>/card.png")
def share_story_card(story_id: int):
    _sweep_share_cache()
    res = _build_story_share(story_id, _fmt_arg())
    if not res: abort(404)
    card, _, _ = res
    return send_file(card, mimetype="image/png")


@app.route("/api/share/story/<int:story_id>/video.mp4")
def share_story_video(story_id: int):
    fmt = _fmt_arg()
    res = _build_story_share(story_id, fmt)
    if not res: abort(404)
    _, video, _ = res
    if not video: abort(404, description="audio not available for this story")
    return send_file(video, mimetype="video/mp4", as_attachment=True,
                     download_name=f"jafo-story-{story_id}-{fmt}.mp4")


@app.route("/api/share/story/<int:story_id>/audio.mp3")
def share_story_audio(story_id: int):
    res = _build_story_share(story_id)
    if not res: abort(404)
    _, _, audio = res
    if not audio: abort(404, description="audio not available for this story")
    return send_file(audio, mimetype="audio/mpeg", as_attachment=True,
                     download_name=f"jafo-story-{story_id}.mp3")


@app.route("/share/call/<int:call_id>")
def share_call_page(call_id: int):
    """OpenGraph-tagged page for Facebook share-dialog scraping."""
    conn = get_db()
    row = conn.execute("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
    conn.close()
    if not row: abort(404)
    cd = call_row_to_dict(row, load_talkgroup_metadata(), load_overrides())
    title = cd.get("talkgroup_tag") or f"Call #{call_id}"
    description = (cd.get("incident_summary") or cd.get("transcript") or "")[:200]
    return render_template(
        "share.html",
        kind="call", id=call_id,
        title=title, description=description,
        node_name=NODE_NAME,
    )


@app.route("/share/story/<int:story_id>")
def share_story_page(story_id: int):
    # Edge nodes don't own the stories table — redirect viewers to the hub
    # so the shared URL resolves correctly and Open Graph scrapers see real
    # data (jafo.live, not jafo.local).
    if _is_edge_node():
        hub_url = os.environ.get("JAFO_HUB_URL", "https://jafo.live").rstrip("/")
        return redirect(f"{hub_url}/share/story/{story_id}", code=302)

    conn = get_db()
    row = conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone()
    if not row:
        conn.close()
        abort(404)
    s = dict(row)

    try:
        ids = json.loads(s.get("related_call_ids") or "[]")
    except json.JSONDecodeError:
        ids = []

    calls = []
    if ids:
        placeholders = ",".join("?" * len(ids))
        cur = conn.execute(
            f"""SELECT id, start_time, duration_sec, opus_path, audio_deleted,
                       talkgroup_tag, transcript, incident_units
                FROM calls WHERE id IN ({placeholders})
                ORDER BY start_time ASC""",
            ids,
        )
        for r in cur:
            d = dict(r)
            if d.get("opus_path") and not d.get("audio_deleted"):
                d["audio_url"] = f"/audio/{d['opus_path']}"
            else:
                d["audio_url"] = None
            d["start_time_str"] = time.strftime("%H:%M", time.localtime(d["start_time"])) if d.get("start_time") else ""
            d["duration_sec"] = int(d.get("duration_sec") or 0) or None
            calls.append(d)
    conn.close()

    first_time_str = ""
    if calls:
        first_time_str = time.strftime("%b %-d, %-I:%M %p", time.localtime(calls[0]["start_time"]))

    # Best-effort canonical URL: prefer X-Forwarded-Host (nginx), else Host header.
    share_url = request.headers.get("X-Forwarded-Host") or request.host
    scheme = request.headers.get("X-Forwarded-Proto") or ("https" if request.is_secure else "http")
    share_url = f"{scheme}://{share_url}"

    return render_template(
        "share.html",
        kind="story", id=story_id,
        title=s.get("title") or f"Story #{story_id}",
        description=s.get("body") or "",
        severity=s.get("severity") or "unknown",
        talkgroup_tag=s.get("talkgroup_tag") or "",
        first_time_str=first_time_str,
        calls=calls,
        node_name=NODE_NAME,
        share_url=share_url,
    )


# =============================================================================
# Geocoding + heatmap
#
# We geocode the `incident_location` text Claude already extracts (e.g.
# "FM 1015 and Mile 7", "2861 SWAT Drive"), cache results forever, and serve a
# heatmap layer that points at real addresses where we have them and falls
# back to talkgroup-derived city centroids otherwise. Calls that have neither
# (would otherwise dump on the RGV centroid) are skipped — the heatmap should
# only show real places.
# =============================================================================
GEOCODE_DDL = """
CREATE TABLE IF NOT EXISTS geocoded_locations (
    location_text TEXT PRIMARY KEY,
    lat           REAL,
    lng           REAL,
    source        TEXT,
    error         TEXT,
    created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_geocode_loc ON geocoded_locations(location_text);
"""

NOMINATIM_HEADERS = {"User-Agent": "jafo/1.0 (RGV public-safety observatory; +https://github.com/Drew-CodeRGV/jafo)"}
NOMINATIM_LAST_REQ_T = 0.0
NOMINATIM_LOCK = threading.Lock()

# Strings that look like addresses but Claude flagged with "unknown" — skip them
GEOCODE_BAD_TEXTS = {"unknown", "n/a", "na", "?", "none", "null", ""}


def ensure_geocode_table() -> None:
    conn = get_db()
    conn.executescript(GEOCODE_DDL)
    conn.commit()
    conn.close()


def _geocode_one(text: str) -> tuple[float, float] | None:
    """Single Nominatim lookup, RGV-bounded, rate-limited to 1 req/sec."""
    global NOMINATIM_LAST_REQ_T
    if not text or text.strip().lower() in GEOCODE_BAD_TEXTS:
        return None
    if len(text) < 4 or len(text) > 200:
        return None

    # West, South, East, North — covers the RGV plus a buffer
    viewbox = "-99.20,25.70,-97.00,26.70"
    region_hint = REGION or "Texas"
    query = text if region_hint.lower() in text.lower() else f"{text}, {region_hint}"

    with NOMINATIM_LOCK:
        now = time.time()
        wait = 1.05 - (now - NOMINATIM_LAST_REQ_T)
        if wait > 0:
            time.sleep(wait)
        NOMINATIM_LAST_REQ_T = time.time()

    try:
        import requests
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": query, "format": "json", "limit": 1,
                "viewbox": viewbox, "bounded": 1,
            },
            headers=NOMINATIM_HEADERS,
            timeout=8,
        )
        r.raise_for_status()
        results = r.json() or []
        if results:
            return float(results[0]["lat"]), float(results[0]["lon"])
    except Exception as e:
        print(f"[geocode] {text!r} failed: {e}", file=sys.stderr)
    return None


def geocode_pending(max_count: int = 8) -> int:
    """Geocode up to N un-cached recent locations. Returns count processed."""
    conn = get_db()
    cur = conn.execute("""
        SELECT DISTINCT incident_location AS loc
        FROM calls
        WHERE incident_location IS NOT NULL
          AND TRIM(incident_location) != ''
          AND processed_at > strftime('%s', 'now', '-2 day')
          AND incident_location NOT IN (SELECT location_text FROM geocoded_locations)
        LIMIT ?
    """, (max_count,))
    pending = [r["loc"] for r in cur]
    conn.close()

    if not pending:
        return 0

    for loc in pending:
        coords = _geocode_one(loc)
        conn = get_db()
        if coords:
            conn.execute("""
                INSERT OR REPLACE INTO geocoded_locations
                  (location_text, lat, lng, source, created_at)
                VALUES (?, ?, ?, ?, ?)
            """, (loc, coords[0], coords[1], "nominatim", int(time.time())))
        else:
            conn.execute("""
                INSERT OR REPLACE INTO geocoded_locations
                  (location_text, error, created_at)
                VALUES (?, ?, ?)
            """, (loc, "no_match", int(time.time())))
        conn.commit()
        conn.close()
    return len(pending)


def _heatmap_loop():
    """Background geocoding — called by the existing stories leader thread."""
    while True:
        try:
            geocode_pending(max_count=8)
        except Exception as e:
            print(f"[geocode] loop error: {e}", file=sys.stderr)
        time.sleep(180)  # every 3 min


def _start_heatmap_thread():
    ensure_geocode_table()
    t = threading.Thread(target=_heatmap_loop, daemon=True, name="geocode-loop")
    t.start()


@app.route("/api/heatmap")
def heatmap_points():
    """Aggregated points for the heatmap layer. Skips unknowns.

    Query params:
      hours       (default 24, max 168) — coarse window in hours
      window_sec  (optional) — fine-grained window in seconds. Overrides
                   `hours` and switches to start_time-based filtering for
                   the live decay heatmap.
    """
    window_sec = request.args.get("window_sec", type=int)
    if window_sec is not None:
        window_sec = max(10, min(window_sec, 86400))
        cutoff_st = int(time.time()) - window_sec
        time_filter_sql = "start_time > ?"
        time_filter_arg = cutoff_st
    else:
        hours = max(1, min(int(request.args.get("hours", default=24)), 168))
        cutoff_pr = int(time.time()) - hours * 3600
        time_filter_sql = "processed_at > ?"
        time_filter_arg = cutoff_pr

    conn = get_db()
    cur = conn.execute(f"""
        SELECT id, talkgroup, incident_location, start_time
        FROM calls
        WHERE status = 'kept' AND {time_filter_sql}
    """, (time_filter_arg,))
    calls = [dict(r) for r in cur]

    cur = conn.execute("""
        SELECT location_text, lat, lng FROM geocoded_locations
        WHERE lat IS NOT NULL AND lng IS NOT NULL
    """)
    geocoded = {r["location_text"]: (r["lat"], r["lng"]) for r in cur}
    conn.close()

    overrides = load_overrides()
    csv_meta = load_talkgroup_metadata()

    # When window_sec mode is active, include start_time so the client can do
    # time-decay weighting (fade-out over a few seconds). When in coarse
    # `hours` mode, the 4th element is 0 and the client treats all weights
    # as static.
    decay_mode = window_sec is not None
    points: list[list[float]] = []
    address_hits = 0
    city_hits = 0
    for c in calls:
        st = c.get("start_time") or 0
        # Prefer a geocoded street/address — most precise
        loc_text = (c.get("incident_location") or "").strip()
        if loc_text and loc_text in geocoded:
            lat, lng = geocoded[loc_text]
            pt = [lat, lng, 1.0]
            if decay_mode: pt.append(st)
            points.append(pt)
            address_hits += 1
            continue

        # Fall back to talkgroup-level city centroid, weighted lower
        tg = c["talkgroup"]
        ov = overrides.get(tg, {})
        if ov.get("lat") is not None and ov.get("lng") is not None:
            pt = [ov["lat"], ov["lng"], 0.5]
            if decay_mode: pt.append(st)
            points.append(pt)
            city_hits += 1
            continue

        city = ov.get("city") or csv_meta.get(tg, {}).get("category") or ""
        (lat, lng), matched = lookup_city_coord(city)
        if matched:
            pt = [lat, lng, 0.5]
            if decay_mode: pt.append(st)
            points.append(pt)
            city_hits += 1
        # No real location → skip (don't pile on the centroid)

    return jsonify({
        "points": points,
        "address_hits": address_hits,
        "city_hits": city_hits,
        "total": len(points),
        "geocoded_locations": len(geocoded),
        "now": int(time.time()),
    })


# -----------------------------------------------------------------------------
# Cellular network monitor — surfaces serving + neighbor cells observed by the
# M.2 modem, plus an outage/quality dashboard. Data comes from jafo-cellmon.
# -----------------------------------------------------------------------------
@app.route("/cell-network")
def cell_network_page():
    return render_template("cell_network.html",
                           node_name=NODE_NAME,
                           is_hub=not _is_edge_node(),
                           hub_link=_hub_link_for_this_node())


@app.route("/api/cell/sites")
def api_cell_sites():
    """All known sites + last-seen + last RSRP. Includes geo if known."""
    cutoff_min = max(1, min(int(request.args.get("hours", 24)), 168)) * 3600
    cutoff = int(time.time()) - cutoff_min
    conn = get_db()
    rows = conn.execute("""
        SELECT * FROM cell_sites
        WHERE last_seen_at >= ?
        ORDER BY last_seen_at DESC
    """, (cutoff,)).fetchall()
    conn.close()
    return jsonify({
        "now":   int(time.time()),
        "count": len(rows),
        "sites": [dict(r) for r in rows],
    })


@app.route("/api/cell/observations")
def api_cell_observations():
    """Recent observations across all cells, optionally filtered by site_id."""
    minutes = max(1, min(int(request.args.get("minutes", 60)), 24 * 60))
    cutoff = int(time.time()) - minutes * 60
    site_id = request.args.get("site_id")
    conn = get_db()
    if site_id:
        site = conn.execute("SELECT * FROM cell_sites WHERE id = ?",
                            (site_id,)).fetchone()
        if not site:
            conn.close()
            return jsonify({"error": "site_id not found"}), 404
        rows = conn.execute("""
            SELECT * FROM cell_observations
            WHERE observed_at >= ?
              AND ((cell_id IS NOT NULL AND cell_id = ?) OR
                   (cell_id IS NULL AND pci = ? AND earfcn = ? AND rat = ?))
            ORDER BY observed_at DESC
            LIMIT 2000
        """, (cutoff, site["cell_id"], site["pci"], site["earfcn"], site["rat"])).fetchall()
    else:
        rows = conn.execute("""
            SELECT * FROM cell_observations
            WHERE observed_at >= ?
            ORDER BY observed_at DESC
            LIMIT 2000
        """, (cutoff,)).fetchall()
    conn.close()
    return jsonify({
        "now":          int(time.time()),
        "minutes":      minutes,
        "count":        len(rows),
        "observations": [dict(r) for r in rows],
    })


@app.route("/api/cell/asr")
def api_cell_asr():
    """ASR towers that have at least one cell_site pinned to them — i.e.
    only towers we're actually observing. Each row carries cell-aggregate
    metadata (count, operators present, dominant operator, max RSRP) so
    the map marker can be sized + colored to communicate at a glance
    'how busy is this tower in our observations'."""
    conn = get_db()
    rows = conn.execute("""
        SELECT a.asr_number, a.owner, a.structure_type, a.height_m,
               a.lat, a.lng, a.city, a.state,
               COUNT(s.id)                      AS cell_count,
               GROUP_CONCAT(DISTINCT s.operator) AS operators,
               MAX(s.last_rsrp_dbm)              AS max_rsrp_dbm
        FROM fcc_asr a
        JOIN cell_sites s ON s.asr_number = a.asr_number
        WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
        GROUP BY a.asr_number
        ORDER BY cell_count DESC
    """).fetchall()
    towers = []
    for r in rows:
        d = dict(r)
        d["operators"] = sorted([o for o in (d.get("operators") or "").split(",") if o])
        d["dominant_operator"] = d["operators"][0] if d["operators"] else None
        towers.append(d)
    conn.close()
    return jsonify({
        "now":    int(time.time()),
        "count":  len(towers),
        "towers": towers,
    })


@app.route("/api/cell/quality")
def api_cell_quality():
    """Aggregate dashboard data — counts + averages per operator + serving cell + recent state changes."""
    now_ts = int(time.time())
    one_h  = now_ts -    3600
    six_h  = now_ts - 6 *3600
    day    = now_ts - 24*3600

    conn = get_db()
    # Newest serving cell
    serving_row = conn.execute("""
        SELECT * FROM cell_observations
        WHERE is_serving = 1
        ORDER BY observed_at DESC LIMIT 1
    """).fetchone()
    serving = dict(serving_row) if serving_row else None

    # Per-operator visibility right now (= sites seen in the last hour)
    op_rows = conn.execute("""
        SELECT operator, COUNT(*) AS n, AVG(last_rsrp_dbm) AS avg_rsrp
        FROM cell_sites
        WHERE last_seen_at >= ? AND operator IS NOT NULL
        GROUP BY operator
        ORDER BY n DESC
    """, (one_h,)).fetchall()

    # Sites that were active in the last 24h but haven't been seen in the last hour
    stale_rows = conn.execute("""
        SELECT id, site_key, operator, rat, band, pci, cell_id, last_rsrp_dbm,
               last_seen_at, lat, lng
        FROM cell_sites
        WHERE last_seen_at < ? AND last_seen_at >= ?
        ORDER BY last_seen_at DESC
        LIMIT 50
    """, (one_h, day)).fetchall()

    # New sites that appeared today (first_seen in last 24h)
    new_rows = conn.execute("""
        SELECT id, site_key, operator, rat, band, pci, cell_id, last_rsrp_dbm,
               first_seen_at, last_seen_at, lat, lng
        FROM cell_sites
        WHERE first_seen_at >= ?
        ORDER BY first_seen_at DESC
        LIMIT 50
    """, (day,)).fetchall()

    # Total visible sites in the last hour, vs the day average per hour
    counts = conn.execute("""
        SELECT
          (SELECT COUNT(*) FROM cell_sites WHERE last_seen_at >= ?) AS sites_1h,
          (SELECT COUNT(*) FROM cell_sites WHERE last_seen_at >= ?) AS sites_6h,
          (SELECT COUNT(*) FROM cell_sites WHERE last_seen_at >= ?) AS sites_24h,
          (SELECT COUNT(*) FROM cell_observations WHERE observed_at >= ?) AS obs_1h,
          (SELECT COUNT(*) FROM cell_observations WHERE observed_at >= ?) AS obs_24h
    """, (one_h, six_h, day, one_h, day)).fetchone()
    conn.close()

    return jsonify({
        "now":         now_ts,
        "serving":     serving,
        "operators":   [dict(r) for r in op_rows],
        "stale_sites": [dict(r) for r in stale_rows],
        "new_sites":   [dict(r) for r in new_rows],
        "counts":      dict(counts) if counts else {},
    })


@app.route("/api/recent-calls-geo")
def recent_calls_geo():
    """Calls in the last N minutes with lat/lng + minimal metadata, for the
    3D-map overlay so users can correlate radio activity with aircraft positions
    (e.g., medevac helicopter responding to an MVA on the same map view)."""
    minutes = max(1, min(int(request.args.get("minutes", 15)), 120))
    cutoff = int(time.time()) - minutes * 60

    conn = get_db()
    cur = conn.execute("""
        SELECT id, talkgroup, talkgroup_tag, incident_type, incident_severity,
               incident_summary, incident_location, start_time, duration_sec
        FROM calls
        WHERE status = 'kept' AND start_time > ?
        ORDER BY start_time DESC
        LIMIT 500
    """, (cutoff,))
    rows = [dict(r) for r in cur]
    cur = conn.execute("""
        SELECT location_text, lat, lng FROM geocoded_locations
        WHERE lat IS NOT NULL AND lng IS NOT NULL
    """)
    geocoded = {r["location_text"]: (r["lat"], r["lng"]) for r in cur}
    conn.close()

    overrides = load_overrides()
    csv_meta = load_talkgroup_metadata()

    out = []
    for c in rows:
        loc_text = (c.get("incident_location") or "").strip()
        lat = lng = None
        precise = False
        if loc_text and loc_text in geocoded:
            lat, lng = geocoded[loc_text]
            precise = True
        else:
            tg = c["talkgroup"]
            ov = overrides.get(tg, {})
            if ov.get("lat") is not None and ov.get("lng") is not None:
                lat, lng = ov["lat"], ov["lng"]
            else:
                city = ov.get("city") or csv_meta.get(tg, {}).get("category") or ""
                (lat, lng), matched = lookup_city_coord(city)
                if not matched:
                    continue  # no usable location at all — skip

        tag = (c.get("talkgroup_tag") or "").upper()
        if "FD" in tag or "FIRE" in tag:
            kind = "fire"
        elif "EMS" in tag or "MMH" in tag or "MEDIC" in tag or "AMBU" in tag or "HOSP" in tag:
            kind = "ems"
        elif any(x in tag for x in ("PD", "DPS", "POLICE", "SHERIFF", "CONST")):
            kind = "law"
        else:
            kind = "other"

        out.append({
            "id":                 c["id"],
            "lat":                lat,
            "lng":                lng,
            "precise":            precise,
            "talkgroup":          c["talkgroup"],
            "talkgroup_tag":      c.get("talkgroup_tag"),
            "incident_type":      c.get("incident_type"),
            "incident_severity":  c.get("incident_severity"),
            "incident_summary":   c.get("incident_summary"),
            "incident_location":  c.get("incident_location"),
            "start_time":         c["start_time"],
            "kind":               kind,
        })

    return jsonify({
        "now":     int(time.time()),
        "minutes": minutes,
        "count":   len(out),
        "calls":   out,
    })


@app.route("/api/map-config")
def map_config():
    """Bounds + center for the live map. Frontend uses these to fit the view."""
    return jsonify({
        "center": list(RGV_CENTER),
        "bounds": [list(RGV_BOUNDS[0]), list(RGV_BOUNDS[1])],
    })


# -----------------------------------------------------------------------------
# Air traffic — proxies adsb.lol (free, no auth, AWS-friendly — OpenSky blocks
# AWS IP ranges on its anonymous tier). Cached server-side for 60s so all
# viewers share one upstream poll.
# -----------------------------------------------------------------------------
_AIRCRAFT_CACHE: dict[str, dict] = {}   # region_slug → {"ts", "payload"}
_AIRCRAFT_LOCK = threading.Lock()
AIRCRAFT_TTL_SEC = 20  # poll adsb.lol every 20s for smoother in-flight tracking

# Local ADS-B feed — written by a co-resident decoder every ~1s.
# We prefer this over adsb.lol when available: faster updates, better
# low-altitude coverage, no rate limits, no internet dependency.
# Probe every common decoder's path so the integration works whether
# the user ends up running readsb, dump1090-fa, dump1090-mutability, etc.
LOCAL_ADSB_PATHS = (
    "/run/dump1090-fa/aircraft.json",          # FlightAware fork (most common)
    "/run/readsb/aircraft.json",               # readsb (when built with RTL)
    "/run/dump1090-mutability/aircraft.json",  # older mutability fork
    "/run/dump1090/aircraft.json",             # generic
)
LOCAL_ADSB_FRESHNESS_SEC = 5    # older than this = decoder stopped


def _load_local_readsb() -> dict | None:
    """Read whichever local decoder is running. Returns adsb.lol-shaped
    payload or None if no decoder produced fresh data."""
    import json as _json, os as _os
    now_t = time.time()
    for path in LOCAL_ADSB_PATHS:
        try:
            st = _os.stat(path)
            if now_t - st.st_mtime > LOCAL_ADSB_FRESHNESS_SEC:
                continue
            with open(path, "r") as f:
                data = _json.load(f)
            return {"ac": data.get("aircraft", []), "now": data.get("now")}
        except (FileNotFoundError, PermissionError, _json.JSONDecodeError, OSError):
            continue
    return None

# Per-aircraft positional history for trail rendering. Keyed by icao24.
# Kept in memory (small) — at ~10-30 active aircraft × 90 points × ~32 bytes
# per point that's < 90 KB. Lost on web restart, which is fine.
_AIRCRAFT_HISTORY: dict[str, list[tuple[int, float, float, int | None]]] = {}
_AIRCRAFT_HISTORY_LOCK = threading.Lock()
TRAIL_MAX_POINTS = 90          # ~30 minutes at 20s polling
TRAIL_TTL_SEC    = 30 * 60     # drop a plane's trail after 30 min of silence

# Airports we annotate with departing/arriving lines when an aircraft is in
# the bbox, low, and climbing/descending near one. Coordinates from FAA AFD.
RGV_AIRPORTS = [
    {"icao": "KMFE", "name": "McAllen Intl",          "lat": 26.17578, "lon": -98.23861},
    {"icao": "KHRL", "name": "Valley Intl (Harlingen)","lat": 26.22844, "lon": -97.65436},
    {"icao": "KBRO", "name": "Brownsville/SPI",       "lat": 25.90681, "lon": -97.42589},
    {"icao": "KEDB", "name": "Edinburg Intl",         "lat": 26.44167, "lon": -98.12083},
    {"icao": "KRWV", "name": "Caldwell (Mid-Valley)", "lat": 26.17556, "lon": -97.97306},
]

def _haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math
    R_NM = 3440.065  # earth radius in nautical miles
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R_NM * math.asin(math.sqrt(a))

# Maps the 3-letter ICAO airline code (first 3 chars of an airline callsign)
# to the 2-letter IATA code we use to fetch a logo from images.kiwi.com.
# Scoped to carriers that actually fly in or over the RGV; anything else
# falls through to "no logo, just the callsign as a chip."
_AIRLINE_ICAO_TO_IATA = {
    # US majors / LCC
    "AAL": "AA", "DAL": "DL", "UAL": "UA", "SWA": "WN",
    "FFT": "F9", "NKS": "NK", "AAY": "G4", "ASA": "AS",
    "JBU": "B6", "HAL": "HA",
    # US regional partners
    "ENY": "MQ", "EDV": "9E", "SKW": "OO", "RPA": "YX",
    "PDT": "ZW", "JIA": "OH",
    # Mexico
    "AMX": "AM", "VOI": "Y4", "VIV": "VB", "MAA": "MX",
    "AIJ": "4O", "AVA": "AV",
    # Cargo
    "FDX": "FX", "UPS": "5X", "GTI": "5Y", "ABX": "GB",
    "CKS": "K4", "ATN": "8C", "ASH": "8L", "CFS": "CC",
    # Hemisphere carriers that overfly
    "ACA": "AC", "WJA": "WS", "CMP": "CM", "LAN": "LA",
    "TAM": "JJ", "LRC": "LR",
}


@app.route("/api/aircraft")
def api_aircraft():
    region_slug = request.args.get("region", "rgv")
    conn = get_db()
    r = conn.execute("""
        SELECT bbox_north, bbox_south, bbox_east, bbox_west
        FROM regions WHERE slug = ?
    """, (region_slug,)).fetchone()
    conn.close()
    if not r or r["bbox_north"] is None:
        return jsonify({"error": "region has no bbox", "aircraft": []}), 404

    south, west, north, east = r["bbox_south"], r["bbox_west"], r["bbox_north"], r["bbox_east"]
    now = time.time()

    with _AIRCRAFT_LOCK:
        cached = _AIRCRAFT_CACHE.get(region_slug)
        # When the cached payload came from local readsb, it's cheap to
        # refresh (file read), so use a much tighter cache window for
        # near-real-time updates of choppers etc. that motivated this work.
        cache_ttl = 2 if (cached and cached.get("payload", {}).get("data_source") == "readsb-local") else AIRCRAFT_TTL_SEC
        if cached and now - cached["ts"] < cache_ttl:
            return jsonify(cached["payload"])

        try:
            # Hybrid feed: pull both local readsb and adsb.lol, then merge by
            # ICAO hex. Aircraft seen by both are "verified"; aircraft seen
            # only by the cloud are still shown (loaded into the map at
            # reduced confidence) so we get a complete picture of the
            # airspace, not just what our antenna can hear. Aircraft seen
            # only by us locally is rare but possible (our antenna closer
            # than the nearest crowd-sourced receiver).
            local_data = _load_local_readsb()

            cloud_data = None
            try:
                import requests as _r
                lat_c = (north + south) / 2.0
                lon_c = (east + west) / 2.0
                import math
                dlat_nm = (north - south) / 2.0 * 60.0
                dlon_nm = (east - west) / 2.0 * 60.0 * math.cos(math.radians(lat_c))
                radius_nm = max(60, int(math.hypot(dlat_nm, dlon_nm)) + 10)
                url = f"https://api.adsb.lol/v2/lat/{lat_c}/lon/{lon_c}/dist/{radius_nm}"
                resp = _r.get(url, timeout=10,
                              headers={"User-Agent": "jafo/1.0 (https://jafo.live)"})
                resp.raise_for_status()
                cloud_data = resp.json() or {}
            except Exception as e:
                # Cloud miss isn't fatal — we'll fall through to local-only.
                cloud_data = None

            # Merge by hex. Local fields win when both have a value (lower
            # latency, fewer hops). For metadata that's typically richer on
            # the cloud side (dbFlags / desc / r / t / category), we keep
            # whatever's non-empty — usually cloud's value when local lacks.
            local_acs = (local_data or {}).get("ac") or []
            cloud_acs = (cloud_data or {}).get("ac") or []
            merged: dict[str, dict] = {}
            for src_name, src_list in (("local", local_acs), ("cloud", cloud_acs)):
                for a in src_list:
                    hex_id = (a.get("hex") or "").lower()
                    if not hex_id:
                        continue
                    if hex_id not in merged:
                        merged[hex_id] = {**a, "_seen": {src_name}}
                    else:
                        merged[hex_id]["_seen"].add(src_name)
                        # Fill in any field that's missing on the existing
                        # record. Local came first, so cloud's keys only
                        # land if local didn't have them.
                        for k, v in a.items():
                            if v not in (None, "", [], {}) and merged[hex_id].get(k) in (None, "", [], {}):
                                merged[hex_id][k] = v

            data = {
                "ac":  list(merged.values()),
                "now": (local_data or cloud_data or {}).get("now"),
            }

            # Build a human label for the data source: which feeds did we
            # successfully pull from this poll?
            if local_data and cloud_data:
                data_source = "merged"
            elif local_data:
                data_source = "readsb-local"
            elif cloud_data:
                data_source = "adsb.lol"
            else:
                data_source = "none"

            ac_list = data.get("ac") or []
            aircraft = []
            for a in ac_list:
                lat = a.get("lat"); lon = a.get("lon")
                if lat is None or lon is None:
                    continue
                # Filter to our bbox in case adsb.lol's circle overshot
                if not (south <= lat <= north and west <= lon <= east):
                    continue
                alt = a.get("alt_baro") if a.get("alt_baro") not in (None, "ground") else a.get("alt_geom")
                # Determine airframe class for icon rendering.
                # ICAO emitter category — primary classifier for kind.
                #   A1 = light (< 15.5k lb, GA / private)
                #   A2 = small (15.5k–75k lb, regional jet, biz jet)
                #   A3 = large (75k–300k lb, A320/737)
                #   A4 = high vortex large (B757)
                #   A5 = heavy (> 300k lb, 777, A380)
                #   A6 = high performance (military jets, supersonic)
                #   A7 = rotorcraft
                #   B1 = glider, B2 = lighter-than-air, B6 = UAV
                cat   = (a.get("category") or "").upper()
                desc  = (a.get("desc") or "").upper()
                tcode = (a.get("t") or "").upper()
                csign = (a.get("flight") or "").strip().upper()
                db_flags = a.get("dbFlags") or 0  # bit 1 = military, 8 = LADD
                is_military = bool(db_flags & 1)
                # Callsign-prefix fallback for military (USAF/USN call patterns)
                if not is_military and csign:
                    mil_prefixes = ("RCH", "REACH", "SAM", "EVAC", "PAT", "MAGMA",
                                    "JAKE", "POOL", "GHOST", "TANK", "NAVY", "DOOM",
                                    "KNIFE", "EAGLE", "SHARK", "SOL")
                    if any(csign.startswith(p) for p in mil_prefixes):
                        is_military = True

                helo_types = {
                    "EC30","EC35","EC45","EC75","EC20","EC55",
                    "AS50","AS55","AS65","AS32","AS35",
                    "B06","B06T","B407","B412","B429","B505",
                    "R22","R44","R66","S76","S92","S70",
                    "H145","H160","H125","H130","H175",
                    "MD50","MD52","MD60","MD90",
                }
                # Order matters — most-specific first.
                if is_military:
                    kind = "military"
                elif cat == "A7" or "HELI" in desc or tcode in helo_types:
                    kind = "helicopter"
                elif cat == "B6":
                    kind = "uav"
                elif cat == "B1":
                    kind = "glider"
                elif cat == "B2":
                    kind = "balloon"
                elif cat in ("A4", "A5"):
                    kind = "heavy"
                elif cat == "A3":
                    kind = "commercial"
                elif cat == "A6":
                    kind = "jet"        # high-performance / fighter-class
                elif cat == "A2":
                    kind = "jet"        # bizjet / regional — same icon
                elif cat == "A1":
                    kind = "light"      # GA / private
                else:
                    kind = "light"

                # Emergency squawks: 7500 (hijack), 7600 (radio fail), 7700 (general)
                squawk = a.get("squawk")
                emergency = squawk in ("7500", "7600", "7700")

                # Airline ICAO is the leading 3 letters of the callsign for
                # commercial flights ("AAL249" → "AAL"). Bail if the callsign
                # is a tail number ("N12AX") — pattern: letter immediately
                # followed by a digit means N-numbered registration, not airline.
                airline_icao = None
                airline_iata = None
                if len(csign) >= 4 and csign[:3].isalpha() and csign[3:].lstrip()[:1].isdigit():
                    airline_icao = csign[:3]
                    airline_iata = _AIRLINE_ICAO_TO_IATA.get(airline_icao)

                # Source of this record: which feed(s) contributed it. Used
                # by the frontend to tint cloud-only aircraft so the user
                # can tell what's been verified by the local antenna vs
                # what we're trusting the crowd-sourced cloud feed for.
                seen = a.get("_seen") or set()
                if   "local" in seen and "cloud" in seen: source = "verified"
                elif "local" in seen:                     source = "local"
                else:                                     source = "cloud"

                aircraft.append({
                    "icao24":      a.get("hex"),
                    "callsign":    csign,
                    "registration": a.get("r"),
                    "type_code":   a.get("t"),
                    "description": a.get("desc"),
                    "category":    cat or None,
                    "kind":        kind,
                    "is_military": is_military,
                    "emergency":   emergency,
                    "airline_icao": airline_icao,
                    "airline_iata": airline_iata,
                    "source":      source,
                    "lat":         lat,
                    "lon":         lon,
                    "altitude_ft": int(alt) if isinstance(alt, (int, float)) else None,
                    "velocity_kt": int(a.get("gs")) if a.get("gs") is not None else None,
                    "track_deg":   a.get("track"),
                    "vertical_rate_fpm": a.get("baro_rate"),
                    "squawk":      squawk,
                    "on_ground":   a.get("alt_baro") == "ground",
                })
            # Update per-aircraft trail history; attach trail to each outgoing record.
            now_int = int(now)
            with _AIRCRAFT_HISTORY_LOCK:
                cutoff = now_int - TRAIL_TTL_SEC
                # Prune aircraft whose last point is older than TTL
                for icao in list(_AIRCRAFT_HISTORY.keys()):
                    hist = _AIRCRAFT_HISTORY[icao]
                    if not hist or hist[-1][0] < cutoff:
                        del _AIRCRAFT_HISTORY[icao]
                # Append current positions, deduping if the lat/lon hasn't moved
                # (some adsb feeds re-emit the same position when an aircraft is stationary)
                for a in aircraft:
                    icao = a.get("icao24")
                    if not icao:
                        continue
                    hist = _AIRCRAFT_HISTORY.setdefault(icao, [])
                    last = hist[-1] if hist else None
                    if not last or (last[1], last[2]) != (a["lat"], a["lon"]):
                        hist.append((now_int, a["lat"], a["lon"], a.get("altitude_ft")))
                        if len(hist) > TRAIL_MAX_POINTS:
                            del hist[0:len(hist) - TRAIL_MAX_POINTS]
                # Attach trails as [[lon, lat], ...] (GeoJSON-friendly order)
                for a in aircraft:
                    icao = a.get("icao24")
                    hist = _AIRCRAFT_HISTORY.get(icao, [])
                    a["trail"] = [[lon, lat] for (_, lat, lon, _) in hist]

            # Airports that fall inside the visible bbox — these are the
            # candidates for departure / arrival annotation.
            airports_visible = [
                ap for ap in RGV_AIRPORTS
                if south <= ap["lat"] <= north and west <= ap["lon"] <= east
            ]

            # Departure / arrival detection: an aircraft is "tied" to an
            # airport if it's in the air, low, near the field, and either
            # climbing (DEP) or descending (ARR). Heuristic, not flight-plan.
            # Thresholds: alt<8000, dist<10nm, |vr|>200fpm — wide enough to
            # catch traffic still on a downwind/base or just airborne.
            for a in aircraft:
                a["airport_event"] = None
                if a.get("on_ground"):
                    continue
                alt = a.get("altitude_ft")
                vr  = a.get("vertical_rate_fpm")
                if alt is None or alt > 8000 or vr is None:
                    continue
                nearest, nearest_d = None, 999.0
                for ap in airports_visible:
                    d = _haversine_nm(a["lat"], a["lon"], ap["lat"], ap["lon"])
                    if d < nearest_d:
                        nearest, nearest_d = ap, d
                if nearest is None or nearest_d > 10.0:
                    continue
                if vr > 200:
                    a["airport_event"] = {"type": "DEP", "icao": nearest["icao"],
                                          "distance_nm": round(nearest_d, 1)}
                elif vr < -200:
                    a["airport_event"] = {"type": "ARR", "icao": nearest["icao"],
                                          "distance_nm": round(nearest_d, 1)}

            payload = {
                "region": region_slug,
                "bbox": {"north": north, "south": south, "east": east, "west": west},
                "fetched_at": int(now),
                "upstream_time": data.get("now"),
                "data_source":   data_source,
                "count": len(aircraft),
                "aircraft": aircraft,
                "airports": airports_visible,
            }
            _AIRCRAFT_CACHE[region_slug] = {"ts": now, "payload": payload}
            return jsonify(payload)
        except Exception as e:
            # Cache an empty result briefly so a flap doesn't hammer OpenSky
            payload = {"region": region_slug, "aircraft": [], "count": 0,
                       "error": f"{type(e).__name__}: {e}", "fetched_at": int(now)}
            _AIRCRAFT_CACHE[region_slug] = {"ts": now, "payload": payload}
            return jsonify(payload), 502


# Apply the full SCHEMA (calls + cell_* + opencellid) once at startup so any
# tables added in newer releases are present even on long-running edge nodes
# whose get_db() short-circuits the schema apply when the DB file exists.
db_connect().close()
# Ensure the overrides table exists. Safe to call repeatedly.
ensure_overrides_table()
# Stories generation only runs on the hub. Edge nodes proxy /api/stories
# from the hub instead — they don't have a Groq key, and Ollama enrichment
# is too weak to produce useful clusters.
if not _is_edge_node():
    _start_stories_thread()
_start_heatmap_thread()


# -----------------------------------------------------------------------------
# Dev entrypoint
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    host = os.environ.get("JAFO_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("JAFO_WEB_PORT", "8080"))
    app.run(host=host, port=port, debug=True)
