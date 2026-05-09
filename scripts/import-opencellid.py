#!/usr/bin/env python3
"""
Import OpenCellID cell-tower data and geolocate cells in jafo's cell_sites table.

OpenCellID is a free, community-contributed database of cell tower locations.
The full world dump is ~600MB compressed. We download per-MCC slices (much
smaller) and bbox-filter to the RGV before inserting, so the local
`opencellid` table stays under ~1 MB.

Usage:
    # First-time: get a token from https://opencellid.org/register.php (free)
    # then run with the default RGV-bbox + US + MX MCCs:
    python3 ~/jafo/scripts/import-opencellid.py --token YOUR_TOKEN

    # Or set the token once in ~/jafo/.env:
    #   JAFO_OPENCELLID_TOKEN=...
    # then just:
    python3 ~/jafo/scripts/import-opencellid.py

    # Skip download, just re-match cell_sites against the existing table:
    python3 ~/jafo/scripts/import-opencellid.py --no-download

    # Wider bbox (south,west,north,east) — covers all of South Texas + N Mexico:
    python3 ~/jafo/scripts/import-opencellid.py --bbox 25.0,-100.0,28.0,-96.0

Re-running is safe: INSERT OR REPLACE on the (radio, mcc, mnc, area, cell)
primary key.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import requests

# Local module path — match other jafo scripts that import from common.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pi" / "services"))
from common import db_connect

# Default MCCs: US (310/311/312/313), Public Safety / FirstNet (313),
# Mexico (334). Override with --mcc.
DEFAULT_MCC = [310, 311, 312, 313, 334]

# Default bbox = the RGV. Liberal padding so we don't miss towers
# right outside the existing jafo region bounds.
RGV_BBOX = (25.5, -99.0, 26.8, -97.0)   # (south, west, north, east)

OCID_URL = "https://opencellid.org/ocid/downloads?token={token}&type=mcc&file={mcc}.csv.gz"


def cell_id_hex_to_int(s: str) -> int | None:
    if not s:
        return None
    try:
        return int(s, 16)
    except ValueError:
        return None


def download_mcc(token: str, mcc: int, dest: Path) -> bool:
    """Stream OpenCellID's per-MCC dump to disk. Returns True if the file
    has data, False if 404 (no records for that MCC), raises otherwise."""
    url = OCID_URL.format(token=token, mcc=mcc)
    t0 = time.time()
    with requests.get(url, stream=True, timeout=180) as r:
        if r.status_code in (401, 403):
            raise SystemExit(f"OpenCellID rejected the token (HTTP {r.status_code}). "
                             "Generate a free one at https://opencellid.org/register.php")
        if r.status_code == 404:
            return False
        r.raise_for_status()
        bytes_dl = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=128 * 1024):
                if chunk:
                    f.write(chunk)
                    bytes_dl += len(chunk)
    dur = time.time() - t0
    print(f"    downloaded {bytes_dl/1e6:.1f} MB in {dur:.1f}s")
    return True


def parse_and_insert(path: Path, bbox: tuple, conn: sqlite3.Connection,
                     bbox_filter: bool) -> tuple[int, int]:
    """Stream-decompress + filter + INSERT. Returns (rows_seen, rows_kept)."""
    south, west, north, east = bbox
    seen = 0
    kept = 0
    batch: list[tuple] = []
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        for row in reader:
            seen += 1
            if len(row) < 9:
                continue
            # OpenCellID CSV columns: radio, mcc, net, area, cell, unit, lon, lat,
            #                         range, samples, changeable, created, updated, averageSignal
            try:
                radio  = row[0]
                rmcc   = int(row[1])
                rnet   = int(row[2])
                rarea  = int(row[3])
                rcell  = int(row[4])
                rlon   = float(row[6])
                rlat   = float(row[7])
                rrange = int(row[8]) if row[8] else 0
                rsamp  = int(row[9]) if len(row) > 9 and row[9] else 0
            except (ValueError, IndexError):
                continue
            if bbox_filter and not (south <= rlat <= north and west <= rlon <= east):
                continue
            batch.append((radio, rmcc, rnet, rarea, rcell, rlon, rlon, rlat,
                          rrange, rsamp))
            kept += 1
            if len(batch) >= 5000:
                conn.executemany("""
                    INSERT OR REPLACE INTO opencellid
                    (radio, mcc, mnc, area, cell, lon, lng, lat, range_m, samples)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, batch)
                batch.clear()
        if batch:
            conn.executemany("""
                INSERT OR REPLACE INTO opencellid
                (radio, mcc, mnc, area, cell, lon, lng, lat, range_m, samples)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, batch)
    conn.commit()
    return seen, kept


def reconcile_sites(conn: sqlite3.Connection) -> tuple[int, int]:
    """Match every still-ungeolocated cell_site against the opencellid table
    by (mcc, mnc, cell). Returns (candidates, matched)."""
    cur = conn.execute("""
        SELECT id, mcc, mnc, cell_id FROM cell_sites
        WHERE lat IS NULL AND cell_id IS NOT NULL AND mcc IS NOT NULL
    """)
    candidates = cur.fetchall()
    matched = 0
    for r in candidates:
        cell_int = cell_id_hex_to_int(r["cell_id"])
        if cell_int is None:
            continue
        # Match on (mcc, mnc, cell). Don't require area (TAC) — partial dumps
        # sometimes report TAC=0 placeholder, and the (mcc, mnc, cell) tuple
        # is unique enough at the per-tower level for our region.
        m = conn.execute("""
            SELECT lat, lon FROM opencellid
            WHERE mcc = ? AND mnc = ? AND cell = ?
            ORDER BY samples DESC LIMIT 1
        """, (r["mcc"], r["mnc"], cell_int)).fetchone()
        if m:
            conn.execute("""
                UPDATE cell_sites SET lat = ?, lng = ?, geo_source = 'opencellid'
                WHERE id = ?
            """, (m["lat"], m["lon"], r["id"]))
            matched += 1
    conn.commit()
    return len(candidates), matched


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token",
        default=os.environ.get("JAFO_OPENCELLID_TOKEN", ""),
        help="OpenCellID API token (or set JAFO_OPENCELLID_TOKEN env var)")
    ap.add_argument("--mcc",
        default=",".join(str(m) for m in DEFAULT_MCC),
        help="Comma-separated MCC list (default: 310,311,312,313,334 = US + MX)")
    ap.add_argument("--bbox",
        default="auto",
        help="Bbox filter: 'south,west,north,east', 'auto' (RGV), or 'none' (whole MCC)")
    ap.add_argument("--no-download", action="store_true",
        help="Skip download — just match cell_sites against existing opencellid table")
    ap.add_argument("--keep-tmp", action="store_true",
        help="Keep the downloaded gzipped CSVs in /tmp instead of deleting them")
    args = ap.parse_args()

    if args.bbox == "auto":
        bbox, bbox_filter = RGV_BBOX, True
    elif args.bbox == "none":
        bbox, bbox_filter = (-90.0, -180.0, 90.0, 180.0), False
    else:
        try:
            parts = [float(x) for x in args.bbox.split(",")]
            if len(parts) != 4:
                raise ValueError
            bbox = tuple(parts)
            bbox_filter = True
        except ValueError:
            raise SystemExit("--bbox must be 'auto', 'none', or "
                             "'south,west,north,east'")

    conn = db_connect()

    if not args.no_download:
        if not args.token:
            raise SystemExit("OpenCellID token required. Free signup at "
                             "https://opencellid.org/register.php — pass "
                             "--token TOKEN or set JAFO_OPENCELLID_TOKEN in .env.")
        mccs = [int(m.strip()) for m in args.mcc.split(",") if m.strip()]
        print(f"target bbox: {bbox if bbox_filter else 'whole world'}")
        print(f"target MCCs: {mccs}\n")

        tmpdir = Path(tempfile.mkdtemp(prefix="jafo-ocid-"))
        try:
            for m in mccs:
                print(f"MCC {m}:")
                gz = tmpdir / f"{m}.csv.gz"
                ok = download_mcc(args.token, m, gz)
                if not ok:
                    print(f"    no OpenCellID data for MCC {m} — skipping")
                    continue
                seen, kept = parse_and_insert(gz, bbox, conn, bbox_filter)
                print(f"    parsed {seen:>9,} rows, kept {kept:>7,}")
                if not args.keep_tmp:
                    gz.unlink()
        finally:
            if not args.keep_tmp:
                try: tmpdir.rmdir()
                except OSError: pass

        print("\nvacuum + analyze ...")
        conn.execute("VACUUM")
        conn.execute("ANALYZE opencellid")
        n_total = conn.execute("SELECT COUNT(*) FROM opencellid").fetchone()[0]
        print(f"opencellid table now holds {n_total:,} rows\n")

    print("matching cell_sites against opencellid ...")
    candidates, matched = reconcile_sites(conn)
    print(f"  {matched:,} of {candidates:,} unlocated sites geolocated")

    # Show a sample of what we just placed on the map
    if matched > 0:
        sample = conn.execute("""
            SELECT operator, rat, band, pci, cell_id, lat, lng
            FROM cell_sites
            WHERE geo_source = 'opencellid'
            ORDER BY last_seen_at DESC LIMIT 8
        """).fetchall()
        print("\nsample of geolocated sites:")
        for s in sample:
            print(f"  {(s['operator'] or '-'):14s}  {s['rat']:7s}  band={(s['band'] or '-'):>5s}  "
                  f"pci={s['pci']:>4}  {s['cell_id']:>10s}  ({s['lat']:.4f}, {s['lng']:.4f})")

    conn.close()
    print("\ndone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
