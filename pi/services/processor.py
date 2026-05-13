#!/usr/bin/env python3
"""
jafo-processor — VAD filter + Opus encode + SQLite insert + retention sweep.

Watches trunk-recorder's recordings dir for new WAVs.
Drops encrypted/short/silent calls. Trims survivors to speech, encodes to Opus.
Inserts a row into the calls table for *every* call (kept or skipped) so we
have stats on what's happening even for the junk we drop.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from common import (
    CALLS_DIR, DATA_DIR, NODE_NAME, RETENTION_DAYS, WATCH_DIR,
    db_connect, setup_logging,
)

log = setup_logging("jafo-processor")

# Filter thresholds
MIN_DURATION_SEC = 1.5
MIN_SPEECH_SEC = 0.8
MIN_SPEECH_RATIO = 0.25
VAD_SAMPLE_RATE = 16000
OPUS_BITRATE = "16k"
SETTLE_SECONDS = 2
POLL_INTERVAL_SEC = 5
RETENTION_SWEEP_INTERVAL_SEC = 3600

# -----------------------------------------------------------------------------
# Silero VAD — lazy-loaded
# -----------------------------------------------------------------------------
_vad_model = None
_vad_get_speech_ts = None

def vad_load():
    global _vad_model, _vad_get_speech_ts
    if _vad_model is not None:
        return
    log.info("Loading Silero VAD model...")
    from silero_vad import load_silero_vad, get_speech_timestamps
    _vad_model = load_silero_vad()
    _vad_get_speech_ts = get_speech_timestamps
    log.info("VAD ready.")


def vad_analyze(wav_path: Path) -> tuple[list, float, float]:
    vad_load()
    audio, sr = sf.read(str(wav_path), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    if sr != VAD_SAMPLE_RATE:
        ratio = VAD_SAMPLE_RATE / sr
        new_len = int(len(audio) * ratio)
        idx = np.linspace(0, len(audio) - 1, new_len).astype(int)
        audio = audio[idx]
        sr = VAD_SAMPLE_RATE

    import torch
    speech_ts = _vad_get_speech_ts(
        torch.from_numpy(audio), _vad_model, sampling_rate=sr,
    )
    total_speech = sum((t["end"] - t["start"]) for t in speech_ts) / sr
    total_audio = len(audio) / sr
    segs = [(t["start"] / sr, t["end"] / sr) for t in speech_ts]
    return segs, total_speech, total_audio


# -----------------------------------------------------------------------------
# ffmpeg
# -----------------------------------------------------------------------------
def to_opus(wav_path: Path, opus_path: Path,
            trim_start: float, trim_dur: float) -> None:
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(wav_path),
        "-ss", f"{trim_start:.3f}",
        "-t",  f"{trim_dur:.3f}",
        "-c:a", "libopus",
        "-b:a", OPUS_BITRATE,
        "-application", "voip",
        "-ar", "16000",
        "-ac", "1",
        # Force OGG container (Opus-in-Ogg). ffmpeg infers this from the .opus
        # extension already, but being explicit ensures the container has a
        # proper OpusHead/OpusTags header so browsers know the duration up
        # front and don't cut playback short on seek.
        "-f", "ogg",
        str(opus_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


# -----------------------------------------------------------------------------
# DB helpers (specific to this service)
# -----------------------------------------------------------------------------
def db_already_processed(conn: sqlite3.Connection, wav_path: Path) -> bool:
    cur = conn.execute("SELECT 1 FROM calls WHERE wav_path = ?", (str(wav_path),))
    return cur.fetchone() is not None


def db_record(conn: sqlite3.Connection, wav_path: Path, metadata: dict,
              status: str, skip_reason: Optional[str] = None,
              opus_path: Optional[str] = None,
              speech_sec: float = 0.0) -> None:
    duration = float(metadata.get("stop_time", 0)) - float(metadata.get("start_time", 0))
    conn.execute("""
        INSERT OR REPLACE INTO calls
        (wav_path, opus_path, talkgroup, talkgroup_tag, start_time,
         duration_sec, speech_sec, status, skip_reason, processed_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        str(wav_path), opus_path,
        metadata.get("talkgroup"),
        metadata.get("talkgroup_tag"),
        int(metadata.get("start_time", 0)),
        duration, speech_sec, status, skip_reason,
        int(time.time()),
        json.dumps(metadata),
    ))
    conn.commit()


# -----------------------------------------------------------------------------
# Per-call processing
# -----------------------------------------------------------------------------
def cleanup(*paths: Path) -> None:
    for p in paths:
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def call_archive_path(metadata: dict, wav_path: Path) -> Path:
    start = int(metadata.get("start_time", 0))
    date_dir = time.strftime("%Y-%m-%d", time.localtime(start)) if start else "unknown-date"
    out = CALLS_DIR / date_dir
    out.mkdir(parents=True, exist_ok=True)
    return out / wav_path.stem


