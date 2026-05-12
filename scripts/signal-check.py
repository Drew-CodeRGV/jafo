#!/usr/bin/env python3
"""
Quick antenna / front-end signal check on the HackRF.

Tunes to the recorder's center freq, captures a few PSDs, then prints peak
power at each LRGVRRS control channel within the HackRF's window plus the
noise-floor estimate. Use it for A/B antenna swaps — higher SNR margin
means a better antenna for the system you care about.

Run with jafo-recorder STOPPED so the HackRF is free:

    sudo systemctl stop jafo-recorder
    ~/jafo-data/venv-services/bin/python ~/jafo/scripts/signal-check.py
    sudo systemctl start jafo-recorder
"""
import argparse
import numpy as np
import SoapySDR
from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32

CONTROL_CHANS = [
    ('McAllen', 851_075_000),
    ('Pharr  ', 851_067_500),
    ('McAllen', 851_312_500),
    ('Pharr  ', 851_337_500),
    ('McAllen', 852_962_500),
]

CENTER = 853_500_000
SRATE  = 7_968_000
NSAMP  = 1 << 18      # 262 144 samples ≈ 33 ms per capture

def capture_psd(ncap):
    # Be explicit — the wrapper sometimes resolves bare `driver=hackrf`
    # to the wrong device when an MSi2500 is also present. Pass the
    # serial as a string-form arg so make() picks the right HackRF.
    serial = None
    for entry in SoapySDR.Device.enumerate(dict(driver='hackrf')):
        try:
            serial = entry['serial']
            break
        except Exception:
            pass
    arg_str = f"driver=hackrf,serial={serial}" if serial else "driver=hackrf"
    dev = SoapySDR.Device(arg_str)
    dev.setSampleRate(SOAPY_SDR_RX, 0, SRATE)
    dev.setFrequency(SOAPY_SDR_RX, 0, CENTER)
    # match the trunk-recorder gain stages
    dev.setGain(SOAPY_SDR_RX, 0, 'AMP', 14)
    dev.setGain(SOAPY_SDR_RX, 0, 'LNA', 40)
    dev.setGain(SOAPY_SDR_RX, 0, 'VGA', 40)

    stream = dev.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
    dev.activateStream(stream)

    # warm-up: discard first buffer
    warm = np.zeros(NSAMP, dtype=np.complex64)
    dev.readStream(stream, [warm], NSAMP, timeoutUs=int(2e6))

    win = np.hanning(NSAMP).astype(np.float32)
    win_norm = (win**2).sum()
    psds = []
    buf = np.zeros(NSAMP, dtype=np.complex64)
    for _ in range(ncap):
        n = 0
        while n < NSAMP:
            sr = dev.readStream(stream, [buf[n:]], NSAMP - n, timeoutUs=int(2e6))
            if sr.ret <= 0:
                break
            n += sr.ret
        if n < NSAMP:
            continue
        s = buf * win
        spec = np.fft.fftshift(np.fft.fft(s))
        psd = 10*np.log10((np.abs(spec)**2) / (SRATE * win_norm) + 1e-20)
        psds.append(psd)

    dev.deactivateStream(stream)
    dev.closeStream(stream)
    return np.mean(psds, axis=0)

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1] if __doc__ else None)
    ap.add_argument("--samples", "-n", type=int, default=12,
                    help="Number of 33 ms captures to average (default: 12 ≈ 0.4 s). "
                         "Bump to 60–300 for stabler readings (~2–10 s) — useful when "
                         "comparing antennas where short-term fading swings several dB.")
    args = ap.parse_args()
    ncap = max(1, args.samples)

    dur_ms = ncap * NSAMP / SRATE * 1000
    print(f"Capturing {ncap}× {NSAMP/SRATE*1000:.0f} ms @ {CENTER/1e6:.3f} MHz / "
          f"{SRATE/1e6:.3f} MS/s (LNA40 VGA40 AMP on, total ≈{dur_ms:.0f} ms)…")
    psd = capture_psd(ncap)
    freqs = CENTER + np.fft.fftshift(np.fft.fftfreq(len(psd), 1/SRATE))

    # mask out DC ±50 kHz and ±25 kHz around every known control channel
    mask = np.ones_like(psd, dtype=bool)
    def excise(f_lo, f_hi):
        lo = np.searchsorted(freqs, f_lo)
        hi = np.searchsorted(freqs, f_hi)
        mask[lo:hi] = False
    excise(CENTER - 50_000, CENTER + 50_000)
    for _, cf in CONTROL_CHANS:
        excise(cf - 25_000, cf + 25_000)
    floor = np.percentile(psd[mask], 10)

    print(f"\nNoise floor (10th pct, masked): {floor:+.1f} dB/Hz (relative)\n")
    print(f"{'Site':8s}  {'Freq (MHz)':>10s}  {'Peak':>8s}  {'SNR':>8s}")
    print("-" * 42)
    for site, cf in CONTROL_CHANS:
        lo = np.searchsorted(freqs, cf - 12_500)
        hi = np.searchsorted(freqs, cf + 12_500)
        if lo >= hi:
            print(f"{site:8s}  {cf/1e6:>10.4f}   out-of-window")
            continue
        peak = psd[lo:hi].max()
        print(f"{site:8s}  {cf/1e6:>10.4f}  {peak:+7.1f}  {peak-floor:+7.1f}")

if __name__ == "__main__":
    main()
