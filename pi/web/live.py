"""
jafo — /live : the public "what's happening right now" map.

Blueprint registered at the bottom of app.py. Reads the incidents / units model
built by the hub enricher (pi/services/incidents.py).

Privacy posture (public hub):
  * transcripts are served as speaker turns with model redactions applied, then
    a second regex scrub (_redact_pii) for phones/SSNs/plates/house numbers;
  * locations are block-level (the enricher never stores the house number in
    incidents.location_text);
  * audio URLs are only emitted for owner viewers (edge operator / admin),
    matching the rest of the app — public viewers get text only.
"""

from __future__ import annotations

import json
import math
import os
import re
import statistics
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta

import requests
from flask import Blueprint, abort, jsonify, redirect, render_template, request

import app as A  # the main Flask module (already fully imported when this loads)

bp = Blueprint("live", __name__)

ACTIVE_STATUSES = ("dispatched", "en_route", "on_scene", "transporting", "busy")
QUIET_AFTER_SEC = 20 * 60
WINDOWS = {"1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
KIND_LABELS = {
    "violence": "Violence and danger", "traffic": "Traffic", "medical": "Medical and welfare",
    "property": "Property and alarms", "suspicious": "Suspicious and disputes", "fire": "Fire",
    "other": "Other calls",
}
UA = {"User-Agent": "jafo/1.0 (public-safety radio observatory; +https://github.com/Drew-CodeRGV/jafo)"}


# -----------------------------------------------------------------------------
# helpers
# -----------------------------------------------------------------------------
def _db():
    return A.get_db()


def _region(conn, slug: str | None):
    if slug:
        r = conn.execute("SELECT * FROM regions WHERE slug = ?", (slug,)).fetchone()
        if r:
            return dict(r)
    r = conn.execute("""SELECT r.* FROM regions r JOIN incidents i ON i.region_id = r.id
                        GROUP BY r.id ORDER BY MAX(i.last_call_at) DESC LIMIT 1""").fetchone()
    if not r:
        r = conn.execute("SELECT * FROM regions ORDER BY id LIMIT 1").fetchone()
    return dict(r) if r else {"id": None, "slug": None, "name": "jafo"}


def _owner() -> bool:
    try:
        return A._viewer_is_owner(request)
    except Exception:
        return False


def _scrub(text: str | None) -> str | None:
    if not text:
        return text
    try:
        return A._redact_pii(text, [])
    except Exception:
        return text


def _jl(s, default=None):
    try:
        return json.loads(s) if s else (default if default is not None else [])
    except Exception:
        return default if default is not None else []


def _audio_url(row, owner: bool):
    if not (owner or A.PUBLIC_AUDIO) or not row["opus_path"] or row["audio_deleted"]:
        return None
    return f"/audio/{row['opus_path']}"


def _public_status(inc, now: int) -> str:
    if inc["closed_at"]:
        return "ended"
    if now - (inc["last_call_at"] or 0) > QUIET_AFTER_SEC and inc["status"] in ("new", "cleared", None):
        return "quiet"
    return inc["status"] or "new"


def _haversine_mi(a_lat, a_lng, b_lat, b_lng):
    r = 3958.8
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


_UNIT_LISTS: dict[int, list] = {}


def _unit_counts(conn, ids: list[int]) -> dict[int, dict]:
    out: dict[int, dict] = defaultdict(lambda: {"police": 0, "fire": 0, "ems": 0, "other": 0})
    if not ids:
        return out
    q = ",".join("?" * len(ids))
    for r in conn.execute(f"""
        SELECT e.incident_id, u.service, COUNT(DISTINCT u.id) n
        FROM unit_events e JOIN units u ON u.id = e.unit_id
        WHERE e.incident_id IN ({q}) GROUP BY e.incident_id, u.service""", ids):
        out[r["incident_id"]][r["service"] or "other"] += r["n"]
    for iid in ids:
        _UNIT_LISTS.pop(iid, None)
    for r in conn.execute(f"""
        SELECT DISTINCT e.incident_id, u.callsign, u.role, u.service
        FROM unit_events e JOIN units u ON u.id = e.unit_id WHERE e.incident_id IN ({q})""", ids):
        _UNIT_LISTS.setdefault(r["incident_id"], []).append((r["callsign"] or "", r["role"] or "", r["service"] or ""))
    return out


# --- who is responding (icons on incidents) ----------------------------------
# Specialised resources detected from unit callsigns/roles, and — for things that
# are requested rather than heard (tow, utility, examiner) — from the summary.
RESPONDER_RULES = [
    ("hazmat", "Hazmat", re.compile(r"haz ?-?mat|\bhm ?\d|decon", re.I), True),
    ("air", "Air unit", re.compile(r"\bair ?\d|helicopter|\bheli|aviation|air evac|life ?flight|airlife|\bomaha\b", re.I), True),
    ("k9", "K-9", re.compile(r"\bk-? ?9\b", re.I), True),
    ("swat", "SWAT / tactical", re.compile(r"\bswat\b|tactical|\bsrt\b|bomb squad", re.I), True),
    ("command", "Command", re.compile(r"battalion|\bbc ?\d|\bchief\b|incident command|\bcommand\b|supervisor|sergeant|lieutenant|captain", re.I), False),
    ("rescue", "Rescue", re.compile(r"\brescue\b|\bsquad\b|extricat", re.I), True),
    ("ladder", "Ladder truck", re.compile(r"ladder|\btruck ?\d|\bquint\b|aerial|tower ?\d", re.I), False),
    ("tow", "Tow truck", re.compile(r"wrecker|\btow\b|tow truck|towing", re.I), True),
    ("utility", "Utility crew", re.compile(r"\baep\b|magic valley|power company|electric co|utility|gas company|texas gas|water dept", re.I), True),
    ("examiner", "Medical examiner", re.compile(r"medical examiner|justice of the peace|\bjp\b|coroner", re.I), True),
    ("border", "Border Patrol", re.compile(r"border patrol|\busbp\b|\bcbp\b", re.I), True),
    ("dps", "State troopers", re.compile(r"\bdps\b|trooper|highway patrol", re.I), True),
]


def _responders(iid: int, counts: dict, text: str) -> list[dict]:
    c = counts.get(iid) or {}
    out = []
    for key, label in (("police", "Police"), ("fire", "Fire"), ("ems", "EMS")):
        if c.get(key):
            out.append({"key": key, "label": label, "n": c[key]})
    units = _UNIT_LISTS.get(iid, [])
    for key, label, rx, from_text in RESPONDER_RULES:
        n = sum(1 for cs, role, _svc in units if rx.search(f"{cs} {role}"))
        if not n and from_text and text and rx.search(text):
            n = 1
        if n:
            out.append({"key": key, "label": label, "n": n})
    if not out and c.get("other"):
        out.append({"key": "other", "label": "Units", "n": c["other"]})
    return out


# --- wall-display softening -------------------------------------------------
# Office walls must not put self-harm, mental-health crises, deaths, sexual
# assault or child abuse up in large type. /live keeps full detail; requests
# from a wall page (Referer .../wall/...) or with ?safe=1 get neutral text.
SENSITIVE_RE = re.compile(r"suicid|self[- ]?(inflicted|harm)|overdos|mental|psych|crisis|\bdoa\b|deceased|dead body|"
                          r"\bdeath\b|\bdied\b|fatal|unattended death|sexual|rape|molest|child abuse|\bcps\b|"
                          r"jumper|hanging|cutting (him|her)self", re.I)
SOFT_TITLE = {"medical": "Medical emergency", "violence": "Police emergency", "fire": "Fire department call",
              "traffic": "Traffic incident", "property": "Police call", "suspicious": "Police call",
              "other": "Emergency call"}


WALL_SENSITIVE_DEFAULT = os.environ.get("JAFO_WALL_SENSITIVE", "soften").strip().lower()  # soften | show


def _wall_sensitive_mode() -> str:
    """'show' = full detail tagged sensitive; 'soften' = neutral text.
    Set per wall with ?sensitive=show|soften on the wall URL (it rides on the
    Referer of the wall's API calls), or hub-wide with JAFO_WALL_SENSITIVE."""
    try:
        ref = request.referrer or ""
        for src in (request.args.get("sensitive", ""), ref):
            if "sensitive=show" in src or src == "show":
                return "show"
            if "sensitive=soften" in src or src == "soften":
                return "soften"
    except RuntimeError:
        pass
    return "show" if WALL_SENSITIVE_DEFAULT == "show" else "soften"


def _wall() -> bool:
    """True when this request should be SOFTENED (a wall page in soften mode)."""
    try:
        is_wall = request.args.get("safe") == "1" or "/wall/" in (request.referrer or "")
    except RuntimeError:
        return False
    return is_wall and _wall_sensitive_mode() == "soften"


def _is_sensitive(row) -> bool:
    keys = row.keys() if hasattr(row, "keys") else []
    if "sensitive" in keys and row["sensitive"]:
        return True
    text = " ".join(str(row[k] or "") for k in ("title", "summary", "type") if k in keys)
    return bool(SENSITIVE_RE.search(text))


def _soft_title(kind) -> str:
    return SOFT_TITLE.get(kind or "other", "Emergency call")


def _incident_brief(inc, counts, now) -> dict:
    if _wall() and _is_sensitive(inc):
        d = _incident_brief_raw(inc, counts, now)
        d.update(title=_soft_title(inc["kind"]), summary=None, location=inc["city"] or None, softened=True)
        return d
    d = _incident_brief_raw(inc, counts, now)
    d["sensitive"] = _is_sensitive(inc)
    return d


def _incident_brief_raw(inc, counts, now) -> dict:
    return {
        "id": inc["id"], "title": inc["title"], "kind": inc["kind"] or "other",
        "service": inc["service"], "type": inc["type"], "severity": inc["severity"],
        "status": _public_status(inc, now), "location": _scrub(inc["location_text"]),
        "city": inc["city"], "lat": inc["lat"], "lng": inc["lng"], "precision": inc["geo_precision"],
        "first_at": inc["first_call_at"], "last_at": inc["last_call_at"], "calls": inc["call_count"],
        "units": counts.get(inc["id"], {}), "closed": bool(inc["closed_at"]),
        "summary": _scrub(inc["summary"]),
        "responders": _responders(inc["id"], counts, f"{inc['title'] or ''} {inc['summary'] or ''}"),
    }


def _speakers_public(row) -> list[dict]:
    sp = _jl(row["speakers_json"])
    if not sp and row["transcript"]:
        sp = [{"who": "", "text": row["transcript"]}]
    redact = _jl(row["redact_json"])
    out = []
    for s in sp:
        t = s.get("text") or ""
        for r in redact:
            if r and len(r) >= 2:
                t = t.replace(r, "⟦" + "•" * min(len(r), 12) + "⟧")
        out.append({"who": s.get("who") or "", "text": _scrub(t)})
    return out


CALL_COLS = """c.id, c.start_time, c.duration_sec, c.talkgroup, c.talkgroup_tag, c.transcript,
               c.call_line, c.call_kind, c.call_service, c.speakers_json, c.redact_json, c.codes_json,
               c.incident_id, c.opus_path, c.audio_deleted, c.incident_type"""


def _soften_call(d: dict, kind) -> dict:
    d.update(line=f"Units are handling a {_soft_title(kind).lower()}.", speakers=[], codes=[], audio=None)
    if d.get("incident"):
        d["incident"] = {**d["incident"], "title": _soft_title(kind)}
    return d


def _call_public(row, owner: bool, incident=None) -> dict:
    d = {
        "id": row["id"], "at": row["start_time"], "dur": row["duration_sec"],
        "talkgroup": row["talkgroup"], "channel": row["talkgroup_tag"] or f"TG {row['talkgroup']}",
        "line": _scrub(row["call_line"]) if row["call_line"] else None,
        "kind": row["call_kind"], "service": row["call_service"], "type": row["incident_type"],
        "speakers": _speakers_public(row), "codes": _jl(row["codes_json"]),
        "incident_id": row["incident_id"], "audio": _audio_url(row, owner),
    }
    if incident is not None:
        d["incident"] = incident
    return d


# -----------------------------------------------------------------------------
# pages
# -----------------------------------------------------------------------------
@bp.route("/live")
def live_root():
    conn = _db()
    r = _region(conn, request.args.get("region"))
    conn.close()
    if not r.get("slug"):
        abort(404)
    return redirect(f"/live/{r['slug']}")


@bp.route("/live/<slug>")
def live_page(slug: str):
    conn = _db()
    r = conn.execute("SELECT slug, name FROM regions WHERE slug = ?", (slug,)).fetchone()
    regions = conn.execute("SELECT slug, name FROM regions ORDER BY id").fetchall()
    conn.close()
    if not r:
        abort(404)
    return render_template("live.html", region_slug=r["slug"], region_name=r["name"],
                           regions=[dict(x) for x in regions], owner=_owner(), tz=str(A_TZ()),
                           audio=_owner() or A.PUBLIC_AUDIO)


WALLS = ("command", "newsroom", "grid", "pulse")
CONCEPTS = ("river", "brief", "console", "near")   # /live redesign prototypes


@bp.route("/live/<slug>/v/<name>")
def concept_page(slug: str, name: str):
    """Redesign prototypes of the /live experience: templates/v_<name>.html."""
    if name not in CONCEPTS:
        abort(404)
    conn = _db()
    r = conn.execute("SELECT * FROM regions WHERE slug = ?", (slug,)).fetchone()
    conn.close()
    if not r:
        abort(404)
    return render_template(f"v_{name}.html", region_slug=slug, region_name=r["name"], region=dict(r),
                           tz=str(A_TZ()), concepts=CONCEPTS, concept=name,
                           audio=_owner() or A.PUBLIC_AUDIO, owner=_owner())


@bp.route("/live/<slug>/wall")
def wall_index(slug: str):
    return redirect(f"/live/{slug}/wall/command")


@bp.route("/live/<slug>/wall/<name>")
def wall_page(slug: str, name: str):
    """Office wall displays (always-on dashboards). Each layout lives in
    templates/wall_<name>.html + static/wall_<name>.{js,css}."""
    if name not in WALLS:
        abort(404)
    conn = _db()
    r = conn.execute("SELECT * FROM regions WHERE slug = ?", (slug,)).fetchone()
    conn.close()
    if not r:
        abort(404)
    r = dict(r)
    return render_template(f"wall_{name}.html", region_slug=slug, region_name=r["name"],
                           region=r, tz=str(A_TZ()), walls=WALLS, wall=name,
                           audio=_owner() or A.PUBLIC_AUDIO)


_PULSE_CACHE: dict[str, tuple[float, dict]] = {}


@bp.route("/api/live/pulse")
def api_pulse():
    key = (request.args.get("region") or "") + ("|soft" if _wall() else "|full")
    hit = _PULSE_CACHE.get(key)
    if hit and time.time() - hit[0] < 10:
        return jsonify(hit[1])
    data = _pulse_data()
    _PULSE_CACHE[key] = (time.time(), data)
    return jsonify(data)


def _pulse_data() -> dict:
    """One cheap call with everything an ambient wall display needs:
    24h activity in 10-minute bins (calls, by service), incidents opened per
    hour by kind, active counts by kind/status, units by status/service, and
    headline numbers. Poll every 15-30 s."""
    now = int(time.time())
    conn = _db()
    r = _region(conn, request.args.get("region"))
    rid = r.get("id")
    start = now - 86400
    bins = [{"calls": 0, "police": 0, "fire": 0, "ems": 0, "other": 0} for _ in range(144)]
    for c in conn.execute("""SELECT start_time, COALESCE(call_service,'other') svc FROM calls
                             WHERE region_id IS ? AND start_time >= ? AND status = 'kept'""", (rid, start)):
        i = min(143, max(0, (c["start_time"] - start) // 600))
        bins[i]["calls"] += 1
        bins[i][c["svc"] if c["svc"] in ("police", "fire", "ems") else "other"] += 1
    hourly = [{k: 0 for k in KIND_LABELS} for _ in range(24)]
    opened_24h = Counter()
    for i in conn.execute("""SELECT first_call_at, COALESCE(kind,'other') kind FROM incidents
                             WHERE region_id IS ? AND first_call_at >= ?""", (rid, start)):
        h = min(23, (i["first_call_at"] - start) // 3600)
        hourly[h][i["kind"]] = hourly[h].get(i["kind"], 0) + 1
        opened_24h[i["kind"]] += 1
    active = conn.execute("""SELECT * FROM incidents WHERE region_id IS ? AND closed_at IS NULL
                             ORDER BY last_call_at DESC""", (rid,)).fetchall()
    counts = _unit_counts(conn, [a["id"] for a in active])
    active_items = [_incident_brief(a, counts, now) for a in active]
    for it, a in zip(active_items, active):
        it["summary"] = _scrub(a["summary"])
    units = conn.execute("""SELECT COALESCE(service,'other') service, status, COUNT(*) n FROM units
                            WHERE region_id IS ? AND last_heard >= ? GROUP BY 1, 2""",
                         (rid, now - 4 * 3600)).fetchall()
    unit_status = defaultdict(lambda: defaultdict(int))
    for u in units:
        unit_status[u["service"]][u["status"] or "unknown"] += u["n"]
    last_call = conn.execute("""SELECT c.start_time, c.call_line, c.talkgroup_tag, c.talkgroup, c.incident_id,
                                       (SELECT kind FROM incidents WHERE id = c.incident_id) incident_kind,
                                       (SELECT title FROM incidents WHERE id = c.incident_id) incident_title
                                FROM calls c WHERE c.region_id IS ? AND c.enriched_v2_at IS NOT NULL
                                ORDER BY c.start_time DESC LIMIT 1""", (rid,)).fetchone()
    calls_1h = sum(b["calls"] for b in bins[-6:])
    calls_prev_1h = sum(b["calls"] for b in bins[-12:-6])
    midnight = int(datetime.now(A_TZ()).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    today = conn.execute("""SELECT COUNT(*) n, SUM(kind IN ('violence','fire')) danger FROM incidents
                            WHERE region_id IS ? AND first_call_at >= ?""", (rid, midnight)).fetchone()
    latest_enriched = conn.execute("""SELECT MAX(start_time) FROM calls WHERE region_id IS ? AND start_time >= ?
                                      AND enriched_v2_at IS NOT NULL""", (rid, start)).fetchone()[0]
    latest_heard = conn.execute("SELECT MAX(start_time) FROM calls WHERE region_id IS ? AND start_time >= ?",
                                (rid, start)).fetchone()[0]
    conn.close()
    conn2 = _db()
    cleared_24h = conn2.execute("""SELECT COUNT(*) FROM incidents WHERE region_id IS ? AND closed_at IS NOT NULL
                                   AND last_call_at >= ?""", (rid, start)).fetchone()[0]
    conn2.close()
    return ({
        "cleared_24h": cleared_24h,
        "active_by_severity": Counter(it["severity"] or "unknown" for it in active_items),
        "today": {"since": midnight, "incidents": today["n"] or 0, "danger": today["danger"] or 0},
        # How far behind the AI pipeline is: walls can show "catching up" honestly.
        "pipeline": {"latest_heard": latest_heard, "latest_enriched": latest_enriched,
                     "lag_sec": (latest_heard - latest_enriched) if latest_heard and latest_enriched else None},
        "now": now, "region": {k: r.get(k) for k in ("slug", "name", "default_lat", "default_lng",
                                                     "bbox_north", "bbox_south", "bbox_east", "bbox_west")},
        "bins_10min": bins, "bins_start": start,
        "incidents_by_hour": hourly, "opened_24h": opened_24h,
        "active": active_items,
        "active_by_kind": Counter(it["kind"] for it in active_items),
        "active_by_status": Counter(it["status"] for it in active_items),
        "units_by_service_status": {k: dict(v) for k, v in unit_status.items()},
        "headline": {"active": len(active_items), "calls_1h": calls_1h, "calls_prev_1h": calls_prev_1h,
                     "opened_24h": sum(opened_24h.values()),
                     "units_out": sum(n for svc in unit_status.values() for st, n in svc.items()
                                      if st in ACTIVE_STATUSES)},
        "last_call": _last_call_public(last_call),
    })


# -----------------------------------------------------------------------------
# API
# -----------------------------------------------------------------------------
@bp.route("/api/live/config")
def api_config():
    conn = _db()
    r = _region(conn, request.args.get("region"))
    conn.close()
    return jsonify({
        "region": {k: r.get(k) for k in ("id", "slug", "name", "default_lat", "default_lng",
                                          "default_zoom", "bbox_north", "bbox_south",
                                          "bbox_east", "bbox_west")},
        "kinds": KIND_LABELS, "owner": _owner(), "now": int(time.time()),
    })


@bp.route("/api/live/incidents")
def api_incidents():
    now = int(time.time())
    at = request.args.get("at", type=int)            # replay: state as of this moment
    window = request.args.get("window", "active")
    kind = request.args.get("kind") or None
    service = request.args.get("service") or None
    q = (request.args.get("q") or "").strip()
    near = request.args.get("near")
    radius = request.args.get("radius", type=float) or 1.0
    limit = min(request.args.get("limit", type=int) or 300, 1000)
    conn = _db()
    r = _region(conn, request.args.get("region"))
    where, args = ["i.region_id IS ?"], [r.get("id")]
    if at:
        where.append("i.first_call_at <= ? AND i.last_call_at >= ?")
        args += [at, at - 45 * 60]
        now = at
    elif window == "active":
        where.append("i.closed_at IS NULL")
    else:
        where.append("i.last_call_at >= ?")
        args.append(now - WINDOWS.get(window, 86400))
    if kind:
        where.append("i.kind IN (%s)" % ",".join("?" * len(kind.split(","))))
        args += kind.split(",")
    if service:
        where.append("i.service = ?")
        args.append(service)
    if q:
        like = f"%{q}%"
        where.append("""(i.title LIKE ? OR i.summary LIKE ? OR i.location_text LIKE ? OR i.street LIKE ?
                        OR i.cross_street LIKE ? OR i.id = ? OR i.id IN (
                          SELECT e.incident_id FROM unit_events e JOIN units u ON u.id = e.unit_id
                          WHERE u.callsign LIKE ?))""")
        args += [like, like, like, like, like, q.lstrip("#") if q.lstrip("#").isdigit() else -1, like]
    rows = conn.execute(f"""SELECT * FROM incidents i WHERE {' AND '.join(where)}
                            ORDER BY i.last_call_at DESC LIMIT ?""", args + [limit]).fetchall()
    counts = _unit_counts(conn, [x["id"] for x in rows])
    items = [_incident_brief(x, counts, now) for x in rows]
    if at:  # at replay time an incident is "ended" if it had gone quiet
        for it in items:
            it["closed"] = False
            it["status"] = "quiet" if at - it["last_at"] > QUIET_AFTER_SEC else it["status"].replace("ended", "on_scene")
    if near:
        try:
            nlat, nlng = (float(x) for x in near.split(","))
            for it in items:
                it["distance_mi"] = (round(_haversine_mi(nlat, nlng, it["lat"], it["lng"]), 2)
                                     if it["lat"] is not None else None)
            items = [it for it in items if it["distance_mi"] is not None and it["distance_mi"] <= radius]
            items.sort(key=lambda it: it["distance_mi"])
        except ValueError:
            pass
    kinds = Counter(it["kind"] for it in items)
    ended_today = 0
    if window == "active" and not at:
        midnight = int(datetime.now(A_TZ()).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        ended_today = conn.execute("""SELECT COUNT(*) FROM incidents WHERE region_id IS ? AND closed_at IS NOT NULL
                                      AND last_call_at >= ?""", (r.get("id"), midnight)).fetchone()[0]
    conn.close()
    return jsonify({"region": r.get("slug"), "now": now, "items": items, "kinds": kinds,
                    "ended_today": ended_today})


def A_TZ():
    from zoneinfo import ZoneInfo
    import os
    return ZoneInfo(os.environ.get("JAFO_TZ", "America/Chicago"))


@bp.route("/api/live/incidents/<int:iid>")
def api_incident(iid: int):
    now = int(time.time())
    owner = _owner()
    conn = _db()
    inc = conn.execute("SELECT * FROM incidents WHERE id = ?", (iid,)).fetchone()
    if not inc:
        conn.close()
        abort(404)
    counts = _unit_counts(conn, [iid])
    d = _incident_brief(inc, counts, now)
    d["summary"] = _scrub(inc["summary"])
    d["people"] = _jl(inc["people_json"])
    d["vehicles"] = _jl(inc["vehicles_json"])
    calls = conn.execute(f"SELECT {CALL_COLS} FROM calls c WHERE c.incident_id = ? ORDER BY c.start_time",
                         (iid,)).fetchall()
    d["timeline"] = [_call_public(c, owner) for c in calls]
    d["duration_sec"] = int(sum((c["duration_sec"] or 0) for c in calls))
    units = conn.execute("""
        SELECT u.id, u.callsign, u.service, u.role, u.status, u.status_since, u.incident_id,
               MIN(e.at) first_at, MAX(e.at) last_at
        FROM unit_events e JOIN units u ON u.id = e.unit_id
        WHERE e.incident_id = ? GROUP BY u.id ORDER BY first_at""", (iid,)).fetchall()
    d["units_list"] = []
    for u in units:
        on_this = u["incident_id"] == iid
        last_ev = conn.execute("""SELECT status, at FROM unit_events WHERE unit_id = ? AND incident_id = ?
                                  AND status != 'unknown' ORDER BY at DESC LIMIT 1""", (u["id"], iid)).fetchone()
        d["units_list"].append({
            "id": u["id"], "callsign": u["callsign"], "service": u["service"], "role": u["role"],
            "status": (u["status"] if on_this else (last_ev["status"] if last_ev else "unknown")),
            "since": u["status_since"] if on_this else (last_ev["at"] if last_ev else u["last_at"]),
            "on_this": on_this,
        })
    # responding-unit trails: where each unit was (incident pins) before this one
    d["trails"] = _unit_trails(conn, [u["id"] for u in units], inc["first_call_at"] - 3 * 3600,
                               inc["last_call_at"], iid)
    d["related_news"] = _related_news(conn, inc)
    if _wall() and _is_sensitive(inc):
        d.update(summary=None, people=[], vehicles=[], related_news=[], trails=[])
        d["timeline"] = [_soften_call(t, inc["kind"]) for t in d["timeline"]]
    elif d.get("sensitive"):
        for t in d["timeline"]:
            t["sensitive"] = True
    slug_row = conn.execute("SELECT slug FROM regions WHERE id = ?", (inc["region_id"],)).fetchone()
    conn.close()
    try:
        import cameras
        d["cameras"] = cameras.nearby(slug_row["slug"] if slug_row else None, inc["lat"], inc["lng"]) \
            if inc["lat"] is not None and inc["geo_precision"] not in ("city",) else []
    except Exception:
        d["cameras"] = []
    return jsonify(d)


def _unit_trails(conn, unit_ids, since, until, iid):
    out = []
    for uid in unit_ids[:8]:
        pts = conn.execute("""
            SELECT e.at, i.lat, i.lng, i.id FROM unit_events e JOIN incidents i ON i.id = e.incident_id
            WHERE e.unit_id = ? AND e.at BETWEEN ? AND ? AND i.lat IS NOT NULL ORDER BY e.at""",
            (uid, since, until)).fetchall()
        seq = []
        for p in pts:
            if not seq or seq[-1]["incident_id"] != p["id"]:
                seq.append({"at": p["at"], "lat": p["lat"], "lng": p["lng"], "incident_id": p["id"]})
        if len(seq) >= 2 and seq[-1]["incident_id"] == iid:
            out.append({"unit_id": uid, "points": seq[-2:]})
    return out


def _related_news(conn, inc):
    """Our own News Desk stories built from calls in this incident (feed-visible only)."""
    try:
        ids = {r[0] for r in conn.execute("SELECT id FROM calls WHERE incident_id = ?", (inc["id"],))}
        if not ids:
            return []
        out = []
        for s in conn.execute(f"""SELECT id, COALESCE(news_title, title) title, primary_call_id, related_call_ids
                                  FROM stories WHERE last_call_at >= ? AND created_at <= ? AND {A._FEED_VISIBLE}
                                  ORDER BY created_at DESC LIMIT 300""",
                              (inc["first_call_at"] - 600, (inc["last_call_at"] or 0) + 6 * 3600)):
            rel = {int(x) for x in str(s["related_call_ids"] or "").replace("[", "").replace("]", "").split(",")
                   if x.strip().isdigit()}
            if s["primary_call_id"] in ids or rel & ids:
                out.append({"id": s["id"], "title": s["title"], "url": f"/news/{s['id']}"})
        return out[:5]
    except Exception:
        return []


@bp.route("/api/live/units")
def api_units():
    now = int(time.time())
    scope = request.args.get("scope", "out")
    conn = _db()
    r = _region(conn, request.args.get("region"))
    if scope == "out":
        rows = conn.execute(f"""
            SELECT u.*, i.title inc_title, i.kind inc_kind, i.lat inc_lat, i.lng inc_lng,
                   i.sensitive inc_sensitive, i.summary inc_summary, i.type inc_type
            FROM units u LEFT JOIN incidents i ON i.id = u.incident_id
            WHERE u.region_id IS ? AND u.status IN ({','.join('?' * len(ACTIVE_STATUSES))})
              AND u.last_heard >= ?
            ORDER BY u.service, u.callsign""", (r.get("id"), *ACTIVE_STATUSES, now - 4 * 3600)).fetchall()
    else:
        rows = conn.execute("""
            SELECT u.*, i.title inc_title, i.kind inc_kind, i.lat inc_lat, i.lng inc_lng,
                   i.sensitive inc_sensitive, i.summary inc_summary, i.type inc_type
            FROM units u LEFT JOIN incidents i ON i.id = u.incident_id
            WHERE u.region_id IS ? AND u.last_heard >= ?
            ORDER BY u.last_heard DESC LIMIT 400""", (r.get("id"), now - 24 * 3600)).fetchall()
    conn.close()
    wall = _wall()
    items = [{
        "id": u["id"], "callsign": u["callsign"], "service": u["service"] or "other", "role": u["role"],
        "status": u["status"] or "unknown", "since": u["status_since"], "last_heard": u["last_heard"],
        "incident_id": u["incident_id"],
        "incident_title": (_soft_title(u["inc_kind"]) if wall and u["incident_id"] and _is_sensitive(
            {"sensitive": u["inc_sensitive"], "title": u["inc_title"], "summary": u["inc_summary"],
             "type": u["inc_type"]}) else u["inc_title"]),
        "incident_kind": u["inc_kind"],
        "incident_sensitive": bool(u["incident_id"]) and _is_sensitive(
            {"sensitive": u["inc_sensitive"], "title": u["inc_title"], "summary": u["inc_summary"],
             "type": u["inc_type"]}),
        "lat": u["inc_lat"], "lng": u["inc_lng"], "location": _scrub(u["location_text"]),
    } for u in rows]
    return jsonify({"items": items, "now": now})


@bp.route("/api/live/units/<int:uid>")
def api_unit(uid: int):
    owner = _owner()
    conn = _db()
    u = conn.execute("SELECT * FROM units WHERE id = ?", (uid,)).fetchone()
    if not u:
        conn.close()
        abort(404)
    since = int(time.time()) - 7 * 86400
    evs = conn.execute("""
        SELECT e.at, e.status, e.incident_id, e.call_id, e.location_text,
               i.title, i.kind, i.lat, i.lng, i.location_text inc_loc
        FROM unit_events e LEFT JOIN incidents i ON i.id = e.incident_id
        WHERE e.unit_id = ? AND e.at >= ? ORDER BY e.at""", (uid, since)).fetchall()
    # Activity: collapse consecutive events into status steps
    steps = []
    for e in evs:
        st = e["status"]
        key = (st, e["incident_id"])
        if steps and (steps[-1]["status"], steps[-1]["incident_id"]) == key:
            steps[-1]["until"] = e["at"]
            continue
        if steps:
            steps[-1]["until"] = e["at"]
        steps.append({"at": e["at"], "until": e["at"], "status": st, "incident_id": e["incident_id"],
                      "title": e["title"], "kind": e["kind"],
                      "location": _scrub(e["inc_loc"] or e["location_text"]),
                      "lat": e["lat"], "lng": e["lng"]})
    call_ids = [e["call_id"] for e in evs if e["call_id"]]
    calls = []
    if call_ids:
        q = ",".join("?" * len(call_ids[-200:]))
        calls = [_call_public(c, owner) for c in conn.execute(
            f"SELECT {CALL_COLS} FROM calls c WHERE c.id IN ({q}) ORDER BY c.start_time", call_ids[-200:])]
    inc = None
    if u["incident_id"]:
        i = conn.execute("SELECT id, title, kind, lat, lng, location_text FROM incidents WHERE id = ?",
                         (u["incident_id"],)).fetchone()
        inc = dict(i) if i else None
    conn.close()
    return jsonify({
        "id": u["id"], "callsign": u["callsign"], "service": u["service"], "role": u["role"],
        "status": u["status"] or "unknown", "since": u["status_since"], "last_heard": u["last_heard"],
        "location": _scrub(u["location_text"]), "incident": inc,
        "activity": [s for s in steps if s["status"] != "unknown" or s["incident_id"]],
        "radio": calls,
    })


@bp.route("/api/live/radio")
def api_radio():
    owner = _owner()
    since = request.args.get("since", type=int)
    before = request.args.get("before", type=int)
    limit = min(request.args.get("limit", type=int) or 60, 300)
    conn = _db()
    r = _region(conn, request.args.get("region"))
    where, args = ["c.region_id IS ?", "c.enriched_v2_at IS NOT NULL"], [r.get("id")]
    if since:
        where.append("c.start_time > ?")
        args.append(since)
    if before:
        where.append("c.start_time < ?")
        args.append(before)
    if request.args.get("channels"):
        chans = [int(x) for x in request.args["channels"].split(",") if x.strip().isdigit()]
        if chans:
            where.append("c.talkgroup NOT IN (%s)" % ",".join("?" * len(chans)))
            args += chans
    if request.args.get("hide_chatter") == "1":
        where.append("(c.incident_id IS NOT NULL OR c.incident_type NOT IN ('Radio Chatter'))")
    rows = conn.execute(f"""SELECT {CALL_COLS}, i.title inc_title, i.kind inc_kind, i.sensitive inc_sensitive,
                                   i.summary inc_summary, i.type inc_type
                            FROM calls c LEFT JOIN incidents i ON i.id = c.incident_id
                            WHERE {' AND '.join(where)}
                            ORDER BY c.start_time {'ASC' if since and not before else 'DESC'} LIMIT ?""",
                        args + [limit]).fetchall()
    wall = _wall()
    items = []
    for c in rows:
        d = _call_public(c, owner, {"id": c["incident_id"], "title": c["inc_title"], "kind": c["inc_kind"]}
                         if c["incident_id"] else None)
        sens = bool(c["incident_id"]) and _is_sensitive({"sensitive": c["inc_sensitive"], "title": c["inc_title"],
                                                          "summary": c["inc_summary"], "type": c["inc_type"]})
        if wall and sens:
            d = _soften_call(d, c["inc_kind"])
        elif sens:
            d["sensitive"] = True
            if d.get("incident"):
                d["incident"]["sensitive"] = True
        items.append(d)
    if since and not before:
        items.reverse()
    chans = conn.execute("""SELECT talkgroup, MAX(talkgroup_tag) tag, COUNT(*) n FROM calls
                            WHERE region_id IS ? AND start_time >= ? GROUP BY talkgroup ORDER BY n DESC LIMIT 60""",
                         (r.get("id"), int(time.time()) - 86400)).fetchall()
    conn.close()
    return jsonify({"items": items, "channels": [{"talkgroup": c["talkgroup"], "name": c["tag"] or f"TG {c['talkgroup']}",
                                                  "calls_24h": c["n"]} for c in chans],
                    "now": int(time.time())})


@bp.route("/api/live/codes")
def api_codes():
    conn = _db()
    r = _region(conn, request.args.get("region"))
    tally: dict[str, Counter] = defaultdict(Counter)
    for row in conn.execute("""SELECT codes_json FROM calls WHERE region_id IS ? AND start_time >= ?
                               AND codes_json IS NOT NULL AND codes_json != '[]'""",
                            (r.get("id"), int(time.time()) - 30 * 86400)):
        for c in _jl(row["codes_json"]):
            code = (c.get("code") or "").strip()
            if code and c.get("meaning"):
                tally[code.upper()][c["meaning"].strip()] += 1
    conn.close()
    items = sorted(({"code": k, "meaning": v.most_common(1)[0][0], "heard": sum(v.values())}
                    for k, v in tally.items()), key=lambda x: -x["heard"])
    return jsonify({"items": items[:150]})


@bp.route("/api/live/stats")
def api_stats():
    days = min(request.args.get("days", type=int) or 30, 365)
    kind = request.args.get("kind") or None
    now = int(time.time())
    tz = A_TZ()
    conn = _db()
    r = _region(conn, request.args.get("region"))
    args = [r.get("id"), now - days * 86400]
    kw = ""
    if kind:
        kw = " AND kind = ?"
        args.append(kind)
    incs = conn.execute(f"""SELECT * FROM incidents WHERE region_id IS ? AND first_call_at >= ?{kw}""",
                        args).fetchall()
    by_hour, by_wd, by_day = [0] * 24, [0] * 7, Counter()
    streets, places, crash_spots = Counter(), Counter(), defaultdict(list)
    for i in incs:
        dt = datetime.fromtimestamp(i["first_call_at"], tz)
        by_hour[dt.hour] += 1
        by_wd[dt.weekday()] += 1
        night = (dt - timedelta(hours=6)).date().isoformat()   # "night of" grouping
        by_day[night] += 1
        if i["street"]:
            streets[i["street"].strip()] += 1
        if i["geo_precision"] == "place" and i["location_text"]:
            places[i["location_text"].split(",")[0].strip()] += 1
        if i["kind"] == "traffic" and i["street"] and i["cross_street"]:
            crash_spots[f"{i['street']} & {i['cross_street']}"].append(dt.hour)
    ndays = max(1, min(days, (now - min([i["first_call_at"] for i in incs], default=now)) // 86400 + 1))

    def tod(h):
        return "Overnight" if h < 6 else "Morning" if h < 12 else "Afternoon" if h < 18 else "Evening"
    # Response: first dispatched/en_route -> first on_scene per (unit, incident)
    resp = defaultdict(list)
    ids = [i["id"] for i in incs]
    city_of = {i["id"]: (i["city"] or "Unknown") for i in incs}
    for chunk in range(0, len(ids), 500):
        part = ids[chunk:chunk + 500]
        q = ",".join("?" * len(part))
        first = {}
        for e in conn.execute(f"""SELECT unit_id, incident_id, status, MIN(at) at FROM unit_events
                                  WHERE incident_id IN ({q}) AND status IN ('dispatched','en_route','on_scene')
                                  GROUP BY unit_id, incident_id, status""", part):
            first.setdefault((e["unit_id"], e["incident_id"]), {})[e["status"]] = e["at"]
        for (uid, iid), st in first.items():
            t0 = min([st[k] for k in ("dispatched", "en_route") if k in st], default=None)
            t1 = st.get("on_scene")
            if t0 and t1 and 30 <= t1 - t0 <= 3600:
                h = datetime.fromtimestamp(t0, tz).hour
                mins = (t1 - t0) / 60
                resp[(tod(h), city_of[iid])].append(mins)
                resp[(tod(h), "All")].append(mins)
                resp[("All day", city_of[iid])].append(mins)
                resp[("All day", "All")].append(mins)
    top_cities = sorted({k[1] for k in resp if k[1] != "All"},
                        key=lambda c: -len(resp.get(("All day", c), [])))[:4]
    response = {"cities": top_cities + ["All"], "rows": []}
    for t in ["Overnight", "Morning", "Afternoon", "Evening", "All day"]:
        row = {"tod": t}
        for c in top_cities + ["All"]:
            v = resp.get((t, c))
            row[c] = round(statistics.median(v), 1) if v and len(v) >= 3 else None
        response["rows"].append(row)
    allv = resp.get(("All day", "All"), [])
    response["median"] = round(statistics.median(allv), 1) if allv else None
    response["samples"] = len(allv)

    def top(sort_key, filt=lambda i: True, n=10):
        rows = sorted((i for i in incs if filt(i)), key=sort_key, reverse=True)[:n]
        return [{"id": i["id"], "title": _soft_title(i["kind"]) if _wall() and _is_sensitive(i) else i["title"],
                 "sensitive": _is_sensitive(i) and not _wall(),
                 "at": i["first_call_at"], "kind": i["kind"],
                 "location": _scrub(i["location_text"]), "calls": i["call_count"]} for i in rows]
    sev = {"critical": 4, "high": 3, "medium": 2, "low": 1}
    unit_n = Counter()
    for chunk in range(0, len(ids), 500):
        part = ids[chunk:chunk + 500]
        q = ",".join("?" * len(part))
        for e in conn.execute(f"""SELECT incident_id, COUNT(DISTINCT unit_id) n FROM unit_events
                                  WHERE incident_id IN ({q}) GROUP BY incident_id""", part):
            unit_n[e["incident_id"]] = e["n"]
    conn.close()

    def kw_filter(*words):
        return lambda i: any(w in f"{i['title']} {i['type']} {i['summary']}".lower() for w in words)
    lists = {
        "serious": top(lambda i: (sev.get(i["severity"], 0), unit_n[i["id"]], i["call_count"]),
                       lambda i: sev.get(i["severity"], 0) >= 3),
        "pursuits": top(lambda i: i["call_count"], kw_filter("pursuit", "chase", "fled", "fleeing", "evading")),
        "fires": top(lambda i: i["call_count"], lambda i: i["kind"] == "fire"),
        "traffic": top(lambda i: (unit_n[i["id"]], i["call_count"]), lambda i: i["kind"] == "traffic"),
        "animals": top(lambda i: i["call_count"], lambda i: i["notable"] == "animal" or kw_filter(
            "animal", "dog", "cow", "horse", "cattle", "snake", "goat", "livestock", "loose")(i)),
        "funniest": top(lambda i: i["call_count"], lambda i: i["notable"] == "funny"),
        "strangest": top(lambda i: i["call_count"], lambda i: i["notable"] == "strange"),
        "most_units": top(lambda i: unit_n[i["id"]]),
        "most_calls": top(lambda i: i["call_count"]),
        "longest": top(lambda i: (i["last_call_at"] or 0) - (i["first_call_at"] or 0)),
    }
    for k in ("most_units", "serious", "traffic"):
        for it in lists[k]:
            it["units"] = unit_n[it["id"]]
    for it in lists["longest"]:
        src = next(i for i in incs if i["id"] == it["id"])
        it["minutes"] = round(((src["last_call_at"] or 0) - (src["first_call_at"] or 0)) / 60)
    wd_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    return jsonify({
        "days": days, "total": len(incs), "per_day": round(len(incs) / ndays, 1),
        "by_hour": by_hour, "by_weekday": [{"day": wd_names[i], "n": by_wd[i]} for i in range(7)],
        "busiest_nights": [{"night": d, "n": n} for d, n in by_day.most_common(3)],
        "streets": [{"name": s, "n": n} for s, n in streets.most_common(8)],
        "places": [{"name": s, "n": n} for s, n in places.most_common(8)],
        "crash_spots": [{"name": s, "n": len(h), "typical": tod(statistics.median(h))}
                        for s, h in sorted(crash_spots.items(), key=lambda kv: -len(kv[1]))[:8]],
        "response": response, "lists": lists,
        "kinds": Counter(i["kind"] or "other" for i in incs),
    })


def _last_call_public(row):
    if not row:
        return None
    d = dict(row)
    if _wall() and d.get("incident_id"):
        conn = _db()
        inc = conn.execute("SELECT * FROM incidents WHERE id = ?", (d["incident_id"],)).fetchone()
        conn.close()
        if inc and _is_sensitive(inc):
            d.update(call_line=f"Units are handling a {_soft_title(inc['kind']).lower()}.",
                     incident_title=_soft_title(inc["kind"]))
    elif d.get("incident_id"):
        conn = _db()
        inc = conn.execute("SELECT * FROM incidents WHERE id = ?", (d["incident_id"],)).fetchone()
        conn.close()
        d["incident_sensitive"] = bool(inc) and _is_sensitive(inc)
    return d


@bp.route("/api/live/replay")
def api_replay():
    """Calls-per-5-minutes histogram for a day plus the call index, so the
    client can scrub through time and re-query incidents?at=..."""
    tz = A_TZ()
    day = request.args.get("day")
    try:
        d0 = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=tz) if day else \
            datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    except ValueError:
        abort(400)
    start, end = int(d0.timestamp()), int((d0 + timedelta(days=1)).timestamp())
    owner = _owner()
    conn = _db()
    r = _region(conn, request.args.get("region"))
    rows = conn.execute(f"""SELECT {CALL_COLS} FROM calls c WHERE c.region_id IS ? AND c.start_time >= ?
                            AND c.start_time < ? AND c.enriched_v2_at IS NOT NULL ORDER BY c.start_time""",
                        (r.get("id"), start, end)).fetchall()
    conn.close()
    bins = [0] * 288
    for c in rows:
        bins[min(287, max(0, (c["start_time"] - start) // 300))] += 1
    calls = [{"id": c["id"], "at": c["start_time"], "dur": c["duration_sec"],
              "channel": c["talkgroup_tag"] or f"TG {c['talkgroup']}", "line": _scrub(c["call_line"]),
              "incident_id": c["incident_id"], "audio": _audio_url(c, owner)} for c in rows]
    return jsonify({"day": d0.date().isoformat(), "start": start, "end": end, "bins": bins, "calls": calls})


@bp.route("/api/live/report", methods=["POST"])
def api_report():
    body = request.get_json(silent=True) or {}
    reason = str(body.get("reason") or "")[:60]
    note = str(body.get("note") or "")[:1000]
    if not reason:
        abort(400)
    conn = _db()
    conn.execute("INSERT INTO call_reports (call_id, incident_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?)",
                 (body.get("call_id"), body.get("incident_id"), reason, note, int(time.time())))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@bp.route("/api/live/presence", methods=["POST"])
def api_presence():
    body = request.get_json(silent=True) or {}
    cid = str(body.get("client_id") or "")[:64]
    now = int(time.time())
    conn = _db()
    r = _region(conn, body.get("region"))
    if cid:
        conn.execute("INSERT OR REPLACE INTO presence (client_id, region_id, seen_at) VALUES (?, ?, ?)",
                     (cid, r.get("id"), now))
        conn.execute("DELETE FROM presence WHERE seen_at < ?", (now - 600,))
        conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM presence WHERE region_id IS ? AND seen_at >= ?",
                     (r.get("id"), now - 75)).fetchone()[0]
    conn.close()
    return jsonify({"watching": max(1, n)})


# --- weather / warnings (NWS, no key; cached) ---------------------------------
_WX_CACHE: dict[str, tuple[float, dict]] = {}
_WX_LOCK = threading.Lock()


def _nws(url: str, ttl: int):
    with _WX_LOCK:
        hit = _WX_CACHE.get(url)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    r = requests.get(url, headers={**UA, "Accept": "application/geo+json"}, timeout=10)
    r.raise_for_status()
    data = r.json()
    with _WX_LOCK:
        _WX_CACHE[url] = (time.time(), data)
    return data


@bp.route("/api/live/weather")
def api_weather():
    conn = _db()
    r = _region(conn, request.args.get("region"))
    conn.close()
    lat, lng = r.get("default_lat"), r.get("default_lng")
    if lat is None:
        return jsonify({})
    out: dict = {}
    try:
        pt = _nws(f"https://api.weather.gov/points/{lat:.4f},{lng:.4f}", 86400)["properties"]
        fc = _nws(pt["forecast"], 1800)["properties"]["periods"][:3]
        out["forecast"] = [{"name": p["name"], "temp": p["temperature"], "short": p["shortForecast"],
                            "pop": (p.get("probabilityOfPrecipitation") or {}).get("value"),
                            "icon": p.get("icon"), "is_day": p.get("isDaytime")} for p in fc]
        out["forecast_url"] = f"https://forecast.weather.gov/MapClick.php?lat={lat}&lon={lng}"
        stations = _nws(pt["observationStations"], 86400)["features"]
        if stations:
            ob = _nws(stations[0]["id"] + "/observations/latest", 600)["properties"]

            def f(v):
                x = (ob.get(v) or {}).get("value")
                return None if x is None else round(x * 9 / 5 + 32)
            wind = (ob.get("windSpeed") or {}).get("value")
            out["now"] = {"temp": f("temperature"), "feels": f("heatIndex") or f("windChill") or f("temperature"),
                          "text": ob.get("textDescription"), "humidity": round((ob.get("relativeHumidity") or {}).get("value") or 0),
                          "wind_mph": None if wind is None else round(wind * 0.621371),
                          "wind_dir": _compass((ob.get("windDirection") or {}).get("value"))}
    except Exception as e:
        out["error"] = str(e)[:120]
    try:
        al = _nws(f"https://api.weather.gov/alerts/active?point={lat:.4f},{lng:.4f}", 300)
        out["alerts"] = [{"event": a["properties"]["event"], "headline": a["properties"]["headline"],
                          "severity": a["properties"]["severity"], "ends": a["properties"].get("ends"),
                          "geometry": a.get("geometry")} for a in al.get("features", [])]
    except Exception:
        out["alerts"] = []
    return jsonify(out)


def _compass(deg):
    if deg is None:
        return None
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][
        int((deg % 360) / 22.5 + 0.5) % 16]
