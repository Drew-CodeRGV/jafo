#!/usr/bin/env python3
"""
Import FCC Antenna Structure Registration (ASR) data into jafo's fcc_asr table.

The FCC publishes a free weekly dump of every registered antenna structure in
the US (towers >200ft, anything near an airport, etc.) at:
    https://data.fcc.gov/download/pub/uls/complete/r_tower.zip   (~36 MB)

We download once, filter to the RGV bbox by default, and INSERT into
`fcc_asr`. Re-running is safe (INSERT OR REPLACE on asr_number).

Usage:
    python3 ~/jafo/scripts/import-fcc-asr.py
    python3 ~/jafo/scripts/import-fcc-asr.py --bbox 25,-100,28,-96
    python3 ~/jafo/scripts/import-fcc-asr.py --no-download   # use cached zip

Field positions are based on the FCC public-files layout for r_tower:
  CO.dat: |type|src|file|sysid|REG_NUM|loc_type|lat_d|lat_m|lat_s|lat_dir|
          lat_total|lng_d|lng_m|lng_s|lng_dir|lng_total|...|
  EN.dat: |type|src|file|sysid|REG_NUM|ent_type|...|name|...|city|state|...|
  RA.dat: |type|src|file|sysid|REG_NUM|...|structure_type|...| (49 fields)
"""
from __future__ import annotations

import argparse
import io
import os
import sqlite3
import sys
import time
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pi" / "services"))
from common import db_connect

ASR_URL = "https://data.fcc.gov/download/pub/uls/complete/r_tower.zip"
RGV_BBOX = (25.5, -99.0, 26.8, -97.0)  # south, west, north, east
CACHE_PATH = Path("/tmp/jafo-asr/r_tower.zip")


def dms_to_decimal(deg: str, mn: str, sec: str, direction: str) -> float | None:
    """Convert FCC DMS to signed decimal degrees. Returns None on parse failure."""
    try:
        val = float(deg) + float(mn or 0) / 60 + float(sec or 0) / 3600
    except (ValueError, TypeError):
        return None
    if direction in ("S", "W"):
        val = -val
    return val


def download_asr(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {ASR_URL} → {dest}")
    t0 = time.time()
    with requests.get(ASR_URL, stream=True, timeout=180) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=128 * 1024):
                if chunk:
                    f.write(chunk)
    sz = dest.stat().st_size / 1e6
    print(f"  downloaded {sz:.1f} MB in {time.time() - t0:.1f}s")


def parse_co(zf: zipfile.ZipFile, bbox: tuple) -> dict[str, tuple[float, float]]:
    """Pass 1: extract (lat, lng) for every transmitter location in bbox."""
    south, west, north, east = bbox
    coords: dict[str, tuple[float, float]] = {}
    seen = 0
    with zf.open("CO.dat") as f:
        text = io.TextIOWrapper(f, encoding="utf-8", errors="replace")
        for line in text:
            seen += 1
            fields = line.rstrip("\r\n").split("|")
            if len(fields) < 16:
                continue
            if fields[5] != "T":            # only transmitter coords
                continue
            asr = fields[4]
            lat = dms_to_decimal(fields[6], fields[7], fields[8], fields[9])
            lng = dms_to_decimal(fields[11], fields[12], fields[13], fields[14])
            if lat is None or lng is None:
                continue
            if not (south <= lat <= north and west <= lng <= east):
                continue
            coords[asr] = (lat, lng)
    print(f"  CO.dat: {seen:,} rows → {len(coords):,} in bbox")
    return coords


def parse_en(zf: zipfile.ZipFile, asr_set: set) -> dict[str, dict]:
    """Pass 2: owner name + city/state for filtered ASR numbers."""
    out: dict[str, dict] = {}
    with zf.open("EN.dat") as f:
        text = io.TextIOWrapper(f, encoding="utf-8", errors="replace")
        for line in text:
            fields = line.rstrip("\r\n").split("|")
            if len(fields) < 22:
                continue
            asr = fields[4]
            if asr not in asr_set:
                continue
            if fields[5] != "O":  # only "Owner" entity records
                continue
            out[asr] = {
                "owner": fields[9].strip() or None,
                "city":  fields[20].strip() or None,
                "state": fields[21].strip() or None,
            }
    print(f"  EN.dat: matched owners for {len(out):,} ASRs")
    return out


