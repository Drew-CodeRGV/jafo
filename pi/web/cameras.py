"""
jafo — TxDOT traffic cameras for /live.

TxDOT's district ITS site exposes a keyless camera catalog
(GetCctvStatusListByDistrict) and per-camera stills
(GetCctvSnapshotByIcdId → JSON-wrapped base64 JPEG, no CORS). We cache the
catalog for an hour and proxy stills with a 60 s cache. The proxy only serves
cameras present in the catalog, so it can't be used to reach anything else.

Region → TxDOT district: rgv → PHR (Pharr), austin → AUS. Override with
JAFO_TXDOT_DISTRICTS="slug:CODE,slug:CODE".
"""

from __future__ import annotations

import base64
import math
import os
import threading
import time
from datetime import datetime

import requests
from flask import Blueprint, Response, abort, jsonify, request

import app as A

bp = Blueprint("cameras", __name__)

ORIGIN = "https://its.txdot.gov/its/DistrictIts"
UA = {"User-Agent": "jafo/1.0 (public-safety radio observatory; +https://github.com/Drew-CodeRGV/jafo)",
      "Accept": "application/json"}
DISTRICTS = {"rgv": "PHR", "austin": "AUS"}
for pair in os.environ.get("JAFO_TXDOT_DISTRICTS", "").split(","):
    if ":" in pair:
        k, v = pair.split(":", 1)
        DISTRICTS[k.strip()] = v.strip().upper()

_lock = threading.Lock()
_catalog: dict[str, tuple[float, list[dict]]] = {}
_snaps: dict[tuple[str, str], tuple[float, bytes, str]] = {}


def catalog(district: str) -> list[dict]:
    with _lock:
        hit = _catalog.get(district)
        if hit and time.time() - hit[0] < 3600:
            return hit[1]
    r = requests.get(f"{ORIGIN}/GetCctvStatusListByDistrict", params={"districtCode": district},
                     headers=UA, timeout=40)
    r.raise_for_status()
    out, seen = [], set()
    for rows in (r.json().get("roadwayCctvStatuses") or {}).values():
        for row in rows or []:
            icd = str(row.get("icd_Id") or "").strip()
            lat, lng = row.get("latitude"), row.get("longitude")
            if not icd or icd in seen or not isinstance(lat, (int, float)) or not row.get("hasSnapshot", True):
                continue
            seen.add(icd)
            name = str(row.get("name") or icd)
            if name.upper().startswith(district + " "):
                name = name[len(district) + 1:]
            out.append({"id": icd, "district": district, "name": name.replace(" @ ", " at "),
                        "road": (row.get("equipLoc") or {}).get("roadway"), "dir": row.get("dirDescription"),
                        "lat": lat, "lng": row.get("longitude"),
                        "online": row.get("statusDescription") == "Device Online"})
    with _lock:
        _catalog[district] = (time.time(), out)
    return out


def _miles(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 7917.6 * math.asin(math.sqrt(h))


def nearby(region_slug: str, lat: float, lng: float, radius: float = 2.0, limit: int = 4) -> list[dict]:
    d = DISTRICTS.get(region_slug or "")
    if not d or lat is None:
        return []
    try:
        cams = [c for c in catalog(d) if c["online"]]
    except Exception:
        return []
    near = sorted(({**c, "distance_mi": round(_miles(lat, lng, c["lat"], c["lng"]), 2)} for c in cams),
                  key=lambda c: c["distance_mi"])
    return [_public(c) for c in near if c["distance_mi"] <= radius][:limit]


def _public(c: dict) -> dict:
    return {**c, "img": f"/api/live/cameras/{c['district']}/snapshot?id={requests.utils.quote(c['id'])}"}


@bp.route("/api/live/cameras")
def api_cameras():
    slug = request.args.get("region") or ""
    d = DISTRICTS.get(slug)
    if not d:
        return jsonify({"items": [], "district": None})
    try:
        cams = catalog(d)
    except Exception as e:
        return jsonify({"items": [], "error": str(e)[:120]}), 502
    near = request.args.get("near")
    if near:
        try:
            lat, lng = (float(x) for x in near.split(","))
        except ValueError:
            abort(400)
        return jsonify({"items": nearby(slug, lat, lng, request.args.get("radius", type=float) or 2.0,
                                        request.args.get("limit", type=int) or 4)})
    return jsonify({"district": d, "items": [_public(c) for c in cams if c["online"]]})


@bp.route("/api/live/cameras/<district>/snapshot")
def api_snapshot(district: str):
    icd = request.args.get("id") or ""
    district = district.upper()
    if district not in DISTRICTS.values():
        abort(404)
    try:
        if not any(c["id"] == icd for c in catalog(district)):
            abort(404)
    except requests.RequestException:
        abort(502)
    key = (district, icd)
    with _lock:
        hit = _snaps.get(key)
    if not hit or time.time() - hit[0] > 60:
        try:
            r = requests.get(f"{ORIGIN}/GetCctvSnapshotByIcdId", params={"icdId": icd, "districtCode": district},
                             headers=UA, timeout=20)
            r.raise_for_status()
            j = r.json()
            img = base64.b64decode(j.get("snippet") or "")
            if not img:
                abort(404)
            hit = (time.time(), img, j.get("timestampFormatted") or "")
            with _lock:
                _snaps[key] = hit
                if len(_snaps) > 400:  # bound memory
                    for k in sorted(_snaps, key=lambda k: _snaps[k][0])[:100]:
                        _snaps.pop(k, None)
        except requests.RequestException:
            if not hit:
                abort(502)
    resp = Response(hit[1], mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "public, max-age=60"
    resp.headers["X-Snapshot-Time"] = hit[2]
    age = None
    try:
        ts = datetime.strptime(hit[2], "%m/%d/%Y %I:%M %p").replace(tzinfo=_tz())
        age = int(time.time() - ts.timestamp())
    except ValueError:
        pass
    if age is not None:
        resp.headers["X-Snapshot-Age"] = str(age)
    return resp


def _tz():
    from zoneinfo import ZoneInfo
    return ZoneInfo(os.environ.get("JAFO_TZ", "America/Chicago"))
