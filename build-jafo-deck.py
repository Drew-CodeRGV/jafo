#!/usr/bin/env python3
"""Generate the JAFO technical-overview deck (.pptx) for a ham/technical audience."""
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
import copy

LOGO = "pi/web/static/logo.png"
OUT  = "jafo-overview.pptx"

# ---- palette (tactical night-ops, built around the blue chopper) ----
BG      = RGBColor(0x0A, 0x10, 0x1F)   # near-black navy
BG2     = RGBColor(0x10, 0x1A, 0x30)   # panel navy
BLUE    = RGBColor(0x3B, 0x82, 0xF6)   # JAFO blue (accent)
BLUE_DK = RGBColor(0x1E, 0x50, 0xC8)   # deep rotor blue
WHITE   = RGBColor(0xF5, 0xF7, 0xFA)
GREY    = RGBColor(0xB4, 0xC0, 0xD4)   # body text
GREY_DK = RGBColor(0x7A, 0x88, 0xA0)   # captions
AMBER   = RGBColor(0xFF, 0xB0, 0x20)   # signal / highlight
GREEN   = RGBColor(0x34, 0xD3, 0x99)   # $0 / active
RED     = RGBColor(0xF8, 0x71, 0x71)

MONO = "Consolas"
SANS = "Calibri"

prs = Presentation()
prs.slide_width  = Inches(13.333)
prs.slide_height = Inches(7.5)
SW, SH = prs.slide_width, prs.slide_height
BLANK = prs.slide_layouts[6]


def solid(shape, color):
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()


def bg(slide, color=BG):
    s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SW, SH)
    solid(s, color)
    s.shadow.inherit = False
    # push to back
    sp = s._element
    sp.getparent().remove(sp)
    slide.shapes._spTree.insert(2, sp)
    return s


def rect(slide, x, y, w, h, color, line=None, line_w=None):
    s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    solid(s, color)
    s.shadow.inherit = False
    if line is not None:
        s.line.color.rgb = line
        s.line.width = line_w or Pt(1)
    return s


def txt(slide, x, y, w, h, runs, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP,
        space_after=6, line_spacing=1.0):
    """runs: list of paragraphs; each paragraph is list of (text,size,color,bold,font)."""
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.05)
    tf.margin_top = tf.margin_bottom = Inches(0.02)
    for i, para in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.space_after = Pt(space_after)
        p.space_before = Pt(0)
        p.line_spacing = line_spacing
        for (t, sz, col, bold, font) in para:
            r = p.add_run()
            r.text = t
            r.font.size = Pt(sz)
            r.font.color.rgb = col
            r.font.bold = bold
            r.font.name = font
    return tb


def R(t, sz=16, col=GREY, bold=False, font=SANS):
    return (t, sz, col, bold, font)


_page = [1]  # title slide is page 1; header() auto-numbers the rest in order

def header(slide, kicker, title):
    _page[0] += 1
    # top accent bar
    rect(slide, 0, 0, SW, Inches(0.12), BLUE)
    txt(slide, Inches(0.6), Inches(0.35), Inches(11), Inches(0.4),
        [[R(kicker, 13, BLUE, True, MONO)]])
    txt(slide, Inches(0.55), Inches(0.62), Inches(11.5), Inches(0.9),
        [[R(title, 32, WHITE, True, SANS)]])
    # small logo top-right
    slide.shapes.add_picture(LOGO, SW - Inches(1.65), Inches(0.28),
                             height=Inches(0.95))
    # footer
    txt(slide, Inches(0.6), SH - Inches(0.45), Inches(8), Inches(0.3),
        [[R("JAFO — Just Another F***ing Observer   ·   passive P25 + multi-band radio observatory",
            9, GREY_DK, False, MONO)]])
    txt(slide, SW - Inches(1.4), SH - Inches(0.45), Inches(0.9), Inches(0.3),
        [[R(str(_page[0]), 10, GREY_DK, True, MONO)]], align=PP_ALIGN.RIGHT)


def bullet(slide, x, y, w, items, gap=0.0, size=16, tick="▸", tickcol=BLUE):
    """items: list of (lead, rest) or (lead, rest, restcolor)."""
    paras = []
    for it in items:
        lead = it[0]; rest = it[1]
        rc = it[2] if len(it) > 2 else GREY
        line = [R(f"{tick} ", size, tickcol, True, SANS)]
        if lead:
            line.append(R(lead, size, WHITE, True, SANS))
            if rest:
                line.append(R("  " + rest, size, rc, False, SANS))
        else:
            line.append(R(rest, size, rc, False, SANS))
        paras.append(line)
    return txt(slide, x, y, w, Inches(5), paras, space_after=9, line_spacing=1.05)


def chip(slide, x, y, w, h, label, val, lcol=GREY_DK, vcol=WHITE, bgc=BG2, border=BLUE):
    rect(slide, x, y, w, h, bgc, line=border, line_w=Pt(1.25))
    txt(slide, x + Inches(0.12), y + Inches(0.08), w - Inches(0.24), h - Inches(0.16),
        [[R(label, 11, lcol, True, MONO)], [R(val, 15, vcol, True, SANS)]],
        anchor=MSO_ANCHOR.MIDDLE, space_after=2)


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


# ======================================================================
# SLIDE 1 — TITLE
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
# faint deep-blue panel behind the chopper
rect(s, Inches(6.7), 0, Inches(6.63), SH, BG2)
# big logo
s.shapes.add_picture(LOGO, Inches(7.1), Inches(2.0), width=Inches(5.7))
rect(s, 0, Inches(2.55), Inches(0.22), Inches(2.4), BLUE)
txt(s, Inches(0.6), Inches(1.5), Inches(6.2), Inches(0.5),
    [[R("PASSIVE OBSERVER · P25 PHASE 1 · LRGVRRS", 14, BLUE, True, MONO)]])
txt(s, Inches(0.55), Inches(2.3), Inches(6.3), Inches(2.2),
    [[R("JAFO", 110, WHITE, True, SANS)],
     [R("Just Another F***ing Observer", 22, GREY, False, SANS)]],
    space_after=4)