def parse_ra(zf: zipfile.ZipFile, asr_set: set) -> dict[str, dict]:
    """Pass 3: structure type + height + status. Field positions from FCC
    r_tower layout — RA.dat has 49 fields. We pull a conservative subset:
      [4]  registration number
      [33] structure type (TOWER/POLE/MAST/...)
      [29] overall height m? OR field [30..32] heights — we keep the
           largest non-zero number among 29-32 as a robust 'height'
      [15] / [8] status code
    Re-parse if FCC changes the layout; the rest of the integration
    won't break — height/type are just nice-to-have.
    """
    out: dict[str, dict] = {}
    with zf.open("RA.dat") as f:
        text = io.TextIOWrapper(f, encoding="utf-8", errors="replace")
        for line in text:
            fields = line.rstrip("\r\n").split("|")
            if len(fields) < 33:
                continue
            asr = fields[4]
            if asr not in asr_set:
                continue
            # Field positions (0-indexed) verified against actual r_tower records:
            #   [4]      ASR registration number
            #   [15]     status code (A = active)
            #   [28..31] heights — keep the max non-zero as overall structure height
            #   [32]     structure type (TOWER, POLE, MAST, …)
            heights = []
            for idx in (28, 29, 30, 31):
                try:
                    v = float(fields[idx])
                    if v > 0:
                        heights.append(v)
                except (ValueError, IndexError):
                    pass
            out[asr] = {
                "structure_type": (fields[32].strip() or None) if len(fields) > 32 else None,
                "height_m":       max(heights) if heights else None,
                "status":         (fields[15].strip() or None) if len(fields) > 15 else None,
            }
    print(f"  RA.dat: matched structure data for {len(out):,} ASRs")
    return out


def insert_all(conn: sqlite3.Connection, coords, owners, ra_data) -> int:
    """Bulk INSERT OR REPLACE all ASR records."""
    now_ts = int(time.time())
    rows = []
    for asr, (lat, lng) in coords.items():
        o = owners.get(asr, {})
        r = ra_data.get(asr, {})
        rows.append((
            asr,
            o.get("owner"),
            r.get("structure_type"),
            r.get("height_m"),
            lat, lng,
            o.get("city"), o.get("state"),
            r.get("status"),
            now_ts,
        ))
    conn.executemany("""
        INSERT OR REPLACE INTO fcc_asr
          (asr_number, owner, structure_type, height_m, lat, lng,
           city, state, status, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, rows)
    conn.commit()
    return len(rows)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", default="auto",
                    help="'south,west,north,east' or 'auto' (RGV) or 'none'")
    ap.add_argument("--no-download", action="store_true",
                    help="use cached /tmp/jafo-asr/r_tower.zip")
    ap.add_argument("--zip", default=str(CACHE_PATH),
                    help="path to r_tower.zip (default: /tmp/jafo-asr/r_tower.zip)")
    args = ap.parse_args()

    if args.bbox == "auto":
        bbox = RGV_BBOX
    elif args.bbox == "none":
        bbox = (-90.0, -180.0, 90.0, 180.0)
    else:
        try:
            parts = [float(x) for x in args.bbox.split(",")]
            if len(parts) != 4:
                raise ValueError
            bbox = tuple(parts)
        except ValueError:
            raise SystemExit("--bbox must be 'auto', 'none', or 'south,west,north,east'")

    zip_path = Path(args.zip)
    if not args.no_download or not zip_path.exists():
        download_asr(zip_path)
    else:
        sz = zip_path.stat().st_size / 1e6
        age_h = (time.time() - zip_path.stat().st_mtime) / 3600
        print(f"  using cached {zip_path} ({sz:.1f} MB, {age_h:.1f}h old)")

    print(f"\nparsing (bbox = {bbox})")
    with zipfile.ZipFile(zip_path) as zf:
        coords  = parse_co(zf, bbox)
        if not coords:
            print("\nno ASR towers in bbox — nothing to import")
            return 0
        asr_set = set(coords)
        owners  = parse_en(zf, asr_set)
        ra_data = parse_ra(zf, asr_set)

    print(f"\nwriting to fcc_asr ...")
    conn = db_connect()
    n = insert_all(conn, coords, owners, ra_data)
    print(f"  inserted/updated {n:,} ASR rows")

    # Summary by owner — most useful when auditing what got imported
    print("\nby owner (top 15):")
    for row in conn.execute("""
        SELECT COALESCE(owner, '(unknown)') AS o, COUNT(*) AS n
        FROM fcc_asr
        GROUP BY o ORDER BY n DESC LIMIT 15
    """):
        print(f"  {row['n']:>4}  {row['o']}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
