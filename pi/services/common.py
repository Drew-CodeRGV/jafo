"""
jafo — shared module for all services.

Provides:
- DB connection with full schema
- Config loading from .env
- Logging setup
- Path constants
"""

from __future__ import annotations

import logging
import os
import sqlite3
from pathlib import Path

from dotenv import load_dotenv

# -----------------------------------------------------------------------------
# Load .env first so JAFO_DATA_DIR / API keys are available before we compute
# any path constants that depend on them.
# -----------------------------------------------------------------------------
ENV_FILE = Path(__file__).resolve().parent.parent.parent / ".env"
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------
DATA_DIR = Path(os.environ.get("JAFO_DATA_DIR", "/home/pi/jafo-data"))
WATCH_DIR = DATA_DIR / "recordings"
CALLS_DIR = DATA_DIR / "calls"
DB_PATH = DATA_DIR / "jafo.db"

# -----------------------------------------------------------------------------
# Config from env
# -----------------------------------------------------------------------------
NODE_NAME = os.environ.get("JAFO_NODE_NAME", "jafo-unknown")
RETENTION_DAYS = int(os.environ.get("AUDIO_RETENTION_DAYS", "30"))
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
REGION = os.environ.get("JAFO_REGION", "McAllen, Hidalgo County, Texas")

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
def setup_logging(name: str) -> logging.Logger:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        force=False,  # don't override if already configured
    )
    return logging.getLogger(name)


# -----------------------------------------------------------------------------
# DB schema — single source of truth
#
# The `calls` table is the spine. Each pipeline stage adds columns:
#   - processor:    inserts the row, sets status/opus_path/etc
#   - transcriber:  fills transcript, transcript_at
#   - enricher:     fills incident_*, enriched_at
#
# A single row evolves through stages. NULL columns = stage not yet done.
# -----------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    wav_path             TEXT UNIQUE,
    opus_path            TEXT,             -- relative to CALLS_DIR (or AUDIO_DIR on hub)
    talkgroup            INTEGER,
    talkgroup_tag        TEXT,
    start_time           INTEGER,          -- unix epoch
    duration_sec         REAL,
    speech_sec           REAL,
    status               TEXT,             -- kept | skipped
    skip_reason          TEXT,
    audio_deleted        INTEGER DEFAULT 0,
    processed_at         INTEGER,
    metadata_json        TEXT,             -- full trunk-recorder metadata

    -- transcription
    transcript           TEXT,
    transcript_model     TEXT,
    transcript_at        INTEGER,
    transcript_error     TEXT,

    -- enrichment (from Claude)
    incident_type        TEXT,             -- e.g. "Traffic Stop", "MVA", "Disturbance"
    incident_summary     TEXT,             -- one-line human summary
    incident_location    TEXT,             -- street/intersection/landmark text
    incident_units       TEXT,             -- comma-separated unit IDs
    incident_severity    TEXT,             -- low | medium | high | critical | unknown
    incident_json        TEXT,             -- full Claude JSON response
    enriched_at          INTEGER,
    enrich_error         TEXT,

    -- multi-node fleet (Phase 1+)
    node_id              INTEGER,          -- which node captured this call (FK nodes.id)
    region_id            INTEGER,          -- denormalized for query speed (FK regions.id)
    uploaded_at          INTEGER,          -- on edge: when uploader pushed to hub
    content_hash         TEXT              -- sha256 of opus, used for ingest dedup
);
CREATE INDEX IF NOT EXISTS idx_status         ON calls(status);
CREATE INDEX IF NOT EXISTS idx_processed_at   ON calls(processed_at);
CREATE INDEX IF NOT EXISTS idx_start_time     ON calls(start_time);
CREATE INDEX IF NOT EXISTS idx_talkgroup      ON calls(talkgroup);
CREATE INDEX IF NOT EXISTS idx_transcript_at  ON calls(transcript_at);
CREATE INDEX IF NOT EXISTS idx_enriched_at    ON calls(enriched_at);
CREATE INDEX IF NOT EXISTS idx_incident_type  ON calls(incident_type);
CREATE INDEX IF NOT EXISTS idx_severity       ON calls(incident_severity);

-- regions: a logical grouping of nodes (e.g. "rgv" = Lower Rio Grande Valley)
CREATE TABLE IF NOT EXISTS regions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    default_lat  REAL,
    default_lng  REAL,
    default_zoom INTEGER DEFAULT 11,
    bbox_north   REAL,
    bbox_south   REAL,
    bbox_east    REAL,
    bbox_west    REAL,
    created_at   INTEGER
);

