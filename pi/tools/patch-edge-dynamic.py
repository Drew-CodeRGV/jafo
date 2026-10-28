#!/usr/bin/env python3
"""Make the Pi's local UI location-dynamic (env-driven). Idempotent."""
import re, sys, py_compile

APP = "/home/pi/jafo/pi/web/app.py"
IDX = "/home/pi/jafo/pi/web/templates/index.html"

app = open(APP).read()
changed = []

# 1 + 3: context processor (system label) + env-driven map center
OLD_MAP = '''@app.route("/api/map-config")
def map_config():
    """Bounds + center for the live map. Frontend uses these to fit the view."""
    return jsonify({
        "center": list(RGV_CENTER),
        "bounds": [list(RGV_BOUNDS[0]), list(RGV_BOUNDS[1])],
    })'''
NEW_MAP = '''@app.context_processor
def _inject_edge_scope():
    # Location-dynamic UI labels, written to .env by relocate.py on each move.
    return {"system_label": os.environ.get("JAFO_SYSTEM_LABEL", "P25 TRUNKED")}


@app.route("/api/map-config")
def map_config():
    """Bounds + center for the live map. Env JAFO_MAP_LAT/LNG (set by relocate.py
    when the node moves) win so the edge map follows the node; else RGV."""
    _lat, _lng = os.environ.get("JAFO_MAP_LAT"), os.environ.get("JAFO_MAP_LNG")
    if _lat and _lng:
        try:
            c = [float(_lat), float(_lng)]; d = 0.45
            return jsonify({"center": c,
                            "bounds": [[c[0]-d, c[1]-d], [c[0]+d, c[1]+d]]})
        except ValueError:
            pass
    return jsonify({
        "center": list(RGV_CENTER),
        "bounds": [list(RGV_BOUNDS[0]), list(RGV_BOUNDS[1])],
    })'''
if "_inject_edge_scope" in app:
    changed.append("map/ctx: already patched")
elif OLD_MAP in app:
    app = app.replace(OLD_MAP, NEW_MAP); changed.append("map/ctx: patched")
else:
    sys.exit("ERROR: map_config block not found (unexpected app.py)")

# 2: ticker edge-proxy scoped by this node's slug
OLD_TK = '''        hub_url = os.environ.get("JAFO_HUB_URL", "https://jafo.live").rstrip("/")
        try:
            import requests as _r
            resp = _r.get(f"{hub_url}/api/ticker", timeout=4)'''
NEW_TK = '''        hub_url = os.environ.get("JAFO_HUB_URL", "https://jafo.live").rstrip("/")
        _ns = os.environ.get("JAFO_NODE_SLUG", "").strip()
        _q = f"?node={_ns}" if _ns else ""
        try:
            import requests as _r
            resp = _r.get(f"{hub_url}/api/ticker{_q}", timeout=4)'''
if "/api/ticker{_q}" in app:
    changed.append("ticker: already patched")
elif OLD_TK in app:
    app = app.replace(OLD_TK, NEW_TK); changed.append("ticker: patched")
else:
    sys.exit("ERROR: ticker edge-proxy block not found")

open(APP, "w").write(app)
py_compile.compile(APP, doraise=True)

# index.html: dynamic system label in the bottom classbar
idx = open(IDX).read()
OLD_LBL = '<span class="cc-cb-left">◤ {{ node_name }} · LRGVRRS P25 PHASE II</span>'
NEW_LBL = '<span class="cc-cb-left">◤ {{ node_name }} · {{ system_label }}</span>'
if NEW_LBL in idx:
    changed.append("label: already patched")
elif OLD_LBL in idx:
    idx = idx.replace(OLD_LBL, NEW_LBL); open(IDX, "w").write(idx); changed.append("label: patched")
else:
    changed.append("label: NOT FOUND (skipped)")

print("OK:", "; ".join(changed))
