"""
jafo — Web Push alerts for /live (installable app + phone notifications).

* VAPID keypair generated on first use at DATA_DIR/config/vapid_private.pem.
* Browsers subscribe via POST /api/live/push/subscribe with a level:
    priority — high/critical incidents only
    all      — medium and above
* A background notifier (hub only, one per host via a file lock) checks for
  newly opened/escalated incidents every 20 s and sends at most 20 alerts per
  subscription per hour. Gone subscriptions (404/410) are deleted.
* The service worker lives at /live/sw.js (scope /live/), the manifest at
  /live/manifest.webmanifest.
"""

from __future__ import annotations

import base64
import fcntl
import json
import os
import sys
import threading
import time

from flask import Blueprint, abort, jsonify, request, send_from_directory, Response

import app as A

bp = Blueprint("push", __name__)

KEY_PATH = A.DATA_DIR / "config" / "vapid_private.pem"
VAPID_SUB = os.environ.get("JAFO_VAPID_SUB", "https://jafo.live")
HOURLY_CAP = 20
SEV_RANK = {"unknown": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
LEVEL_MIN = {"priority": 3, "all": 2}

DDL = """
CREATE TABLE IF NOT EXISTS push_subs (
    endpoint    TEXT PRIMARY KEY,
    sub_json    TEXT NOT NULL,
    region_id   INTEGER,
    level       TEXT DEFAULT 'priority',
    created_at  INTEGER,
    last_ok     INTEGER,
    fails       INTEGER DEFAULT 0,
    window_start INTEGER DEFAULT 0,
    window_sent  INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_sent (
    incident_id INTEGER,
    level       TEXT,
    sent_at     INTEGER,
    PRIMARY KEY (incident_id, level)
);
"""


def _ensure():
    conn = A.get_db()
    conn.executescript(DDL)
    conn.commit()
    conn.close()


_vapid_lock = threading.Lock()
_pub_key_b64: str | None = None


def _vapid():
    """Return (pem_path, applicationServerKey b64url), creating keys once."""
    global _pub_key_b64
    with _vapid_lock:
        from py_vapid import Vapid
        from cryptography.hazmat.primitives import serialization
        if not KEY_PATH.exists():
            KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
            v = Vapid()
            v.generate_keys()
            v.save_key(str(KEY_PATH))
            os.chmod(KEY_PATH, 0o600)
        if _pub_key_b64 is None:
            v = Vapid.from_file(str(KEY_PATH))
            raw = v.public_key.public_bytes(serialization.Encoding.X962,
                                            serialization.PublicFormat.UncompressedPoint)
            _pub_key_b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
        return str(KEY_PATH), _pub_key_b64


# -----------------------------------------------------------------------------
# routes
# -----------------------------------------------------------------------------
@bp.route("/live/sw.js")
def service_worker():
    resp = send_from_directory(A.app.static_folder, "live-sw.js", mimetype="application/javascript")
    resp.headers["Service-Worker-Allowed"] = "/live/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@bp.route("/live/manifest.webmanifest")
def manifest():
    slug = request.args.get("region") or ""
    m = {
        "name": "JAFO Live", "short_name": "JAFO",
        "description": "Public-safety radio, live on a map.",
        "start_url": f"/live/{slug}" if slug else "/live", "scope": "/live/",
        "display": "standalone", "background_color": "#e9edf2", "theme_color": "#1f6fe0",
        "icons": [{"src": "/static/jafo-icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"}],
    }
    return Response(json.dumps(m), mimetype="application/manifest+json")


@bp.route("/api/live/push/key")
def push_key():
    try:
        _, pub = _vapid()
    except Exception as e:
        return jsonify({"error": f"push unavailable: {type(e).__name__}"}), 503
    return jsonify({"key": pub})


@bp.route("/api/live/push/subscribe", methods=["POST"])
def push_subscribe():
    body = request.get_json(silent=True) or {}
    sub = body.get("subscription") or {}
    endpoint = sub.get("endpoint")
    if not endpoint or not str(endpoint).startswith("https://") or not (sub.get("keys") or {}).get("p256dh"):
        abort(400)
    level = body.get("level") if body.get("level") in LEVEL_MIN else "priority"
    conn = A.get_db()
    r = conn.execute("SELECT id FROM regions WHERE slug = ?", (body.get("region"),)).fetchone()
    conn.execute("""INSERT INTO push_subs (endpoint, sub_json, region_id, level, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(endpoint) DO UPDATE SET sub_json = excluded.sub_json,
                      region_id = excluded.region_id, level = excluded.level, fails = 0""",
                 (endpoint, json.dumps(sub), r["id"] if r else None, level, int(time.time())))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "level": level})


