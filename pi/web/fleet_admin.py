"""
Station requests, admin sign-in and fleet management (hub only).

Public
  /live/<region>/join          the "add my station to jafo.live" form (live.py / live_edge.py render it)
  POST /api/live/join          stores a request (edges proxy /api/live/* here)
  GET  /api/live/reverse       lat,lng -> "City, State" for the form's "Use my location"

Admin (all gated by app._admin_ok, i.e. the jafo_admin cookie or JAFO_ADMIN_TOKEN)
  /admin/login                 Sign in with Google (allow-listed emails) or the admin token
  /admin/auth/google[/callback], /admin/logout
  /admin/stations              Requests · Stations · Admins
  /api/admin/requests, /api/admin/requests/<id>/approve|decline
  /api/admin/stations/<id>/rotate|status
  /api/admin/admins            list / add / remove admin emails

Google sign-in needs JAFO_GOOGLE_CLIENT_ID + JAFO_GOOGLE_CLIENT_SECRET in the hub
.env, and the redirect URI  <JAFO_PUBLIC_URL>/admin/auth/google/callback  registered
on that OAuth client. Owners (JAFO_ADMIN_EMAILS, comma-separated) can always sign
in and can't be removed in the UI; others are added on the Admins tab.
Node tokens are shown once at approval/rotation and stored only as sha256.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.parse

import requests
from flask import Blueprint, abort, jsonify, make_response, redirect, render_template, request
from itsdangerous import BadSignature, URLSafeTimedSerializer

import app as A

bp = Blueprint("fleet_admin", __name__)

PUBLIC_URL = os.environ.get("JAFO_PUBLIC_URL", "https://jafo.live").rstrip("/")
G_ID = os.environ.get("JAFO_GOOGLE_CLIENT_ID", "").strip()
G_SECRET = os.environ.get("JAFO_GOOGLE_CLIENT_SECRET", "").strip()
OWNERS = {e.strip().lower() for e in os.environ.get("JAFO_ADMIN_EMAILS", "").split(",") if e.strip()}
REDIRECT = PUBLIC_URL + "/admin/auth/google/callback"
USER_COOKIE = "jafo_admin_user"

_secret = os.environ.get("JAFO_SECRET_KEY", "").strip() or \
    hashlib.sha256(("jafo-session-v1:" + (A.ADMIN_TOKEN or secrets.token_hex(16))).encode()).hexdigest()
_signer = URLSafeTimedSerializer(_secret, salt="jafo-admin")

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$")

_schema_done = False


def _db():
    conn = A.get_db()
    global _schema_done
    if not _schema_done:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS station_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT, email TEXT, location TEXT, lat REAL, lng REAL,
            hardware TEXT, radio_system TEXT, message TEXT,
            status TEXT DEFAULT 'pending',        -- pending | approved | declined
            node_id INTEGER, admin_note TEXT,
            created_at INTEGER, decided_at INTEGER, decided_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_station_requests_status ON station_requests(status, created_at);
        CREATE TABLE IF NOT EXISTS admin_users (
            email TEXT PRIMARY KEY, added_by TEXT, added_at INTEGER, last_login_at INTEGER
        );
        """)
        _schema_done = True
    return conn


# ----------------------------------------------------------------------------- identity

def _cookie_secure() -> bool:
    if request.is_secure or request.headers.get("X-Forwarded-Proto", "") == "https":
        return True
    pub = urllib.parse.urlparse(PUBLIC_URL)
    return pub.scheme == "https" and request.host.split(":")[0] == pub.hostname


def _who() -> str:
    """The signed-in admin's email, 'token' for token logins, '' if not admin."""
    if not A._admin_ok(request):
        return ""
    raw = request.cookies.get(USER_COOKIE, "")
    if raw:
        try:
            return _signer.loads(raw, max_age=A._ADMIN_COOKIE_MAX_AGE)
        except BadSignature:
            pass
    return "token"


def _need_admin():
    if not A._admin_ok(request):
        abort(401)


def _allowed(email: str, conn) -> bool:
    email = email.lower()
    if email in OWNERS:
        return True
    return bool(conn.execute("SELECT 1 FROM admin_users WHERE email = ?", (email,)).fetchone())


def _login_response(email: str, dest: str = "/admin/stations"):
    resp = make_response(redirect(dest))
    sec = _cookie_secure()
    resp.set_cookie(A._ADMIN_COOKIE_NAME, A._ADMIN_COOKIE_VALUE, max_age=A._ADMIN_COOKIE_MAX_AGE,
                    httponly=True, secure=sec, samesite="Lax")
    resp.set_cookie(USER_COOKIE, _signer.dumps(email), max_age=A._ADMIN_COOKIE_MAX_AGE,
                    httponly=True, secure=sec, samesite="Lax")
    return resp


