"""
jafo — /live on an EDGE node (jafo.local).

The incidents/units model is built on the hub (enricher v2), so the edge
renders the same /live and wall pages locally and proxies every
/api/live/* call to the hub. Audio URLs (/audio/...) are already served or
proxied by the edge app itself. The Referer header is forwarded so wall
displays get the same sensitive-incident softening as on the hub.

Registered by app.py instead of live.py/push.py/cameras.py when
JAFO_HUB_URL is set (edge role).
"""

from __future__ import annotations

import os
import time

import requests
from flask import Blueprint, Response, abort, current_app, redirect, render_template, request

bp = Blueprint("live_edge", __name__)

HUB = os.environ.get("JAFO_HUB_URL", "").strip().rstrip("/")
NODE_SLUG = os.environ.get("JAFO_NODE_SLUG", "").strip()
TZ = os.environ.get("JAFO_TZ", "America/Chicago")
WALLS = ("command", "newsroom", "grid", "pulse", "river")
CONCEPTS = ("river", "brief", "console", "near")
LANDING = os.environ.get("JAFO_LANDING", "live").strip().lower()   # live | classic
_cache: dict[str, tuple[float, object]] = {}
_proxy_cache: dict[tuple, tuple] = {}
PROXY_TTL = float(os.environ.get("JAFO_EDGE_PROXY_TTL", "4"))


def _hub_json(path: str, ttl: int = 600, **params):
    key = path + repr(sorted(params.items()))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    r = requests.get(HUB + path, params=params, timeout=15)
    r.raise_for_status()
    data = r.json()
    _cache[key] = (time.time(), data)
    return data


def _my_region() -> str:
    """This node's region slug, looked up on the hub (follows relocations)."""
    override = os.environ.get("JAFO_LIVE_REGION", "").strip()
    if override:
        return override
    try:
        nodes = _hub_json("/api/fleet/nodes")
        for n in nodes if isinstance(nodes, list) else nodes.get("nodes", []):
            if n.get("slug") == NODE_SLUG and n.get("region_slug"):
                return n["region_slug"]
    except Exception:
        pass
    return "rgv"


def _region(slug: str) -> dict:
    try:
        return _hub_json("/api/live/config", region=slug).get("region") or {"slug": slug, "name": slug}
    except Exception:
        return {"slug": slug, "name": slug}


def _regions() -> list[dict]:
    try:
        data = _hub_json("/api/regions")
        rows = data if isinstance(data, list) else data.get("regions", [])
        return [{"slug": r["slug"], "name": r.get("name") or r["slug"]} for r in rows if r.get("slug")]
    except Exception:
        return []


@bp.before_app_request
def _landing():
    # jafo.local opens on the live map like jafo.live; the classic dashboard
    # stays one click away at /classic.
    if request.path == "/" and LANDING == "live" and request.method == "GET":
        return redirect("/live")
    return None


@bp.route("/classic")
def classic():
    return current_app.view_functions["index"]()


CONCEPT_HOME = {"brief": "", "near": "?lens=near", "console": "/pro", "river": "/wall/river"}


def _ctx(slug: str) -> dict:
    r = _region(slug)
    return dict(region_slug=slug, region_name=r.get("name") or slug, region=r,
                regions=_regions() or [{"slug": slug, "name": r.get("name") or slug}],
                owner=True, audio=True, tz=TZ, edge=True, walls=WALLS, concepts=CONCEPTS)


@bp.route("/live/<slug>/v/<name>")
def concept_page(slug: str, name: str):
    if name not in CONCEPTS:
        abort(404)
    if request.args.get("proto") != "1":
        url = f"/live/{slug}{CONCEPT_HOME[name]}"
        qs = request.query_string.decode()
        if qs:
            url += ("&" if "?" in url else "?") + qs
        return redirect(url)
    return render_template(f"v_{name}.html", concept=name, **_ctx(slug))


@bp.route("/live")
def live_root():
    return redirect(f"/live/{_my_region()}")


@bp.route("/live/<slug>")
def live_page(slug: str):
    return render_template(["live_brief.html", "v_brief.html"], view="brief", concept="brief", **_ctx(slug))


@bp.route("/live/<slug>/map")
def live_map(slug: str):
    return render_template("live.html", view="map", **_ctx(slug))


@bp.route("/live/<slug>/pro")
def live_pro(slug: str):
    return render_template(["pro.html", "v_console.html"], view="pro", concept="console", **_ctx(slug))


@bp.route("/live/<slug>/wall")
def wall_index(slug: str):
    return redirect(f"/live/{slug}/wall/command")


@bp.route("/live/<slug>/wall/<name>")
def wall_page(slug: str, name: str):
    if name not in WALLS:
        abort(404)
    ctx = _ctx(slug)
    ctx.update(wall=name, concept=name, owner=False)
    return render_template([f"wall_{name}.html"] + (["v_river.html"] if name == "river" else []), **ctx)


@bp.route("/live/sw.js")
@bp.route("/live/manifest.webmanifest")
@bp.route("/api/live/<path:sub>", methods=["GET", "POST"])
def proxy(sub: str = ""):
    if not HUB:
        abort(503)
    headers = {"Accept": request.headers.get("Accept", "*/*")}
    if request.referrer:
        headers["Referer"] = request.referrer
    if request.content_type:
        headers["Content-Type"] = request.content_type
    # Micro-cache GETs so several screens on jafo.local cost the Pi one hub
    # round-trip per few seconds, not one per browser poll.
    ck = None
    if request.method == "GET" and request.path.startswith("/api/live/"):
        ck = (request.full_path, "/wall/" in (request.referrer or ""), "sensitive=show" in (request.referrer or ""))
        hit = _proxy_cache.get(ck)
        if hit and time.time() - hit[0] < PROXY_TTL:
            return Response(hit[1], status=hit[2], headers=hit[3])
    try:
        r = requests.request(request.method, HUB + request.path, params=request.args,
                             data=request.get_data() if request.method == "POST" else None,
                             headers=headers, timeout=25)
    except requests.RequestException:
        abort(502)
    keep = {k: v for k, v in r.headers.items()
            if k.lower() in ("content-type", "cache-control", "x-snapshot-time", "x-snapshot-age",
                             "service-worker-allowed")}
    if ck and r.status_code == 200:
        if len(_proxy_cache) > 500:
            _proxy_cache.clear()
        _proxy_cache[ck] = (time.time(), r.content, r.status_code, keep)
    return Response(r.content, status=r.status_code, headers=keep)
