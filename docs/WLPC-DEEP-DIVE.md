# JAFO Deep Dive — WLPC 2027 (Phoenix)

> **Build Your Own Passive Radio Observatory**
> A two-afternoon, hands-on WLPC Deep Dive. Every student leaves with a working
> JAFO node they built themselves. It's a Raspberry Pi that listens to the local
> P25 system and the sky above it, turns what it hears into plain-English
> incidents, and reports to **jafo.live**.

**Format:** WLPC Deep Dive — two 3-hour sessions (Day 1 PM + Day 2 PM), ~6 hours total.
**Seats:** workshop-capped (suggest 16–24 for one instructor + 1–2 TAs).
**Outcome:** a self-contained, self-configuring JAFO observatory, plus the skills and kit to run one anywhere.

*Last updated 2026-11-27. Changes since the first draft are listed in §8.*

Companion files: `docs/deep-dive/` holds the printable student guide, proposal
and kit BOM. Their HTML sources render to the PDFs; regenerate them with
`docs/deep-dive/build.sh`. `build-jafo-deck.py` generates the technical
overview deck (`jafo-overview.pptx` / `.pdf`). Screenshots are in `docs/media/`.

---

## Teaching arc (the through-line)

> **Day 1 — understand it from first principles.** Unbox the radio, learn how
> P25 trunking actually works, and stand up a P25 receiver *by hand* in GNU Radio
> so nothing is a black box.
>
> **Day 2 — turn it into a product.** Layer the JAFO stack on top: one script
> that self-configures, AI that turns radio calls into incidents and units,
> privacy by design, the public views (Briefing, Map, Console, wall displays),
> the sky (ADS-B + ACARS), and a live feed to jafo.live. Walk out with a working
> observatory.

We deliberately build the hard way first (Day 1: GNU Radio / OP25), *then* show
how JAFO automates all of it (Day 2), so students understand what the one-command
install is actually doing under the hood.

---

## 1. The student kit (hardware)

Each seat gets a pre-purchased kit (included in the Deep Dive fee, per WLPC
format). Target build cost **~$244/seat** (standard, RTL-only kit — full working build).

| # | Item | Why it's in the kit | ~Cost |
|---|------|--------------------|------:|
| 1 | **Raspberry Pi 5 (8 GB)** | The brain. Runs the capture side of the pipeline. | $80 |
| 2 | **Official 27 W USB-C PSU** | The Pi 5 is power-hungry; off-brand PSUs cause brownouts. | $12 |
| 3 | **Active cooler** | *Mandatory.* P25 decode alone holds ~85% of a core; our production node runs 72–78 °C and hits the soft-throttle limit without good airflow. | $5 |
| 4 | **64 GB A2 microSD** | Boot + data for the workshop — cheap, simple, easy to re-flash. | $12 |
| 5 | **2 × RTL-SDR Blog V4** *(standard SDR)* | SDR #1 = P25 (800 MHz). SDR #2 = the sky: ADS-B (1090 MHz) and ACARS (~131 MHz), time-shared. | $70 |
| 6 | **RTL-SDR Blog dipole antenna kit** | Adjustable — set for 800 MHz (P25) and 1090 MHz (ADS-B). | incl. / $15 |
| 7 | **Powered USB 3.0 hub** | *Non-negotiable* — two SDRs + the Pi draw too much off the Pi alone. | $20 |
| 8 | **Case + short USB cables + labels** | Take-home-ready; keeps the bench tidy. Case must leave the fan room to breathe. | $20 |

The whole workshop runs off a **microSD**. It's fast enough for the session,
cheap, and trivial to re-flash if a student wants to start over. Since the node
only keeps the last 4 hours of audio (the hub is the system of record), microSD
is fine for take-home use too. NVMe is an optional upgrade.

**Student brings:** a laptop (SSH client + Raspberry Pi Imager + a microSD reader
or we provide a USB reader), and a phone/laptop browser for the dashboard.

**Instructor provides (shared):** venue networking (a dedicated SSID/switch so 24
Pis don't fight the conference Wi-Fi), a known-good **antenna feed** (see §5 RF
logistics), and a pre-staged RadioReference data cache for the Phoenix system.

### What the production node runs (shown on Day 2)