txt(s, Inches(0.6), Inches(4.8), Inches(6.2), Inches(1.6),
    [[R("Hear the whole Rio Grande Valley in real time —", 17, GREY, False, SANS)],
     [R("capture, transcribe, and classify unencrypted", 17, GREY, False, SANS)],
     [R("public-safety radio on a single Raspberry Pi 5.", 17, GREY, False, SANS)]],
    space_after=2, line_spacing=1.1)
txt(s, Inches(0.6), Inches(6.55), Inches(8), Inches(0.5),
    [[R("Technical overview  ·  KE5ZJO  ·  ", 12, GREY_DK, False, MONO),
      R("you can hear a mouse fart at 2000 ft", 12, AMBER, False, MONO)]])

# ======================================================================
# SLIDE 2 — ORIGIN (heritage + childhood)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "ORIGIN · WHO'S BEHIND THIS", "I came to this as a radio operator")
txt(s, Inches(0.6), Inches(1.72), Inches(12.1), Inches(0.6),
    [[R("Not as a Wi-Fi guy. ", 18, WHITE, True, SANS),
      R("Radio's been the thread my whole life — as far back as I can remember — and it runs in the family.",
        18, GREY, False, SANS)]], line_spacing=1.12)
_lin = [("GREAT-GRANDFATHER", "TX Highway Patrol"),
        ("GRANDFATHER", "State trooper & senator"),
        ("GRANDFATHER", "U.S. Coast Guard"),
        ("DAD", "Pilot")]
_cx = Inches(0.6)
for _lbl, _val in _lin:
    chip(s, _cx, Inches(2.45), Inches(2.88), Inches(0.8), _lbl, _val)
    _cx = _cx + Inches(3.02)
_mom = [
    (BLUE, "The F-4 flight book.",
     "Dad handed me his F-4 Phantom manual and I got stuck on the radio-comms pages — convinced "
     "that if I just found the right frequency, I could talk to him while he flew. That was the start."),
    (AMBER, "Granddad's scanner.",
     "At my great-granddad's I flipped on his police scanner and his radios — floored that so many "
     "messages move through the air, and that you could just… receive them."),
]
_by = Inches(3.5)
for _col, _lead, _body in _mom:
    rect(s, Inches(0.6), _by, Inches(0.14), Inches(1.2), _col)
    txt(s, Inches(0.95), _by - Inches(0.05), Inches(11.6), Inches(1.3),
        [[R(_lead, 19, WHITE, True, SANS)], [R(_body, 15, GREY, False, SANS)]],
        space_after=5, line_spacing=1.14)
    _by = _by + Inches(1.55)
notes(s, "I didn't come to this as a Wi-Fi person — I came as a radio operator. I've been "
         "interested in radio communications pretty much my whole life. My grandfather was a state "
         "trooper (and a senator), my great-grandfather was Texas Highway Patrol, my dad was a "
         "pilot, and my other grandfather served in the Coast Guard. When my dad handed me one of "
         "his flight books about the F-4 Phantom, I got fascinated by the part about radio "
         "communications. As a kid I naively thought that if I could just tune the right frequency, "
         "I could talk to my dad while he was flying his jet. That started this love for antennas "
         "and communication and how it all worked. Then I found police scanners — sitting at my "
         "great-granddad's house, seeing his scanner and his radios, turning them on to see how "
         "they worked. I was always fascinated by how many messages go through the air and get received.")

# ======================================================================
# SLIDE 3 — THE ITCH (the gap → ask AI → purpose)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "THE ITCH", "I just wanted to listen to P25")
txt(s, Inches(0.6), Inches(1.72), Inches(12.1), Inches(0.8),
    [[R("Got my ham license; the curiosity never left. I always figured these software-defined "
       "radios could do more than just push packets back and forth.", 17, GREY, False, SANS)]],
    line_spacing=1.14)
rect(s, Inches(0.6), Inches(2.75), Inches(0.14), Inches(1.25), BLUE)
txt(s, Inches(0.95), Inches(2.7), Inches(11.6), Inches(1.3),
    [[R("P25 locked me out.", 19, WHITE, True, SANS)],
     [R("When public safety went trunked and P25, just listening got daunting — a capable scanner "
        "runs $200–$2,000, and rolling your own (hello, GNU Radio flowgraphs) is brutal. "
        "My Kenwood TS-2000 can reach the ISS — but it can't touch P25.", 15, GREY, False, SANS)]],
    space_after=5, line_spacing=1.14)
rect(s, Inches(0.6), Inches(4.35), Inches(12.13), Inches(1.15), BG2, line=GREEN, line_w=Pt(1.5))
txt(s, Inches(0.85), Inches(4.5), Inches(11.6), Inches(0.9),
    [[R("So I asked AI to build it — and it did.  ", 18, GREEN, True, SANS),
      R("Two candy-bar RTL-SDRs, a Raspberry Pi, and that one question. A friend showed me his "
        "take and leveled mine up; I leveled his up. Out came this dashboard.", 15, GREY, False, SANS)]],
    anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.15)
txt(s, Inches(0.6), Inches(5.78), Inches(12.1), Inches(1.0),
    [[R("Why bother?  ", 16, AMBER, True, SANS),
      R("No local paper anymore, no police blotter, and the news trades facts for opinion. "
        "I wanted to tap the source — what's actually happening in and around my community.",
        16, GREY, False, SANS)]], line_spacing=1.15)
