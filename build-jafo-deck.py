#!/usr/bin/env python3
"""Generate the JAFO technical-overview deck (.pptx) for a ham/technical audience."""
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
import copy
import os

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


MEDIA = "docs/media"

def shot(slide, name, x, y, w=None, h=None, crop_top=0.0, crop_bottom=0.0, border=BLUE_DK):
    """Screenshot with a thin frame. Keeps aspect ratio (after cropping); give w or h.
    Returns (w, h) actually used, or None if the file is missing."""
    path = os.path.join(MEDIA, name)
    if not os.path.exists(path):
        print("missing screenshot, skipped:", path)
        return None
    from PIL import Image
    with Image.open(path) as im:
        iw, ih = im.size
    vis_h = ih * (1 - crop_top - crop_bottom)
    ratio = iw / vis_h
    if w is None:
        w = int(h * ratio)
    else:
        h = int(w / ratio)
    rect(slide, x - Inches(0.03), y - Inches(0.03), w + Inches(0.06), h + Inches(0.06),
         BG2, line=border, line_w=Pt(1.0))
    pic = slide.shapes.add_picture(path, x, y, width=w, height=h)
    if crop_top or crop_bottom:
        pic.crop_top = crop_top
        pic.crop_bottom = crop_bottom
        pic.width, pic.height = w, h
    return (w, h)


def caption(slide, x, y, w, text, col=GREY_DK, align=PP_ALIGN.LEFT):
    txt(slide, x, y, w, Inches(0.3), [[R(text, 10.5, col, False, MONO)]], align=align)


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
     [R("unencrypted public-safety radio, captured on a", 17, GREY, False, SANS)],
     [R("Raspberry Pi 5, told as plain-English stories.", 17, GREY, False, SANS)]],
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
    [[R("A Raspberry Pi ", 18, GREY, False, SANS),
      R("observatory for unencrypted public-safety radio", 18, WHITE, True, SANS),
      R(" in the RGV. It listens to the ", 18, GREY, False, SANS),
      R("Lower Rio Grande Valley Regional Radio System", 18, BLUE, True, SANS),
      R(" — a P25 Phase 1 trunked system across Hidalgo, Cameron, Willacy, Starr & Brooks counties.",
        18, GREY, False, SANS)]], line_spacing=1.1)
bullet(s, Inches(0.6), Inches(3.62), Inches(7.3), [
    ("Passive & receive-only.", "No transmit, no decryption — just what's already in the clear."),
    ("Police where it's in the clear", "— many PD dispatch channels are; some agencies encrypt. Plus fire, EMS, schools, constables, public works, and everyone's traffic patterns.", GREY),
    ("Edge + hub.", "The Pi (edge) captures and keeps only the last 4 hours of audio. The jafo.live hub is the system of record — 14 days of audio — and runs the heavy AI."),
    ("Built to put itself out of a job —", "advocacy for the City to publish a public CAD feed.", GREY),
], size=15)
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
notes(s, "What JAFO is today. It listens to the Lower Rio Grande Valley Regional Radio System — "
         "P25 Phase 1, trunked, five counties. It is passive and receive-only: no transmitting, no "
         "decryption, only what is already in the clear. It started as everything-on-one-box; now "
         "it's an edge + hub design. The Raspberry Pi at the edge captures the radio and keeps just "
         "the last four hours of audio. The cloud hub at jafo.live is the system of record — it keeps "
         "14 days of audio — and it runs the heavy AI: transcription and incident building. That "
         "keeps the Pi light and lets more than one node feed the same hub.")

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
    ("Incidents + units", "calls linked into stories, unit status tracked"),
    ("News stories + digests", "plain-English briefings"),
    ("Situational awareness", "radio + sky + ground, one live map"),
]
txt(s, rx + Inches(0.25), Inches(2.42), Inches(5.3), Inches(3.9),
    [[R("▸ ", 14, AMBER, True, SANS), R(a + "  ", 14.5, WHITE, True, SANS),
      R("— " + b, 13, GREY, False, SANS)] for a, b in _brain],
    space_after=13, line_spacing=1.05)
