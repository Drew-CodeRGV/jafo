"""
jafo-acars — decode ACARS aircraft messages from the RTL-SDR.

Runs ONLY when the RTL is tasked to ACARS (the RTL is shared with ADS-B; see
scripts/sdr-mode.sh to switch). Wraps `acarsdec`, parses its JSON output, and
stores each message in the acars_messages table for the web feed.

Config (env, all optional):
  JAFO_ACARSDEC_BIN    path to acarsdec (default: acarsdec on PATH)
  JAFO_ACARS_RTL_INDEX RTL device index (default: 0)
  JAFO_ACARS_FREQS     space-separated MHz (default: common US ACARS channels)
  JAFO_ACARSDEC_CMD    full command override; must emit one JSON object per line
"""

import json
import os
import subprocess
import time

from common import db_connect, setup_logging

log = setup_logging("jafo-acars")

ACARSDEC_BIN = os.environ.get("JAFO_ACARSDEC_BIN", "acarsdec")
RTL_INDEX = os.environ.get("JAFO_ACARS_RTL_INDEX", "0")
# Channels MUST fit inside one RTL sample window (~2 MHz), so they're clustered
# in the 130–131.8 MHz US ACARS group (131.550 is the primary channel).
FREQS = os.environ.get(
    "JAFO_ACARS_FREQS",
    "131.550 130.025 130.450 131.125 131.725 131.825"
).split()
GAIN = os.environ.get("JAFO_ACARS_GAIN", "").strip()   # empty = AGC
PPM = os.environ.get("JAFO_ACARS_PPM", "").strip()
RTL_MULT = os.environ.get("JAFO_ACARS_RTL_MULT", "192")  # 192 = 2.4 MS/s
CMD_OVERRIDE = os.environ.get("JAFO_ACARSDEC_CMD", "").strip()


def build_cmd() -> list[str]:
    if CMD_OVERRIDE:
        return CMD_OVERRIDE.split()
    # acarsdec 3.x: -o 4 = per-message JSON to stdout (one object per line);
    # -e drops empty messages. Then the RTL device + clustered frequencies.
    cmd = [ACARSDEC_BIN, "-o", "4", "-e", "-m", RTL_MULT]
    if GAIN:
        cmd += ["-g", GAIN]
    if PPM:
        cmd += ["-p", PPM]
    cmd += ["-r", RTL_INDEX, *FREQS]
    return cmd


def _clean(v):
    if v is None:
        return None
    s = str(v).strip().lstrip(".").strip()
    return s or None


def parse_msg(obj: dict) -> dict:
    # acarsdec JSON is mostly flat, but some builds nest under "acars".
    src = obj.get("acars") if isinstance(obj.get("acars"), dict) else obj
    def g(*ks):
        for k in ks:
            if src.get(k) not in (None, ""):
                return src[k]
        return None
    return {
        "freq": g("freq", "freq_mhz"),
        "channel": g("channel", "chn"),
        "mode": g("mode") or "ACARS",
        "tail": _clean(g("tail", "registration", "reg")),
        "flight": _clean(g("flight", "fid", "flight_id")),
        "label": _clean(g("label", "lbl")),
        "block_id": _clean(g("block_id", "bid")),
        "msg_no": _clean(g("msgno", "msg_no", "seqno")),
        "text": g("text", "msg_text", "data"),
    }


def store(conn, obj: dict) -> None:
    f = parse_msg(obj)
    conn.execute(
        """INSERT INTO acars_messages
           (received_at, freq_mhz, channel, mode, tail, flight, label, block_id, msg_no, text, raw_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (int(time.time()), f["freq"], f["channel"], f["mode"], f["tail"], f["flight"],
         f["label"], f["block_id"], f["msg_no"], f["text"], json.dumps(obj)[:4000]),
    )
    conn.commit()


def main() -> None:
    conn = db_connect()
    cmd = build_cmd()
    log.info("jafo-acars starting: %s", " ".join(cmd))
    while True:
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1)
        except FileNotFoundError:
            log.error("acarsdec not found (%s). Install it, then switch to ACARS mode.", ACARSDEC_BIN)
            time.sleep(30)
            continue
        for line in proc.stdout:
            line = line.strip()
            if not line or line[0] != "{":
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            try:
                store(conn, obj)
            except Exception as e:
                log.warning("store failed: %s", e)
        err = (proc.stderr.read() if proc.stderr else "")[:200]
        log.warning("acarsdec exited (code %s); restart in 5s. %s", proc.returncode, err)
        time.sleep(5)


if __name__ == "__main__":
    main()