notes(s, "As I grew up and got my amateur radio license, that curiosity was always there. I always "
         "had this idea that software-defined radios can do so much more than just transmit packets "
         "of data back and forth. I've always been an avid fan of APCO and public-safety comms. But "
         "as trunked signals came about and radio moved into P25, it seemed like a daunting, "
         "expensive task — a couple hundred to a couple thousand dollars for a scanner, or a hard "
         "way to interpret the signals. My Kenwood TS-2000 can't pick up P25, but I can talk to the "
         "International Space Station — so that's pretty cool. What I wanted was a way to listen to "
         "and decode trunked P25. And if you've ever used GNU Radio, you know how hard it is to "
         "build a recipe to do all that. So one day I'm sitting there with a couple of those "
         "candy-bar RTL-SDRs and a Raspberry Pi, and I thought: why not just ask AI to do it for "
         "me? And it did. I shared it with a friend, he showed me what he was doing, which leveled "
         "up what I was doing — so I did something that leveled up what he was doing. And you end up "
         "with this dashboard full of information. I wanted to scale it and make it available to "
         "everyone, but also make it intricate and detailed so it could run in the background and "
         "look really cool — and give me information about what's happening in and around my "
         "community. We don't have a newspaper anymore, we don't have a police blotter, and the "
         "news gives a lot of opinion instead of actual facts. I wanted a way to tap into the "
         "source. And that's what I did.")

# ======================================================================
# SLIDE 4 — WHAT IT IS
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "ORIENTATION", "What JAFO is")
txt(s, Inches(0.6), Inches(1.8), Inches(7.3), Inches(1.4),
    [[R("A single-Pi, self-hosted ", 19, GREY, False, SANS),
      R("observatory for unencrypted public-safety radio", 19, WHITE, True, SANS),
      R(" in the RGV. It listens to the ", 19, GREY, False, SANS),
      R("Lower Rio Grande Valley Regional Radio System", 19, BLUE, True, SANS),
      R(" — a P25 Phase 1 trunked system across Hidalgo, Cameron, Willacy, Starr & Brooks counties.",
        19, GREY, False, SANS)]], line_spacing=1.12)
bullet(s, Inches(0.6), Inches(4.05), Inches(7.3), [
    ("Passive & receive-only.", "No transmit, no decryption — just what's already in the clear."),
    ("Not police voice", "(that's encrypted) — but fire, EMS, schools, constables, public works, plus everyone's traffic patterns.", GREY),
    ("Everything local.", "SQLite DB + audio on disk, served from the box. No cloud servers, no S3."),
    ("Built to put itself out of a job —", "advocacy for the City to publish a public CAD feed.", GREY),
])
# right panel: the why / identity
px = Inches(8.2)
rect(s, px, Inches(1.8), Inches(4.55), Inches(4.7), BG2, line=BLUE_DK, line_w=Pt(1.25))
txt(s, px + Inches(0.3), Inches(2.0), Inches(4.0), Inches(0.5),
    [[R("THE NAME", 12, AMBER, True, MONO)]])
txt(s, px + Inches(0.3), Inches(2.4), Inches(4.0), Inches(1.6),
    [[R("The callsign for the spotter in ", 15, GREY, False, SANS),
      R("Blue Thunder", 15, WHITE, True, SANS),
      R(" (1983). Passive role, sees everything, only speaks when there's something worth saying.",
        15, GREY, False, SANS)]], line_spacing=1.1)
txt(s, px + Inches(0.3), Inches(4.15), Inches(4.0), Inches(0.5),
    [[R("SYSTEM IDENTITY", 12, AMBER, True, MONO)]])
txt(s, px + Inches(0.3), Inches(4.55), Inches(4.0), Inches(1.8),
    [[R("System ID   0x2B5", 15, WHITE, False, MONO)],
     [R("WACN        0xBEE00", 15, WHITE, False, MONO)],
     [R("NAC         0x2B1  (Pharr)", 15, WHITE, False, MONO)],
     [R("Band        851–856 MHz", 15, GREY, False, MONO)]], space_after=5)

# ======================================================================
# SLIDE — CAPABILITIES (one Pi, many ears)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "WHAT IT DOES", "One Pi, listening to everything")
# left panel: the ears
rect(s, Inches(0.6), Inches(1.75), Inches(6.0), Inches(4.6), BG2, line=BLUE_DK, line_w=Pt(1.0))
txt(s, Inches(0.85), Inches(1.9), Inches(5.5), Inches(0.4),
    [[R("THE EARS — what it hears", 13, BLUE, True, MONO)]])
_ears = [
    ("P25 trunked", "public-safety voice — fire, EMS, PD traffic patterns"),
    ("Aircraft overhead", "ADS-B — airliners + helicopters"),
    ("ACARS", "aircraft data & telemetry"),
    ("Rail", "VHF railroad voice"),
    ("Maritime", "marine VHF / AIS"),
    ("Business & utility", "VHF / UHF conventional"),
    ("Weather", "NOAA broadcast"),
]
txt(s, Inches(0.85), Inches(2.42), Inches(5.5), Inches(3.9),
    [[R("▸ ", 14, BLUE, True, SANS), R(a + "  ", 14.5, WHITE, True, SANS),
      R("— " + b, 13, GREY, False, SANS)] for a, b in _ears],
    space_after=8, line_spacing=1.05)
# right panel: the brain
rx = Inches(6.9)
rect(s, rx, Inches(1.75), Inches(5.83), Inches(4.6), BG2, line=AMBER, line_w=Pt(1.0))
txt(s, rx + Inches(0.25), Inches(1.9), Inches(5.3), Inches(0.4),
    [[R("THE BRAIN — what it makes of it", 13, AMBER, True, MONO)]])
_brain = [
    ("Auto-transcription", "bilingual EN / ES, ~1s"),
    ("Auto talkgroup ID", "named from RadioReference"),
    ("Incident extraction", "type · location · units · severity"),
    ("News stories + digests", "plain-English briefings"),
    ("Situational awareness", "radio + sky + ground, one live map"),
]
txt(s, rx + Inches(0.25), Inches(2.42), Inches(5.3), Inches(3.9),
    [[R("▸ ", 14, AMBER, True, SANS), R(a + "  ", 14.5, WHITE, True, SANS),
      R("— " + b, 13, GREY, False, SANS)] for a, b in _brain],
    space_after=13, line_spacing=1.05)