@bp.route("/admin/login")
def admin_login():
    if A._admin_ok(request):
        return redirect("/admin/stations")
    return render_template("admin_login.html", google=bool(G_ID and G_SECRET and A.ADMIN_TOKEN),
                           token_enabled=bool(A.ADMIN_TOKEN), redirect_uri=REDIRECT,
                           error=request.args.get("error", ""))


@bp.route("/admin/auth/google")
def google_start():
    if not (G_ID and G_SECRET and A.ADMIN_TOKEN):
        return redirect("/admin/login?error=google-not-configured")
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    q = urllib.parse.urlencode({
        "client_id": G_ID, "redirect_uri": REDIRECT, "response_type": "code",
        "scope": "openid email profile", "state": state, "nonce": nonce, "prompt": "select_account",
    })
    resp = make_response(redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q))
    resp.set_cookie("jafo_oauth", _signer.dumps({"s": state, "n": nonce}), max_age=600,
                    httponly=True, secure=_cookie_secure(), samesite="Lax")
    return resp


def _b64json(seg: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)))


@bp.route("/admin/auth/google/callback")
def google_callback():
    try:
        st = _signer.loads(request.cookies.get("jafo_oauth", ""), max_age=600)
    except BadSignature:
        return redirect("/admin/login?error=expired")
    if not request.args.get("code") or not secrets.compare_digest(request.args.get("state", ""), st["s"]):
        return redirect("/admin/login?error=state")
    try:
        r = requests.post("https://oauth2.googleapis.com/token", timeout=10, data={
            "code": request.args["code"], "client_id": G_ID, "client_secret": G_SECRET,
            "redirect_uri": REDIRECT, "grant_type": "authorization_code"})
        r.raise_for_status()
        # The ID token came straight from Google's token endpoint over TLS, so
        # (per OpenID Connect Core 3.1.3.7) its claims can be trusted without
        # re-verifying the signature; we still check audience, issuer, expiry, nonce.
        claims = _b64json(r.json()["id_token"].split(".")[1])
    except Exception:
        return redirect("/admin/login?error=google")
    ok = (claims.get("aud") == G_ID and claims.get("iss") in ("accounts.google.com", "https://accounts.google.com")
          and int(claims.get("exp", 0)) > time.time() and claims.get("nonce") == st["n"]
          and claims.get("email_verified") in (True, "true"))
    email = (claims.get("email") or "").lower()
    if not ok or not email:
        return redirect("/admin/login?error=google")
    conn = _db()
    try:
        if not _allowed(email, conn):
            return redirect("/admin/login?error=not-allowed&email=" + urllib.parse.quote(email))
        conn.execute("INSERT INTO admin_users (email, added_by, added_at, last_login_at) VALUES (?, 'owner', ?, ?) "
                     "ON CONFLICT(email) DO UPDATE SET last_login_at = excluded.last_login_at",
                     (email, int(time.time()), int(time.time())))
        conn.commit()
    finally:
        conn.close()
    resp = _login_response(email)
    resp.delete_cookie("jafo_oauth")
    return resp


@bp.route("/admin/logout")
def admin_logout():
    resp = make_response(redirect("/admin/login"))
    resp.delete_cookie(A._ADMIN_COOKIE_NAME, samesite="Lax")
    resp.delete_cookie(USER_COOKIE, samesite="Lax")
    return resp


@bp.route("/admin/stations")
def admin_stations():
    if not A._admin_ok(request):
        return redirect("/admin/login")
    return render_template("admin_stations.html", who=_who(), owners=sorted(OWNERS),
                           google=bool(G_ID and G_SECRET))


# ----------------------------------------------------------------------------- public: join

_rate: dict[str, list[float]] = {}
_rate_lock = threading.Lock()
_NOM_LOCK, _NOM_LAST = threading.Lock(), [0.0]


def _ip() -> str:
    return (request.headers.get("X-Real-IP") or request.remote_addr or "").strip()