-- nodes: a Pi capture station belonging to one region
CREATE TABLE IF NOT EXISTS nodes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT UNIQUE NOT NULL,
    region_id     INTEGER NOT NULL,
    display_name  TEXT NOT NULL,
    owner_email   TEXT,
    lat           REAL,
    lng           REAL,
    token_hash    TEXT,                  -- sha256(token); NULL until admin add-node sets it
    notes         TEXT,
    status        TEXT DEFAULT 'active', -- active | disabled
    created_at    INTEGER,
    last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_region ON nodes(region_id);
CREATE INDEX IF NOT EXISTS idx_nodes_token  ON nodes(token_hash);

-- Cellular network observations from the M.2 modem (jafo-cellmon).
-- Each row is one cell sighting from a single AT-command poll. Per-poll snapshots
-- are kept long enough to compute averages + detect appearances/disappearances.
CREATE TABLE IF NOT EXISTS cell_observations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at   INTEGER NOT NULL,
    rat           TEXT,                -- "LTE" | "NR5G-SA" | "NR5G-NSA" | "WCDMA"
    is_serving    INTEGER DEFAULT 0,   -- 1 = serving cell, 0 = neighbor
    state         TEXT,                -- "CONNECT" | "NOCONN" | "SEARCH" | "REGISTERED" | NULL
    mcc           INTEGER,
    mnc           INTEGER,
    cell_id       TEXT,                -- full hex cell ID (serving) or NULL (neighbor)
    pci           INTEGER,
    earfcn        INTEGER,              -- LTE EARFCN or NR ARFCN
    band          TEXT,                 -- "B12", "n41", etc
    tac           TEXT,                 -- hex tracking area
    rsrp_dbm      INTEGER,
    rsrq_db       REAL,
    rssi_dbm      INTEGER,
    sinr_db       REAL,
    operator      TEXT,                 -- "T-Mobile US" | "Verizon" etc — from MCC/MNC
    raw_text      TEXT                  -- original AT line, kept for re-parsing
);
CREATE INDEX IF NOT EXISTS idx_cellobs_time         ON cell_observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_cellobs_serving      ON cell_observations(is_serving, observed_at);
CREATE INDEX IF NOT EXISTS idx_cellobs_pci_earfcn   ON cell_observations(pci, earfcn, observed_at);
CREATE INDEX IF NOT EXISTS idx_cellobs_op           ON cell_observations(operator, observed_at);