rect(s, Inches(0.6), Inches(6.5), Inches(12.13), Inches(0.42), BG2, line=GREEN, line_w=Pt(1.25))
txt(s, Inches(0.6), Inches(6.5), Inches(12.13), Inches(0.42),
    [[R("All self-contained on a single Raspberry Pi.", 15, GREEN, True, SANS)]],
    align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
notes(s, "What it does: one script sets up a brand-new Raspberry Pi — it identifies where it is, "
         "reaches out to RadioReference, pulls in all the P25 data, sets itself up, builds the "
         "maps, reports live back to jafo.live, adds itself to the fleet, and starts reporting. It "
         "automatically identifies talkgroups, auto-transcribes, and builds news stories and "
         "digests. It gives you situational awareness combined with the airliners and helicopters "
         "flying overhead — plus access to rail, maritime, business VHF/UHF, and weather. All "
         "self-contained on a Raspberry Pi.")

# ======================================================================
# SLIDE — THE PIPELINE
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "THE PIPELINE", "RF in → searchable intel out")
stages = [
    ("RF CAPTURE", "SDR + trunk-recorder", "decode P25 control,\nrecord voice → WAV", BLUE, "$0"),
    ("FILTER", "Silero VAD + Opus", "drop 80–90% junk,\nencode survivors", BLUE, "$0"),
    ("TRANSCRIBE", "Groq Whisper", "large-v3-turbo,\nEN/ES, ~1s latency", AMBER, "~$1–3/mo"),
    ("ENRICH", "Claude Haiku", "structured incident\nJSON extraction", AMBER, "~$2–5/mo"),
    ("SERVE", "Flask + nginx", "timeline, search,\naudio, map, API", GREEN, "$0"),
]
n = len(stages)
cw = Inches(2.28); gap = Inches(0.13)
x0 = Inches(0.6); y0 = Inches(2.15); ch = Inches(2.7)
for i, (t, sub, desc, col, cost) in enumerate(stages):
    x = x0 + i * (cw + gap)
    rect(s, x, y0, cw, ch, BG2, line=col, line_w=Pt(1.5))
    rect(s, x, y0, cw, Inches(0.12), col)
    txt(s, x + Inches(0.14), y0 + Inches(0.26), cw - Inches(0.28), Inches(0.4),
        [[R(f"{i+1}", 13, col, True, MONO), R("  " + t, 14, WHITE, True, SANS)]])
    txt(s, x + Inches(0.14), y0 + Inches(0.78), cw - Inches(0.28), Inches(0.4),
        [[R(sub, 13, col, True, SANS)]])
    txt(s, x + Inches(0.14), y0 + Inches(1.2), cw - Inches(0.28), Inches(1.0),
        [[R(l, 12, GREY, False, SANS)] for l in desc.split("\n")], space_after=2,
        line_spacing=1.05)
    txt(s, x + Inches(0.14), y0 + ch - Inches(0.42), cw - Inches(0.28), Inches(0.35),
        [[R(cost, 13, (GREEN if cost == "$0" else AMBER), True, MONO)]])
    if i < n - 1:
        ar = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW,
                                x + cw - Inches(0.02), y0 + ch/2 - Inches(0.12),
                                gap + Inches(0.04), Inches(0.24))
        solid(ar, col)
txt(s, Inches(0.6), Inches(5.3), Inches(12.1), Inches(1.0),
    [[R("One SQLite database is the spine.", 16, WHITE, True, SANS),
      R("  A call row evolves through stages — processor inserts it, transcriber adds text, "
        "enricher adds the incident JSON. NULL columns mean “stage not done yet,” so any "
        "service can crash and resume exactly where it left off. WAL mode keeps readers and "
        "writers safe across processes.", 16, GREY, False, SANS)]], line_spacing=1.12)
chip(s, Inches(0.6), Inches(6.3), Inches(2.9), Inches(0.62), "THROUGHPUT", "~300 calls/day")
chip(s, Inches(3.7), Inches(6.3), Inches(2.9), Inches(0.62), "ALL-IN COST", "~$3–8 / month", vcol=GREEN)
chip(s, Inches(6.8), Inches(6.3), Inches(2.9), Inches(0.62), "FILTER YIELD", "80–90% dropped")
chip(s, Inches(9.9), Inches(6.3), Inches(2.82), Inches(0.62), "CLOUD SERVERS", "zero", vcol=GREEN)

# ======================================================================
# SLIDE 4 — THE FIVE SERVICES (detail)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "PIPELINE DETAIL", "Five systemd services")
rows = [
    ("jafo-recorder", "trunk-recorder v5.2.x (compiled)",
     "Decodes the P25 control channel, captures voice calls to WAV. Reads config.json.", "$0"),
    ("jafo-processor", "Silero VAD · ffmpeg/Opus",
     "Drops no-speech/too-short calls, encodes survivors to Opus 16 kHz mono 32 kbps, inserts DB row.", "$0"),
    ("jafo-transcriber", "Groq whisper-large-v3-turbo",
     "Polls for kept calls w/ no transcript, sends Opus, writes text back. Bilingual EN/ES, ~0.3–1.0 s.", "~$1–3/mo"),
    ("jafo-enricher", "Anthropic claude-haiku-4-5",
     "Polls for transcribed calls, extracts {type, summary, location, units, severity} as JSON.", "~$2–5/mo"),
    ("jafo-web", "Flask on :8080 ← nginx :80",
     "Timeline + talkgroup groups + FTS5 search + range audio streaming + map + news desk + JSON API.", "$0"),
]
y = Inches(1.85); rh = Inches(1.0)
for i, (name, tech, desc, cost) in enumerate(rows):
    yy = y + i * (rh + Inches(0.03))
    rect(s, Inches(0.6), yy, Inches(12.13), rh, BG2 if i % 2 == 0 else BG,
         line=BLUE_DK, line_w=Pt(0.75))
    rect(s, Inches(0.6), yy, Inches(0.1), rh, BLUE)
    txt(s, Inches(0.85), yy + Inches(0.1), Inches(3.0), rh - Inches(0.2),
        [[R(name, 17, WHITE, True, MONO)], [R(tech, 12, BLUE, True, SANS)]],
        anchor=MSO_ANCHOR.MIDDLE, space_after=3)
    txt(s, Inches(4.0), yy + Inches(0.1), Inches(7.1), rh - Inches(0.2),
        [[R(desc, 14, GREY, False, SANS)]], anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.05)
    txt(s, Inches(11.2), yy + Inches(0.1), Inches(1.4), rh - Inches(0.2),
        [[R(cost, 13, (GREEN if cost == "$0" else AMBER), True, MONO)]],
        anchor=MSO_ANCHOR.MIDDLE, align=PP_ALIGN.RIGHT)

