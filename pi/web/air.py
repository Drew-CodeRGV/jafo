"""
jafo — /api/live/air: aircraft for the live map, made meaningful.

Builds on the hub's existing ADS-B feed (app.api_aircraft: local readsb merged
with adsb.lol, with per-aircraft trail history) and ACARS table, and adds:

  * role tagging — border (CBP/AMO), medical, police, military, news — from
    callsign patterns, the ADS-B military flag and the registered owner
    (adsbdb lookups, cached 24 h, done in a background thread so the API never
    waits on them);
  * circling detection from the trail (cumulative turn > 300° in a tight area);
  * near_incident — the closest open incident within 1.5 mi of a low aircraft
    (a helicopter circling a scene is the classic case);
  * recent ACARS messages;
  * ?demo=1 — a realistic synthetic sky so the UI can be designed at night.
"""

from __future__ import annotations

import math
import queue
import re
import threading
import time

import requests
from flask import Blueprint, jsonify, request

import app as A

bp = Blueprint("air", __name__)

ROLE_PATTERNS = [
    ("border", re.compile(r"CUSTOMS|BORDER|HOMELAND SECURITY|\bCBP\b|\bDHS\b|AIR AND MARINE", re.I)),
    ("medical", re.compile(r"AIR EVAC|AIR METHODS|\bPHI\b|MEDIC|LIFE ?FLIGHT|LIFENET|AIRLIFE|HOSPITAL|CARE ?FLIGHT|"
                           r"HALO|MED ?FLIGHT|AIR AMBULANCE|GUARDIAN FLIGHT|AEROCARE", re.I)),
    ("police", re.compile(r"POLICE|SHERIFF|PUBLIC SAFETY|\bDPS\b|STATE TROOPER|LAW ENFORCEMENT|CONSTABLE", re.I)),
    ("news", re.compile(r"\bNEWS\b|TELEVISION|BROADCAST|KRGV|KGBT|KVEO|KXAN|KVUE|KEYE", re.I)),
]
CALLSIGN_ROLES = [
    ("border", re.compile(r"^(OMAHA|CBP|AMO|MARCH|SKYWATCH)\d*", re.I)),
    ("medical", re.compile(r"^(EVAC|LIFE|MEDIC|AIRLIFE|HALO|MERCY|CAREFLT|LN|AE)\d", re.I)),
    ("police", re.compile(r"^(DPS|TXDPS|COP|AIR1|SHERIFF|PD)\d*", re.I)),
]

_owner_cache: dict[str, tuple[float, str | None]] = {}
_lookup_q: "queue.Queue[str]" = queue.Queue()
_lookup_started = False


def _lookup_worker():
    while True:
        reg = _lookup_q.get()
        try:
            r = requests.get(f"https://api.adsbdb.com/v0/aircraft/{reg}", timeout=8,
                             headers={"User-Agent": "jafo/1.0 (+https://github.com/Drew-CodeRGV/jafo)"})
            ac = ((r.json() or {}).get("response") or {}).get("aircraft") or {} if r.ok else {}
            _owner_cache[reg] = (time.time(), ac.get("registered_owner"))
        except Exception:
            _owner_cache[reg] = (time.time(), None)
        time.sleep(1.0)  # be gentle with the free API


def _owner(reg: str | None) -> str | None:
    global _lookup_started
    if not reg:
        return None
    hit = _owner_cache.get(reg)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]
    if not _lookup_started:
        _lookup_started = True
        threading.Thread(target=_lookup_worker, name="air-owner-lookup", daemon=True).start()
    if reg not in _owner_cache:
        _owner_cache[reg] = (0, None)   # mark queued
        _lookup_q.put(reg)
    return None


def _role(a: dict, owner: str | None) -> str | None:
    if a.get("is_military"):
        return "military"
    cs = (a.get("callsign") or "").strip()
    for role, rx in CALLSIGN_ROLES:
        if cs and rx.match(cs):
            return role
    for role, rx in ROLE_PATTERNS:
        if owner and rx.search(owner):
            return role
    return None


def _miles(a_lat, a_lng, b_lat, b_lng):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lng - a_lng) / 2) ** 2
    return 7917.6 * math.asin(math.sqrt(h))


