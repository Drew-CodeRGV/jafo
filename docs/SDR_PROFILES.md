# SDR Profiles

jafo auto-detects which SDRs are plugged in at install time and picks a configuration profile that uses them well. You can re-run the installer at any time to re-detect (e.g. after adding or removing hardware).

## Detection logic

`pi/tools/detect-sdrs.sh` scans `lsusb` output for known SDR USB IDs:

| Device              | USB ID         |
|---------------------|----------------|
| HackRF One          | `1d50:6089`    |
| SDRplay RSP1        | `1df7:2500`    |
| SDRplay RSP1A/RSP1B | `1df7:3000`    |
| SDRplay RSPduo      | `1df7:3010`    |
| SDRplay RSPdx       | `1df7:3020`    |
| SDRplay RSPdx-R2    | `1df7:3030`    |
| RTL-SDR (most)      | `0bda:2832/8`  |

This works **before any SDR drivers are installed** — `lsusb` is part of the kernel's USB subsystem, not the SDR-specific stack. That's important: it means we can decide what to install based on what's plugged in, not the other way around.

## Profile selection

Bootstrap picks the best profile for the detected combination:

| Detected SDRs                | Profile           | Strategy |
|------------------------------|-------------------|----------|
| HackRF + RTL-SDR             | `hackrf-rtl`      | RTL on control, HackRF on voice (4 recorders) |
| HackRF + SDRplay RSP         | `hackrf-rsp1`     | RSP on control, HackRF on voice (4 recorders) |
| RSP + RTL-SDR                | `rsp1-rtl`        | RTL on control, RSP on voice (4 recorders) |
| HackRF + RSP + RTL-SDR       | `rsp1-hackrf-rtl` | RTL on control, HackRF on voice. RSP held in reserve |
| HackRF only                  | `hackrf-only`     | Single SDR, 10 MS/s window covers control + voice (3 recorders) |
| SDRplay RSP only             | `rsp1-only`       | Single SDR, 8 MS/s window covers control + voice (3 recorders) |
| RTL-SDR only                 | `rtl-only`        | Won't work — RTL bandwidth too narrow for voice. Add another SDR. |
| Nothing                      | `none`            | Bootstrap continues but capture won't start |

## Why these choices

**Control channel: RTL-SDR > RSP > HackRF.**
The control channel is a single narrow signal that needs nothing more than a couple MHz of bandwidth. RTL-SDR is rock-solid here, costs almost nothing, and frees the better SDRs for voice. SDRplay is a great alternative if no RTL-SDR is available — its narrower noise floor on weak signals is genuinely useful. HackRF *can* do the control channel but it's overkill and the HackRF's higher phase noise is wasted on something this simple.

**Voice channels: HackRF > RSP > RTL-SDR.**
Voice channels span ~5 MHz on LRGVRRS (851-856 MHz). You want a wide sample rate to capture all of them with one tuner. HackRF supports up to 20 MS/s (we use 8). RSP1 supports up to 10 MS/s. RTL-SDR maxes at ~2.4 MS/s — not enough.

**Why not always use SDRplay for everything?**
Three reasons. (1) SDRplay's proprietary API is closed-source and has had compatibility wobbles between versions. (2) Its gain handling is unusual — separate IF and RF stages — which trunk-recorder's "generic gain" doesn't always handle ideally. (3) RTL-SDRs are $30 and just work. For the control channel role, simpler is better.

## Profile files

Each profile is a `trunk-recorder` JSON config in `config/profiles/`:

```
config/profiles/
├── hackrf-rtl.json         (default)
├── hackrf-rsp1.json
├── rsp1-rtl.json
├── rsp1-hackrf-rtl.json
├── hackrf-only.json
└── rsp1-only.json
```

The installer copies the chosen one to `~/jafo-data/config/config.json` and records the choice in `~/jafo-data/config/.active-profile` for later inspection.

## Switching profiles manually

If detection picks the wrong profile (e.g. you want all-HackRF mode even though an RTL-SDR is plugged in), copy a different profile by hand:

```bash
cp ~/jafo/config/profiles/hackrf-only.json ~/jafo-data/config/config.json
sudo systemctl restart jafo-recorder
```

## SDRplay-specific gotchas

The SDRplay API is the only proprietary piece in the whole stack. A few things worth knowing:

1. **The `msi2500` kernel driver** ships with most Linux distros and grabs SDRplay devices on plug-in. The installer blacklists it, but a reboot is sometimes required for the blacklist to take effect.
2. **`sdrplay.service`** is the userspace API daemon. SoapySDRPlay3 talks to it, not directly to the device. If the service isn't running, no app will see the device.
3. **API version compatibility**. SoapySDRPlay3 needs API v3.15 or later. The current `install.sh` from sdrplay.com installs v3.15.2 (or whatever's current). If you ever upgrade the API independently, you'll need to rebuild SoapySDRPlay3:
   ```bash
   FORCE_REBUILD_SOAPY_SDRPLAY3=1 bash ~/jafo/pi/build-sdrplay.sh
   ```
4. **Gain settings on RSPs** are weird. The current profiles set `gain: 40` and `agc_setpoint: -30`, which gives sensible AGC behavior. If decode rates are poor, try toggling AGC off and tweaking IFGR/RFGR manually — search "SDRplay gain trunk-recorder" for the rabbit hole.

## RSP1 vs RSP1A vs RSPdx

For our use case (P25 trunked at 800 MHz):

- **RSP1** — what you have. 14-bit ADC, 12 MHz max bandwidth. Fine.
- **RSP1A** — slightly better front-end filtering, bias-tee. Marginal improvement.
- **RSPdx** — better dynamic range below 200 MHz (irrelevant for us). Marginal improvement at 800 MHz.

For 800 MHz P25, all three perform similarly. Don't upgrade unless you also want HF/VHF performance.

## Multi-site control channel strategy

LRGVRRS has multiple physical sites — McAllen, Pharr, La Joya, Brownsville, Harlingen, etc. — each broadcasting the same system on different frequencies. Each site has 2-3 control-channel-capable frequencies.

The shipped profiles list **multiple sites' control channels** in a single `control_channels` array. trunk-recorder rotates through them and locks onto the strongest one it can decode. This is intentional: in practice the site closest to you geographically isn't always the one you can hear best (line-of-sight, terrain, building shadowing all matter at 800 MHz).

For McAllen-area Pi installs, the profiles list:

```json
"control_channels": [851067500, 851337500, 851075000, 851312500, 852962500]
```

That's Pharr (851.0675, 851.3375) + McAllen (851.075, 851.3125, 852.9625) in priority order.

### For installs outside the McAllen area

Edit `~/jafo-data/config/config.json` and replace the control channels with your nearest sites'. Find them at https://www.radioreference.com/db/sid/6742 — each row labeled with red `c` markers is a control channel.

### For multiple LRGVRRS systems

If you want to capture from a different system entirely (e.g. a state-wide network or a different city's trunked radio), the easiest path is to start from one of these profiles and substitute:

- `control_channels` array
- `shortName` (used in log messages)
- The `talkgroupsFile` (export from RadioReference for that specific system)

You can also have multiple `systems` entries if you want to monitor more than one trunked radio system simultaneously — but each system needs its own dedicated decoder slot which means more SDRs.

## HackRF gain stages reference

For future reference if you're tweaking gains manually:

| Stage | trunk-recorder field | Valid values | Notes |
|---|---|---|---|
| RF amp (preamp) | `gain` | `0`, `14` | The +14 dB preamp. ON for weak signals. |
| IF (LNA) | `ifGain` | `0, 8, 16, 24, 32, 40` | 8 dB steps. Higher = more gain before mixing. |
| BB (VGA) | `bbGain` | `0, 2, 4, ..., 62` | 2 dB steps. Final amplifier stage. |

**Default for weak P25 reception**: `gain=14, ifGain=40, bbGain=40` (all maxed). If you start getting decode errors due to overload from cellular or other strong signals, drop `bbGain` to 32 or 24 first.

## SDRplay gain notes

SDRplay's "gain" parameter via Soapy maps to **IFGR (IF Gain Reduction)**. Counterintuitive: higher value = MORE attenuation = LESS gain. Range is 20-59. Default in profiles is 40 (moderate), which works for most signals. For very weak signals, drop to 30 or 25. For strong signals causing overload, raise to 50 or 55.

The `agc_setpoint=-30` in the device string keeps AGC active at a reasonable target. `iqcorr_ctrl=true` enables IQ DC offset correction.