@bp.route("/api/live/join", methods=["POST"])
def api_join():
    b = request.get_json(silent=True) or {}
    if b.get("website"):               # honeypot: bots fill every field
        return jsonify({"ok": True})
    now = time.time()
    with _rate_lock:
        hits = [t for t in _rate.get(_ip(), []) if now - t < 3600]
        if len(hits) >= 5:
            return jsonify({"ok": False, "error": "Too many requests from here. Please try again later."}), 429
        _rate[_ip()] = hits + [now]

    def s(k, n):
        return re.sub(r"[\x00-\x08\x0b-\x1f]", "", str(b.get(k) or "")).strip()[:n]
    name, email, location = s("name", 120), s("email", 200).lower(), s("location", 200)
    if not name or not EMAIL_RE.match(email) or not location:
        return jsonify({"ok": False, "error": "Please fill in your name, a valid email and your location."}), 400
    lat = lng = None
    try:
        if b.get("lat") is not None and b.get("lng") is not None:
            lat, lng = round(float(b["lat"]), 2), round(float(b["lng"]), 2)   # ~1 km: town-level only
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                lat = lng = None
    except (TypeError, ValueError):
        lat = lng = None
    conn = _db()
    try:
        dup = conn.execute("SELECT id FROM station_requests WHERE email = ? AND status = 'pending'", (email,)).fetchone()
        if dup:
            conn.execute("""UPDATE station_requests SET name=?, location=?, lat=?, lng=?, hardware=?, radio_system=?,
                            message=?, created_at=? WHERE id=?""",
                         (name, location, lat, lng, s("hardware", 80), s("radio_system", 200), s("message", 2000),
                          int(now), dup["id"]))
        else:
            conn.execute("""INSERT INTO station_requests (name, email, location, lat, lng, hardware, radio_system,
                            message, status, created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)""",
                         (name, email, location, lat, lng, s("hardware", 80), s("radio_system", 200),
                          s("message", 2000), int(now)))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@bp.route("/api/live/reverse")
def api_reverse():
    """Coordinates -> 'Town, State' for the join form. Town-level only."""
    try:
        lat, lng = round(float(request.args["lat"]), 2), round(float(request.args["lng"]), 2)
    except (KeyError, ValueError):
        abort(400)
    try:
        with _NOM_LOCK:
            wait = 1.1 - (time.time() - _NOM_LAST[0])
            if wait > 0:
                time.sleep(wait)
            _NOM_LAST[0] = time.time()
            d = requests.get("https://nominatim.openstreetmap.org/reverse",
                             params={"lat": lat, "lon": lng, "format": "jsonv2", "zoom": 10},
                             headers={"User-Agent": "jafo-live/1.0"}, timeout=8).json()
        a = d.get("address") or {}
        town = a.get("city") or a.get("town") or a.get("village") or a.get("hamlet") or a.get("county") or ""
        state = a.get("state") or a.get("country") or ""
        label = ", ".join(x for x in (town, state) if x)
    except Exception:
        label = ""
    return jsonify({"label": label or f"{lat}, {lng}", "lat": lat, "lng": lng})


# ----------------------------------------------------------------------------- admin APIs

def _slug(s: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9-]", "", (s or "").strip().lower().replace(" ", "-"))).strip("-")[:48]


def _issue(conn, node_id: int) -> str:
    tok = secrets.token_urlsafe(32)
    conn.execute("UPDATE nodes SET token_hash = ? WHERE id = ?", (hashlib.sha256(tok.encode()).hexdigest(), node_id))
    return tok


@bp.route("/api/admin/requests")
def admin_requests():
    _need_admin()
    conn = _db()
    try:
        rows = [dict(r) for r in conn.execute(
            """SELECT q.*, n.slug AS node_slug FROM station_requests q LEFT JOIN nodes n ON n.id = q.node_id
               ORDER BY (q.status = 'pending') DESC, q.created_at DESC LIMIT 300""")]
        regions = [dict(r) for r in conn.execute(
            "SELECT id, slug, name, default_lat, default_lng FROM regions ORDER BY name")]
        nodes = [dict(r) for r in conn.execute(
            """SELECT n.id, n.slug, n.display_name, n.owner_email, n.status, n.created_at, n.last_seen_at, n.lat, n.lng,
                      n.notes, (n.token_hash IS NOT NULL) AS has_token, r.slug AS region_slug, r.name AS region_name
               FROM nodes n LEFT JOIN regions r ON r.id = n.region_id ORDER BY n.created_at DESC""")]
    finally:
        conn.close()
    return jsonify({"requests": rows, "regions": regions, "stations": nodes, "who": _who()})


