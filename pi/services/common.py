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
# Paths
# -----------------------------------------------------------------------------
DATA_DIR = Path(os.environ.get("JAFO_DATA_DIR", "/home/pi/jafo-data"))
WATCH_DIR = DATA_DIR / "recordings"
CALLS_DIR = DATA_DIR / "calls"
DB_PATH = DATA_DIR / "jafo.db"
ENV_FILE = Path("/home/pi/jafo/.env")

# Load .env (services run with EnvironmentFile= in systemd, but also call this for CLI)
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)

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
    opus_path            TEXT,             -- relative to CALLS_DIR
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
    enrich_error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_status         ON calls(status);
CREATE INDEX IF NOT EXISTS idx_processed_at   ON calls(processed_at);
CREATE INDEX IF NOT EXISTS idx_start_time     ON calls(start_time);
CREATE INDEX IF NOT EXISTS idx_talkgroup      ON calls(talkgroup);
CREATE INDEX IF NOT EXISTS idx_transcript_at  ON calls(transcript_at);
CREATE INDEX IF NOT EXISTS idx_enriched_at    ON calls(enriched_at);
CREATE INDEX IF NOT EXISTS idx_incident_type  ON calls(incident_type);
CREATE INDEX IF NOT EXISTS idx_severity       ON calls(incident_severity);

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
    conn.commit()
    return conn