# ======================================================================
# SLIDE 5 — WHAT YOU CAN ACCESS
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "ACCESS", "What you can get at")
cols = [
    ("LIVE WEB UI", "http://jafo.local", BLUE, [
        "Timeline of calls, live-polling",
        "Talkgroup filter — by service / city",
        "FTS5 full-text search (transcripts + summaries)",
        "In-browser audio playback (audio/ogg)",
        "Per-call detail + structured incident",
        "Map / OSINT & analyst views",
        "Spectrum plan + SDR-mode toggle",
    ]),
    ("SIGNALS BEYOND P25", "same box, extra SDR modes", AMBER, [
        "ADS-B aircraft tracking + lookup",
        "ACARS message decode",
        "Shared RTL: ADS-B ⇄ ACARS via sdr-mode.sh",
        "Conventional / non-trunked scan tools",
        "Cell-site + FCC ASR ingest (OSINT demo)",
    ]),
    ("DATA & PLATFORM", "APIs, hub, pipeline", GREEN, [
        "JSON API: /api/calls, /search, /stats, /health",
        "Share cards: PNG / MP4 / MP3 per call or story",
        "News Desk: stories, ticker, editions, moderation",
        "jafo.live cloud hub — multi-node system of record",
        "Otter renderer → n8n video pipeline",
        "Admin: fleet/nodes, regions, LLM-eval",
    ]),
]
cw = Inches(3.95); x0 = Inches(0.6); gap = Inches(0.17); y0 = Inches(1.85)
for i, (title, sub, col, items) in enumerate(cols):
    x = x0 + i * (cw + gap)
    rect(s, x, y0, cw, Inches(5.0), BG2, line=col, line_w=Pt(1.5))
    rect(s, x, y0, cw, Inches(0.75), col)
    txt(s, x + Inches(0.2), y0 + Inches(0.08), cw - Inches(0.4), Inches(0.7),
        [[R(title, 16, BG, True, SANS)], [R(sub, 11, BG, False, MONO)]],
        space_after=1)
    txt(s, x + Inches(0.22), y0 + Inches(0.95), cw - Inches(0.44), Inches(3.9),
        [[R("• ", 13, col, True, SANS), R(it, 13.5, GREY, False, SANS)] for it in items],
        space_after=8, line_spacing=1.05)

# ======================================================================
# SLIDE 6 — COMPONENTS NEEDED
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "BILL OF MATERIALS", "What it takes to run one")
# Hardware
txt(s, Inches(0.6), Inches(1.75), Inches(6), Inches(0.4),
    [[R("HARDWARE", 15, BLUE, True, MONO), R("   one-time ~$200–400", 13, GREY_DK, False, MONO)]])
bullet(s, Inches(0.6), Inches(2.25), Inches(6.1), [
    ("Raspberry Pi 5 (8 GB)", "+ official 27 W USB-C PSU + active cooler"),
    ("Powered USB hub —", "non-negotiable; SDRs draw too much for the Pi.", RED),
    ("256 GB+ SSD", "on an NVMe HAT (journal + DB + audio)"),
    ("800 MHz antenna", "mounted high — biggest single lever on decode"),
    ("One or more SDRs,", "auto-detected at install:"),
], size=15)
txt(s, Inches(0.95), Inches(5.25), Inches(5.9), Inches(1.8),
    [[R("HackRF One + RTL-SDR", 13.5, WHITE, True, MONO), R("   standard config", 12, GREY, False, SANS)],
     [R("HackRF One + SDRplay RSP", 13.5, WHITE, True, MONO), R("   better dynamic range", 12, GREY, False, SANS)],
     [R("Airspy R2 (P25) + RTL (ADS-B)", 13.5, WHITE, True, MONO), R("   current RGV node", 12, AMBER, False, SANS)],
     [R("HackRF / RSP alone", 13.5, WHITE, True, MONO), R("   single-SDR mode", 12, GREY, False, SANS)]],
    space_after=6)
# Software + APIs (right)
rx = Inches(7.0)
txt(s, rx, Inches(1.75), Inches(6), Inches(0.4),
    [[R("SOFTWARE", 15, GREEN, True, MONO), R("   all installed by bootstrap.sh", 13, GREY_DK, False, MONO)]])
bullet(s, rx, Inches(2.25), Inches(5.9), [
    ("Raspberry Pi OS Lite", "64-bit, Bookworm"),
    ("GNU Radio + SoapySDR", "+ SDR drivers, DVB-T/msi2500 blacklisted"),
    ("trunk-recorder", "built from source (Boost, ffmpeg, cmake)"),
    ("Python venvs", "processor/transcriber/enricher + web"),
    ("SQLite (FTS5, WAL)", "· nginx · 5 systemd units"),
], size=15)
rect(s, rx, Inches(4.75), Inches(5.73), Inches(2.1), BG2, line=AMBER, line_w=Pt(1.5))
txt(s, rx + Inches(0.25), Inches(4.9), Inches(5.3), Inches(0.4),
    [[R("TWO PAID APIs", 15, AMBER, True, MONO), R("   free to start, pay-as-you-go", 12, GREY_DK, False, MONO)]])
txt(s, rx + Inches(0.25), Inches(5.4), Inches(5.3), Inches(1.4),
    [[R("Groq", 15, WHITE, True, SANS), R("  — Whisper transcription  (~$1–3/mo)", 14, GREY, False, SANS)],
     [R("Anthropic", 15, WHITE, True, SANS), R("  — Claude Haiku enrichment  (~$2–5/mo)", 14, GREY, False, SANS)],
     [R("No keys? Capture + storage still run —", 13, GREY, False, SANS)],
     [R("you just lose transcripts & enrichment.", 13, GREY, False, SANS)]],
    space_after=5, line_spacing=1.05)