@bp.route("/api/admin/requests/<int:rid>/approve", methods=["POST"])
def admin_approve(rid: int):
    _need_admin()
    b = request.get_json(silent=True) or {}
    node_slug = _slug(b.get("node_slug", ""))
    if not node_slug:
        return jsonify({"error": "station name (slug) required"}), 400
    conn = _db()
    try:
        q = conn.execute("SELECT * FROM station_requests WHERE id = ?", (rid,)).fetchone()
        if not q:
            abort(404)
        if conn.execute("SELECT 1 FROM nodes WHERE slug = ?", (node_slug,)).fetchone():
            return jsonify({"error": f"a station called {node_slug} already exists"}), 409
        now = int(time.time())
        if b.get("region_id"):
            reg = conn.execute("SELECT id, slug FROM regions WHERE id = ?", (int(b["region_id"]),)).fetchone()
            if not reg:
                return jsonify({"error": "unknown region"}), 400
            region_id, region_slug = reg["id"], reg["slug"]
        else:
            region_slug = _slug(b.get("region_slug", ""))
            region_name = str(b.get("region_name") or "").strip()[:120]
            if not region_slug or not region_name:
                return jsonify({"error": "pick a region or name a new one"}), 400
            if conn.execute("SELECT 1 FROM regions WHERE slug = ?", (region_slug,)).fetchone():
                return jsonify({"error": f"region {region_slug} already exists; pick it from the list"}), 409
            conn.execute("""INSERT INTO regions (slug, name, description, default_lat, default_lng, default_zoom, created_at)
                            VALUES (?, ?, ?, ?, ?, 11, ?)""",
                         (region_slug, region_name, f"Station request #{rid}", q["lat"], q["lng"], now))
            region_id = conn.execute("SELECT id FROM regions WHERE slug = ?", (region_slug,)).fetchone()["id"]
        display = str(b.get("display_name") or q["location"] or node_slug)[:120]
        conn.execute("""INSERT INTO nodes (slug, region_id, display_name, owner_email, lat, lng, notes, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)""",
                     (node_slug, region_id, display, q["email"], q["lat"], q["lng"],
                      f"request #{rid} · {q['name']}", now))
        node_id = conn.execute("SELECT id FROM nodes WHERE slug = ?", (node_slug,)).fetchone()["id"]
        tok = _issue(conn, node_id)
        conn.execute("""UPDATE station_requests SET status='approved', node_id=?, decided_at=?, decided_by=?,
                        admin_note=? WHERE id=?""", (node_id, now, _who(), str(b.get("note") or "")[:500], rid))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "node_slug": node_slug, "region_slug": region_slug, "token": tok,
                    "email": q["email"], "name": q["name"]})


@bp.route("/api/admin/requests/<int:rid>/decline", methods=["POST"])
def admin_decline(rid: int):
    _need_admin()
    b = request.get_json(silent=True) or {}
    conn = _db()
    try:
        conn.execute("UPDATE station_requests SET status='declined', decided_at=?, decided_by=?, admin_note=? WHERE id=?",
                     (int(time.time()), _who(), str(b.get("note") or "")[:500], rid))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@bp.route("/api/admin/stations/<int:nid>/rotate", methods=["POST"])
def admin_rotate(nid: int):
    _need_admin()
    conn = _db()
    try:
        n = conn.execute("SELECT slug, owner_email, display_name FROM nodes WHERE id = ?", (nid,)).fetchone()
        if not n:
            abort(404)
        tok = _issue(conn, nid)
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "node_slug": n["slug"], "token": tok, "email": n["owner_email"] or "",
                    "name": n["display_name"]})


@bp.route("/api/admin/stations/<int:nid>/status", methods=["POST"])
def admin_station_status(nid: int):
    _need_admin()
    st = (request.get_json(silent=True) or {}).get("status")
    if st not in ("active", "disabled"):
        abort(400)
    conn = _db()
    try:
        conn.execute("UPDATE nodes SET status = ? WHERE id = ?", (st, nid))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@bp.route("/api/admin/admins", methods=["GET", "POST", "DELETE"])
def admin_admins():
    _need_admin()
    conn = _db()
    try:
        if request.method == "POST":
            email = str((request.get_json(silent=True) or {}).get("email") or "").strip().lower()
            if not EMAIL_RE.match(email):
                return jsonify({"error": "enter a valid Google account email"}), 400
            conn.execute("INSERT OR IGNORE INTO admin_users (email, added_by, added_at) VALUES (?, ?, ?)",
                         (email, _who(), int(time.time())))
            conn.commit()
        elif request.method == "DELETE":
            email = str(request.args.get("email") or "").strip().lower()
            if email in OWNERS:
                return jsonify({"error": "owners are set in the hub .env (JAFO_ADMIN_EMAILS)"}), 400
            conn.execute("DELETE FROM admin_users WHERE email = ?", (email,))
            conn.commit()
        rows = [dict(r) for r in conn.execute("SELECT * FROM admin_users ORDER BY added_at")]
    finally:
        conn.close()
    seen = {r["email"] for r in rows}
    out = [{"email": e, "owner": True, "added_by": "hub .env", "added_at": None, "last_login_at": None}
           for e in sorted(OWNERS) if e not in seen]
    out += [{**r, "owner": r["email"] in OWNERS} for r in rows]
    return jsonify({"admins": out})