-- Per-site rollup: one row per unique cell tower we've ever heard from.
-- "Unique" = (rat, mcc, mnc, pci, earfcn) — for serving cells we also keep
-- the full cell_id; neighbors don't expose it but the composite key is stable.
CREATE TABLE IF NOT EXISTS cell_sites (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    site_key       TEXT UNIQUE NOT NULL,
    rat            TEXT,
    mcc            INTEGER,
    mnc            INTEGER,
    cell_id        TEXT,
    pci            INTEGER,
    earfcn         INTEGER,
    band           TEXT,
    operator       TEXT,
    first_seen_at  INTEGER,
    last_seen_at   INTEGER,
    last_rsrp_dbm  INTEGER,
    obs_count      INTEGER DEFAULT 0,
    -- geolocation (filled in by OpenCellID lookup or manual)
    lat            REAL,
    lng            REAL,
    geo_source     TEXT,                 -- "opencellid" | "manual" | "asr-proximity" | "triangulated"
    asr_number     TEXT,                 -- FCC ASR this cell is pinned to (proximity match)
    notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_cellsites_lastseen ON cell_sites(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_cellsites_op       ON cell_sites(operator);
-- idx_cellsites_asr is created in _migrate() after the ALTER TABLE adds
-- the asr_number column on existing DBs (CREATE TABLE IF NOT EXISTS won't
-- backfill the column, so the index creation moves to migration time).

-- FCC Antenna Structure Registration — physical tower locations from the
-- weekly r_tower.zip dump. Free, public, comprehensive (every registered
-- structure >200ft or near an airport). Used as a reference layer on the
-- cell-network map and (later) for cell-to-tower proximity matching.
CREATE TABLE IF NOT EXISTS fcc_asr (
    asr_number      TEXT PRIMARY KEY,
    owner           TEXT,
    structure_type  TEXT,                  -- TOWER, POLE, MAST, etc.
    height_m        REAL,                  -- overall above-ground height
    lat             REAL,
    lng             REAL,
    city            TEXT,
    state           TEXT,
    status          TEXT,                  -- A = active/granted, etc.
    imported_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_asr_geo   ON fcc_asr(lat, lng);
CREATE INDEX IF NOT EXISTS idx_asr_owner ON fcc_asr(owner);

-- OpenCellID lookup table — populated by an offline import of the OCID CSV.
-- Empty until the user runs the importer. Lookups are by (mcc, mnc, lac/tac, cid).
CREATE TABLE IF NOT EXISTS opencellid (
    radio    TEXT,
    mcc      INTEGER,
    mnc      INTEGER,
    area     INTEGER,        -- LAC for GSM/UMTS, TAC for LTE
    cell     INTEGER,
    lon      REAL,
    lng      REAL,            -- alias kept for naming consistency
    lat      REAL,
    range_m  INTEGER,
    samples  INTEGER,
    PRIMARY KEY (radio, mcc, mnc, area, cell)
) WITHOUT ROWID;

-- Full-text search on transcripts and summaries
CREATE VIRTUAL TABLE IF NOT EXISTS calls_fts USING fts5(
    transcript,
    incident_summary,
    incident_location,
    talkgroup_tag,
    content='calls',
    content_rowid='id'
);

-- Keep FTS in sync via triggers
CREATE TRIGGER IF NOT EXISTS calls_ai AFTER INSERT ON calls BEGIN
    INSERT INTO calls_fts(rowid, transcript, incident_summary, incident_location, talkgroup_tag)
    VALUES (new.id, new.transcript, new.incident_summary, new.incident_location, new.talkgroup_tag);
END;
CREATE TRIGGER IF NOT EXISTS calls_ad AFTER DELETE ON calls BEGIN
    INSERT INTO calls_fts(calls_fts, rowid, transcript, incident_summary, incident_location, talkgroup_tag)
    VALUES('delete', old.id, old.transcript, old.incident_summary, old.incident_location, old.talkgroup_tag);
END;
CREATE TRIGGER IF NOT EXISTS calls_au AFTER UPDATE ON calls BEGIN
    INSERT INTO calls_fts(calls_fts, rowid, transcript, incident_summary, incident_location, talkgroup_tag)
    VALUES('delete', old.id, old.transcript, old.incident_summary, old.incident_location, old.talkgroup_tag);
    INSERT INTO calls_fts(rowid, transcript, incident_summary, incident_location, talkgroup_tag)
    VALUES (new.id, new.transcript, new.incident_summary, new.incident_location, new.talkgroup_tag);
END;
"""

_NEW_CALL_COLS = [
    # Phase 1 — multi-node fleet
    ("node_id",      "INTEGER"),
    ("region_id",    "INTEGER"),
    ("uploaded_at",  "INTEGER"),
    ("content_hash", "TEXT"),
    # Enhance Call (premium re-transcribe) — original transcript preserved
    ("transcript_original",       "TEXT"),
    ("transcript_original_model", "TEXT"),
    # Dual-run (shadow Ollama enrichment for evaluation / corpus building)
    ("incident_json_ollama",       "TEXT"),
    ("incident_type_ollama",       "TEXT"),
    ("incident_severity_ollama",   "TEXT"),
    ("transcript_model_ollama",    "TEXT"),
    ("enriched_at_ollama",         "INTEGER"),
    ("shadow_enrich_error",        "TEXT"),
]


def _migrate(conn: sqlite3.Connection) -> None:
    """Idempotent column additions for pre-existing DBs.

    Runs AFTER the SCHEMA executescript (which creates new tables but cannot
    ALTER existing ones). Adds new columns + their indexes.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(calls)")}
    for name, defn in _NEW_CALL_COLS:
        if name not in cols:
            conn.execute(f"ALTER TABLE calls ADD COLUMN {name} {defn}")
    # Indexes on the new columns — only safe to create after the ALTERs above.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_node          ON calls(node_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_region        ON calls(region_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_uploaded      ON calls(uploaded_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_hash          ON calls(content_hash)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_calls_shadow_pending ON calls(enriched_at, enriched_at_ollama)")

    # cell_sites — add the asr_number column on existing DBs (introduced
    # with the FCC ASR proximity-matching feature). Safe to run repeatedly.
    cs_cols = {row[1] for row in conn.execute("PRAGMA table_info(cell_sites)")}
    if "asr_number" not in cs_cols:
        conn.execute("ALTER TABLE cell_sites ADD COLUMN asr_number TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cellsites_asr ON cell_sites(asr_number)")
    # node_id is for the hub side, where multiple edge nodes contribute
    # observations. Edge-side stays NULL — there's only ever one node per
    # local DB. Multi-tenant UNIQUE refactor (node_id, site_key) is a v2
    # task; for now hub upserts by site_key only.
    if "node_id" not in cs_cols:
        conn.execute("ALTER TABLE cell_sites ADD COLUMN node_id INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cellsites_node ON cell_sites(node_id)")


def db_connect() -> sqlite3.Connection:
    """Open the DB and ensure schema exists. Safe to call from multiple processes."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    # WAL mode lets multiple readers coexist with a writer — needed for our
    # multi-service setup where processor + transcriber + enricher + web all
    # touch the same DB.
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()
    return conn
