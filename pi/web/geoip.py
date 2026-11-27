"""
City-level IP geolocation for the "N watching" listener map — done locally, so
visitors' IP addresses never leave the hub.

Uses the free DB-IP "IP to City Lite" database (CC BY 4.0, attribution on the
About page) at DATA_DIR/geo/dbip-city-lite.mmdb. The hub refreshes it monthly
in a background thread; edges never load it (they proxy /api/live to the hub).

lookup(ip) -> {"name": "McAllen, Texas", "cc": "US", "lat": 26.2, "lng": -98.23} | None
Only the city centroid is returned (rounded to 0.01°), never anything finer.
"""

from __future__ import annotations

import gzip
import ipaddress
import logging
import os
import shutil
import threading
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import requests

log = logging.getLogger("jafo.geoip")

try:
    import maxminddb
except ImportError:   # pragma: no cover
    maxminddb = None

try:
    from common import DATA_DIR
except Exception:   # pragma: no cover
    DATA_DIR = Path(os.environ.get("JAFO_DATA_DIR", "/var/jafo"))

DB_FILE = Path(os.environ.get("JAFO_GEOIP_DB", str(Path(DATA_DIR) / "geo" / "dbip-city-lite.mmdb")))
REFRESH_DAYS = 35
_reader = None
_lock = threading.Lock()
_refreshing = False


def _open():
    global _reader
    if _reader is None and maxminddb and DB_FILE.exists():
        try:
            _reader = maxminddb.open_database(str(DB_FILE))
        except Exception as e:
            log.warning("geoip: can't open %s: %s", DB_FILE, e)
    return _reader


def _refresh():
    """Download this month's DB-IP lite city file, swap it in atomically."""
    global _reader, _refreshing
    try:
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        url = f"https://download.db-ip.com/free/dbip-city-lite-{month}.mmdb.gz"
        DB_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp_gz, tmp = DB_FILE.with_suffix(".gz.part"), DB_FILE.with_suffix(".part")
        with requests.get(url, stream=True, timeout=60, headers={"User-Agent": "jafo-live/1.0"}) as r:
            r.raise_for_status()
            with open(tmp_gz, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        with gzip.open(tmp_gz, "rb") as src, open(tmp, "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.replace(tmp, DB_FILE)
        tmp_gz.unlink(missing_ok=True)
        with _lock:
            _reader = None
            lookup.cache_clear()
        log.info("geoip: refreshed %s", url)
    except Exception as e:
        log.warning("geoip: refresh failed: %s", e)
    finally:
        _refreshing = False


def maybe_refresh():
    global _refreshing
    if _refreshing or os.environ.get("JAFO_HUB_URL"):
        return
    try:
        stale = not DB_FILE.exists() or time.time() - DB_FILE.stat().st_mtime > REFRESH_DAYS * 86400
    except OSError:
        stale = True
    if stale:
        _refreshing = True
        threading.Thread(target=_refresh, daemon=True, name="geoip-refresh").start()


@lru_cache(maxsize=4096)
def lookup(ip: str) -> dict | None:
    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return None
    if addr.is_private or addr.is_loopback or addr.is_reserved or addr.is_link_local:
        return None
    with _lock:
        rd = _open()
        if not rd:
            return None
        try:
            rec = rd.get(str(addr)) or {}
        except Exception:
            return None
    loc = rec.get("location") or {}
    if loc.get("latitude") is None:
        return None
    city = ((rec.get("city") or {}).get("names") or {}).get("en")
    subs = rec.get("subdivisions") or []
    state = ((subs[0] if subs else {}).get("names") or {}).get("en")
    country = ((rec.get("country") or {}).get("names") or {}).get("en")
    cc = (rec.get("country") or {}).get("iso_code") or ""
    where = state if cc in ("US", "MX", "CA") else country
    name = ", ".join(x for x in (city, where) if x) or country or "Unknown"
    return {"name": name, "cc": cc, "lat": round(float(loc["latitude"]), 2), "lng": round(float(loc["longitude"]), 2)}
