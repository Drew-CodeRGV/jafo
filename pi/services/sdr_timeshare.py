#!/usr/bin/env python3
"""
jafo-sdr-timeshare — share the single RTL-SDR between ADS-B and ACARS.

Smart 45/10 cycle (all tunable in .env):

  JAFO_TIMESHARE=45:10        ADS-B seconds : base ACARS seconds ("off" disables)
  JAFO_TIMESHARE_SMART=1      enable the four smart rules below

  1. Burst extension — if an ACARS message lands in the last 3 s of a window,
     stay +5 s (repeatable) up to 20 s total: ACARS arrives in bursts.
  2. Skip when there is nothing to hear — no airliners in range below
     FL250 (per the hub's merged ADS-B picture) → keep ADS-B, skip ACARS.
  3. Never blind the important stuff — skip ACARS while JAFO's own antenna is
     the only receiver tracking an interesting low aircraft (helicopter over an
     incident, emergency squawk, border/police/medical aircraft).
  4. Lean in — if the last ACARS window caught messages the next one is 15 s;
     after two empty windows back to the base.

Stands down (leaves the radio alone) when the operator picks a mode by hand:
sdr-mode.sh writes DATA_DIR/config/timeshare.pause for adsb/acars/voice/noaa
and removes it for `sdr-mode.sh auto`. Also stands down if voice mode's config
backup exists or NOAA is running. On exit it always returns the RTL to ADS-B.

Status (duty, windows, skips, messages) is written to DATA_DIR/timeshare.json
and posted to the hub (POST /api/ingest/sdr-status) so /live can show it.
"""

from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from collections import deque

import requests

from common import DATA_DIR, DB_PATH, setup_logging

log = setup_logging("jafo-sdr-timeshare")

CFG = os.environ.get("JAFO_TIMESHARE", "45:10").strip().lower()
SMART = os.environ.get("JAFO_TIMESHARE_SMART", "1").strip().lower() in ("1", "true", "yes")
HUB = os.environ.get("JAFO_HUB_URL", "").strip().rstrip("/")
TOKEN = os.environ.get("JAFO_NODE_TOKEN", "").strip()
NODE_SLUG = os.environ.get("JAFO_NODE_SLUG", "").strip()
PAUSE = DATA_DIR / "config" / "timeshare.pause"
VOICE_BAK = DATA_DIR / "config" / "config.json.bak-sdrmode"
STATUS = DATA_DIR / "timeshare.json"

ACARS_MAX = 20          # seconds, including burst extensions
LEAN_IN = 15            # seconds after a productive window
BURST_TAIL = 3          # a message in the last N seconds extends the window
BURST_STEP = 5

running = True


def _sh(*units, action):
    subprocess.run(["sudo", "systemctl", action, *units], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)


def _active(unit) -> bool:
    r = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True)
    return r.stdout.strip() == "active"


def to_adsb():
    _sh("jafo-acars.service", action="stop")
    _sh("readsb.service", "jafo-adsb-serve.service", action="start")


def to_acars():
    _sh("readsb.service", "jafo-adsb-serve.service", action="stop")
    _sh("jafo-acars.service", action="start")


def manual_override() -> str | None:
    if PAUSE.exists():
        return "paused (manual mode)"
    if VOICE_BAK.exists():
        return "voice mode"
    if _active("jafo-noaa.service"):
        return "NOAA mode"
    return None


def acars_last():
    try:
        c = sqlite3.connect(DB_PATH, timeout=5)
        row = c.execute("SELECT MAX(id), MAX(received_at) FROM acars_messages").fetchone()
        c.close()
        return (row[0] or 0), (row[1] or 0)
    except sqlite3.Error:
        return 0, 0


_region = None


def region_slug() -> str:
    global _region
    if _region:
        return _region
    _region = os.environ.get("JAFO_LIVE_REGION", "").strip() or None
    if not _region and HUB:
        try:
            nodes = requests.get(f"{HUB}/api/fleet/nodes", timeout=8).json().get("nodes", [])
            _region = next((n["region_slug"] for n in nodes if n.get("slug") == NODE_SLUG), None)
        except Exception:
            pass
    _region = _region or "rgv"
    return _region


def sky_check() -> tuple[bool, str]:
    """(skip_acars, reason) from the hub's merged ADS-B picture."""
    if not SMART or not HUB:
        return False, ""
    try:
        air = requests.get(f"{HUB}/api/live/air", params={"region": region_slug()}, timeout=6).json()
    except Exception:
        return False, ""    # hub unreachable: don't get clever, run the base cycle
    acs = air.get("aircraft") or []
    for a in acs:   # rule 3 — only our antenna hears it, and it matters
        if a.get("source") == "local" and not a.get("on_ground") and (a.get("alt_ft") or 99999) < 5000 and (
                a.get("emergency") or a.get("near_incident") or a.get("role") in ("border", "police", "medical")):
            return True, f"holding ADS-B for {a.get('callsign') or a.get('hex')} (only JAFO hears it)"
    airliners = [a for a in acs if a.get("kind") in ("commercial", "heavy", "jet")
                 and (a.get("on_ground") or (a.get("alt_ft") or 0) < 25000)]
    if not airliners:   # rule 2
        return True, "no airliners in range below FL250"
    return False, f"{len(airliners)} airliner(s) in range"


