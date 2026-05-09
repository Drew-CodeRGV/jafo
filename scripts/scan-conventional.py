#!/usr/bin/env python3
"""
Wideband discovery scanner for the SDRplay's conventional window.

Scans the full 2.4 MHz centered on the conventional source's tuned freq, finds
every carrier above the noise floor, and produces a sorted list of activity by
frequency (rounded to the nearest 12.5 kHz channel grid).

Use this when you suspect there are conventional licenses in your window
beyond what's already in `conventional-talkgroups.csv` — run during peak
business hours, then FCC-ULS each unknown frequency to identify the licensee.

Requires `jafo-recorder` to be stopped for the duration of the scan.

Usage:
  sudo systemctl stop jafo-recorder
  python3 ~/jafo/scripts/scan-conventional.py [duration_sec]
  sudo systemctl start jafo-recorder

Default duration: 300 seconds (5 minutes). 1800 (30 min) recommended for
production discovery during weekday peak.

Methodology:
  - Floor: 10th percentile of bins NOT in the DC zone and NOT inside any
    known LRGVRRS voice channel (those are P25, broadband, would inflate
    the floor estimate). 10th-pct is robust when many carriers are active.
  - LRGVRRS voice freqs are *learned* by parsing the recorder journal for
    the last 48 hours, so the whitelist always matches what the system is
    actually using. No hardcoded guesses.
"""
import json
import re
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import SoapySDR
from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32

# --- config (matches the SDRplay block in config.json) -----------------------
CENTER         = 856_625_000      # Hz; midpoint of MISD-PD Disp + TAC
RATE           =   2_400_000      # S/s
GAIN_DB        =          10      # SDRplay LNA setting
NFFT           =        8192      # FFT size — ~293 Hz / bin
NAVG_PER_PASS  =         300      # ~1 sec integration per pass
SNR_THRESH_DB  =         6.0      # how far above noise floor to call a carrier
DC_REJECT_HZ   =       5_000      # blank ±5 kHz around tuned center (DC spike)
GRID_HZ        =      12_500      # P25/LMR standard channel spacing
P25_VOICE_HZ   =      15_000      # mask ±15 kHz around each known voice channel

# Confirmed conventional channels in our window.
KNOWN_CONVENTIONAL = {
    857_212_500: "MISD-PD Disp",
    856_037_500: "MISD-PD TAC",
}


def grid_freq(hz: float) -> int:
    return int(round(hz / GRID_HZ)) * GRID_HZ


def learn_lrgvrrs_voice_freqs(window_min_hz: int, window_max_hz: int,
                              hours: int = 48) -> dict:
    """Parse the jafo-recorder journal to find every freq the trunked system
    has used as a voice channel in the last `hours`. Returns dict of
    {grid_freq_hz: label_string}.

    This auto-keeps the whitelist current — no hardcoded freq lists to drift.
    """
    print(f"  scanning journal for LRGVRRS voice channels (last {hours}h) ...")
    try:
        proc = subprocess.run(
            ["journalctl", "-u", "jafo-recorder",
             "--since", f"{hours} hours ago", "--no-pager"],
            capture_output=True, text=True, timeout=60, check=False,
        )
    except Exception as e:
        print(f"  (journal read failed: {e})")
        return {}

    pat_freq = re.compile(r"Freq:\s+(\d+\.\d+)\s+MHz")
    pat_tg   = re.compile(r"TG:\s+(\d+)\s+\(([^)]*)\)")
    counts   = defaultdict(int)
    examples = {}

    for line in proc.stdout.splitlines():
        if "lrgvrrs" not in line:
            continue
        if "Starting" not in line and "Recorder" not in line:
            continue
        mf = pat_freq.search(line)
        if not mf:
            continue
        f_hz = int(round(float(mf.group(1)) * 1e6))
        if f_hz < window_min_hz or f_hz > window_max_hz:
            continue
        grid = grid_freq(f_hz)
        counts[grid] += 1
        mt = pat_tg.search(line)
        if mt and grid not in examples:
            examples[grid] = mt.group(2).strip()

    learned = {}
    for grid, count in counts.items():
        ex = examples.get(grid, "")
        learned[grid] = f"LRGVRRS voice ({count} hits, e.g. {ex})" if ex else \
                        f"LRGVRRS voice ({count} hits)"
    print(f"  learned {len(learned)} LRGVRRS voice freqs in window")
    for grid, lbl in sorted(learned.items()):
        print(f"    {grid/1e6:>9.4f} MHz  {lbl}")
    return learned


