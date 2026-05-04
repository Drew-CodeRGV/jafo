#!/usr/bin/env python3
"""
Phase 1 migration — seed default region/node + backfill existing calls.

Idempotent: re-running is safe.

Usage:
    # Pi (with backfill of historical calls):
    /home/pi/jafo-data/venv-services/bin/python scripts/migrate_phase1.py \\
        --node-slug jafo-mcallen-home --region-slug rgv --backfill

    # Cloud hub (no backfill — empty DB):
    /var/jafo/venv-services/bin/python scripts/migrate_phase1.py \\
        --region-slug rgv

The --backfill flag updates calls.node_id/region_id where NULL. Without it,
only the region + node rows are seeded.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# Make pi/services importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pi" / "services"))
from common import db_connect  # noqa: E402


# RGV defaults — used if --region-slug rgv and the row doesn't exist yet.
RGV_DEFAULTS = dict(
    name="Lower Rio Grande Valley",
    description="P25 trunked LRGVRRS + conventional channels in Hidalgo & Cameron counties.",
    default_lat=26.20,
    default_lng=-98.20,
    default_zoom=11,
    bbox_north=26.55,
    bbox_south=25.80,
    bbox_east=-97.10,
    bbox_west=-98.90,
)


def upsert_region(conn, slug: str) -> int:
    row = conn.execute("SELECT id FROM regions WHERE slug = ?", (slug,)).fetchone()
    if row:
        return row["id"]
    if slug == "rgv":
        d = RGV_DEFAULTS
    else:
        d = dict(name=slug.upper(), description="", default_lat=None, default_lng=None,
                 default_zoom=11, bbox_north=None, bbox_south=None, bbox_east=None, bbox_west=None)
    cur = conn.execute("""
        INSERT INTO regions
            (slug, name, description, default_lat, default_lng, default_zoom,
             bbox_north, bbox_south, bbox_east, bbox_west, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (slug, d["name"], d["description"], d["default_lat"], d["default_lng"],
          d["default_zoom"], d["bbox_north"], d["bbox_south"], d["bbox_east"],
          d["bbox_west"], int(time.time())))
    print(f"  + created region '{slug}' (id={cur.lastrowid})")
    return cur.lastrowid


def upsert_node(conn, slug: str, region_id: int, display_name: str | None,
                owner_email: str | None, lat: float | None, lng: float | None) -> int:
    row = conn.execute("SELECT id FROM nodes WHERE slug = ?", (slug,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("""
        INSERT INTO nodes
            (slug, region_id, display_name, owner_email, lat, lng, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    """, (slug, region_id, display_name or slug, owner_email, lat, lng, int(time.time())))
    print(f"  + created node '{slug}' (id={cur.lastrowid}, region_id={region_id})")
    return cur.lastrowid


def backfill_calls(conn, node_id: int, region_id: int) -> int:
    cur = conn.execute(
        "UPDATE calls SET node_id = ?, region_id = ? WHERE node_id IS NULL",
        (node_id, region_id),
    )
    return cur.rowcount


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region-slug", required=True, help="Region slug (e.g. 'rgv')")
    ap.add_argument("--node-slug", help="Node slug (e.g. 'jafo-mcallen-home'). Required with --backfill.")
    ap.add_argument("--node-display-name", help="Friendly name shown in admin UI")
    ap.add_argument("--node-owner-email")
    ap.add_argument("--node-lat", type=float)
    ap.add_argument("--node-lng", type=float)
    ap.add_argument("--backfill", action="store_true",
                    help="UPDATE calls SET node_id=?, region_id=? WHERE node_id IS NULL")
    args = ap.parse_args()

    if args.backfill and not args.node_slug:
        ap.error("--backfill requires --node-slug")

    conn = db_connect()
    print(f"Connected to DB.")
    print(f"Calls in DB: {conn.execute('SELECT COUNT(*) FROM calls').fetchone()[0]}")
    print(f"Regions before: {conn.execute('SELECT COUNT(*) FROM regions').fetchone()[0]}")
    print(f"Nodes before:   {conn.execute('SELECT COUNT(*) FROM nodes').fetchone()[0]}")
    print()

    region_id = upsert_region(conn, args.region_slug)

    node_id = None
    if args.node_slug:
        node_id = upsert_node(
            conn, args.node_slug, region_id,
            args.node_display_name, args.node_owner_email,
            args.node_lat, args.node_lng,
        )

    if args.backfill:
        n = backfill_calls(conn, node_id, region_id)
        print(f"  + backfilled {n:,} call rows with node_id={node_id} region_id={region_id}")

    conn.commit()
    print()
    print("Final counts:")
    print(f"  regions: {conn.execute('SELECT COUNT(*) FROM regions').fetchone()[0]}")
    print(f"  nodes:   {conn.execute('SELECT COUNT(*) FROM nodes').fetchone()[0]}")
    print(f"  calls with node_id set: {conn.execute('SELECT COUNT(*) FROM calls WHERE node_id IS NOT NULL').fetchone()[0]:,}")
    conn.close()


if __name__ == "__main__":
    main()
