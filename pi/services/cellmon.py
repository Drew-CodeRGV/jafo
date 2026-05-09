#!/usr/bin/env python3
"""
jafo-cellmon — cellular network observer for the M.2 modem.

Polls a Quectel-family LTE/5G modem (RM520N-GL tested) over the AT serial
port every POLL_INTERVAL_SEC seconds, parses servingcell + neighbourcell
into normalized rows in `cell_observations`, and rolls each unique cell
into `cell_sites` (with first/last seen + obs_count).

The service is resilient to the modem being unplugged: it loops on
serial open errors with exponential backoff, so you can leave it enabled
and it'll come to life the moment the dev board is connected.

To verify the parser without hardware:
    python3 cellmon.py --selftest
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from typing import Any

# Local imports — match the convention used by processor/transcriber/enricher
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import db_connect

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
AT_DEVICE        = os.environ.get("JAFO_CELLMON_DEVICE", "/dev/ttyUSB2")
AT_BAUD          = int(os.environ.get("JAFO_CELLMON_BAUD", "115200"))
POLL_INTERVAL_SEC = int(os.environ.get("JAFO_CELLMON_POLL_SEC", "60"))
AT_TIMEOUT_SEC    = float(os.environ.get("JAFO_CELLMON_AT_TIMEOUT", "3"))

# US + RGV cross-border carrier MCC/MNC table. Add lines as needed.
# Source: ITU MCC/MNC list, manually curated for US + Mexico operators in RGV.
MCC_MNC_OPERATOR: dict[tuple[int, int], str] = {
    # T-Mobile US
    (310, 260): "T-Mobile US",   (311, 260): "T-Mobile US",
    (311, 490): "T-Mobile US",   (311, 660): "T-Mobile US",
    (310, 200): "T-Mobile US",   (310, 210): "T-Mobile US",
    (310, 220): "T-Mobile US",   (310, 230): "T-Mobile US",
    (310, 240): "T-Mobile US",   (310, 250): "T-Mobile US",
    (310, 270): "T-Mobile US",   (310, 310): "T-Mobile US",
    (310, 490): "T-Mobile US",
    # Verizon
    (310, 4):   "Verizon",       (311, 480): "Verizon",
    (310, 5):   "Verizon",       (310, 6):   "Verizon",
    (310, 10):  "Verizon",       (310, 12):  "Verizon",
    # AT&T
    (310, 410): "AT&T",          (310, 150): "AT&T",
    (310, 70):  "AT&T",          (310, 170): "AT&T",
    (310, 280): "AT&T",          (310, 380): "AT&T",
    (311, 180): "AT&T",
    # Mexico
    (334, 20):  "Telcel (MX)",   (334, 30):  "Movistar (MX)",
    (334, 90):  "AT&T MX",       (334, 50):  "AT&T MX",
    (334, 140): "AT&T MX",
    # US Cellular & rural
    (311, 220): "US Cellular",   (311, 580): "US Cellular",
    # FirstNet (rides AT&T's network — same physical sites, separate PLMN)
    (313, 100): "FirstNet",      (312, 970): "FirstNet",
}


def lookup_operator(mcc: int | None, mnc: int | None) -> str | None:
    if mcc is None or mnc is None:
        return None
    return MCC_MNC_OPERATOR.get((mcc, mnc))


# ---------------------------------------------------------------------------
# AT response parsers
# ---------------------------------------------------------------------------
# Quectel servingcell formats vary per RAT. We pin the field offsets that
# matter and lean on raw_text for anything we don't recognize.
#
# LTE (FDD/TDD):
#   +QENG: "servingcell","<state>","LTE","<TDD/FDD>",MCC,MNC,cellID,PCID,
#          EARFCN,band,UL_BW,DL_BW,TAC,RSRP,RSRQ,RSSI,SINR,...
# NR5G-SA:
#   +QENG: "servingcell","<state>","NR5G-SA","<TDD>",MCC,MNC,cellID,PCID,
#          TAC,ARFCN,band,DL_BW,RSRP,RSRQ,SINR,scs,...
# WCDMA:
#   +QENG: "servingcell","<state>","WCDMA",MCC,MNC,LAC,cellID,UARFCN,PSC,
#          RAC,RSCP,ECIO,...

_RE_NUM = re.compile(r"-?\d+")


def _to_int(s: str | None) -> int | None:
    if s is None or s == "" or s == "-":
        return None
    try:
        return int(s, 0)  # handles "0x..." and decimal
    except (ValueError, TypeError):
        return None


def _to_float(s: str | None) -> float | None:
    if s is None or s == "" or s == "-":
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1]
    return s


def parse_servingcell(line: str) -> dict[str, Any] | None:
    """Parse one +QENG: "servingcell",... line. Returns dict or None."""
    if "+QENG:" not in line:
        return None
    payload = line.split("+QENG:", 1)[1].strip()
    fields = [_strip_quotes(p) for p in payload.split(",")]
    if not fields or fields[0] != "servingcell":
        return None

    out: dict[str, Any] = {"is_serving": 1, "raw_text": line.strip()}
    state = fields[1] if len(fields) > 1 else None
    rat   = fields[2] if len(fields) > 2 else None
    out["state"] = state or None
    out["rat"]   = rat or None

    if rat == "LTE":
        # +QENG: "servingcell",state,"LTE",duplex,MCC,MNC,cellID,PCID,EARFCN,band,UL_BW,DL_BW,TAC,RSRP,RSRQ,RSSI,SINR,...
        f = fields
        out["mcc"]      = _to_int(f[4]  if len(f) > 4 else None)
        out["mnc"]      = _to_int(f[5]  if len(f) > 5 else None)
        out["cell_id"]  = (f[6]  if len(f) > 6 else None) or None
        out["pci"]      = _to_int(f[7]  if len(f) > 7 else None)
        out["earfcn"]   = _to_int(f[8]  if len(f) > 8 else None)
        band            = (f[9]  if len(f) > 9 else None)
        out["band"]     = f"B{band}" if band and band.lstrip("-").isdigit() else (band or None)
        out["tac"]      = (f[12] if len(f) > 12 else None) or None
        out["rsrp_dbm"] = _to_int(f[13] if len(f) > 13 else None)
        out["rsrq_db"]  = _to_float(f[14] if len(f) > 14 else None)
        out["rssi_dbm"] = _to_int(f[15] if len(f) > 15 else None)
        out["sinr_db"]  = _to_float(f[16] if len(f) > 16 else None)
    elif rat in ("NR5G-SA", "NR5G-NSA"):
        # +QENG: "servingcell",state,"NR5G-SA",duplex,MCC,MNC,cellID,PCID,TAC,ARFCN,band,DL_BW,RSRP,RSRQ,SINR,scs,...
        f = fields
        out["mcc"]      = _to_int(f[4]  if len(f) > 4 else None)
        out["mnc"]      = _to_int(f[5]  if len(f) > 5 else None)
        out["cell_id"]  = (f[6]  if len(f) > 6 else None) or None
        out["pci"]      = _to_int(f[7]  if len(f) > 7 else None)
        out["tac"]      = (f[8]  if len(f) > 8 else None) or None
        out["earfcn"]   = _to_int(f[9]  if len(f) > 9 else None)
        band            = (f[10] if len(f) > 10 else None)
        out["band"]     = f"n{band}" if band and band.lstrip("-").isdigit() else (band or None)
        out["rsrp_dbm"] = _to_int(f[12] if len(f) > 12 else None)
        out["rsrq_db"]  = _to_float(f[13] if len(f) > 13 else None)
        out["sinr_db"]  = _to_float(f[14] if len(f) > 14 else None)
    elif rat == "WCDMA":
        # +QENG: "servingcell",state,"WCDMA",MCC,MNC,LAC,cellID,UARFCN,PSC,RAC,RSCP,ECIO,...
        f = fields
        out["mcc"]      = _to_int(f[3]  if len(f) > 3 else None)
        out["mnc"]      = _to_int(f[4]  if len(f) > 4 else None)
        out["tac"]      = (f[5]  if len(f) > 5 else None) or None  # LAC stored under tac
        out["cell_id"]  = (f[6]  if len(f) > 6 else None) or None
        out["earfcn"]   = _to_int(f[7]  if len(f) > 7 else None)
        out["pci"]      = _to_int(f[8]  if len(f) > 8 else None)
        out["rsrp_dbm"] = _to_int(f[10] if len(f) > 10 else None)  # RSCP under rsrp
        out["rsrq_db"]  = _to_float(f[11] if len(f) > 11 else None) # ECIO under rsrq
    out["operator"] = lookup_operator(out.get("mcc"), out.get("mnc"))
    return out


def parse_qscan(line: str) -> dict[str, Any] | None:
    """Parse one +QSCAN line. Active scan returns RSRP/RSRQ/SINR even when
    the modem isn't fully registered (LIMSRV / no service / non-home SIM).
    Format observed on RM520N-GL firmware AAR03A03M4G:
      +QSCAN: "<RAT>",MCC,MNC,ARFCN,PCI,RSRP,RSRQ,SINR,is_srv,Cell_ID,TAC,band,
              srxlev,scs,band_extra,...
    """
    if "+QSCAN:" not in line:
        return None
    payload = line.split("+QSCAN:", 1)[1].strip()
    fields = [_strip_quotes(p) for p in payload.split(",")]
    if not fields or len(fields) < 6:
        return None
    rat = fields[0]
    out: dict[str, Any] = {
        "is_serving": _to_int(fields[8] if len(fields) > 8 else None) or 0,
        "raw_text":   line.strip(),
        "rat":        rat or None,
    }
    out["mcc"]      = _to_int(fields[1])
    out["mnc"]      = _to_int(fields[2])
    out["earfcn"]   = _to_int(fields[3])
    out["pci"]      = _to_int(fields[4])
    out["rsrp_dbm"] = _to_int(fields[5])
    out["rsrq_db"]  = _to_float(fields[6])
    out["sinr_db"]  = _to_float(fields[7])
    out["cell_id"]  = (fields[9] if len(fields) > 9 else None) or None
    out["tac"]      = (fields[10] if len(fields) > 10 else None) or None
    # Field 11 is documented as NR_band on Quectel, but the values observed
    # on RM520N-GL firmware AAR03A03M4G don't always match standard 3GPP
    # band numbers (e.g. 106/162/217/273 — outside the n# space). Store
    # raw without prefixing so we don't mislabel; the truer band can be
    # derived from ARFCN later if needed.
    band            = (fields[11] if len(fields) > 11 else None)
    out["band"]     = band or None
    out["operator"] = lookup_operator(out.get("mcc"), out.get("mnc"))
    return out


def parse_neighbourcell(line: str) -> dict[str, Any] | None:
    """Parse one +QENG: "neighbourcell ...",... line. Returns dict or None."""
    if "+QENG:" not in line:
        return None
    payload = line.split("+QENG:", 1)[1].strip()
    fields = [_strip_quotes(p) for p in payload.split(",")]
    if not fields:
        return None
    label = fields[0]
    if not label.startswith("neighbourcell"):
        return None

    out: dict[str, Any] = {"is_serving": 0, "raw_text": line.strip()}
    rat = fields[1] if len(fields) > 1 else None
    out["rat"] = rat or None

    if rat in ("LTE", "NR5G-SA", "NR5G-NSA"):
        # +QENG: "neighbourcell <intra|inter>","LTE",EARFCN,PCID,RSRQ,RSRP,RSSI,SINR,...
        # +QENG: "neighbourcell","NR5G-NSA",ARFCN,PCID,RSRP,RSRQ,SINR,...   (varies)
        f = fields
        out["earfcn"]   = _to_int(f[2] if len(f) > 2 else None)
        out["pci"]      = _to_int(f[3] if len(f) > 3 else None)
        if rat == "LTE":
            out["rsrq_db"]  = _to_float(f[4] if len(f) > 4 else None)
            out["rsrp_dbm"] = _to_int(f[5] if len(f) > 5 else None)
            out["rssi_dbm"] = _to_int(f[6] if len(f) > 6 else None)
            out["sinr_db"]  = _to_float(f[7] if len(f) > 7 else None)
        else:
            # NR neighbor — keep best-effort positions
            out["rsrp_dbm"] = _to_int(f[4] if len(f) > 4 else None)
            out["rsrq_db"]  = _to_float(f[5] if len(f) > 5 else None)
            out["sinr_db"]  = _to_float(f[6] if len(f) > 6 else None)
    elif rat == "WCDMA":
        # +QENG: "neighbourcell","WCDMA",UARFCN,CellResel,RNCID,CellID,RSCP,ECIO,...
        f = fields
        out["earfcn"]   = _to_int(f[2] if len(f) > 2 else None)
        out["cell_id"]  = (f[5] if len(f) > 5 else None) or None
        out["rsrp_dbm"] = _to_int(f[6] if len(f) > 6 else None)
        out["rsrq_db"]  = _to_float(f[7] if len(f) > 7 else None)
    return out


# ---------------------------------------------------------------------------
# DB writer — observations + site rollup
# ---------------------------------------------------------------------------
def _site_key(rec: dict[str, Any]) -> str:
    """Stable composite key for one tower across polls. PCI+EARFCN+MCC+MNC
    is unique enough for our metro-area scope; cell_id (where present)
    pins it absolutely for serving cells."""
    if rec.get("cell_id"):
        return f"{rec.get('rat')}/{rec.get('mcc')}/{rec.get('mnc')}/{rec['cell_id']}"
    return f"{rec.get('rat')}/{rec.get('mcc') or '?'}/{rec.get('mnc') or '?'}/{rec.get('earfcn')}/{rec.get('pci')}"


def _persist(records: list[dict[str, Any]]) -> int:
    """Write a batch of observations + upsert site rollups. Returns count."""
    if not records:
        return 0
    now = int(time.time())
    conn = db_connect()
    try:
        for r in records:
            r.setdefault("observed_at", now)
            conn.execute("""
                INSERT INTO cell_observations
                  (observed_at, rat, is_serving, state, mcc, mnc, cell_id, pci,
                   earfcn, band, tac, rsrp_dbm, rsrq_db, rssi_dbm, sinr_db,
                   operator, raw_text)
                VALUES (:observed_at, :rat, :is_serving, :state, :mcc, :mnc,
                        :cell_id, :pci, :earfcn, :band, :tac, :rsrp_dbm,
                        :rsrq_db, :rssi_dbm, :sinr_db, :operator, :raw_text)
            """, {
                "observed_at": r["observed_at"],
                "rat":         r.get("rat"),
                "is_serving":  r.get("is_serving") or 0,
                "state":       r.get("state"),
                "mcc":         r.get("mcc"),
                "mnc":         r.get("mnc"),
                "cell_id":     r.get("cell_id"),
                "pci":         r.get("pci"),
                "earfcn":      r.get("earfcn"),
                "band":        r.get("band"),
                "tac":         r.get("tac"),
                "rsrp_dbm":    r.get("rsrp_dbm"),
                "rsrq_db":     r.get("rsrq_db"),
                "rssi_dbm":    r.get("rssi_dbm"),
                "sinr_db":     r.get("sinr_db"),
                "operator":    r.get("operator"),
                "raw_text":    r.get("raw_text"),
            })

            sk = _site_key(r)
            existing = conn.execute("SELECT id, first_seen_at, obs_count FROM cell_sites WHERE site_key = ?",
                                     (sk,)).fetchone()
            if existing:
                conn.execute("""
                    UPDATE cell_sites
                    SET last_seen_at = ?, last_rsrp_dbm = COALESCE(?, last_rsrp_dbm),
                        obs_count = obs_count + 1,
                        cell_id = COALESCE(cell_id, ?),
                        band = COALESCE(band, ?), operator = COALESCE(operator, ?)
                    WHERE id = ?
                """, (now, r.get("rsrp_dbm"), r.get("cell_id"), r.get("band"),
                      r.get("operator"), existing["id"]))
            else:
                cur = conn.execute("""
                    INSERT INTO cell_sites
                      (site_key, rat, mcc, mnc, cell_id, pci, earfcn, band,
                       operator, first_seen_at, last_seen_at, last_rsrp_dbm, obs_count)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
                """, (sk, r.get("rat"), r.get("mcc"), r.get("mnc"),
                      r.get("cell_id"), r.get("pci"), r.get("earfcn"),
                      r.get("band"), r.get("operator"), now, now,
                      r.get("rsrp_dbm")))
                # Geolocate the moment a new tower is recognized: try
                # OpenCellID first (precise, crowd-sourced), then fall
                # back to FCC ASR proximity matching using the Pi's
                # known location + the cell's RSRP.
                new_id = cur.lastrowid
                if not _try_geolocate_one(conn, new_id):
                    _try_geolocate_via_asr(conn, new_id)
        conn.commit()
    finally:
        conn.close()
    return len(records)


# ---------------------------------------------------------------------------
# Modem I/O
# ---------------------------------------------------------------------------
def _open_serial():
    """Lazy import pyserial so the selftest path runs without it installed."""
    import serial
    return serial.Serial(AT_DEVICE, AT_BAUD, timeout=AT_TIMEOUT_SEC)


def _at_query(ser, cmd: str, timeout: float = AT_TIMEOUT_SEC) -> str:
    """Send an AT command, read until we see "OK"/"ERROR" or hit the timeout."""
    ser.reset_input_buffer()
    ser.write((cmd + "\r\n").encode("ascii"))
    end = time.time() + timeout
    buf = bytearray()
    while time.time() < end:
        chunk = ser.read(512)
        if chunk:
            buf.extend(chunk)
            tail = buf.decode("ascii", errors="replace")
            if "\nOK" in tail or "\nERROR" in tail or "\n+CME ERROR" in tail:
                break
        else:
            time.sleep(0.05)
    return buf.decode("ascii", errors="replace")


QSCAN_INTERVAL_POLLS    = int(os.environ.get("JAFO_CELLMON_QSCAN_EVERY",  "5"))
QSCAN_MODE              = os.environ.get("JAFO_CELLMON_QSCAN_MODE", "3")  # RM520N-GL: 1-3 valid; 3 = full sweep
RECONCILE_EVERY_POLLS   = int(os.environ.get("JAFO_CELLMON_RECONCILE_EVERY", "10"))  # 10 polls × 60s = 10 min

# poll counter — drives "every Nth poll do a deeper scan / a sweep reconcile"
_poll_counter = {"n": 0}


# --------------------------------------------------------------------------
# OpenCellID geolocation — match a cell_site row against the local
# `opencellid` table. Two entry points:
#   _try_geolocate_one()  — runs on every newly-inserted site (cheap)
#   _reconcile_unlocated() — periodic sweep for sites that were inserted
#                            before opencellid was populated, or for sites
#                            that didn't match before but might now (e.g.,
#                            after the user re-imports a fresh OCID dump).
# --------------------------------------------------------------------------
def _try_geolocate_one(conn: sqlite3.Connection, site_id: int) -> bool:
    """Try to fill lat/lng for a single just-inserted cell_site row by
    joining against the opencellid table. Returns True on a match."""
    row = conn.execute("""
        SELECT mcc, mnc, cell_id FROM cell_sites
        WHERE id = ? AND lat IS NULL AND cell_id IS NOT NULL AND mcc IS NOT NULL
    """, (site_id,)).fetchone()
    if not row:
        return False
    try:
        cell_int = int(row["cell_id"], 16)
    except (ValueError, TypeError):
        return False
    m = conn.execute("""
        SELECT lat, lon FROM opencellid
        WHERE mcc = ? AND mnc = ? AND cell = ?
        ORDER BY samples DESC LIMIT 1
    """, (row["mcc"], row["mnc"], cell_int)).fetchone()
    if not m:
        return False
    conn.execute("""
        UPDATE cell_sites SET lat = ?, lng = ?, geo_source = 'opencellid'
        WHERE id = ?
    """, (m["lat"], m["lon"], site_id))
    return True


# --------------------------------------------------------------------------
# Phase 2 — proximity matching: pin a cell to the nearest plausible FCC ASR
# tower owned by the right carrier (or a neutral tower-leasing company).
# Confidence is implicit in the radius: stronger RSRP → smaller search
# radius → tighter match. Cells matched this way get geo_source='asr-proximity'
# so the UI can render them with reduced confidence styling.
# --------------------------------------------------------------------------
import math

# ASR owner names → carrier(s) the tower likely hosts. Match is case-
# insensitive substring against the `owner` column.
_CARRIER_OWNER_KEYWORDS = {
    "T-Mobile US":  ("T-MOBILE", "OMNIPOINT", "METROPCS", "METROPHONE", "POWERTEL"),
    "Verizon":      ("VERIZON", "CELLCO", "ALLTEL"),
    "AT&T":         ("AT&T", "CINGULAR", "SOUTHWESTERN BELL", "BELLSOUTH",
                     "NEW CINGULAR"),
    "FirstNet":     ("AT&T", "CINGULAR", "FIRSTNET"),
    "AT&T MX":      ("AT&T", "CINGULAR"),
    "Telcel (MX)":  ("TELCEL", "RADIOMOVIL DIPSA"),
    "Movistar (MX)":("MOVISTAR", "TELEFONICA"),
    "US Cellular":  ("US CELLULAR", "UNITED STATES CELLULAR"),
}

# Neutral tower-leasing companies — they host antennas from multiple
# carriers, so any of them is a plausible match for a cell whose owner
# doesn't appear in the carrier-specific list above.
_NEUTRAL_HOSTS = (
    "AMERICAN TOWER", "SBA", "CROWN CASTLE", "CROWN COMMUNICATION", "CCATT",
    "TILLMAN", "STC FIVE", "PINNACLE", "APC TOWERS", "SKYWAY",
    "VERTICAL BRIDGE", "AEP", "VB-S1", "TALL TOWERS", "TOWER",
)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def _radius_km_for_rsrp(rsrp_dbm: int | None) -> float:
    """RSRP → plausible cell-to-tower distance bracket. Conservative.
    Real path-loss varies wildly (terrain, buildings, antenna gain), so
    these brackets are intentionally wide enough to cover 95% of urban
    LTE/5G geometries without being so wide they lose specificity."""
    if rsrp_dbm is None:    return 0.0   # don't match without RSRP
    if rsrp_dbm >= -85:     return 3.0
    if rsrp_dbm >= -95:     return 6.0
    if rsrp_dbm >= -105:    return 12.0
    if rsrp_dbm >= -115:    return 20.0
    return 0.0  # too weak — distance estimate is meaningless


def _pi_location_estimate(conn: sqlite3.Connection) -> tuple[float, float] | None:
    """Where is this Pi? Three fallback layers:
      1. The local node row in `nodes` (if JAFO_NODE_SLUG is set)
      2. Centroid of already-OpenCellID-located cells (they're necessarily
         within RF range of the Pi, so their average is close to the Pi)
      3. None — caller skips proximity matching
    """
    slug = os.environ.get("JAFO_NODE_SLUG", "").strip()
    if slug:
        row = conn.execute("SELECT lat, lng FROM nodes WHERE slug = ?", (slug,)).fetchone()
        if row and row["lat"] is not None and row["lng"] is not None:
            return (row["lat"], row["lng"])
    row = conn.execute("""
        SELECT AVG(lat) AS lat, AVG(lng) AS lng
        FROM cell_sites
        WHERE geo_source = 'opencellid' AND lat IS NOT NULL
    """).fetchone()
    if row and row["lat"] is not None:
        return (row["lat"], row["lng"])
    return None


def _try_geolocate_via_asr(conn: sqlite3.Connection, site_id: int,
                           pi_loc: tuple[float, float] | None = None) -> bool:
    """Pin a cell to the nearest plausible FCC ASR tower based on its
    operator and RSRP. Returns True on a match."""
    site = conn.execute("""
        SELECT id, mcc, mnc, operator, last_rsrp_dbm
        FROM cell_sites WHERE id = ? AND lat IS NULL
    """, (site_id,)).fetchone()
    if not site:
        return False
    radius_km = _radius_km_for_rsrp(site["last_rsrp_dbm"])
    if radius_km <= 0:
        return False

    if pi_loc is None:
        pi_loc = _pi_location_estimate(conn)
    if pi_loc is None:
        return False
    pi_lat, pi_lng = pi_loc

    # Bbox pre-filter (cheap), then haversine inside Python
    dlat = radius_km / 111.0
    dlng = radius_km / (111.0 * max(0.05, math.cos(math.radians(pi_lat))))
    candidates = conn.execute("""
        SELECT asr_number, owner, lat, lng FROM fcc_asr
        WHERE lat BETWEEN ? AND ?
          AND lng BETWEEN ? AND ?
          AND lat IS NOT NULL
    """, (pi_lat - dlat, pi_lat + dlat, pi_lng - dlng, pi_lng + dlng)).fetchall()
    if not candidates:
        return False

    # Score: prefer carrier-named owners, then neutral hosts. Tie-break by
    # distance from the Pi (closer = better).
    carrier_keywords = _CARRIER_OWNER_KEYWORDS.get(site["operator"], ())
    best = None  # (priority, distance_km, asr_row)
    for asr in candidates:
        d = _haversine_km(pi_lat, pi_lng, asr["lat"], asr["lng"])
        if d > radius_km:
            continue
        owner_up = (asr["owner"] or "").upper()
        if any(k in owner_up for k in carrier_keywords):
            priority = 0   # carrier-owned/branded — best
        elif any(k in owner_up for k in _NEUTRAL_HOSTS):
            priority = 1   # neutral host — second best
        else:
            priority = 2   # other (utility, broadcaster) — last resort
        cand = (priority, d, asr)
        if best is None or cand < best:
            best = cand
    if best is None:
        return False
    _, dist, asr = best
    conn.execute("""
        UPDATE cell_sites
        SET lat = ?, lng = ?, geo_source = 'asr-proximity',
            asr_number = ?, notes = ?
        WHERE id = ?
    """, (asr["lat"], asr["lng"], asr["asr_number"],
          f"ASR {asr['asr_number']} ({asr['owner']}); {dist:.1f} km from Pi",
          site_id))
    return True


def _reconcile_unlocated(conn: sqlite3.Connection) -> int:
    """Sweep every still-unlocated cell_site through both geolocation paths:
    OpenCellID first (precise), FCC ASR proximity second (approximate).
    Idempotent + cheap when nothing matches — most of the cost is the
    indexed lookups."""
    pi_loc = _pi_location_estimate(conn)  # one query, reuse across rows
    cur = conn.execute("""
        SELECT id FROM cell_sites
        WHERE lat IS NULL AND mcc IS NOT NULL
    """).fetchall()
    matched = 0
    for r in cur:
        if _try_geolocate_one(conn, r["id"]):
            matched += 1
            continue
        if _try_geolocate_via_asr(conn, r["id"], pi_loc=pi_loc):
            matched += 1
    if matched:
        conn.commit()
    return matched


def _poll_once(ser) -> int:
    """One poll cycle: QENG (cheap, ~1s) + optionally QSCAN (deep, ~30s).

    QSCAN is the workhorse for cell discovery on a non-registered SIM
    (it returns RSRP/RSRQ/SINR even in LIMSRV mode); QENG is run every
    cycle so the serving-cell card on the dashboard stays current.
    """
    rows: list[dict[str, Any]] = []
    sv = _at_query(ser, 'AT+QENG="servingcell"')
    for line in sv.splitlines():
        rec = parse_servingcell(line)
        if rec and (rec.get("rat") or rec.get("state")):
            rows.append(rec)
    nb = _at_query(ser, 'AT+QENG="neighbourcell"')
    for line in nb.splitlines():
        rec = parse_neighbourcell(line)
        if rec and (rec.get("pci") is not None or rec.get("cell_id")):
            rows.append(rec)

    _poll_counter["n"] += 1
    if _poll_counter["n"] % QSCAN_INTERVAL_POLLS == 1:
        # Deep scan — takes 20–40s. Active sweep across configured RAT/bands;
        # finds cells the modem can demodulate even when it isn't registered.
        scan = _at_query(ser, f"AT+QSCAN={QSCAN_MODE},1", timeout=45)
        for line in scan.splitlines():
            rec = parse_qscan(line)
            if rec and (rec.get("pci") is not None or rec.get("cell_id")):
                rows.append(rec)
    return _persist(rows)


def main_loop() -> None:
    print(f"[cellmon] device={AT_DEVICE} poll_sec={POLL_INTERVAL_SEC}", flush=True)
    backoff = 5.0
    while True:
        try:
            ser = _open_serial()
        except Exception as e:
            print(f"[cellmon] modem not ready ({e}) — retry in {backoff:.0f}s", flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 1.5, 120.0)
            continue
        backoff = 5.0
        print(f"[cellmon] opened {AT_DEVICE} — polling", flush=True)
        try:
            with ser:
                # one-shot init: ATE0 (no echo), CMEE=2 (verbose error)
                _at_query(ser, "ATE0")
                _at_query(ser, "AT+CMEE=2")
                while True:
                    n = _poll_once(ser)
                    extra = ""
                    # Periodic OpenCellID re-match for any sites still missing
                    # lat/lng — does meaningful work only when the user has
                    # imported fresh OCID data since the last sweep.
                    if _poll_counter["n"] % RECONCILE_EVERY_POLLS == 0:
                        conn = db_connect()
                        try:
                            m = _reconcile_unlocated(conn)
                            if m:
                                extra = f" | reconciled {m} site(s) from OpenCellID"
                        finally:
                            conn.close()
                    print(f"[cellmon] persisted {n} obs{extra}", flush=True)
                    time.sleep(POLL_INTERVAL_SEC)
        except Exception as e:
            print(f"[cellmon] serial error ({e}) — reopening", flush=True)
            time.sleep(backoff)


# ---------------------------------------------------------------------------
# Selftest — runs the parser against fixtures so you can sanity-check before
# plugging in the modem. `python3 cellmon.py --selftest`
# ---------------------------------------------------------------------------
_SELFTEST_FIXTURES = {
    "lte_serving": (
        '+QENG: "servingcell","CONNECT","LTE","FDD",311,490,4DAA15A,210,5230,'
        '4,5,5,FFFE,-95,-9,-67,15,-,-,-,-,-,-,-,-'
    ),
    "nr_serving": (
        '+QENG: "servingcell","NOCONN","NR5G-SA","TDD",311,480,1A2B3C4D,510,'
        '12345,640123,77,40,-89,-11,17,1,-'
    ),
    "lte_neigh_intra": (
        '+QENG: "neighbourcell intra","LTE",5230,318,-13,-103,-78,8,30,4,0,0,62'
    ),
    "lte_neigh_inter": (
        '+QENG: "neighbourcell inter","LTE",2300,49,-15,-110,-82,6,18,4,40,30'
    ),
    "wcdma_serving": (
        '+QENG: "servingcell","NOCONN","WCDMA",311,490,1234,5678,10713,42,-,-92,-8,-,-'
    ),
}


def _selftest() -> int:
    fails = 0
    for name, line in _SELFTEST_FIXTURES.items():
        if "neigh" in name:
            r = parse_neighbourcell(line)
        else:
            r = parse_servingcell(line)
        if r is None:
            print(f"  FAIL {name}: parser returned None")
            fails += 1
            continue
        keys = {k: v for k, v in r.items() if k != "raw_text"}
        print(f"  ok   {name}: {keys}")
    print(f"\n{len(_SELFTEST_FIXTURES) - fails}/{len(_SELFTEST_FIXTURES)} fixtures parsed cleanly")
    return 1 if fails else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true",
                    help="Run parser fixtures and exit (no hardware needed)")
    args = ap.parse_args()
    if args.selftest:
        sys.exit(_selftest())
    main_loop()