def open_sdrplay():
    """Try several driver-arg permutations; return the first that opens."""
    for args in ("driver=miri,miri=0", "driver=miri",
                 "driver=sdrplay,serial=0000000001", "driver=sdrplay"):
        try:
            sdr = SoapySDR.Device(args)
            print(f"  opened with: {args!r}  hw={sdr.getHardwareKey()}")
            return sdr
        except Exception as e:
            print(f"  tried {args!r}: {e}")
    raise SystemExit("could not open SDRplay; is jafo-recorder still running?")


def main():
    duration_sec = int(sys.argv[1]) if len(sys.argv) > 1 else 300

    win_lo = CENTER - RATE // 2
    win_hi = CENTER + RATE // 2
    print(f"window: {win_lo/1e6:.3f} - {win_hi/1e6:.3f} MHz")

    learned_lrgv = learn_lrgvrrs_voice_freqs(win_lo, win_hi, hours=48)
    label_for = {}
    label_for.update(KNOWN_CONVENTIONAL)
    for g, lbl in learned_lrgv.items():
        # don't overwrite a confirmed conventional label
        label_for.setdefault(g, lbl)

    print(f"\nopening SDR @ center={CENTER/1e6:.4f} MHz  rate={RATE/1e6:.2f} MS/s  gain={GAIN_DB} dB")
    sdr = open_sdrplay()
    sdr.setSampleRate(SOAPY_SDR_RX, 0, RATE)
    sdr.setFrequency(SOAPY_SDR_RX, 0, CENTER)
    try:
        sdr.setGain(SOAPY_SDR_RX, 0, GAIN_DB)
    except Exception as e:
        print(f"  (setGain warn: {e})")

    stream = sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
    sdr.activateStream(stream)

    buf      = np.zeros(NFFT, dtype=np.complex64)
    window   = np.hanning(NFFT)
    freqs_hz = np.fft.fftshift(np.fft.fftfreq(NFFT, 1 / RATE)) + CENTER
    bin_hz   = RATE / NFFT

    # 0.5s settle / drain
    t_settle = time.time() + 0.5
    while time.time() < t_settle:
        sdr.readStream(stream, [buf], NFFT, timeoutUs=500_000)

    # ---- build the floor mask: exclude DC + LRGVRRS voice zones ------------
    floor_mask = np.ones(NFFT, dtype=bool)

    idx_center = NFFT // 2
    n_dc_bins  = int(DC_REJECT_HZ / bin_hz) + 1
    floor_mask[idx_center - n_dc_bins : idx_center + n_dc_bins + 1] = False

    n_p25_bins = int(P25_VOICE_HZ / bin_hz) + 1
    for grid_hz_freq in learned_lrgv:
        center_idx = int(round((grid_hz_freq - CENTER + RATE / 2) / bin_hz))
        lo = max(0, center_idx - n_p25_bins)
        hi = min(NFFT, center_idx + n_p25_bins + 1)
        floor_mask[lo:hi] = False

    # peak-detection mask: same exclusions (we don't want to *report* DC or
    # LRGVRRS voice as discoveries)
    peak_mask = floor_mask.copy()

    n_floor_bins = int(np.sum(floor_mask))
    print(f"  floor mask: {n_floor_bins} of {NFFT} bins eligible "
          f"({100*n_floor_bins/NFFT:.0f}% — rest masked as DC or LRGVRRS voice)")

    print(f"\nscanning for {duration_sec}s ({duration_sec/60:.1f} min)")
    print(f"  bin width: {bin_hz:.0f} Hz   threshold: +{SNR_THRESH_DB} dB above 10th-pct floor\n")

    hit_count   = defaultdict(int)
    peak_snr_db = defaultdict(lambda: -200.0)

    t_start = time.time()
    t_end   = t_start + duration_sec
    pass_idx = 0

    while time.time() < t_end:
        psd_pass = np.zeros(NFFT, dtype=np.float64)
        n_ok = 0
        for _ in range(NAVG_PER_PASS):
            sr = sdr.readStream(stream, [buf], NFFT, timeoutUs=1_000_000)
            if sr.ret != NFFT:
                continue
            fft = np.fft.fftshift(np.fft.fft(buf * window))
            psd_pass += np.abs(fft) ** 2
            n_ok += 1
        if n_ok == 0:
            continue
        psd_pass /= n_ok
        psd_db = 10 * np.log10(psd_pass + 1e-20)

        # 10th-percentile floor over the un-masked bins
        floor_bins = psd_db[floor_mask]
        noise_floor = float(np.percentile(floor_bins, 10))
        threshold = noise_floor + SNR_THRESH_DB

        above = (psd_db > threshold) & peak_mask
        peaks_this_pass = []

        idxs = np.where(above)[0]
        if len(idxs) > 0:
            # Group consecutive bins (a single ~12.5 kHz carrier spans ~40 bins
            # at 293 Hz/bin, so use a 4-bin gap to merge).
            groups = np.split(idxs, np.where(np.diff(idxs) > 4)[0] + 1)
            seen_grids_this_pass = set()
            for grp in groups:
                peak_idx = int(grp[np.argmax(psd_db[grp])])
                peak_freq = float(freqs_hz[peak_idx])
                peak_snr  = float(psd_db[peak_idx] - noise_floor)
                grid = grid_freq(peak_freq)
                # de-dupe: a wide carrier may split into multiple groups but
                # still occupies one channel — count it once per pass
                if grid in seen_grids_this_pass:
                    peak_snr_db[grid] = max(peak_snr_db[grid], peak_snr)
                    continue
                seen_grids_this_pass.add(grid)
                hit_count[grid] += 1
                peak_snr_db[grid] = max(peak_snr_db[grid], peak_snr)
                peaks_this_pass.append((grid, peak_snr))

        pass_idx += 1
        elapsed = int(time.time() - t_start)
        active = sorted(peaks_this_pass, key=lambda x: -x[1])[:5]
        active_str = (", ".join(f"{g/1e6:.4f}={s:+.1f}" for g, s in active)
                      if active else "(quiet)")
        print(f"  [{elapsed:>4}s/{duration_sec}s] floor={noise_floor:+.1f} dB  "
              f"thr={threshold:+.1f}  active: {active_str}")

    sdr.deactivateStream(stream)
    sdr.closeStream(stream)

    # --------------------------- final report -------------------------------
    total_passes = pass_idx
    print(f"\n=== {total_passes} passes complete over {duration_sec}s ===")
    print(f"=== detected carriers in {win_lo/1e6:.3f}-{win_hi/1e6:.3f} MHz ===\n")

    rows = []
    for grid, count in hit_count.items():
        lbl = label_for.get(grid, "")
        is_known = grid in KNOWN_CONVENTIONAL
        is_lrgv  = grid in learned_lrgv
        rows.append({
            "freq_mhz": grid / 1e6,
            "hits": count,
            "peak_snr_db": peak_snr_db[grid],
            "activity_pct": round(100 * count / max(1, total_passes), 1),
            "label": lbl,
            "category": "conventional-known" if is_known else
                        "lrgvrrs-voice"      if is_lrgv  else
                        "unknown",
        })

    # Always sort: unknowns first (most interesting), then known conventional,
    # then LRGVRRS voice. Within each group, hits then SNR.
    cat_order = {"unknown": 0, "conventional-known": 1, "lrgvrrs-voice": 2}
    rows.sort(key=lambda r: (cat_order[r["category"]], -r["hits"], -r["peak_snr_db"]))

    last_cat = None
    print(f"{'Freq (MHz)':>11}  {'Hits':>5}  {'Peak SNR':>9}  {'Active':>7}  Label / Notes")
    for r in rows:
        # Hide spurs that flickered briefly and weakly
        if r["category"] == "unknown" and r["hits"] < 2 and r["peak_snr_db"] < 12:
            continue
        if r["category"] != last_cat:
            print()
            header = {
                "unknown":            "--- UNKNOWN — FCC ULS lookup candidates ---",
                "conventional-known": "--- KNOWN conventional (already configured) ---",
                "lrgvrrs-voice":      "--- LRGVRRS voice (P25, already on HackRF) ---",
            }[r["category"]]
            print(header)
            last_cat = r["category"]
        print(f"  {r['freq_mhz']:>9.4f}    {r['hits']:>3}    "
              f"{r['peak_snr_db']:>+5.1f} dB    {r['activity_pct']:>5.1f}%   "
              f"{r['label'] or '(unknown)'}")

    # JSON dump
    out_path = Path(f"/tmp/jafo-scan-{int(time.time())}.json")
    out_path.write_text(json.dumps({
        "center_hz": CENTER, "rate_hz": RATE, "duration_sec": duration_sec,
        "passes": total_passes, "snr_threshold_db": SNR_THRESH_DB,
        "learned_lrgvrrs_voice_freqs_hz": list(learned_lrgv.keys()),
        "results": rows,
    }, indent=2))
    print(f"\nfull results saved to {out_path}")


if __name__ == "__main__":
    main()
