#!/usr/bin/env python3
"""
jafo admin — fleet management CLI for the central hub.

Run on the hub (jafo.live) with the hub's venv pointing at /var/jafo/jafo.db.

Subcommands:
  list-nodes                       Show every node and its status
  add-node    <slug> --region X    Create a node + emit a one-time token
  rotate      <slug>               Generate a new token; old one stops working
  disable     <slug>               Mark node disabled (ingest 403s)
  enable      <slug>               Re-enable a disabled node
  show        <slug>               Detail view of one node

Tokens are stored hashed (sha256). The plaintext is only printed once
when generated; copy it into the kit's .env immediately.
"""

from __future__ import annotations

import argparse
import hashlib
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pi" / "services"))
from common import db_connect  # noqa: E402


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _get_region(conn, slug: str):
    row = conn.execute("SELECT id, slug, name FROM regions WHERE slug = ?", (slug,)).fetchone()
    if not row:
        sys.exit(f"ERROR: region '{slug}' not found. Available: " +
                 ", ".join(r["slug"] for r in conn.execute("SELECT slug FROM regions").fetchall()))
    return row


def _get_node(conn, slug: str):
    row = conn.execute("""
        SELECT n.*, r.slug AS region_slug FROM nodes n
        LEFT JOIN regions r ON r.id = n.region_id
        WHERE n.slug = ?
    """, (slug,)).fetchone()
    if not row:
        sys.exit(f"ERROR: node '{slug}' not found.")
    return row


def cmd_list_nodes(args):
    conn = db_connect()
    rows = conn.execute("""
        SELECT n.slug, n.display_name, r.slug AS region, n.status,
               n.owner_email, n.last_seen_at, n.created_at,
               (SELECT COUNT(*) FROM calls WHERE node_id = n.id) AS call_count
        FROM nodes n LEFT JOIN regions r ON r.id = n.region_id
        ORDER BY n.created_at
    """).fetchall()
    if not rows:
        print("(no nodes yet — use add-node to create one)")
        return
    print(f"{'SLUG':28} {'REGION':10} {'STATUS':8} {'CALLS':>7}  {'LAST SEEN':>16}  DISPLAY NAME")
    print("-" * 100)
    for r in rows:
        last = (time.strftime("%Y-%m-%d %H:%M", time.localtime(r["last_seen_at"]))
                if r["last_seen_at"] else "(never)")
        print(f"{r['slug']:28} {r['region'] or '-':10} {r['status']:8} "
              f"{r['call_count']:>7,}  {last:>16}  {r['display_name']}")


def cmd_show(args):
    conn = db_connect()
    n = _get_node(conn, args.slug)
    print(f"slug:         {n['slug']}")
    print(f"display_name: {n['display_name']}")
    print(f"region:       {n['region_slug']}")
    print(f"owner_email:  {n['owner_email']}")
    print(f"lat,lng:      {n['lat']}, {n['lng']}")
    print(f"status:       {n['status']}")
    print(f"created_at:   {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(n['created_at'])) if n['created_at'] else '-'}")
    print(f"last_seen_at: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(n['last_seen_at'])) if n['last_seen_at'] else '(never)'}")
    print(f"token set:    {'yes' if n['token_hash'] else 'NO'}")
    if n["notes"]:
        print(f"notes:        {n['notes']}")
    cnt = conn.execute("SELECT COUNT(*) FROM calls WHERE node_id = ?", (n["id"],)).fetchone()[0]
    print(f"calls in DB:  {cnt:,}")


def cmd_add_node(args):
    conn = db_connect()
    region = _get_region(conn, args.region)

    # If node exists with same slug, error or rotate token
    existing = conn.execute("SELECT id FROM nodes WHERE slug = ?", (args.slug,)).fetchone()
    if existing:
        sys.exit(f"ERROR: node '{args.slug}' already exists. Use 'rotate' to issue a new token, "
                 f"or pick a different slug.")

    token = secrets.token_urlsafe(32)
    token_hash = _hash(token)

    cur = conn.execute("""
        INSERT INTO nodes
          (slug, region_id, display_name, owner_email, lat, lng, token_hash,
           notes, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    """, (
        args.slug, region["id"],
        args.display_name or args.slug,
        args.owner_email,
        args.lat, args.lng,
        token_hash, args.notes,
        int(time.time()),
    ))
    conn.commit()

    print()
    print("=" * 72)
    print(f"NODE CREATED: {args.slug}")
    print("=" * 72)
    print(f"  region:       {region['slug']} ({region['name']})")
    print(f"  display_name: {args.display_name or args.slug}")
    print(f"  node id:      {cur.lastrowid}")
    print()
    print("TOKEN (copy NOW — will not be shown again):")
    print()
    print(f"  {token}")
    print()
    print("Add to the node's /home/pi/jafo/.env:")
    print()
    print(f"  JAFO_HUB_URL=https://jafo.live")
    print(f"  JAFO_NODE_SLUG={args.slug}")
    print(f"  JAFO_NODE_TOKEN={token}")
    print()


def cmd_rotate(args):
    conn = db_connect()
    n = _get_node(conn, args.slug)
    token = secrets.token_urlsafe(32)
    token_hash = _hash(token)
    conn.execute("UPDATE nodes SET token_hash = ? WHERE id = ?", (token_hash, n["id"]))
    conn.commit()
    print(f"Token rotated for {args.slug}.")
    print()
    print(f"NEW TOKEN: {token}")
    print()
    print(f"Update the node's .env JAFO_NODE_TOKEN= and restart jafo-uploader.")


def cmd_disable(args):
    conn = db_connect()
    n = _get_node(conn, args.slug)
    conn.execute("UPDATE nodes SET status = 'disabled' WHERE id = ?", (n["id"],))
    conn.commit()
    print(f"{args.slug}: status = disabled. /api/ingest will now return 403 for this token.")


def cmd_enable(args):
    conn = db_connect()
    n = _get_node(conn, args.slug)
    conn.execute("UPDATE nodes SET status = 'active' WHERE id = ?", (n["id"],))
    conn.commit()
    print(f"{args.slug}: status = active.")


def main():
    ap = argparse.ArgumentParser(prog="jafo-admin")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list-nodes")

    p = sub.add_parser("show")
    p.add_argument("slug")

    p = sub.add_parser("add-node")
    p.add_argument("slug")
    p.add_argument("--region", required=True)
    p.add_argument("--display-name")
    p.add_argument("--owner-email")
    p.add_argument("--lat", type=float)
    p.add_argument("--lng", type=float)
    p.add_argument("--notes")

    p = sub.add_parser("rotate")
    p.add_argument("slug")

    p = sub.add_parser("disable")
    p.add_argument("slug")

    p = sub.add_parser("enable")
    p.add_argument("slug")

    args = ap.parse_args()

    handlers = {
        "list-nodes": cmd_list_nodes, "show": cmd_show,
        "add-node": cmd_add_node, "rotate": cmd_rotate,
        "disable": cmd_disable, "enable": cmd_enable,
    }
    handlers[args.cmd](args)


if __name__ == "__main__":
    main()