rect(s, Inches(0.6), Inches(6.5), Inches(12.13), Inches(0.42), BG2, line=GREEN, line_w=Pt(1.25))
txt(s, Inches(0.6), Inches(6.5), Inches(12.13), Inches(0.42),
    [[R("Captured on a Raspberry Pi at the edge — the heavy AI runs on the jafo.live hub.", 15, GREEN, True, SANS)]],
    align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
notes(s, "What it does: one script sets up a brand-new Raspberry Pi — it identifies where it is, "
         "reaches out to RadioReference, pulls in all the P25 data, sets itself up, builds the "
         "maps, reports live back to jafo.live, adds itself to the fleet, and starts reporting. It "
         "automatically identifies talkgroups, auto-transcribes, and builds news stories and "
         "digests. It gives you situational awareness combined with the airliners and helicopters "
         "flying overhead — plus access to rail, maritime, business VHF/UHF, and weather. The radios "
         "and capture live on the Raspberry Pi; transcription and incident building run on the "
         "jafo.live hub.")

# ======================================================================
# SLIDE — THE PIPELINE
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "THE PIPELINE", "RF in → searchable intel out")
stages = [
    ("RF CAPTURE", "trunk-recorder", "decode P25 control,\nrecord voice → WAV", BLUE, "$0", "EDGE · Pi"),
    ("FILTER", "Silero VAD + Opus", "drop 80–90% junk,\nencode, upload to hub", BLUE, "$0", "EDGE · Pi"),
    ("TRANSCRIBE", "Groq Whisper", "large-v3-turbo,\nEN/ES, ~1s latency", AMBER, "pay-as-you-go", "HUB · jafo.live"),
    ("ENRICH", "Claude Haiku 5.5", "enricher v2: incidents,\nunits, block, redaction", AMBER, "pay-as-you-go", "HUB · jafo.live"),
    ("SERVE", "Flask + nginx", "briefing, map, walls,\npush alerts, API", GREEN, "$0", "HUB + Pi"),
]
n = len(stages)
cw = Inches(2.28); gap = Inches(0.13)
x0 = Inches(0.6); y0 = Inches(2.15); ch = Inches(2.7)
for i, (t, sub, desc, col, cost, where) in enumerate(stages):
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
    txt(s, x, y0 - Inches(0.36), cw, Inches(0.3),
        [[R(where, 11, GREY_DK, True, MONO)]], align=PP_ALIGN.CENTER)
    if i < n - 1:
        ar = s.shapes.add_shape(MSO_SHAPE.RIGHT_ARROW,
                                x + cw - Inches(0.02), y0 + ch/2 - Inches(0.12),
                                gap + Inches(0.04), Inches(0.24))
        solid(ar, col)
txt(s, Inches(0.6), Inches(5.3), Inches(12.1), Inches(1.0),
    [[R("A call row is the spine.", 16, WHITE, True, SANS),
      R("  The Pi's processor inserts it and uploads the audio; on the hub the transcriber adds "
        "text and the enricher links it into an incident. NULL columns mean “stage not done "
        "yet,” so any service can crash and resume where it left off. SQLite in WAL mode on both ends.",
        16, GREY, False, SANS)]], line_spacing=1.12)
chip(s, Inches(0.6), Inches(6.3), Inches(2.9), Inches(0.62), "CALLS / DAY", "~6,000")
chip(s, Inches(3.7), Inches(6.3), Inches(2.9), Inches(0.62), "INCIDENTS / DAY", "~220", vcol=AMBER)
chip(s, Inches(6.8), Inches(6.3), Inches(2.9), Inches(0.62), "UNITS TRACKED", "~500")
chip(s, Inches(9.9), Inches(6.3), Inches(2.82), Inches(0.62), "AUDIO KEPT", "Pi 4 h · hub 14 d", vcol=GREEN)
notes(s, "The pipeline, left to right. On the Pi: trunk-recorder follows the P25 control channel "
         "and records each voice call; Silero VAD throws away the 80 to 90 percent that's noise or "
         "too short, and the survivors are encoded to Opus and uploaded to the hub. On the hub: Groq "
         "runs Whisper large-v3-turbo for English and Spanish transcripts, and Claude Haiku 5.5 — "
         "what we call enricher v2 — turns each call into part of an incident. The capture stages "
         "cost nothing to run; the two AI stages are pay-as-you-go APIs. Real volume today: about "
         "6,000 calls a day, about 220 incidents a day, roughly 500 units tracked. The Pi keeps four "
         "hours of audio; the hub keeps fourteen days.")