The RGV reference node is an **Airspy R2 on P25** (control + voice channels at once,
no retune gaps) plus **one RTL-SDR shared between ADS-B and ACARS** by the smart
time-share service. That's the "upgrade path" students see.

### Optional upgrades (shown on Day 2, not required for the build)

- **SDRplay RSP1A** (~$110) — wideband single-SDR capture like the Airspy for less, but
  needs the proprietary SDRplay driver (a bit more setup). A good middle tier.
- **Airspy R2** (~$170) — the P25 upgrade. A wideband 10 MS/s front end that captures
  the **control channel + multiple voice channels simultaneously**. This is what
  production JAFO nodes run.
- **A third SDR** (~$35) — ADS-B and ACARS full-time instead of time-shared.
- **NVMe HAT + 256 GB SSD** (~$45) — faster and far more durable than microSD.
- **Outdoor / window-mounted antennas** — the single biggest reception upgrade, for
  both 800 MHz and 1090 MHz. (Lesson from the RGV node: an indoor ADS-B antenna
  heard *zero* aircraft while the community network saw twelve. Placement beats
  everything.)

> **Kit tiers at a glance:** *Standard* = 2× RTL-SDR V4 + microSD (~$244, full working build).
> *Pro upgrade* = add an Airspy R2 (~$170) or SDRplay RSP1A (~$110) for wide, simultaneous
> multi-channel capture (production-grade).

### Accounts / services (free or near-free)
- **Groq API key** — Whisper transcription (free tier covers the workshop).
- **Anthropic API key** — Claude (Haiku 5.5) turns calls into incidents and units.
  We can issue scoped workshop keys or have students create trial accounts.
- **RadioReference** — *optional.* The workshop ships the Phoenix system's sites +
  talkgroups pre-cached, so no student needs a premium sub on-site. For running
  one at home anywhere, a premium sub (~$15–30/yr) + a free API appKey lets JAFO
  auto-pull any system (this is the "runs anywhere" magic).

---

## 2. Prerequisites (sent to students before the conference)

- Comfortable in a Linux terminal (cd, nano/vim, sudo) — we'll scaffold the rest.
- Laptop with **Raspberry Pi Imager** and an **SSH client** installed.
- Create free **Groq** and **Anthropic** accounts (steps provided).
- *Optional pre-read:* "what is a trunked radio system" primer (1 page, we provide),
  and jafo.live/live/rgv/about (what JAFO hides and why listening is legal).
- No RF or SDR experience required — that's the point.

---

## 3. Day 1 — "From photons to P25: a receiver you understand" (3 hrs)

| Time | Module | What happens | Milestone |
|-----:|--------|--------------|-----------|
| 0:00 | **M0 · Welcome + the JAFO story** (15m) | Why this exists; what you'll leave with. A 2-minute tour of jafo.live so everyone sees the destination. Kit unboxing + inventory check. | Everyone has all parts |
| 0:15 | **M1 · Hardware tour + RF 101** (25m) | What each device does. Antennas, frequency, bandwidth, sampling, gain — just enough RF to be dangerous. | Mental model of the signal chain |
| 0:40 | **M2 · Radio-comms + P25 primer** (30m) | Analog→digital, APCO **P25** (Phase 1 vs 2), **what a trunked system is**: control channel, voice grants, talkgroups, sites, WACN/NAC/SysID. Encryption: what's in the clear and what isn't. | Can read a RadioReference system page |
| 1:10 | **M3 · Flash + first boot** (20m) | Image the Pi, headless boot, SSH in, update, RTL-SDR V4 drivers, blacklist DVB-T. | `rtl_test` sees both dongles |
| 1:30 | *break* (10m) | | |
| 1:40 | **M4 · GNU Radio behind the scenes** (45m) | Install GNU Radio + gr-osmosdr. Build a flowgraph in **GRC** (RTL source → FFT): *see* spectrum. The **SDR↔GNU Radio interface**: device args, sample rate, gain. Then a simple FM/NOAA receiver so the blocks click. | Student-built flowgraph receiving *something* |
| 2:25 | **M5 · Decode P25 with OP25** (25m) | Install **OP25** (GNU-Radio-based P25 decoder). Point it at the venue control channel; watch it trunk-track and follow voice grants. This is "receiving P25 using GNU Radio." | **Live P25 decode on screen** |
| 2:50 | **M6 · Wrap + bridge to Day 2** (10m) | You have a P25 receiver you *understand*. Tomorrow: make it a product. | — |

