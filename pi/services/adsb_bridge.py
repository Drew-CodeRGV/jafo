#!/usr/bin/env python3
"""
jafo-adsb-bridge (hub-side) — pull a remote edge node's readsb aircraft.json
over the tailnet and write it to the hub's /run/readsb/aircraft.json.

The hub's web app already prefers a co-resident decoder via _load_local_readsb(),
which reads /run/readsb/aircraft.json (freshness 5s) and hybrid-merges it with
adsb.lol. The hub has no RTL of its own, so this bridge makes a remote Pi's
antenna look "local" to that code — no changes to app.py needed.

Stdlib only; runs under /usr/bin/python3. Config via env:
  JAFO_ADSB_SOURCE_URL - where to pull from (default: the RGV Pi over tailnet)
  JAFO_ADSB_DEST_DIR   - where to write (default: /run/readsb)
  JAFO_ADSB_POLL_SEC   - poll cadence (default: 1.0s — matches readsb's write rate)
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import urllib.request

SRC = os.environ.get("JAFO_ADSB_SOURCE_URL",
                     "http://100.66.142.15:8754/aircraft.json")
DEST_DIR = os.environ.get("JAFO_ADSB_DEST_DIR", "/run/readsb")
DEST = os.path.join(DEST_DIR, "aircraft.json")
INTERVAL = float(os.environ.get("JAFO_ADSB_POLL_SEC", "1.0"))


def fetch_and_write() -> int:
    """Pull the remote JSON, validate it parses, write atomically. Returns the
    aircraft count (for logging). Raises on any fetch/parse error."""
    with urllib.request.urlopen(SRC, timeout=5) as r:
        data = r.read()
    doc = json.loads(data)  # validate — never write garbage the web must parse
    os.makedirs(DEST_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DEST_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, DEST)        # atomic swap — readers never see a partial file
        os.chmod(DEST, 0o644)        # world-readable so the web user can read it
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return len(doc.get("aircraft", []))


def main() -> None:
    print(f"[adsb-bridge] src={SRC} dest={DEST} every={INTERVAL}s", flush=True)
    last_err = None
    while True:
        try:
            fetch_and_write()
            last_err = None
        except Exception as e:
            # Log transitions only — don't spam when the Pi/antenna is down.
            msg = f"{type(e).__name__}: {e}"
            if msg != last_err:
                print(f"[adsb-bridge] source unavailable ({msg})", flush=True)
                last_err = msg
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
