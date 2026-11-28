#!/usr/bin/env python3
"""
relocate.py — when this jafo node moves, make it fully re-home itself:

  detect location → resolve the local P25 system → pull its control channels
  (SDR-window-aware) and talkgroups → SELF-PROVISION a hub node+region for the
  new location (geographic name) → install talkgroups → repoint the uploader →
  restart capture. One command (or run on boot), no manual hub steps.

Data sources, in priority order, for both frequencies and talkgroups:
  1. local RR cache   ~/jafo-data/config/rr-cache/{sites,tg}-<sid>.csv
  2. RadioReference SOAP API   (if appKey+login in radioreference.json)
  3. built-in REGISTRY         (seeded fallback CCs; names unavailable)

Modes:
  (default)   detect + show plan, then confirm interactively
  --auto      no prompt; act ONLY if the resolved region differs from current,
              and ONLY if a receivable site is found (never tears down a working
              config on a bad/flapping geo-lookup). Safe for a boot service/timer.
  --dry-run   detect + plan, change nothing
  --yes       skip the confirmation prompt
  --retune    allow moving the SDR center to reach a cross-band nearest site

Stdlib only. Runs ON the Pi.
"""
import argparse, csv, json, math, os, re, subprocess, sys, time, urllib.request
from datetime import datetime

HOME      = os.path.expanduser("~")
DATA_DIR  = os.environ.get("JAFO_DATA_DIR", os.path.join(HOME, "jafo-data"))
CONF_DIR  = os.path.join(DATA_DIR, "config")
CONFIG    = os.path.join(CONF_DIR, "config.json")
TG_ACTIVE = os.path.join(CONF_DIR, "talkgroups.csv")
RR_CREDS  = os.path.join(CONF_DIR, "radioreference.json")
CACHE_DIR = os.path.join(CONF_DIR, "rr-cache")
ENV_FILE  = os.path.join(HOME, "jafo", ".env")
RR_URL    = "https://api.radioreference.com/soap2/"

# Seeded systems keyed by location. CCs here are a fallback; a cached sites CSV
# (rr-cache/sites-<sid>.csv) or the RR API is preferred and SDR-window-filtered.
REGISTRY = [
    {"sid": 2, "name": "GATRRS (Greater Austin/Travis Regional Radio System)",
     "region_slug": "austin", "region_name": "Greater Austin / Travis",
     "node_slug": "jafo-austin-01", "node_display": "JAFO Austin 01",
     "shortName": "gatrrs", "sysid": "13E", "wacn": "BEE09",
     "sys_label": "GATRRS P25 PHASE II",
     "match": ("austin", "travis", "williamson", "hays", "round rock", "cedar park",
               "pflugerville", "georgetown"),
     "control_channels": [851137500, 851287500, 851312500, 851387500]},
    {"sid": 6742, "name": "LRGVRRS (Lower Rio Grande Valley Regional Radio System)",
     "region_slug": "rgv", "region_name": "Lower Rio Grande Valley",
     "node_slug": "jafo-mcallen-home", "node_display": "Drew McAllen Home Station",
     "shortName": "lrgvrrs", "sysid": "2B5", "wacn": "BEE00",
     "sys_label": "LRGVRRS P25 PHASE II",
     "match": ("mcallen", "hidalgo", "edinburg", "pharr", "mission", "cameron",
               "brownsville", "harlingen", "weslaco", "willacy", "starr"),
     "control_channels": [851067500, 851337500, 851075000, 851312500, 852962500]},
]


# ---------- small helpers ----------
def log(*a): print(*a, flush=True)