# ======================================================================
# SLIDE 7 — QUICK START (new node)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "DEPLOY · ZERO-TOUCH", "Flash it, run one script, walk away")
txt(s, Inches(0.6), Inches(1.65), Inches(12.1), Inches(0.5),
    [[R("One command on a fresh Pi. It figures out the rest and comes up ", 15, GREY, False, SANS),
      R("live on the fleet", 15, GREEN, True, SANS),
      R(" — no manual config, no CSVs to hand-load.", 15, GREY, False, SANS)]], line_spacing=1.1)
steps = [
    ("1", "FLASH", "Fresh Pi OS, run the install script — it builds the whole stack."),
    ("2", "LOCATE", "Geolocates itself from its network — figures out what city it's in."),
    ("3", "RADIOREFERENCE", "Pulls the local P25 system from RadioReference — control channels + all talkgroups."),
    ("4", "SELF-CONFIG", "Tunes the SDR (window-aware), loads talkgroups, names every channel."),
    ("5", "MAPS", "Builds the map and coverage view for the new location."),
    ("6", "JOIN FLEET", "Self-registers on jafo.live, gets its own node, starts uploading."),
    ("7", "REPORT", "Captures → transcribes → enriches — live, named, on the map."),
]
y = Inches(2.3); rh = Inches(0.57)
for num, tag, desc in steps:
    rect(s, Inches(0.6), y, Inches(0.6), Inches(0.49), GREEN)
    txt(s, Inches(0.6), y, Inches(0.6), Inches(0.49),
        [[R(num, 22, BG, True, SANS)]], align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    rect(s, Inches(1.26), y, Inches(2.5), Inches(0.49), BG2, line=BLUE_DK, line_w=Pt(0.75))
    txt(s, Inches(1.38), y, Inches(2.4), Inches(0.49),
        [[R(tag, 13.5, BLUE, True, MONO)]], anchor=MSO_ANCHOR.MIDDLE)
    rect(s, Inches(3.82), y, Inches(8.91), Inches(0.49), BG, line=BLUE_DK, line_w=Pt(0.75))
    txt(s, Inches(3.98), y, Inches(8.7), Inches(0.49),
        [[R(desc, 13, GREY, False, SANS)]], anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.0)
    y = y + rh
txt(s, Inches(0.6), Inches(6.45), Inches(12.1), Inches(0.5),
    [[R("And when it moves:  ", 13, AMBER, True, SANS),
      R("relocate it to a new city and it re-homes itself — new frequencies, new talkgroups, new "
        "map, new fleet node — automatically, on boot.", 13, GREY, False, SANS)]], line_spacing=1.05)

# ======================================================================
# SLIDE 8 — VERIFY / OPERATE + CLOSE
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "OPERATE", "Verify, watch, iterate")
# left: verify commands
rect(s, Inches(0.6), Inches(1.8), Inches(6.15), Inches(4.6), BG2, line=BLUE_DK, line_w=Pt(1.0))
txt(s, Inches(0.85), Inches(1.95), Inches(5.6), Inches(0.4),
    [[R("HEALTH CHECK", 13, BLUE, True, MONO)]])
cmds = [
    "# pre-flight SDR check",
    "~/jafo/pi/tools/check-sdrs.sh",
    "",
    "# are all five up?",
    "sudo systemctl status 'jafo-*'",
    "",
    "# live logs (follow any stage)",
    "journalctl -u jafo-recorder -f",
    "journalctl -u jafo-transcriber -f",
    "",
    "# pipeline health summary",
    "~/jafo/pi/services/stats.py",
]
txt(s, Inches(0.85), Inches(2.4), Inches(5.6), Inches(4.0),
    [[R(c if c else " ",
        13, (GREY_DK if c.startswith("#") else WHITE), False, MONO)] for c in cmds],
    space_after=2, line_spacing=1.0)
# right: operate + why
rx = Inches(7.0)
txt(s, rx, Inches(1.85), Inches(6), Inches(0.4),
    [[R("DAY-TO-DAY", 13, GREEN, True, MONO)]])
bullet(s, rx, Inches(2.3), Inches(5.8), [
    ("Edit code, restart one unit —", "sudo systemctl restart jafo-web, etc."),
    ("harden-pi.sh", "bulletproofs a node (idempotent)."),
    ("update-pi.sh", "pulls + redeploys the latest."),
    ("Run Claude Code on the Pi", "— it reads CLAUDE.md + HANDOFF.md for full context."),
], size=14)
rect(s, rx, Inches(4.35), Inches(5.73), Inches(2.05), BG2, line=AMBER, line_w=Pt(1.5))
txt(s, rx + Inches(0.25), Inches(4.5), Inches(5.3), Inches(0.4),
    [[R("WHY IT EXISTS", 13, AMBER, True, MONO)]])
txt(s, rx + Inches(0.25), Inches(4.95), Inches(5.3), Inches(1.4),
    [[R("Hear the RGV in real time, demonstrate civic-tech AI plumbing on a $200 Pi, and build "
       "the case for an official public CAD feed —", 14.5, GREY, False, SANS),
      R(" which would make JAFO obsolete. That's the goal.", 14.5, WHITE, True, SANS)]],
    line_spacing=1.12)
# acknowledgment / shout-out (bottom-left, above footer)
txt(s, Inches(0.6), Inches(6.62), Inches(9.6), Inches(0.35),
    [[R("SHOUT-OUT   ", 11, AMBER, True, MONO),
      R("Jonathan Down", 13, WHITE, True, SANS),
      R("  — for showing me his framework early on.", 13, GREY, False, SANS)]])
# tiny chopper bottom-right
s.shapes.add_picture(LOGO, SW - Inches(2.3), SH - Inches(1.75), height=Inches(1.25))

# ======================================================================
# SLIDE — ANYWHERE (not just RGV + fleet / shared-dataset vision)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "ANYWHERE", "Built in the Valley — it runs anywhere")
txt(s, Inches(0.6), Inches(1.75), Inches(12.1), Inches(0.6),
    [[R("I built it for the Rio Grande Valley — but nothing about it is RGV-specific. ", 18, WHITE, True, SANS),
      R("Set one up anywhere.", 18, GREEN, True, SANS)]], line_spacing=1.12)