class Stats:
    def __init__(self):
        self.hist: deque = deque()   # (ts, kind, seconds, msgs)
        self.state = "adsb"
        self.since = time.time()
        self.note = ""

    def add(self, kind, seconds, msgs=0):
        now = time.time()
        self.hist.append((now, kind, seconds, msgs))
        while self.hist and self.hist[0][0] < now - 3600:
            self.hist.popleft()

    def snapshot(self, override=None):
        a = sum(s for _, k, s, _ in self.hist if k == "adsb")
        c = sum(s for _, k, s, _ in self.hist if k == "acars")
        tot = max(1.0, a + c)
        return {
            "node": NODE_SLUG, "enabled": CFG != "off", "smart": SMART, "config": CFG,
            "state": "standby" if override else self.state, "override": override, "since": int(self.since),
            "note": self.note, "updated": int(time.time()),
            "last_hour": {"adsb_pct": round(100 * a / tot), "acars_pct": round(100 * c / tot),
                          "acars_windows": sum(1 for _, k, _, _ in self.hist if k == "acars"),
                          "skipped": sum(1 for _, k, _, _ in self.hist if k == "skip"),
                          "acars_msgs": sum(m for _, k, _, m in self.hist if k == "acars")},
        }


def publish(stats: Stats, override=None):
    snap = stats.snapshot(override)
    try:
        STATUS.write_text(json.dumps(snap))
    except OSError:
        pass
    if HUB and TOKEN:
        try:
            requests.post(f"{HUB}/api/ingest/sdr-status", json=snap,
                          headers={"Authorization": f"Bearer {TOKEN}"}, timeout=5)
        except Exception:
            pass


def sleep_while_running(sec: float):
    end = time.time() + sec
    while running and time.time() < end:
        time.sleep(min(0.5, end - time.time()))


def acars_window(base: int) -> tuple[int, int]:
    """Run one ACARS window; returns (seconds used, messages caught)."""
    id0, _ = acars_last()
    to_acars()
    start = time.time()
    end = start + base
    while running and time.time() < end:
        time.sleep(0.5)
        if end - time.time() <= BURST_TAIL and SMART:
            _, last_at = acars_last()
            if last_at and time.time() - last_at <= BURST_TAIL and end - start < ACARS_MAX:
                end = min(start + ACARS_MAX, end + BURST_STEP)
    to_adsb()
    used = int(round(time.time() - start))
    id1, _ = acars_last()
    # acars.py writes as messages arrive; allow a beat for the last ones to land
    time.sleep(1.0)
    id1 = max(id1, acars_last()[0])
    return used, max(0, id1 - id0)


def main():
    global running
    if CFG == "off":
        log.info("JAFO_TIMESHARE=off — idle.")
        while True:
            time.sleep(3600)
    adsb_sec, acars_base = (int(x) for x in CFG.split(":"))

    def stop(*_):
        global running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    stats = Stats()
    empty_streak = 0
    next_acars = acars_base
    log.info("Starting smart time-share %ss ADS-B / %ss ACARS (smart=%s)", adsb_sec, acars_base, SMART)
    if not manual_override():
        to_adsb()
    while running:
        ov = manual_override()
        if ov:
            stats.note = ov
            publish(stats, override=ov)
            sleep_while_running(10)
            continue
        # --- ADS-B leg
        stats.state, stats.since = "adsb", time.time()
        publish(stats)
        sleep_while_running(adsb_sec)
        stats.add("adsb", adsb_sec)
        if not running or manual_override():
            continue
        skip, why = sky_check()
        if skip:
            stats.note = f"skipped ACARS: {why}"
            stats.add("skip", 0)
            log.info("SKIP  %s", why)
            continue
        # --- ACARS leg
        stats.state, stats.since, stats.note = "acars", time.time(), why
        publish(stats)
        used, caught = acars_window(next_acars)
        stats.add("acars", used, caught)
        log.info("ACARS %ss window (base %ss) caught %d msg(s)%s", used, next_acars, caught,
                 f" · {why}" if why else "")
        if caught:
            empty_streak, next_acars = 0, (LEAN_IN if SMART else acars_base)
        else:
            empty_streak += 1
            if empty_streak >= 2:
                next_acars = acars_base
    # always leave the RTL on ADS-B
    if not manual_override():
        to_adsb()
    stats.state = "adsb"
    publish(stats)
    log.info("Stopped — RTL back on ADS-B.")


if __name__ == "__main__":
    main()
    sys.exit(0)