def http_json(url, timeout=12):
    req = urllib.request.Request(url, headers={"User-Agent": "jafo-relocate/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def read_env():
    env = {}
    try:
        for line in open(ENV_FILE):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env

def slugify(s):
    return re.sub(r"[^a-z0-9-]", "", (s or "").strip().lower().replace(" ", "-"))[:48]

def haversine_km(a, b, c, d):
    R = 6371.0
    p1, p2 = math.radians(a), math.radians(c)
    dp, dl = math.radians(c - a), math.radians(d - b)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(h))


# ---------- location ----------
def detect_location():
    d = http_json("https://ipinfo.io/json")
    lat, lng = (float(x) for x in d["loc"].split(","))
    return {"ip": d.get("ip"), "city": d.get("city"), "region": d.get("region"),
            "postal": d.get("postal"), "org": d.get("org"), "lat": lat, "lng": lng}


# ---------- SDR window + sites CSV ----------
def sdr_window():
    src = json.load(open(CONFIG))["sources"][0]
    c, rate = src["center"], src["rate"]
    return c - rate // 2, c + rate // 2

def parse_sites_csv(path):
    sites = []
    with open(path, newline="") as f:
        rdr = csv.reader(f); next(rdr, None)
        for row in rdr:
            if len(row) < 10: continue
            try: lat, lng = float(row[6]), float(row[7])
            except ValueError: continue
            ctrl = []
            for cell in row[9:]:
                c = cell.strip()
                if not c: continue
                flag = c[-1].lower() if c[-1].isalpha() else ""
                num = c[:-1] if flag else c
                try: hz = int(round(float(num) * 1_000_000))
                except ValueError: continue
                if flag == "c": ctrl.append(hz)
            if ctrl:
                sites.append({"desc": row[4], "nac": (row[3] or "").strip(),
                              "county": row[5], "lat": lat, "lng": lng, "control": ctrl})
    return sites

def pick_site(sites, lat, lng, lo, hi, retune=False):
    ranked = sorted(sites, key=lambda s: haversine_km(lat, lng, s["lat"], s["lng"]))
    for s in ranked: s["dist_km"] = round(haversine_km(lat, lng, s["lat"], s["lng"]), 1)
    in_win = [s for s in ranked if s["control"] and all(lo <= cc <= hi for cc in s["control"])]
    if not retune:
        if not in_win: return None, None
        best = in_win[0]
        note = None if best is ranked[0] else \
            f"closer site '{ranked[0]['desc']}' ({ranked[0]['dist_km']}km) is out of band; using '{best['desc']}'"
        return best, note
    return ranked[0], None


# ---------- RadioReference API ----------
def rr_creds():
    try: d = json.load(open(RR_CREDS))
    except Exception: return None
    return d if d.get("appKey") and d.get("username") and d.get("password") else None

def rr_call(method, inner, creds, timeout=25):
    esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    env = (f'<?xml version="1.0"?><soapenv:Envelope '
           f'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
           f'xmlns:api="http://api.radioreference.com/soap2/"><soapenv:Body>'
           f'<api:{method} soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">{inner}'
           f'<authInfo><appKey>{esc(creds["appKey"])}</appKey><username>{esc(creds["username"])}</username>'
           f'<password>{esc(creds["password"])}</password><version>latest</version><style>rpc</style>'
           f'</authInfo></api:{method}></soapenv:Body></soapenv:Envelope>')
    req = urllib.request.Request(RR_URL, data=env.encode(),
                                 headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": '""'})
    try: body = urllib.request.urlopen(req, timeout=timeout).read().decode("latin-1")
    except urllib.error.HTTPError as e: body = e.read().decode("latin-1")
    f = re.search(r"<faultstring[^>]*>(.*?)</faultstring>", body, re.S)
    if f: raise RuntimeError("RR API: " + f.group(1))
    return body

def rr_talkgroups_csv(sid, creds):
    xml = (f'<sid xsi:type="xsd:int" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
           f'xmlns:xsd="http://www.w3.org/2001/XMLSchema">{int(sid)}</sid>')
    body = rr_call("getTrsTalkgroups", xml, creds)
    rows = [["Decimal", "Hex", "Alpha Tag", "Mode", "Description", "Tag", "Category"]]
    for blk in re.split(r"</?item[ >]", body):
        dec = re.search(r"<tgDec[^>]*>([0-9]+)</tgDec>", blk)
        if not dec: continue
        g = lambda t: (re.search(rf"<{t}[^>]*>(.*?)</{t}>", blk) or [None, ""])[1]
        rows.append([dec.group(1), g("tgHex"), g("tgAlpha"), g("tgMode"),
                     g("tgDescr"), g("tags"), g("tgCat")])
    import io
    buf = io.StringIO(); csv.writer(buf).writerows(rows)
    return buf.getvalue() if len(rows) > 1 else None


# ---------- resolve the plan ----------
def cached(kind, sid):
    p = os.path.join(CACHE_DIR, f"{kind}-{sid}.csv")
    return p if os.path.exists(p) else None

def resolve(loc, args):
    creds = rr_creds()
    hay = " ".join(str(loc.get(k, "")) for k in ("city", "region")).lower()
    reg = next((r for r in REGISTRY if any(k in hay for k in r["match"])), None)

    if reg:
        sid = reg["sid"]
        plan = {k: reg.get(k) for k in ("name", "sid", "region_slug", "region_name",
                "node_slug", "node_display", "shortName", "sysid", "wacn", "sys_label")}
        plan["control_channels"] = reg["control_channels"]
        plan["source"] = "registry"
    else:
        # Unknown location: derive geographic identity; needs cached CSV or RR API.
        city = slugify(loc.get("city") or "node")
        plan = {"name": f"{loc.get('city')} P25", "sid": args.sid,
                "region_slug": city, "region_name": loc.get("city") or city,
                "node_slug": f"jafo-{city}-01", "node_display": f"JAFO {loc.get('city') or city}",
                "shortName": city, "sysid": None, "wacn": None,
                "sys_label": f"{(loc.get('city') or city).upper()} P25",
                "control_channels": None, "source": "geo-derived"}

    sid = plan["sid"]
    # --- control channels: cached sites CSV (preferred, SDR-window-aware) ---
    sites_csv = args.sites_csv or (cached("sites", sid) if sid else None)
    if sites_csv:
        sites = parse_sites_csv(sites_csv)
        lo, hi = sdr_window()
        site, note = pick_site(sites, loc["lat"], loc["lng"], lo, hi, args.retune)
        if site:
            plan["control_channels"] = site["control"]
            plan["site"] = site; plan["note"] = note
    if not plan.get("control_channels"):
        return None  # can't determine receivable frequencies

    # --- talkgroups: cached CSV, else RR API ---
    tg_path = args.talkgroups_csv or (cached("tg", sid) if sid else None)
    if tg_path:
        plan["talkgroups_csv"] = open(tg_path).read()
    elif creds and sid:
        try: plan["talkgroups_csv"] = rr_talkgroups_csv(sid, creds)
        except Exception as e: log("  (talkgroups via RR API failed:", e, ")")
    return plan


# ---------- apply ----------
def backup(path):
    if os.path.exists(path):
        subprocess.run(["cp", path, f"{path}.bak-{datetime.now():%Y%m%d-%H%M%S}"], check=True)

def set_env(keys: dict):
    txt = open(ENV_FILE).read()
    for k, v in keys.items():
        line = f'{k}="{v}"' if (" " in str(v) or "," in str(v)) else f"{k}={v}"
        txt = re.sub(rf"^{k}=.*$", line, txt, flags=re.M) if re.search(rf"^{k}=.*$", txt, flags=re.M) \
              else txt.rstrip() + "\n" + line + "\n"
    backup(ENV_FILE); open(ENV_FILE, "w").write(txt)

def provision(plan, loc, env):
    hub = (env.get("JAFO_HUB_URL") or "https://jafo.live").rstrip("/")
    tok = env.get("JAFO_PROVISION_TOKEN")
    if not tok:
        log("  ! no JAFO_PROVISION_TOKEN in .env — cannot self-provision hub node"); return None
    payload = {"region_slug": plan["region_slug"], "region_name": plan["region_name"],
               "node_slug": plan["node_slug"], "node_display": plan["node_display"],
               "lat": loc["lat"], "lng": loc["lng"],
               "region_desc": f"{plan['name']} — auto-provisioned",
               "owner_email": env.get("JAFO_OWNER_EMAIL"),
               "talkgroups_csv": plan.get("talkgroups_csv")}
    req = urllib.request.Request(hub + "/api/provision",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def patch_config(plan):
    c = json.load(open(CONFIG)); s = c["systems"][0]
    s["_prev_control_channels"] = s.get("control_channels")
    s["control_channels"] = plan["control_channels"]
    s["shortName"] = plan["shortName"]
    s["_comment_system"] = f"{plan['name']} — auto-relocated ({plan['source']})"
    backup(CONFIG); json.dump(c, open(CONFIG, "w"), indent=4)

def restart(unit): subprocess.run(["sudo", "systemctl", "restart", unit])

def verify(wait=35):
    time.sleep(wait)
    logs = [os.path.join(DATA_DIR, "logs", f) for f in os.listdir(os.path.join(DATA_DIR, "logs")) if f.endswith(".log")]
    if not logs: return None
    tail = open(max(logs, key=os.path.getmtime), errors="ignore").read()[-20000:]
    m = re.search(r"System ID\s+(\S+)\s+WACN:\s+(\S+)\s+NAC:\s+(\S+)", tail)
    return m.groups() if m else None


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser(description="Self-re-home this jafo node to its current location.")
    ap.add_argument("--auto", action="store_true", help="act only on a region change; no prompt; safe for boot/timer")
    ap.add_argument("--yes", action="store_true", help="skip confirmation")
    ap.add_argument("--dry-run", action="store_true", help="detect + plan only")
    ap.add_argument("--retune", action="store_true", help="allow cross-band SDR recenter")
    ap.add_argument("--sites-csv"); ap.add_argument("--talkgroups-csv"); ap.add_argument("--sid", type=int)
    args = ap.parse_args()
    env = read_env()

    log("• Detecting location …")
    loc = detect_location()
    log(f"  → {loc['city']}, {loc['region']} ({loc['lat']:.3f},{loc['lng']:.3f}) via {loc['org']}")

    plan = resolve(loc, args)
    if not plan:
        msg = "Could not resolve a receivable system for this location (no cached sites CSV / RR appKey / registry match)."
        if args.auto: log("• " + msg + " Leaving current config untouched."); return 0
        sys.exit("✗ " + msg)

    cur_region = env.get("JAFO_REGION", "")
    cur_ccs = json.load(open(CONFIG))["systems"][0].get("control_channels", [])
    same_system = sorted(cur_ccs) == sorted(plan["control_channels"]) and \
                  (not env.get("JAFO_PROVISION_TOKEN") or env.get("JAFO_NODE_SLUG") == plan["node_slug"])

    ccs = ", ".join(f"{h/1e6:.4f}" for h in plan["control_channels"])
    log("\n──────── RELOCATION PLAN ────────")
    log(f"  System     : {plan['name']}  ({plan['source']})")
    if plan.get("site"):
        s = plan["site"]; log(f"  Site       : {s['desc']} NAC {s['nac']} ({s['dist_km']}km)")
    if plan.get("note"): log(f"  Note       : {plan['note']}")
    log(f"  Control ch : {ccs} MHz")
    log(f"  Hub node   : {plan['node_slug']}  ·  region {plan['region_slug']}")
    log(f"  Talkgroups : {'yes ('+str(plan['talkgroups_csv'].count(chr(10)))+' rows)' if plan.get('talkgroups_csv') else 'none (names unavailable)'}")
    log(f"  Already current: {'YES' if same_system else 'no'}")
    log("─────────────────────────────────\n")

    if args.dry_run: log("(dry-run) no changes."); return 0
    if same_system: log("Already homed here — nothing to do."); return 0
    if args.auto and plan["node_slug"] == env.get("JAFO_NODE_SLUG"):
        log("Region unchanged — auto mode makes no changes."); return 0
    if not args.yes and not args.auto:
        if not sys.stdin.isatty(): sys.exit("Need --yes to apply non-interactively.")
        if input("Relocate now? [y/N] ").strip().lower() not in ("y", "yes"): return 0

    if env.get("JAFO_PROVISION_TOKEN"):
        log("• Self-provisioning hub node …")
        try:
            pr = provision(plan, loc, env)
        except Exception as e:
            sys.exit(f"✗ provision failed: {e}")
        if not pr or not pr.get("node_token"):
            sys.exit("✗ provision returned no token")
        log(f"  ✓ hub node {pr['node_slug']} ({'created' if pr.get('created') else 'updated'}), "
            f"talkgroups rows: {pr.get('talkgroups_rows')}")
    else:
        # Standalone station (no fleet provisioning token): configure the radio
        # locally and keep whatever hub token the owner entered themselves.
        log("• No JAFO_PROVISION_TOKEN — setting up as a standalone station (local web UI only"
            + (", feeding the hub with your own node token)" if env.get("JAFO_NODE_TOKEN") else ")"))
        pr = {"node_token": env.get("JAFO_NODE_TOKEN", "")}

    log("• Installing talkgroups + config + env …")
    if plan.get("talkgroups_csv"):
        backup(TG_ACTIVE)
        open(TG_ACTIVE, "w").write(plan["talkgroups_csv"])
    patch_config(plan)
    set_env({**({"JAFO_NODE_SLUG": plan["node_slug"], "JAFO_NODE_NAME": plan["node_slug"],
                 "JAFO_NODE_TOKEN": pr["node_token"]} if env.get("JAFO_PROVISION_TOKEN") else {}),
             "JAFO_REGION": plan["region_name"],
             # location-dynamic edge UI (map center + system label follow the move)
             "JAFO_MAP_LAT": f"{loc['lat']:.5f}", "JAFO_MAP_LNG": f"{loc['lng']:.5f}",
             "JAFO_SYSTEM_LABEL": plan.get("sys_label") or "P25 TRUNKED"})

    log("• Restarting recorder / enricher / uploader / web …")
    for u in ("jafo-recorder", "jafo-enricher", "jafo-uploader", "jafo-web"): restart(u)

    log("• Verifying decode …")
    v = verify()
    if v:
        ok = (not plan["wacn"]) or (plan["wacn"].upper() in v[1].upper())
        log(f"  ✓ System ID {v[0]} WACN {v[1]} NAC {v[2]}  —  "
            + ("WACN matches." if ok else f"⚠ expected {plan['wacn']}"))
    else:
        log("  ⚠ no decode seen yet — may still be acquiring (backups written for revert).")
    log(f"\n✓ Relocated to {plan['region_name']} as {plan['node_slug']}.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