def process_call(conn: sqlite3.Connection, wav_path: Path) -> None:
    json_path = wav_path.with_suffix(".json")
    if not json_path.exists():
        return

    try:
        metadata = json.loads(json_path.read_text())
    except json.JSONDecodeError as e:
        log.warning("Bad JSON for %s: %s — discarding pair", wav_path.name, e)
        cleanup(wav_path, json_path)
        return

    tag = metadata.get("talkgroup_tag", "?")
    tg = metadata.get("talkgroup", "?")

    # Filter: encryption
    if metadata.get("encrypted") or metadata.get("phase2_tdma_encrypted"):
        log.info("SKIP encrypted    tg=%s tag=%s", tg, tag)
        db_record(conn, wav_path, metadata, "skipped", "encrypted")
        cleanup(wav_path, json_path)
        return

    # Filter: duration
    duration = float(metadata.get("stop_time", 0)) - float(metadata.get("start_time", 0))
    if duration < MIN_DURATION_SEC:
        log.info("SKIP too_short    tg=%s tag=%s dur=%.1fs", tg, tag, duration)
        db_record(conn, wav_path, metadata, "skipped", "too_short")
        cleanup(wav_path, json_path)
        return

    # Filter: VAD
    try:
        segs, speech_sec, total_sec = vad_analyze(wav_path)
    except Exception as e:
        log.warning("VAD failed on %s: %s — keeping anyway", wav_path.name, e)
        segs = [(0.0, duration)]
        speech_sec = duration
        total_sec = duration

    if not segs:
        log.info("SKIP no_speech    tg=%s tag=%s dur=%.1fs", tg, tag, duration)
        db_record(conn, wav_path, metadata, "skipped", "no_speech",
                  speech_sec=speech_sec)
        cleanup(wav_path, json_path)
        return

    speech_ratio = speech_sec / total_sec if total_sec > 0 else 0
    if speech_sec < MIN_SPEECH_SEC or speech_ratio < MIN_SPEECH_RATIO:
        log.info("SKIP low_speech   tg=%s tag=%s speech=%.1fs ratio=%.2f",
                 tg, tag, speech_sec, speech_ratio)
        db_record(conn, wav_path, metadata, "skipped", "low_speech_ratio",
                  speech_sec=speech_sec)
        cleanup(wav_path, json_path)
        return

    # Trim + Opus encode
    trim_start = segs[0][0]
    trim_end = segs[-1][1]
    trim_dur = trim_end - trim_start
    archive_base = call_archive_path(metadata, wav_path)
    opus_path = archive_base.with_suffix(".opus")
    meta_out_path = archive_base.with_suffix(".json")

    try:
        to_opus(wav_path, opus_path, trim_start, trim_dur)
    except subprocess.CalledProcessError as e:
        log.error("ffmpeg failed on %s: %s", wav_path.name,
                  e.stderr.decode(errors="ignore"))
        db_record(conn, wav_path, metadata, "skipped", "ffmpeg_error")
        cleanup(wav_path, json_path)
        return

    # Enrich + write metadata sidecar
    metadata["original_duration_sec"] = duration
    metadata["trimmed_duration_sec"] = trim_dur
    metadata["speech_segments"] = len(segs)
    metadata["speech_sec"] = round(speech_sec, 3)
    metadata["audio_format"] = "opus"
    metadata["opus_bitrate"] = OPUS_BITRATE
    metadata["captured_by"] = NODE_NAME
    meta_out_path.write_text(json.dumps(metadata, indent=2))

    log.info("KEEP tg=%s tag=%s orig=%.1fs trimmed=%.1fs → %s",
             tg, tag, duration, trim_dur, opus_path.relative_to(CALLS_DIR))
    db_record(conn, wav_path, metadata, "kept",
              opus_path=str(opus_path.relative_to(CALLS_DIR)),
              speech_sec=speech_sec)
    cleanup(wav_path, json_path)


# -----------------------------------------------------------------------------
# Retention sweep
# -----------------------------------------------------------------------------
def retention_sweep(conn: sqlite3.Connection) -> None:
    cutoff = int(time.time()) - (RETENTION_DAYS * 86400)
    cur = conn.execute("""
        SELECT id, opus_path FROM calls
        WHERE status = 'kept' AND audio_deleted = 0 AND start_time < ?
    """, (cutoff,))
    rows = cur.fetchall()
    if not rows:
        return

    deleted = 0
    for row in rows:
        if row["opus_path"]:
            full = CALLS_DIR / row["opus_path"]
            sidecar = full.with_suffix(".json")
            try:
                full.unlink(missing_ok=True)
                sidecar.unlink(missing_ok=True)
                deleted += 1
            except OSError as e:
                log.warning("Failed deleting %s: %s", full, e)
        conn.execute("UPDATE calls SET audio_deleted = 1 WHERE id = ?", (row["id"],))
    conn.commit()
    log.info("Retention sweep: removed %d .opus files older than %d days",
             deleted, RETENTION_DAYS)

    for d in CALLS_DIR.iterdir():
        if d.is_dir() and not any(d.iterdir()):
            try:
                d.rmdir()
            except OSError:
                pass


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------
def main() -> None:
    log.info("Starting jafo-processor. watch=%s calls=%s node=%s retention=%dd",
             WATCH_DIR, CALLS_DIR, NODE_NAME, RETENTION_DAYS)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    WATCH_DIR.mkdir(parents=True, exist_ok=True)
    CALLS_DIR.mkdir(parents=True, exist_ok=True)
    conn = db_connect()
    vad_load()

    last_sweep = 0
    while True:
        now = time.time()
        for wav in WATCH_DIR.rglob("*.wav"):
            if db_already_processed(conn, wav):
                continue
            try:
                mtime = wav.stat().st_mtime
            except FileNotFoundError:
                continue
            if (now - mtime) < SETTLE_SECONDS:
                continue
            try:
                process_call(conn, wav)
            except Exception as e:
                log.exception("Error processing %s: %s", wav, e)

        if now - last_sweep > RETENTION_SWEEP_INTERVAL_SEC:
            try:
                retention_sweep(conn)
            except Exception as e:
                log.exception("Retention sweep failed: %s", e)
            last_sweep = now

        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Interrupted, exiting.")
        sys.exit(0)