# ======================================================================
# SLIDE 4 — THE FIVE SERVICES (detail)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "PIPELINE DETAIL · EDGE + HUB", "Five core services")
rows = [
    ("jafo-recorder", "Pi · trunk-recorder v5.2.x",
     "Decodes the P25 control channel, captures voice calls to WAV. Reads config.json.", "$0"),
    ("jafo-processor", "Pi · Silero VAD · ffmpeg/Opus",
     "Drops no-speech/too-short calls, encodes survivors to Opus 16 kHz mono 32 kbps, inserts the row, "
     "uploads to the hub. Keeps only the last 4 hours on the Pi.", "$0"),
    ("jafo-transcriber", "Hub · Groq Whisper",
     "Picks up calls with no transcript, sends the Opus to whisper-large-v3-turbo, writes text back. "
     "Bilingual EN/ES, ~0.3–1.0 s.", "pay-as-you-go"),
    ("jafo-enricher", "Hub · claude-haiku-5-5 (v2)",
     "One plain-English line per call; links it to a new or ongoing incident; tracks unit status; "
     "pins the block; explains radio codes; returns what to redact.", "pay-as-you-go"),
    ("jafo-web", "Hub + Pi · Flask ← nginx",
     "Briefing, Near me, Map, Console, wall displays, push alerts, search, audio streaming, JSON API.", "$0"),
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
    txt(s, Inches(11.0), yy + Inches(0.1), Inches(1.65), rh - Inches(0.2),
        [[R(cost, 12, (GREEN if cost == "$0" else AMBER), True, MONO)]],
        anchor=MSO_ANCHOR.MIDDLE, align=PP_ALIGN.RIGHT)
notes(s, "The five core services. Recorder and processor run on the Pi, next to the radios. "
         "Transcriber and enricher run on the jafo.live hub, so the Pi stays cool and light. The web "
         "app runs in both places: jafo.live for the public, jafo.local on the Pi for the same views "
         "on the local network. The enricher is the interesting one now — Claude Haiku 5.5, model "
         "claude-haiku-5-5. For every call it writes one plain-English line, decides whether the call "
         "belongs to an incident already in progress or starts a new one, updates unit status, pins "
         "the location to the block, explains radio codes, and hands back a list of private bits to "
         "redact. The two AI services are pay-as-you-go APIs.")

# ======================================================================
# SLIDE — FROM CALLS TO INCIDENTS (enricher v2)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "ENRICHER V2 · ON THE HUB", "From calls to incidents")
txt(s, Inches(0.6), Inches(1.68), Inches(6.4), Inches(0.4),
    [[R("Every transcribed call goes to ", 14, GREY, False, SANS),
      R("Claude Haiku 5.5", 14, AMBER, True, SANS),
      R(" with the incidents already open. It returns:", 14, GREY, False, SANS)]])
_v2 = [
    ("One plain-English line", "— what was actually said, without the jargon."),
    ("An incident link", "— joins an ongoing incident or opens a new one."),
    ("Unit status", "— who's dispatched, on the way, on scene, transporting, available."),
    ("A location, to the block", "— geocoded; the house number is never stored."),
    ("Radio codes explained", "— 10-codes and local shorthand, decoded."),
    ("A redact list", "— private substrings to scrub before anything is shown."),
]
txt(s, Inches(0.6), Inches(2.2), Inches(6.4), Inches(4.0),
    [[R("▸ ", 14, AMBER, True, SANS), R(a + " ", 14.5, WHITE, True, SANS),
      R(b, 13.5, GREY, False, SANS)] for a, b in _v2],
    space_after=9, line_spacing=1.05)
# unit status chain
_st = [("DISPATCHED", AMBER), ("ON THE WAY", BLUE), ("ON SCENE", RED),
       ("TRANSPORTING", GREEN), ("AVAILABLE", GREY)]
_sx = Inches(0.6); _sw = Inches(1.08); _sg = Inches(0.25)
for _i, (_lbl, _c) in enumerate(_st):
    rect(s, _sx, Inches(6.2), _sw, Inches(0.5), BG2, line=_c, line_w=Pt(1.25))
    txt(s, _sx, Inches(6.2), _sw, Inches(0.5), [[R(_lbl, 9.5, _c, True, MONO)]],
        align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    if _i < len(_st) - 1:
        txt(s, _sx + _sw, Inches(6.2), _sg, Inches(0.5), [[R("→", 13, GREY_DK, True, SANS)]],
            align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    _sx = _sx + _sw + _sg
# right: wall display + example
_r = shot(s, "wall-command.png", Inches(7.3), Inches(1.75), w=Inches(5.4))
if _r:
    caption(s, Inches(7.3), Inches(1.75) + _r[1] + Inches(0.06), Inches(5.4),
            "Command wall: incidents, units by status, radio volume")
rect(s, Inches(7.3), Inches(5.2), Inches(5.43), Inches(1.5), BG2, line=AMBER, line_w=Pt(1.5))
txt(s, Inches(7.5), Inches(5.3), Inches(5.05), Inches(1.35),
    [[R("EXAMPLE · FROM THE 12-HOUR BRIEFING", 10.5, AMBER, True, MONO)],
     [R("Large warehouse fire on South Weaver in McAllen", 16, WHITE, True, SANS)],
     [R("— twelve units, Rescue and Ladder. Dozens of radio calls, rolled into one story.",
        13.5, GREY, False, SANS)]], space_after=4, line_spacing=1.08)
notes(s, "This is the part that changed the most. The old enricher pulled a little JSON blob out of "
         "each call in isolation. Enricher v2 sees each call alongside the incidents that are "
         "already open. For every call, Claude Haiku 5.5 writes one plain-English line, decides "
         "whether the call belongs to something already going on or starts a new incident, updates "
         "the status of every unit it hears — dispatched, on the way, on scene, transporting, "
         "available — pins the location to the block, never the house number, explains the radio "
         "codes, and returns a list of private substrings to redact. The result: instead of "
         "hundreds of separate radio clips, you get stories like 'Large warehouse fire on South "
         "Weaver in McAllen — twelve units, Rescue and Ladder.' Today that's about 220 incidents a "
         "day out of about 6,000 calls, with roughly 500 units tracked.")

# ======================================================================
# SLIDE — JAFO LIVE (the public views)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "JAFO LIVE · jafo.live/live/<region>", "What you can get at")
_iy = Inches(1.72); _ih = Inches(2.75)
_x = Inches(0.6)
for _name, _cap in [("briefing-12h.png", "Briefing · 12-hour recap"),
                    ("console.png", "Console · pro view with River timeline"),
                    ("map-phone.png", "Map · phone")]:
    _r = shot(s, _name, _x, _iy, h=_ih)
    if _r:
        caption(s, _x, _iy + _ih + Inches(0.06), _r[0], _cap)
        _x = _x + _r[0] + Inches(0.22)
_views = [
    (BLUE, [("Briefing", "plain-English front page: Now / 4h / 8h / 12h / 24h recap of the biggest incidents"),
            ("Ranked by importance", "severity, units, radio volume, special resources (hazmat, air, rescue, ladder), duration")]),
    (AMBER, [("Near me", "stories around places you choose"),
             ("Map", "full screen — incidents, units, aircraft"),
             ("Console", "multi-pane pro view with a River timeline")]),
    (GREEN, [("Walls", "command · newsroom · grid · pulse · river"),
             ("Extras", "web push alerts, TxDOT camera stills, NWS weather, About & privacy page"),
             ("“N watching”", "city-level listener map; IPs never stored")]),
]
_cw = Inches(3.95); _gx = Inches(0.14)
for _i, (_c, _items) in enumerate(_views):
    _x = Inches(0.6) + _i * (_cw + _gx)
    rect(s, _x, Inches(4.92), Inches(0.08), Inches(1.65), _c)
    txt(s, _x + Inches(0.18), Inches(4.88), _cw - Inches(0.2), Inches(1.8),
        [[R(a + "  ", 12.5, WHITE, True, SANS), R(b, 11.5, GREY, False, SANS)] for a, b in _items],
        space_after=4, line_spacing=1.02)
txt(s, Inches(0.6), Inches(6.72), Inches(12.1), Inches(0.3),
    [[R("jafo.local", 11.5, BLUE, True, MONO),
      R("  on the Pi serves the same views on the local network.", 11.5, GREY, False, SANS)]])
notes(s, "This is what people actually see at jafo.live/live/<region>. The front door is the "
         "Briefing: a plain-English front page. Pick Now, 4, 8, 12 or 24 hours and it writes a recap "
         "of the biggest incidents, ranked by an importance score — severity, how many units, how "
         "much radio traffic, whether special resources like hazmat, air, rescue or a ladder truck "
         "went, and how long it lasted. Near me shows stories around places you pick. There's a "
         "full-screen map, and the Console — a pro, multi-pane view with a River timeline along "
         "the bottom. Five wall displays for TVs: command, newsroom, grid, pulse and river. Web push "
         "alerts, TxDOT camera stills, National Weather Service weather, a public About & privacy "
         "page, and an 'N watching' map that shows, city-level, where listeners are — from a local "
         "IP lookup; the IPs themselves are never stored. And jafo.local on the Pi shows the same "
         "views on your own network.")

# ======================================================================
# SLIDE — PRIVACY BY DESIGN
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "PRIVACY BY DESIGN", "Tell the story, not the person")
# left panel: what's hidden
rect(s, Inches(0.6), Inches(1.75), Inches(6.0), Inches(4.95), BG2, line=BLUE_DK, line_w=Pt(1.0))
txt(s, Inches(0.85), Inches(1.9), Inches(5.5), Inches(0.4),
    [[R("WHAT'S HIDDEN", 13, BLUE, True, MONO)]])
bullet(s, Inches(0.85), Inches(2.35), Inches(5.55), [
    ("House numbers →", "the block. “2200 block of South 10th Street,” never the address."),
    ("Personal details —", "names, phone numbers, SSNs, dates of birth, license plates, radio IDs."),
    ("ACARS crew names", "are scrubbed from aircraft messages."),
], size=14)
txt(s, Inches(0.85), Inches(4.45), Inches(5.5), Inches(0.4),
    [[R("TWO LAYERS", 13, BLUE, True, MONO)]])
txt(s, Inches(0.85), Inches(4.85), Inches(5.55), Inches(1.8),
    [[R("1  ", 14, AMBER, True, MONO), R("AI redact list", 14, WHITE, True, SANS),
      R(" — the model returns the private substrings in each call.", 13.5, GREY, False, SANS)],
     [R("2  ", 14, AMBER, True, MONO), R("Pattern scrub", 14, WHITE, True, SANS),
      R(" — regexes catch phone numbers, SSNs, plates, house numbers the model missed.",
        13.5, GREY, False, SANS)]], space_after=8, line_spacing=1.05)
# right column: three blocks
_pb = [
    (AMBER, "Sensitive calls are softened on walls.",
     "Self-harm, mental health, death, sexual assault, child abuse — wall displays show a gentler "
     "summary, since they run on TVs in public rooms."),
    (GREEN, "Encrypted channels are never touched.",
     "No decryption, no attempt. If it isn't in the clear, JAFO doesn't hear it."),
    (RED, "Honest limit: audio is not bleeped.",
     "Transcripts and summaries are scrubbed. The recording itself is the original radio call."),
]
_by = Inches(1.8)
for _c, _lead, _body in _pb:
    rect(s, Inches(6.95), _by, Inches(0.12), Inches(1.3), _c)
    txt(s, Inches(7.25), _by - Inches(0.05), Inches(5.5), Inches(1.45),
        [[R(_lead, 16, WHITE, True, SANS)], [R(_body, 13.5, GREY, False, SANS)]],
        space_after=4, line_spacing=1.1)
    _by = _by + Inches(1.68)
notes(s, "Privacy is built into the pipeline, not bolted on. Locations are block-level by design — "
         "the house number is never stored on an incident. Names, phone numbers, Social Security "
         "numbers, dates of birth, license plates and radio IDs are hidden, and crew names are "
         "scrubbed from ACARS. There are two layers: the model itself returns a redact list for "
         "every call, and then a pattern-based scrub runs as a safety net for anything it missed. "
         "Sensitive incidents — self-harm, mental health, death, sexual assault, child abuse — are "
         "softened on the wall displays, because those run on TVs. Encrypted channels are never "
         "touched. And to be honest about the limit: the audio is not bleeped. The text is "
         "scrubbed; the recording is the original radio call.")

# ======================================================================
# SLIDE — WHY IT'S LEGAL
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "WHY IT'S LEGAL", "Listening to what's in the clear")
txt(s, Inches(0.6), Inches(1.7), Inches(12.1), Inches(0.5),
    [[R("Public-safety radio that anyone with a scanner can hear is open to the public by law. "
        "Encrypted radio is not — and JAFO stays out of it.", 16, GREY, False, SANS)]],
    line_spacing=1.1)
_law = [
    (BLUE, "18 U.S.C. § 2511(2)(g)", "FEDERAL",
     "Permits intercepting radio from governmental, law-enforcement and public-safety systems "
     "that is readily accessible to the general public."),
    (AMBER, "18 U.S.C. § 2510(16)", "FEDERAL",
     "Defines “readily accessible”: scrambled or encrypted radio is not. So decrypting would "
     "be a different thing entirely."),
    (GREEN, "Tex. Penal Code § 16.02(c)", "TEXAS",
     "A similar Texas rule for radio readily accessible to the public. It treats police mobile "
     "data terminals differently — JAFO listens to voice only."),
]
_cw = Inches(3.95); _gap = Inches(0.14)
for _i, (_c, _cite, _tag, _body) in enumerate(_law):
    _x = Inches(0.6) + _i * (_cw + _gap)
    rect(s, _x, Inches(2.5), _cw, Inches(3.0), BG2, line=_c, line_w=Pt(1.5))
    rect(s, _x, Inches(2.5), _cw, Inches(0.12), _c)
    txt(s, _x + Inches(0.22), Inches(2.75), _cw - Inches(0.44), Inches(2.7),
        [[R(_tag, 11, _c, True, MONO)], [R(_cite, 18, WHITE, True, SANS)],
         [R(_body, 14, GREY, False, SANS)]], space_after=7, line_spacing=1.1)
rect(s, Inches(0.6), Inches(5.75), Inches(12.13), Inches(0.75), BG2, line=BLUE_DK, line_w=Pt(1.0))
txt(s, Inches(0.85), Inches(5.75), Inches(11.7), Inches(0.75),
    [[R("In practice:  ", 14, WHITE, True, SANS),
      R("receive-only, voice-only, no decryption, encrypted talkgroups skipped.  ", 14, GREY, False, SANS),
      R("Not legal advice.", 14, AMBER, True, SANS)]], anchor=MSO_ANCHOR.MIDDLE)
notes(s, "People always ask whether this is legal. The federal wiretap law has an explicit carve-out: "
         "18 U.S.C. 2511(2)(g) permits intercepting radio communications from governmental, law "
         "enforcement and public-safety systems that are readily accessible to the general public. "
         "And 2510(16) defines that term — scrambled or encrypted radio is not readily accessible. "
         "So listening in the clear is fine; breaking encryption would be a different matter, and "
         "JAFO never tries. Texas Penal Code 16.02(c) has a similar rule, and it treats police mobile "
         "data terminals differently — JAFO listens to voice only. This is the reasoning we publish "
         "on the About page. It's not legal advice.")

# ======================================================================
# SLIDE — THE SKY (ADS-B + ACARS)
# ======================================================================
s = prs.slides.add_slide(BLANK)
bg(s)
header(s, "THE SKY · ADS-B + ACARS", "One RTL-SDR, two jobs")
_sky = [
    (BLUE, "ADS-B — aircraft on the map.",
     "Popups show side-profile illustrations by aircraft type, in airline colours. Tracks are kept "
     "48 h. When the Pi's antenna sees nothing, a community feed fills in: adsb.lol → adsb.fi → "
     "airplanes.live."),
    (AMBER, "ACARS — decoded into plain English.",
     "“Took off from McAllen at 11:24 am, bound for Dallas–Fort Worth.”  “Position report: 53 mi "
     "southeast of Matamoros at 38,980 ft…”  Pings and machine data are hidden; crew names scrubbed."),
    (GREEN, "A smart time-share.",
     "45 s ADS-B / 10 s ACARS. It skips ACARS when no airliners are in range, and backs off to "
     "ADS-B legs of up to 6 minutes when ACARS is quiet."),
]
_by = Inches(1.8)
for _c, _lead, _body in _sky:
    rect(s, Inches(0.6), _by, Inches(0.12), Inches(1.25), _c)
    txt(s, Inches(0.9), _by - Inches(0.05), Inches(7.1), Inches(1.45),
        [[R(_lead, 17, WHITE, True, SANS)], [R(_body, 13.5, GREY, False, SANS)]],
        space_after=4, line_spacing=1.1)
    _by = _by + Inches(1.55)
chip(s, Inches(0.6), Inches(6.12), Inches(3.4), Inches(0.62), "ACARS ARCHIVED", "13,400 messages", vcol=AMBER)
chip(s, Inches(4.2), Inches(6.12), Inches(3.4), Inches(0.62), "AIRCRAFT TRACKS", "kept 48 hours")
# right: aircraft popup illustration + decoded ACARS strip (phone crops)
_ry = Inches(1.75); _rx = Inches(8.33); _rw = Inches(4.4)
_r = shot(s, "aircraft-profile.png", _rx, _ry, w=_rw, crop_top=0.737)
if _r:
    caption(s, _rx, _ry + _r[1] + Inches(0.06), _rw, "Aircraft popup · type + airline illustration")
    _ry = _ry + _r[1] + Inches(0.45)
_r = shot(s, "map-aircraft.png", _rx, _ry, w=_rw, crop_top=0.8846, crop_bottom=0.0096)
if _r:
    caption(s, _rx, _ry + _r[1] + Inches(0.06), _rw, "Air tab · decoded ACARS + time-share status")
notes(s, "The Pi has a second radio: one RTL-SDR that does two jobs. ADS-B puts aircraft on the "
         "map — the popups have side-profile illustrations by aircraft type in airline colours, and "
         "tracks are kept for 48 hours. If the Pi's antenna sees nothing, a community feed fills in, "
         "falling back from adsb.lol to adsb.fi to airplanes.live. ACARS is the text datalink "
         "airliners use, and JAFO decodes it into plain English: 'Took off from McAllen at 11:24 am, "
         "bound for Dallas–Fort Worth', or a position report 53 miles southeast of Matamoros at "
         "38,980 feet. Pings and machine data are hidden and crew names are scrubbed. The two share "
         "the radio on a smart time-share: 45 seconds of ADS-B, 10 of ACARS; it skips ACARS when no "
         "airliners are in range and backs off to ADS-B legs of up to six minutes when ACARS is "
         "quiet. About 13,400 ACARS messages are archived so far.")

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
    ("Raspberry Pi 5 (8 GB)", "+ official 27 W USB-C PSU"),
    ("Active cooling is mandatory —", "the production Pi runs at 72–78 °C.", RED),
    ("Powered USB hub —", "non-negotiable; SDRs draw too much for the Pi.", RED),
    ("256 GB+ SSD", "on an NVMe HAT (journal + DB + audio)"),
    ("800 MHz antenna", "mounted high — biggest single lever on decode"),
    ("One or more SDRs,", "auto-detected at install:"),
], size=14)
txt(s, Inches(0.95), Inches(5.3), Inches(5.9), Inches(1.7),
    [[R("Airspy R2 (P25) + RTL-SDR", 13, WHITE, True, MONO), R("   current RGV node", 12, AMBER, True, SANS)],
     [R("   RTL time-shared: ADS-B ⇄ ACARS (45 s / 10 s, smart)", 11.5, GREY, False, SANS)],
     [R("HackRF One + RTL-SDR", 13, WHITE, True, MONO), R("   standard config", 12, GREY, False, SANS)],
     [R("HackRF One + SDRplay RSP", 13, WHITE, True, MONO), R("   better dynamic range", 12, GREY, False, SANS)],
     [R("HackRF / RSP alone", 13, WHITE, True, MONO), R("   single-SDR mode", 12, GREY, False, SANS)]],
    space_after=3)
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
    [[R("Groq", 15, WHITE, True, SANS), R("  — Whisper large-v3-turbo transcription", 14, GREY, False, SANS)],
     [R("Anthropic", 15, WHITE, True, SANS), R("  — Claude Haiku 5.5 enrichment (v2)", 14, GREY, False, SANS)],
     [R("No keys? Capture + storage still run —", 13, GREY, False, SANS)],
     [R("you just lose transcripts & enrichment.", 13, GREY, False, SANS)]],
    space_after=5, line_spacing=1.05)
notes(s, "What it takes to run one. A Raspberry Pi 5 with the official power supply, and active "
         "cooling is not optional — the production Pi sits at 72 to 78 degrees C. A powered USB hub, "
         "an NVMe SSD, and the antenna, mounted high, matters more than anything else. The current "
         "RGV node runs an Airspy R2 for P25 and one RTL-SDR that time-shares between ADS-B and "
         "ACARS — 45 seconds of one, 10 of the other, skipping ACARS when nothing's in range. The "
         "other SDR combinations still work and are auto-detected at install. Two paid APIs, both "
         "pay-as-you-go: Groq for Whisper transcription and Anthropic for Claude Haiku 5.5. Without "
         "keys, capture and storage still run.")

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