_blk = [
    (BLUE, "It identifies the local signals itself.",
     "Drop it in a new city and it works out the P25 system from your location + RadioReference, "
     "tunes in, and keeps the talkgroups current. No hand-config, no RF expertise required."),
    (GREEN, "Every node makes the whole thing smarter.",
     "The goal: get as many people running one as possible. Each is your own dashboard — and feeds "
     "a larger, shared dataset. More ears, more coverage, better situational awareness for everyone."),
]
_by = Inches(2.7)
for _col, _lead, _body in _blk:
    rect(s, Inches(0.6), _by, Inches(0.14), Inches(1.2), _col)
    txt(s, Inches(0.95), _by - Inches(0.05), Inches(11.6), Inches(1.3),
        [[R(_lead, 20, WHITE, True, SANS)], [R(_body, 15, GREY, False, SANS)]],
        space_after=5, line_spacing=1.14)
    _by = _by + Inches(1.6)
rect(s, Inches(0.6), Inches(6.05), Inches(12.13), Inches(0.62), BG2, line=AMBER, line_w=Pt(1.5))
txt(s, Inches(0.6), Inches(6.05), Inches(12.13), Inches(0.62),
    [[R("Complete situational awareness — what's actually happening in and around you.", 17, AMBER, True, SANS)]],
    align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
notes(s, "This isn't just for the Lower Rio Grande Valley — it started there, but you can use it "
         "anywhere. It identifies the signals based on your location and RadioReference, and it "
         "keeps them updated. I built it locally, but the idea is to get as many people as possible "
         "setting one of these up — to give themselves a dashboard, but also to contribute to the "
         "larger dataset. One of the great things it does is give you complete situational "
         "awareness — understanding what's happening in and around your environment.")

# ======================================================================
# SLIDE — IN THE WILD (real use cases)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "IN THE WILD", "What I actually use it for")
txt(s, Inches(0.6), Inches(1.72), Inches(12.1), Inches(0.5),
    [[R("Not theoretical — it's wired into real workflows today.", 17, GREY, False, SANS)]])
_cw = Inches(5.95); _gap = Inches(0.23)
_cards = [
    (BLUE, "POLITIQUERA.COM", "Political consulting",
     "I pull JAFO's incident feed into the site to flag anything happening at the polling places "
     "we're watching across Texas — in real time, on election day."),
    (GREEN, "NEIGHBORHOOD GUARD", "Community watch / security",
     "Real-time awareness of anything happening in and around our community, so the patrol knows "
     "exactly what to keep an eye out for."),
]
_cx = Inches(0.6)
for _col, _tag, _sub, _body in _cards:
    rect(s, _cx, Inches(2.4), _cw, Inches(3.45), BG2, line=_col, line_w=Pt(1.5))
    rect(s, _cx, Inches(2.4), _cw, Inches(0.9), _col)
    txt(s, _cx + Inches(0.25), Inches(2.5), _cw - Inches(0.5), Inches(0.75),
        [[R(_tag, 17, BG, True, MONO)], [R(_sub, 12, BG, False, SANS)]], space_after=2)
    txt(s, _cx + Inches(0.3), Inches(3.6), _cw - Inches(0.6), Inches(2.0),
        [[R(_body, 16, GREY, False, SANS)]], line_spacing=1.2)
    _cx = _cx + _cw + _gap
txt(s, Inches(0.6), Inches(6.15), Inches(12.1), Inches(0.5),
    [[R("Same box, same feed — ", 15, WHITE, True, SANS),
      R("a different situational-awareness lens for each.", 15, GREY, False, SANS)]])
notes(s, "What I'm using it for today: I integrate components of its dashboard into a website I do "
         "for political consulting, politiquera.com. It tells me if there are any incidents taking "
         "place at any of the polling places we're watching around the state of Texas. I also use "
         "it for my neighborhood guard-check security service — to let them know if there's anything "
         "happening in and around our community that they need to be on the lookout for.")

# ======================================================================
# SLIDE 9 — THE REAL POINT (curiosity / career)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "THE REAL POINT", "It was never really about the radio")
_blocks9 = [
    (BLUE, "Curiosity is the actual job.",
     "The half-life of any specific skill keeps shrinking. What doesn't go stale is staying "
     "curious and staying informed — that's the career skill sitting underneath all the others."),
    (AMBER, "A weird side project is a serious move.",
     "Listening to public-safety radio on a $200 Pi keeps your hands in the real work while the "
     "titles, the tools, and the org charts keep reshuffling around you."),
    (GREEN, "Passion is cheap until you build it.",
     "Curiosity only gets meaningful the moment you turn it into a thing. The building is the "
     "point — not the idea, and not the intention to someday get around to it."),
]
_by = Inches(2.05)
for _col, _lead, _body in _blocks9:
    rect(s, Inches(0.6), _by, Inches(0.14), Inches(1.15), _col)
    txt(s, Inches(0.95), _by - Inches(0.05), Inches(11.5), Inches(1.35),
        [[R(_lead, 20, WHITE, True, SANS)],
         [R(_body, 15, GREY, False, SANS)]], space_after=5, line_spacing=1.14)
    _by = _by + Inches(1.5)
notes(s, "The radio is just the artifact. The real point: curiosity is the career skill. "
         "Specific skills keep going stale faster — staying curious and staying informed is what "
         "keeps you relevant. A weird side project keeps your hands in the real work while titles "
         "and tools shuffle around you. And passion only means something once you build the thing.")

# ======================================================================
# SLIDE 10 — CLOSING (AI / compounding / do more with less)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "CLOSING", "Every project feeds the next")
_blocks10 = [
    (BLUE, "It compounds.",
     "None of these projects happens without the one before it. Each idea-made-real hands the "
     "next one a part it already needs. One doesn't happen without the other."),
    (AMBER, "AI got the ideas out of my head.",
     "That's the real gift of the last two years — not the code. It's turning a concept into a "
     "working thing before I lose the thread, and learning how the software actually fits "
     "together along the way — the real version, not the diagram."),
    (GREEN, "Then you iterate — and do more with less.",
     "Every loop, the gap between “an idea” and “a thing that runs” gets shorter. That "
     "compounding is the edge — and it's available to anyone willing to stay curious."),
]
_by = Inches(1.95)
for _col, _lead, _body in _blocks10:
    rect(s, Inches(0.6), _by, Inches(0.14), Inches(1.15), _col)
    txt(s, Inches(0.95), _by - Inches(0.05), Inches(11.5), Inches(1.3),
        [[R(_lead, 20, WHITE, True, SANS)],
         [R(_body, 15, GREY, False, SANS)]], space_after=5, line_spacing=1.14)
    _by = _by + Inches(1.45)
rect(s, Inches(0.6), Inches(6.18), Inches(12.13), Inches(0.72), BG2, line=AMBER, line_w=Pt(1.5))
txt(s, Inches(0.6), Inches(6.18), Inches(12.13), Inches(0.72),
    [[R("Stay curious.   Build the thing.   Let it compound.", 20, AMBER, True, SANS)]],
    align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
notes(s, "What two years with AI taught me: every project I get involved in ends up benefiting "
         "the next one, and the next. One doesn't happen without the other. The real power of AI "
         "for me has been taking the ideas and concepts out of my head and actually doing "
         "something with them — turning them into real things. It helps me understand how software "
         "fits together, and it helps me iterate — to do more with less.")

# ======================================================================
# SLIDE 11 — CONTRIBUTE (community / the loop)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "CONTRIBUTE", "We can all contribute something")
_blocks11 = [
    (BLUE, "It starts by contributing something.",
     "Mine began as a hardware tool — WifiStand — something the whole industry could pick up and "
     "actually use. It's since merged into things like the Wi-Fi toolkit Keith just shipped."),
    (AMBER, "It doesn't have to be physical.",
     "An idea others can benefit from, put out into the world, counts. It might feel small or too "
     "simple to you — that's not what matters."),
    (GREEN, "Build for people, and it loops back.",
     "Building for a group that's into it is just more fun. They're appreciative, they're "
     "supportive, and they give you feedback — and that feedback becomes the next thing: for them, "
     "for a bigger audience, or for your own work and day-to-day."),
]
_by = Inches(1.95)
for _col, _lead, _body in _blocks11:
    rect(s, Inches(0.6), _by, Inches(0.14), Inches(1.15), _col)
    txt(s, Inches(0.95), _by - Inches(0.05), Inches(11.5), Inches(1.35),
        [[R(_lead, 20, WHITE, True, SANS)],
         [R(_body, 15, GREY, False, SANS)]], space_after=5, line_spacing=1.14)
    _by = _by + Inches(1.55)
notes(s, "This goes back to the idea that we can all contribute something. For me it started with "
         "WifiStand — a hardware tool everybody in our industry could use and benefit from. Over "
         "time that merged into things like the Wi-Fi toolkit Keith just came out with. It doesn't "
         "have to be physical — it could be an idea you think everyone can benefit from that you "
         "put out there. It might not seem like a lot to you, or it might seem simple, but it ends "
         "up being really fun — not just to build a product, but to build a product that "
         "contributes to a group of people. That group is appreciative and supportive. They give "
         "you feedback — and that might help you build something for them, which gives you an idea "
         "to build something for a greater population, or helps you build something that helps your "
         "work, your day-to-day, or makes you better at what you do.")

# ======================================================================
# SLIDE 12 — FINALE (start building · the ask · thank you)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
rect(s, Inches(6.9), 0, Inches(6.43), SH, BG2)                 # right panel
s.shapes.add_picture(LOGO, Inches(8.5), Inches(2.3), width=Inches(4.6))
rect(s, 0, 0, SW, Inches(0.12), BLUE)                          # top accent
rect(s, 0, Inches(1.05), Inches(0.22), Inches(1.0), AMBER)
txt(s, Inches(0.6), Inches(0.55), Inches(7), Inches(0.4),
    [[R("YOUR MOVE", 14, BLUE, True, MONO)]])
txt(s, Inches(0.55), Inches(1.0), Inches(7.8), Inches(1.0),
    [[R("So start building.", 46, WHITE, True, SANS)]])
txt(s, Inches(0.6), Inches(2.35), Inches(7.5), Inches(1.6),
    [[R("If you haven't started yet — ", 20, GREY, False, SANS),
      R("start", 20, AMBER, True, SANS),
      R(". The tools and the platforms are already out there. You just have to start somewhere.",
        20, GREY, False, SANS)]], line_spacing=1.2)
rect(s, Inches(0.6), Inches(4.15), Inches(7.55), Inches(1.3), BG2, line=BLUE_DK, line_w=Pt(1.25))
txt(s, Inches(0.8), Inches(4.3), Inches(7.15), Inches(1.0),
    [[R("Stuck? ", 15, AMBER, True, SANS),
      R("Ask me, ask Jerry, ask Keith", 15, WHITE, True, SANS),
      R(", ask anyone around you — we'll happily talk your ear off about how much fun we're "
        "having doing this.", 15, GREY, False, SANS)]], anchor=MSO_ANCHOR.MIDDLE, line_spacing=1.15)
txt(s, Inches(0.55), Inches(5.75), Inches(7.5), Inches(1.0),
    [[R("Thank you.", 40, AMBER, True, SANS)]])
txt(s, Inches(0.6), Inches(6.85), Inches(8), Inches(0.4),
    [[R("Drew Lentz  ·  KE5ZJO  ·  jafo.live", 12, GREY_DK, False, MONO)]])
notes(s, "So if you haven't started building yet — start building. Get into this and do something "
         "productive, because the tools and the platforms are out there. You just have to start "
         "somewhere. And if you need help, ask me, or ask Jerry, or ask Keith, or ask anybody "
         "around you — we'll be happy to talk your ears off about how much fun we're having doing "
         "this. Thank you.")

prs.save(OUT)
print("saved", OUT, "slides:", len(prs.slides._sldIdLst))
