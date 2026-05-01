# Pi Hardware

## Required (everyone)

| Item | Notes |
|------|-------|
| Raspberry Pi 5 (8GB) | 4GB will work but tight |
| Official 27W USB-C PSU | Don't substitute. Cheap PSUs cause random reboots |
| Active cooler | Pi 5 active cooler ($5) is sufficient |
| Powered USB hub | Non-negotiable for any SDR setup |
| 800 MHz antenna | Discone or tuned vertical, mounted high |
| 256GB+ SSD | NVMe HAT preferred over SD card |

## SDRs (pick a combination)

The bootstrap auto-detects what's plugged in and configures accordingly. See `SDR_PROFILES.md` for the matrix of supported combinations. The most common picks:

| Combination | Why pick it | Approx. cost |
|-------------|-------------|--------------|
| **HackRF + RTL-SDR** | The standard. Cheap, works, well-documented. | ~$300 + $30 |
| **HackRF + SDRplay RSP1** | Better dynamic range on weak signals. Slightly more setup. | ~$300 + $120 |
| **HackRF alone** | Already have one, want to start. Slightly fewer voice slots. | $300 |
| **SDRplay RSP1 alone** | Already have one. Single-SDR mode. | $120 |

## SDRplay vs RTL-SDR — which is better?

For the **control channel** role (decoding the data signal that tells trunk-recorder what frequencies to record on), they're functionally interchangeable. The control channel is a strong, narrow signal; both decode it reliably with a halfway decent antenna.

For the **voice channel** role, neither is ideal — you really want a HackRF or similar wideband SDR. RTL-SDR is too narrow (2.4 MHz max) to capture all voice channels in one tuner. RSP1 *can* do it (8 MHz) but at the cost of using your only good SDR for what trunk-recorder considers a less-demanding job.

The sweet spot is: **HackRF for voice, RTL-SDR or RSP1 for control.** Whichever of the two you have, jafo will configure it correctly.

## Antenna matters more than you'd think

The whip that ships with most RTL-SDRs is barely adequate for testing. For production:

- **Best:** Outdoor discone or tuned 800 MHz vertical, low-loss coax (LMR-240+) into the Pi
- **OK:** Indoor 800 MHz mag-mount on metal near a window
- **Bad:** Stock telescoping whip on the desk

Antenna is the single biggest determinant of decode rate. A great SDR with a bad antenna will lose to a cheap SDR with a good antenna every time.

## USB layout

ALL SDRs → powered USB hub → Pi 5 USB 3.0 (blue) port.

Do not put one SDR direct on the Pi and another on the hub — that's a recipe for the worse-quality connection to drop intermittently. Especially with SDRplay, which is sensitive to USB power glitches.

## Power budget

| Component       | Draw  |
|-----------------|-------|
| Pi 5 idle       | ~3W   |
| Pi 5 under load | ~8W   |
| HackRF          | ~2-3W |
| SDRplay RSP1    | ~1.5W |
| RTL-SDR         | ~0.5W |
| NVMe SSD        | ~2W   |

The 27W official PSU has plenty of margin. The powered hub provides its own power to the SDRs so they're not pulling from the Pi's bus.

## Network

Wired Ethernet preferred. WiFi works fine.

## Storage

- 30 days of Opus calls + DB: ~300 MB
- trunk-recorder build: ~500 MB
- All Python venvs + packages: ~1 GB
- SDRplay API + SoapySDRPlay3 build: ~200 MB (only if RSP detected)
- OS: ~3 GB

A 256 GB SSD is ~98% empty after a year of operation.