@bp.route("/api/live/push/unsubscribe", methods=["POST"])
def push_unsubscribe():
    body = request.get_json(silent=True) or {}
    conn = A.get_db()
    conn.execute("DELETE FROM push_subs WHERE endpoint = ?", (body.get("endpoint"),))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# -----------------------------------------------------------------------------
# notifier
# -----------------------------------------------------------------------------
def _send(sub_row, payload: dict, pem: str) -> str:
    from pywebpush import webpush, WebPushException
    try:
        webpush(subscription_info=json.loads(sub_row["sub_json"]), data=json.dumps(payload),
                vapid_private_key=pem, vapid_claims={"sub": VAPID_SUB}, ttl=600, timeout=10)
        return "ok"
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        return "gone" if code in (404, 410) else f"err {code}"
    except Exception as e:
        return f"err {type(e).__name__}"


def notify_once(now: int | None = None) -> int:
    now = now or int(time.time())
    conn = A.get_db()
    subs = conn.execute("SELECT * FROM push_subs").fetchall()
    if not subs:
        conn.close()
        return 0
    pem, _ = _vapid()
    incs = conn.execute("""SELECT i.*, r.slug FROM incidents i LEFT JOIN regions r ON r.id = i.region_id
                           WHERE i.closed_at IS NULL AND i.first_call_at >= ?""", (now - 20 * 60,)).fetchall()
    sent = 0
    for inc in incs:
        rank = SEV_RANK.get(inc["severity"] or "unknown", 0)
        for level, minrank in LEVEL_MIN.items():
            if rank < minrank:
                continue
            if conn.execute("SELECT 1 FROM push_sent WHERE incident_id = ? AND level = ?",
                            (inc["id"], level)).fetchone():
                continue
            conn.execute("INSERT OR IGNORE INTO push_sent (incident_id, level, sent_at) VALUES (?, ?, ?)",
                         (inc["id"], level, now))
            conn.commit()
            body = ", ".join(x for x in [inc["location_text"], inc["city"]] if x) or "Location not given yet"
            if inc["summary"]:
                body += " — " + A._redact_pii(inc["summary"], [])[:140]
            payload = {"title": inc["title"], "body": body, "tag": f"inc-{inc['id']}",
                       "url": f"/live/{inc['slug'] or ''}#i/{inc['id']}", "kind": inc["kind"]}
            for s in subs:
                if s["level"] != level or (s["region_id"] and s["region_id"] != inc["region_id"]):
                    continue
                ws, wn = s["window_start"] or 0, s["window_sent"] or 0
                if now - ws >= 3600:
                    ws, wn = now, 0
                if wn >= HOURLY_CAP:
                    continue
                res = _send(s, payload, pem)
                if res == "ok":
                    sent += 1
                    conn.execute("UPDATE push_subs SET last_ok = ?, fails = 0, window_start = ?, window_sent = ? "
                                 "WHERE endpoint = ?", (now, ws, wn + 1, s["endpoint"]))
                elif res == "gone" or (s["fails"] or 0) >= 20:
                    conn.execute("DELETE FROM push_subs WHERE endpoint = ?", (s["endpoint"],))
                else:
                    conn.execute("UPDATE push_subs SET fails = fails + 1 WHERE endpoint = ?", (s["endpoint"],))
                conn.commit()
    conn.close()
    return sent


_lock_fh = None


def start_notifier():
    """Hub only; one notifier per host even with several gunicorn workers."""
    global _lock_fh
    if A._is_edge_node():
        return
    try:
        _lock_fh = open(A.DATA_DIR / "push-notifier.lock", "w")
        fcntl.flock(_lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return

    def loop():
        while True:
            try:
                n = notify_once()
                if n:
                    print(f"[push] sent {n} alert(s)", file=sys.stderr)
            except Exception as e:
                print(f"[push] notifier error: {e}", file=sys.stderr)
            time.sleep(20)
    threading.Thread(target=loop, name="push-notifier", daemon=True).start()


_ensure()