---

## 4. Day 2 — "From receiver to observatory: build JAFO + join the fleet" (3 hrs)

| Time | Module | What happens | Milestone |
|-----:|--------|--------------|-----------|
| 0:00 | **M7 · Recap + the leap to a pipeline** (15m) | From raw decode → a system. The 5 services on the Pi (record, filter, transcribe, enrich, serve) and the **edge/hub split**: the Pi captures and keeps 4 hours; jafo.live is the system of record and runs the heavy AI. | Understand the pipeline |
| 0:15 | **M8 · Install the JAFO stack — one command** (35m) | Run the install script. Watch it **detect location → pull the Phoenix P25 system from RadioReference → self-configure (SDR-window-aware) → name talkgroups → build the map**. Open `jafo.local`. | **Live dashboard, local traffic** |
| 0:50 | **M9 · The brain: calls → incidents → units** (30m) | Groq Whisper transcribes; **Claude Haiku 5.5** reads each call with its neighbours. It writes one plain-English line and links the call to an incident (new or ongoing). It tracks each unit's status (dispatched → on the way → on scene → transporting → available), pins the location to the block, explains radio codes, and lists anything private to hide. An importance score ranks incidents (severity, units, radio volume, special resources, duration). | Your first incidents with units and a timeline |
| 1:20 | **M10 · Privacy, ethics & the law** (15m) | What to hide and how: the two-layer redaction (AI redact list + regex scrub for phones/plates/SSNs/house numbers), block-level locations, softened sensitive calls on wall displays, encrypted channels never touched. Why listening is legal (18 U.S.C. § 2511(2)(g); Tex. Penal Code § 16.02(c)) and what isn't. Walk through jafo.live's About page. | Can explain what JAFO hides and why |
| 1:35 | *break* (10m) | | |
| 1:45 | **M11 · Views + "many ears"** (35m) | Tour the views built on the incident model: **Briefing** (plain-English front page, Now/4h/8h/12h/24h recap of the biggest incidents), **Near me**, the full **Map**, the **Console** pro view with River timeline, and **wall displays**. Then the sky: SDR #2 on **ADS-B + ACARS** with the smart time-share, aircraft side-profiles, and ACARS decoded into plain English ("Took off from McAllen at 11:24 am, bound for DFW"). Push alerts, TxDOT cameras, the listener map. | A view of your city you made your own |
| 2:20 | **M12 · Join the fleet + take it home** (25m) | Self-register the node → report to **jafo.live** → see your city's Briefing. Running it sustainably: heat, the time-share's backoff, 4-hour retention. Plug it in anywhere → it re-homes itself. Community, roadmap, how to contribute. | **Your node live on jafo.live**, and a JAFO to take home |
| 2:45 | **Q&A + open bench** (15m) | Debugging, upgrades, show-and-tell. | — |

---

## 5. RF + venue logistics (instructor prep — critical)

Indoor 800 MHz P25 reception at a conference center is the #1 risk. Plan:

- **Pre-scope the venue:** identify the strongest receivable **unencrypted** P25
  system in Phoenix (likely a regional/statewide system) and its control channels.
  List several sites' control channels so OP25/JAFO locks the strongest.
- **Shared antenna feed:** one good **outdoor / window-mounted 800 MHz antenna**
  split to the room (or a few window dipoles), rather than 24 rubber ducks fighting
  the building. Budget an active splitter/distribution amp. Do the same for 1090 MHz
  if you want ADS-B to land indoors. The community feed (adsb.lol → adsb.fi →
  airplanes.live) covers the sky view either way.
- **Fallback that always works:** a **recorded IQ capture** of the live system (and
  an OP25/JAFO config to replay it), so the decode milestones land even if the room
  is RF-dead. Also useful for pacing.
- **Pre-cache RadioReference data** for the Phoenix system (sites + talkgroups CSVs)
  so Day 2's auto-config works without 24 RR logins.