def _bearing(a, b):
    y = math.sin(math.radians(b[1] - a[1])) * math.cos(math.radians(b[0]))
    x = (math.cos(math.radians(a[0])) * math.sin(math.radians(b[0])) -
         math.sin(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.cos(math.radians(b[1] - a[1])))
    return math.degrees(math.atan2(y, x))


def _circling(trail: list) -> bool:
    """trail: [[lat, lng, alt, ts], ...] oldest→newest."""
    pts = [p for p in trail if p[3] >= (trail[-1][3] - 600)] if trail else []
    if len(pts) < 6:
        return False
    turn, prev = 0.0, None
    for i in range(1, len(pts)):
        if _miles(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) < 0.02:
            continue
        b = _bearing(pts[i - 1], pts[i])
        if prev is not None:
            d = (b - prev + 540) % 360 - 180
            turn += abs(d)
        prev = b
    lats, lngs = [p[0] for p in pts], [p[1] for p in pts]
    span = _miles(min(lats), min(lngs), max(lats), max(lngs))
    return turn > 300 and span < 3.0


def _open_incidents(region_slug: str):
    conn = A.get_db()
    rows = conn.execute("""SELECT i.id, i.title, i.kind, i.lat, i.lng, i.sensitive, i.summary, i.type
                           FROM incidents i JOIN regions r ON r.id = i.region_id
                           WHERE r.slug = ? AND i.closed_at IS NULL AND i.lat IS NOT NULL""",
                        (region_slug,)).fetchall()
    conn.close()
    return rows


def _near_incident(a: dict, incs) -> dict | None:
    if a.get("lat") is None or (a.get("alt_ft") or 0) > 5000 or a.get("on_ground"):
        return None
    best = None
    for i in incs:
        d = _miles(a["lat"], a["lng"], i["lat"], i["lng"])
        if d <= 1.5 and (best is None or d < best[0]):
            best = (d, i)
    if not best:
        return None
    d, i = best
    try:
        import live
        title = live._soft_title(i["kind"]) if live._wall() and live._is_sensitive(i) else i["title"]
    except Exception:
        title = i["title"]
    return {"id": i["id"], "title": title, "kind": i["kind"], "distance_mi": round(d, 2)}


ROLE_LABEL = {"border": "Border Patrol / CBP", "medical": "Medical flight", "police": "Police aviation",
              "military": "Military", "news": "News helicopter"}
KIND_LABEL = {"helicopter": "Helicopter", "commercial": "Airliner", "heavy": "Heavy jet", "jet": "Jet",
              "light": "Light aircraft", "military": "Military", "uav": "Drone", "glider": "Glider",
              "balloon": "Balloon"}


def _label(a: dict) -> str:
    who = ROLE_LABEL.get(a.get("role")) or KIND_LABEL.get(a.get("kind")) or "Aircraft"
    bits = [who]
    if a.get("type"):
        bits.append(a["type"])
    if a.get("on_ground"):
        bits.append("on the ground")
    elif a.get("alt_ft") is not None:
        bits.append(f"{a['alt_ft']:,} ft")
    return " · ".join(bits)


def _acars(region_slug: str) -> dict:
    conn = A.get_db()
    try:
        rows = conn.execute("""SELECT received_at, flight, tail, label, text FROM acars_messages
                               WHERE received_at >= ? ORDER BY received_at DESC LIMIT 30""",
                            (int(time.time()) - 6 * 3600,)).fetchall()
    except Exception:
        rows = []
    conn.close()
    msgs = [{"at": r["received_at"], "flight": (r["flight"] or "").strip(), "tail": (r["tail"] or "").strip(),
             "label": r["label"], "text": (r["text"] or "")[:400]} for r in rows]
    return {"active": bool(msgs and time.time() - msgs[0]["at"] < 300), "messages": msgs}


@bp.route("/api/ingest/acars", methods=["POST"])
def ingest_acars():
    """Edge nodes push decoded ACARS here (Bearer node token). Body:
    {"messages": [{received_at, freq_mhz, channel, mode, tail, flight, label,
    block_id, msg_no, text}, ...]} — duplicates are skipped."""
    nid = A._node_id_from_token(request)
    if nid is None:
        return jsonify({"error": "bad token"}), 401
    body = request.get_json(silent=True) or {}
    msgs = body.get("messages") or []
    if not isinstance(msgs, list) or len(msgs) > 2000:
        return jsonify({"error": "bad batch"}), 400
    conn = A.get_db()
    cols = {r[1] for r in conn.execute("PRAGMA table_info(acars_messages)")}
    if "node_id" not in cols:
        conn.execute("ALTER TABLE acars_messages ADD COLUMN node_id INTEGER")
    conn.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_acars_dedupe
                    ON acars_messages(received_at, IFNULL(tail,''), IFNULL(label,''), IFNULL(msg_no,''), IFNULL(block_id,''))""")
    n = 0
    for m in msgs:
        try:
            cur = conn.execute("""INSERT OR IGNORE INTO acars_messages
                (received_at, freq_mhz, channel, mode, tail, flight, label, block_id, msg_no, text, raw_json, node_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)""",
                (int(m["received_at"]), m.get("freq_mhz"), m.get("channel"), m.get("mode"), m.get("tail"),
                 m.get("flight"), m.get("label"), m.get("block_id"), m.get("msg_no"),
                 (m.get("text") or "")[:4000], nid))
            n += cur.rowcount
        except (KeyError, TypeError, ValueError):
            continue
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "inserted": n, "received": len(msgs)})


@bp.route("/api/live/air")
def api_air():
    region = request.args.get("region") or "rgv"
    if request.args.get("demo") == "1":
        return jsonify(_demo(region))
    resp = A.api_aircraft()
    data = (resp[0] if isinstance(resp, tuple) else resp).get_json() or {}
    incs = _open_incidents(region)
    out = []
    with A._AIRCRAFT_HISTORY_LOCK:
        hist = {k: list(v) for k, v in A._AIRCRAFT_HISTORY.items()}
    for a in data.get("aircraft") or []:
        rec = {
            "hex": a.get("icao24"), "callsign": (a.get("callsign") or "").strip() or None,
            "reg": a.get("registration"), "type": a.get("type_code"), "desc": a.get("description"),
            "kind": a.get("kind"), "lat": a.get("lat"), "lng": a.get("lon"), "alt_ft": a.get("altitude_ft"),
            "gs_kt": a.get("velocity_kt"), "track": a.get("track_deg"), "vs_fpm": a.get("vertical_rate_fpm"),
            "squawk": a.get("squawk"), "emergency": a.get("squawk") if a.get("emergency") else None,
            "on_ground": bool(a.get("on_ground")), "airport_event": a.get("airport_event"),
            "source": a.get("source"), "is_military": a.get("is_military"),
        }
        owner = _owner(rec["reg"]) if (rec["kind"] in ("helicopter", "light", "military") or
                                       a.get("is_military")) else None
        rec["operator"] = owner
        rec["role"] = _role({**rec, "is_military": a.get("is_military")}, owner)
        h = hist.get(rec["hex"]) or []
        rec["trail"] = [[lat, lon, alt, t] for (t, lat, lon, alt) in h][-90:]
        rec["circling"] = _circling(rec["trail"])
        rec["near_incident"] = _near_incident(rec, incs)
        rec["seen_sec"] = int(time.time() - h[-1][0]) if h else None
        rec["interesting"] = bool(rec["role"] or rec["emergency"] or rec["kind"] in ("helicopter", "military") or
                                  rec["circling"] or rec["near_incident"])
        rec["label"] = _label(rec)
        rec.pop("is_military", None)
        out.append(rec)
    out.sort(key=lambda r: (not r["emergency"], not r["interesting"], r["alt_ft"] or 99999))
    return jsonify({
        "now": int(time.time()), "demo": False, "aircraft": out,
        "airports": data.get("airports") or [], "acars": _acars(region),
        "counts": _counts(out), "source": data.get("data_source"),
    })


def _counts(out):
    return {"total": len(out), "airborne": sum(1 for a in out if not a["on_ground"]),
            "interesting": sum(1 for a in out if a["interesting"]),
            "emergency": sum(1 for a in out if a["emergency"]),
            "helicopters": sum(1 for a in out if a["kind"] == "helicopter")}


# -----------------------------------------------------------------------------
# demo sky
# -----------------------------------------------------------------------------
def _orbit(c_lat, c_lng, r_mi, period, t, phase=0.0):
    ang = 2 * math.pi * ((t / period) + phase)
    dlat = (r_mi / 69.0) * math.cos(ang)
    dlng = (r_mi / (69.0 * math.cos(math.radians(c_lat)))) * math.sin(ang)
    trk = (math.degrees(ang) + 90) % 360
    return c_lat + dlat, c_lng + dlng, trk


def _leg(a, b, period, t, alt0, alt1):
    f = (t % period) / period
    lat = a[0] + (b[0] - a[0]) * f
    lng = a[1] + (b[1] - a[1]) * f
    trk = (_bearing(a, b) + 360) % 360
    return lat, lng, trk, int(alt0 + (alt1 - alt0) * f)


def _demo(region_slug: str) -> dict:
    now = time.time()
    conn = A.get_db()
    r = conn.execute("SELECT * FROM regions WHERE slug = ?", (region_slug,)).fetchone()
    inc = conn.execute("""SELECT i.id, i.title, i.kind, i.lat, i.lng FROM incidents i JOIN regions r ON r.id = i.region_id
                          WHERE r.slug = ? AND i.lat IS NOT NULL ORDER BY i.last_call_at DESC LIMIT 1""",
                       (region_slug,)).fetchone()
    conn.close()
    clat, clng = (r["default_lat"], r["default_lng"]) if r else (26.2, -98.2)
    target = (inc["lat"], inc["lng"]) if inc else (clat + 0.02, clng)
    fleet = [
        # hex, callsign, reg, type, kind, role, motion
        ("a1c0e1", "OMAHA22", "N974CB", "AS50", "helicopter", "border",
         lambda t: (*_orbit(clat - 0.10, clng - 0.06, 0.6, 140, t), 750)),
        ("a4b2f7", "DPS12", "N812DP", "B407", "helicopter", "police",
         lambda t: (*_orbit(target[0], target[1], 0.35, 95, t, 0.3), 1100)),
        ("a8e5d2", "EVAC54", "N554AE", "EC35", "helicopter", "medical",
         lambda t: _leg_alt((clat + 0.01, clng - 0.04), (clat - 0.04, clng + 0.21), 700, t, 1500, 1500)),
        ("a0f3c9", "AAL2611", "N912AN", "B738", "commercial", None,
         lambda t: _leg_alt((clat + 0.45, clng + 0.10), (26.1758, -98.2386), 900, t, 11000, 600)),
        ("aa21d4", "UAL4402", "N87353", "E145", "jet", None,
         lambda t: _leg_alt((26.2284, -97.6544), (26.65, -97.30), 800, t, 800, 14000)),
        ("ae0812", "RCH481", "05-1427", "C17", "heavy", "military",
         lambda t: _leg_alt((clat - 0.4, clng - 0.9), (clat + 0.3, clng + 0.9), 1500, t, 21000, 21000)),
        ("a33b17", "N733RG", "N733RG", "C172", "light", None,
         lambda t: (*_orbit(clat + 0.18, clng + 0.03, 1.4, 420, t, 0.6), 2400)),
        ("a5d9e0", "N1250X", "N1250X", "PA28", "light", None,
         lambda t: _leg_alt((clat - 0.2, clng + 0.4), (clat + 0.1, clng - 0.3), 1200, t, 3500, 3500)),
    ]
    out = []
    for hexid, cs, reg, typ, kind, role, mot in fleet:
        lat, lng, trk, alt = mot(now)
        trail = []
        for k in range(30, 0, -1):
            tt = now - k * 20
            la, ln, _, al = mot(tt)
            trail.append([la, ln, al, int(tt)])
        trail.append([lat, lng, alt, int(now)])
        rec = {"hex": hexid, "callsign": cs, "reg": reg, "type": typ, "desc": None, "kind": kind,
               "operator": {"border": "U S CUSTOMS AND BORDER PROTECTION", "police": "TEXAS DEPARTMENT OF PUBLIC SAFETY",
                            "medical": "AIR EVAC EMS INC", "military": "UNITED STATES AIR FORCE"}.get(role),
               "role": role, "lat": lat, "lng": lng, "alt_ft": alt, "gs_kt": 95 if kind == "helicopter" else 140 if kind == "light" else 280,
               "track": round(trk), "vs_fpm": 0, "squawk": "7700" if cs == "N1250X" else "1200",
               "emergency": "7700" if cs == "N1250X" else None, "on_ground": False, "airport_event": None,
               "source": "demo", "seen_sec": 1, "trail": trail}
        rec["circling"] = _circling(trail)
        rec["near_incident"] = ({"id": inc["id"], "title": inc["title"], "kind": inc["kind"],
                                 "distance_mi": round(_miles(lat, lng, inc["lat"], inc["lng"]), 2)}
                                if inc and cs == "DPS12" else None)
        rec["interesting"] = bool(role or rec["emergency"] or kind == "helicopter" or rec["circling"])
        rec["label"] = _label(rec)
        out.append(rec)
    out.sort(key=lambda r: (not r["emergency"], not r["interesting"], r["alt_ft"] or 99999))
    ac = {"active": True, "messages": [
        {"at": int(now) - 40, "flight": "AA2611", "tail": "N912AN", "label": "H1", "text": "ETA KMFE 0712Z FUEL 8.4 GATE 3 REQ"},
        {"at": int(now) - 190, "flight": "UA4402", "tail": "N87353", "label": "Q0", "text": "OFF KHRL 0658Z"},
        {"at": int(now) - 420, "flight": "AA2611", "tail": "N912AN", "label": "5Z", "text": "/WX KMFE 0653Z 14008KT 10SM SCT035 22/17 A2998"},
    ]}
    return {"now": int(now), "demo": True, "aircraft": out, "airports": [
        {"icao": "KMFE", "name": "McAllen Intl", "lat": 26.17578, "lon": -98.23861},
        {"icao": "KHRL", "name": "Valley Intl (Harlingen)", "lat": 26.22844, "lon": -97.65436},
        {"icao": "KBRO", "name": "Brownsville/SPI", "lat": 25.90681, "lon": -97.42589}],
        "acars": ac, "counts": _counts(out), "source": "demo"}


def _leg_alt(a, b, period, t, alt0, alt1):
    lat, lng, trk, alt = _leg(a, b, period, t, alt0, alt1)
    return lat, lng, trk, alt
