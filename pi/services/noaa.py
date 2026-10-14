"""
jafo-noaa — NOAA Weather Radio SAME/EAS alert monitor (RTL-SDR @ 162.400 MHz).

Runs ONLY in NOAA mode (the RTL is shared; see scripts/sdr-mode.sh). Pipes
rtl_fm into multimon-ng's EAS decoder and stores any SAME/EAS weather alerts.
NOAA is a continuous broadcast, so we deliberately do NOT record/transcribe the
voice (it would flood the feed) — only the SAME alert headers, which fire during
watches/warnings and the weekly test.

Needs: rtl_fm (installed) + multimon-ng (`sudo apt install multimon-ng`).
"""

import os
import shutil
import subprocess
import time

from common import db_connect, setup_logging

log = setup_logging("jafo-noaa")

FREQ = os.environ.get("JAFO_NOAA_FREQ", "162400000")
RTL_INDEX = os.environ.get("JAFO_NOAA_RTL_INDEX", "0")
GAIN = os.environ.get("JAFO_NOAA_GAIN", "40")


def ensure_table(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS weather_alerts (
            id          INTEGER PRIMARY KEY,
            received_at INTEGER,
            kind        TEXT,
            text        TEXT,
            raw         TEXT
        )""")
    conn.commit()


def main() -> None:
    if not shutil.which("rtl_fm") or not shutil.which("multimon-ng"):
        log.error("NOAA mode needs rtl_fm + multimon-ng. Install: sudo apt install multimon-ng. Idling.")
        while True:
            time.sleep(60)

    conn = db_connect()
    ensure_table(conn)
    rtl = ["rtl_fm", "-d", RTL_INDEX, "-f", FREQ, "-M", "fm", "-s", "22050", "-g", GAIN, "-F", "9", "-"]
    mm = ["multimon-ng", "-a", "EAS", "-t", "raw", "-"]
    log.info("jafo-noaa: %s | %s", " ".join(rtl), " ".join(mm))

    while True:
        p1 = p2 = None
        try:
            p1 = subprocess.Popen(rtl, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            p2 = subprocess.Popen(mm, stdin=p1.stdout, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, bufsize=1)
            p1.stdout.close()
            for line in p2.stdout:
                line = line.strip()
                if not line:
                    continue
                if "EAS" in line or line.startswith("ZCZC") or "NNNN" in line:
                    conn.execute(
                        "INSERT INTO weather_alerts (received_at, kind, text, raw) VALUES (?,?,?,?)",
                        (int(time.time()), "SAME", line[:400], line[:800]))
                    conn.commit()
                    log.info("ALERT: %s", line[:120])
        except Exception as e:
            log.warning("noaa decoder error: %s", e)
        finally:
            for p in (p2, p1):
                try:
                    if p:
                        p.kill()
                except Exception:
                    pass
        log.warning("noaa decoder exited; restart in 5s")
        time.sleep(5)


if __name__ == "__main__":
    main()