- **Networking:** dedicated SSID/VLAN or a switch; jafo.live reachable from the room.
- **Heat:** 24 Pis decoding P25 in one room get hot. Fans on, cases open, and
  keep them off tablecloths.
- **Legality note for students:** see M10. In the US, receiving unencrypted
  public-safety radio is lawful (18 U.S.C. § 2511(2)(g)); encrypted traffic isn't
  "readily accessible" and we never touch it. We transmit nothing. Publishing is
  where privacy duties start, which is why JAFO redacts.

---

## 6. The student guide — curriculum module map

Each module expands into step-by-step, copy-pasteable instructions with
expected output and "if it didn't work" checkpoints. The guide lives in
`docs/deep-dive/student-guide.html` (rendered to `docs/deep-dive/jafo-deep-dive-student-guide.pdf`).

**Day 1**
- M0 — Welcome / kit inventory checklist / the destination (jafo.live tour)
- M1 — Hardware tour + RF 101 (diagrams: signal chain, bands)
- M2 — Radio-comms + P25/trunking primer (annotated RadioReference page)
- M3 — Flash & first boot (exact Imager settings, SSH, driver + blacklist commands)
- M4 — GNU Radio: install, the GRC flowgraph, SDR interface, FM/NOAA receiver
- M5 — OP25: install, config for the venue system, read the output, follow a call
- M6 — Wrap

**Day 2**
- M7 — Architecture: the 5 services, the edge/hub split, the data model
- M8 — One-command install + what each auto-provision step is doing
- M9 — The brain: transcription, incidents + units, locations, codes, importance
- M10 — Privacy, ethics & the law
- M11 — Views + many ears: Briefing, Near me, Map, Console, walls; ADS-B/ACARS time-share; aircraft profiles; plain-English ACARS
- M12 — Join the fleet + take it home (sustainability, relocation, troubleshooting)

**Appendices (student takeaway reference)**
- A — Full bill of materials + where to buy / upgrade paths
- B — Command cheat-sheet (every command used, in order)
- C — Troubleshooting (no dongle, no decode, weak RF, no transcripts, hot Pi)
- D — Glossary (P25, trunking, WACN/NAC, talkgroup, control channel, SDR, ADS-B, ACARS terms)
- E — Running one at home: RadioReference appKey + "it works anywhere"
- F — Privacy & legal quick reference

---

## 7. What each student leaves with

- A **working JAFO node** they built and understand — not a black box.
- The **hardware kit** (Pi + SDRs + antenna) to run it at home, anywhere.
- A **GNU Radio / OP25** skillset — they can decode P25 by hand.
- A working grasp of the **AI layer**: how radio calls become incidents, units and a timeline.
- A clear answer to **"is this legal, and what should I hide?"**
- Their node **on the jafo.live fleet**, contributing to a shared dataset.
- The **student guide** as a permanent reference.

---

## 8. What changed since the first draft (Oct → Nov 2026)

The production system moved a long way after the deep dive was first scoped; the
Day 2 curriculum now teaches what's actually running:

- **Incidents + units model (enricher v2):** Claude Haiku 5.5 links calls into
  incidents, tracks unit status, geocodes to the block, and writes the redaction
  list. It runs on the hub, so the Pi stays light.
- **jafo.live/live:** Briefing (front door, with a Now/4h/8h/12h/24h written recap
  of the biggest incidents), Near me, full Map, Console (pro view with River
  timeline), five wall displays, push alerts, TxDOT cameras, weather.
- **Privacy & legality:** two-layer redaction, block-level locations, softened
  sensitive calls on walls, and a public About page covering what's hidden and why
  listening is legal. New module M10.
- **The sky:** ADS-B with community fallback feeds (adsb.lol → adsb.fi →
  airplanes.live), persisted aircraft history, aircraft side-profile illustrations,
  ACARS decoded into plain English, and a smart RTL time-share between ADS-B and
  ACARS that backs off when the band is quiet.
- **Edge/hub split:** the Pi keeps 4 hours of audio; jafo.live is the system of record.
- **Sustainability:** heat is real (72–78 °C on the production Pi), so active
  cooling is mandatory and periodic jobs back off.
- **Listener map:** "N watching" shows, by city, where people are watching from.
  It uses local IP lookup, and IPs are never stored.
