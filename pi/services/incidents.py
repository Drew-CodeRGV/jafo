"""
jafo — incidents & units model (enricher v2).

Each radio call is sent to Claude Haiku together with the incidents that are
currently open in its region. The model returns, in one structured-output
response:

  * a plain-English one-line summary of the transmission (`call_line`)
  * the verbatim transcript split into speaker turns
  * private substrings to hide from the public (house numbers, phones, plates…)
  * radio codes heard and what they mean
  * the units heard and the status each one is reporting
  * whether this call belongs to an open incident, starts a new one, or neither
  * the updated incident title + rolling summary

`apply_result()` then folds that into the `incidents`, `units`, `unit_events`
and `radio_ids` tables. `sweep()` closes incidents that have gone quiet.

Everything here is pure DB + HTTP plumbing; the Anthropic client is passed in
by the caller (enricher.py, backfill_incidents.py).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

TZ = ZoneInfo(os.environ.get("JAFO_TZ", "America/Chicago"))
MODEL = "claude-haiku-5-5"
MAX_TOKENS = 6000            # thinking (low effort) + JSON; output is ~300-900 tokens

KINDS = ["violence", "traffic", "medical", "property", "suspicious", "fire", "other"]
SERVICES = ["police", "fire", "ems", "other"]
UNIT_STATUSES = ["dispatched", "en_route", "on_scene", "transporting", "busy",
                 "available", "unknown"]
SEVERITIES = ["low", "medium", "high", "critical", "unknown"]

CANDIDATE_WINDOW_SEC = 90 * 60     # incidents eligible for attachment
QUIET_CLOSE_SEC = 45 * 60          # close an incident this long after its last call
CLEARED_CLOSE_SEC = 10 * 60        # ...or this long after every unit cleared
UNIT_STALE_SEC = 6 * 3600          # a unit not heard for this long drops off "out"

# -----------------------------------------------------------------------------
# Region grounding. Compact on purpose: it rides on every request (cached).
# -----------------------------------------------------------------------------
REGION_CONTEXT = {
    "rgv": """Region: Lower Rio Grande Valley (RGV), deep South Texas, on the US-Mexico border. \
Radio system: LRGVRRS (P25).
Cities (Hidalgo County): McAllen, Edinburg, Pharr, Mission, San Juan, Alamo, Donna, Weslaco, \
Mercedes, Hidalgo, Alton, Palmview, Penitas (Peñitas), La Joya, Sullivan City, Progreso, Elsa, Edcouch, La Villa, \
Monte Alto, La Homa, Las Milpas, Granjeno, Abram, Citrus City, Linn, Faysville, Hargill, Lopezville, Olivarez.
Cities (Cameron County): Brownsville, Harlingen, San Benito, La Feria, Los Fresnos, Port Isabel, \
South Padre Island, Olmito, Combes, Primera, Rio Hondo. Starr County: Rio Grande City, Roma, La Grulla. \
Willacy County: Raymondville, Lyford, San Perlita.
Highways: Expressway 83 / I-2 / US-83 (east-west); Expressway 281 / I-69E / US-281 / US-77 (north-south); \
US-83 Business; Military Hwy (FM 1016); FM 1015, FM 494, FM 2557, FM 88, FM 676.
McAllen streets: 23rd St, 10th St, 2nd St, Ware Rd, Bicentennial Blvd, Nolana Ave, Trenton Rd, \
Dove Ave, Pecan Blvd, Business 83, La Vista, Jackson Ave.
Agencies: HCSO (Hidalgo County SO), MPD (McAllen PD), EPD (Edinburg PD), Pharr PD, Mission PD, \
Harlingen PD/FD, Brownsville PD/FD, DPS, Border Patrol (USBP), McAllen Fire, Hidalgo County fire/EMS.""",
    "austin": """Region: Greater Austin / Travis County, Central Texas. Radio system: GATRRS (P25).
Cities: Austin, Round Rock, Pflugerville, Cedar Park, Leander, Georgetown, Manor, Del Valle, \
Lakeway, Bee Cave, West Lake Hills, Sunset Valley, Buda, Kyle, San Marcos, Hutto, Taylor.
Highways: I-35, MoPac (Loop 1), US-183 / Research Blvd, SH-71 / Ben White Blvd, US-290, \
SH-130, SH-45, Loop 360 / Capital of Texas Hwy, FM 620, FM 1431, FM 973, Parmer Ln.
Agencies: APD (Austin Police), AFD (Austin Fire), ATCEMS (Austin-Travis County EMS, "Medic" units), \
TCSO (Travis County SO), WCSO, Round Rock PD/FD, Pflugerville PD, Cedar Park PD/FD, DPS, UT Police, \
Austin Water, Capital Metro.""",
}


def region_context(slug: str | None, name: str | None) -> str:
    return REGION_CONTEXT.get(slug or "", f"Region: {name or os.environ.get('JAFO_REGION', 'Texas')}.")


# -----------------------------------------------------------------------------
# Prompt + output schema
# -----------------------------------------------------------------------------
SYSTEM_TEMPLATE = """You turn public-safety radio traffic into a clear, accurate public picture of \
what is happening in a city, the way a sharp local dispatcher would explain it to a neighbor.

You get ONE radio transmission (machine-transcribed, so names and streets are often misheard) \
plus the incidents that are currently open in the region and the units recently heard.

{region}

Rules:
- Ground everything in the transcript. Never invent units, places, injuries or events. If a field \
is unknown use null / [] / "unknown".
- Correct obvious transcription errors in place names and agency names using the region notes \
(e.g. "no lana" -> "Nolana"), but only for things that were actually said.
- call_line: ONE plain-English sentence (max ~160 chars) saying what this transmission means, in \
third person, with radio codes translated ("Engine 2 arrived on scene.", "Dispatch sent Charlie 62 \
and Charlie 66 to a domestic disturbance where a man has a kitchen knife."). No civilian names, \
phone numbers, plates, dates of birth, house numbers or radio ID numbers. Never write meta-commentary \
about the transcript ("the transcript is garbled", "no event is described", "unclear transmission"): just \
say plainly what was audible ("Dispatch called Medic 7.", "A unit asked dispatch to repeat."). For pure \
acks/noise use a short line like "Unit 43 acknowledged." and set chatter=true.
- speakers: the transcript split into turns, verbatim (light cleanup only). who = the callsign of the \
unit talking, or "Dispatch" (prefix with the agency/area if known, e.g. "Harlingen Fire dispatch"), or \
just "Unit" when unknown — never a radio ID number. Use the "Radios heard" hints: a radio ID with a known \
label is probably that speaker.
- self_id: the callsign of the unit transmitting if it identifies itself as the speaker ("Engine 2 is \
en route" said BY Engine 2), else null. Never put Dispatch here.
- redact: exact substrings of the transcript (copied character-for-character) that must be hidden from \
the public: civilian names, residential house/apartment numbers, phone numbers, dates of birth, \
license plates, driver-license/ID/SSN numbers, case numbers tied to a person. Officer callsigns, \
business names, block-level streets and intersections are fine.
- codes: radio/10-codes or signal codes heard, with a short plain meaning (2-6 words, e.g. \
"10-97" -> "Arrived on scene"). Only include codes whose meaning you are confident of; omit the rest.
- units: every unit/apparatus mentioned, using a consistent callsign. Only real callsigns (an apparatus \
type or officer ID WITH its number: "Medic 3", "Engine 2", "Ladder 5", "Charlie 62", "L-604", "Unit 247"). \
Radio channels are NOT units ("Ground 2", "Fireground 3", "TAC 1", "Main"), nor are bare words like \
"Engine" or "Medic" with no number. Speech-to-text often mangles "Medic" as "Matic"/"Manex"/"Medics" — \
fix those (reuse the exact spelling from \
"Units recently heard" when it is the same unit), with the status THIS transmission implies for it: \
dispatched (assigned), en_route, on_scene (arrived/10-97/10-23), transporting (to hospital/jail), \
busy (on a traffic stop/report/out of service), available (clear/10-8/back in service), unknown.
- location: the street address/intersection/landmark as said (corrected). Split it into house_number \
(digits only), street, cross_street, place (business/landmark), city. These are used to place a map \
pin at block level; the house number is never shown publicly.
- incident decision:
  * "attach" + id when this call is clearly about one of the open incidents (same address/area, same \
units working it, a follow-up such as arrival, update, transport, clearing). Prefer attaching \
follow-ups: units arriving, "show me on scene", "code 4", patient updates all belong to the incident \
those units are working.
  * "new" when this transmission dispatches or reports a distinct real-world event not in the list. \
Any unit sent/assigned to an address, business or intersection is an event (a call for service, noise \
complaint, alarm, crash, fire, pursuit, medical call, traffic stop with a location). Fireground \
operations (tank water, foam, hose lines, ventilation) mean an active fire: attach to it or start one.
  * "none" for chatter with no event, records/warrant/license checks, admin traffic, tests, \
and anything you cannot tie to an event.
- incident_title (for attach/new): short headline, max ~50 chars, plain English, no PII \
("Domestic dispute involving knife", "Fall with neck pain", "Two-vehicle crash with injuries"). \
Keep the existing title unless this call meaningfully changes the picture.
- incident_summary (for attach/new): 1-3 sentences summarizing the WHOLE incident so far (the \
existing summary plus what this call adds). No civilian names, plates, phones or house numbers.
- kind: violence (weapons, assault, shots, robbery, domestic with violence), traffic (crashes, \
road hazards, traffic stops, pursuits), medical (EMS, falls, overdoses, welfare/mental health), \
property (theft, burglary, alarms, vandalism), suspicious (suspicious persons/vehicles, disputes, \
disturbances, noise), fire (fires, smoke, gas, hazmat), other.
- people / vehicles: involved parties as roles + descriptions WITHOUT names or plates \
("Subject - armed with a kitchen knife", "White sedan - several weapons reported inside").
- severity: low | medium | high | critical | unknown.
- type: short category such as "Traffic Stop", "MVA", "Disturbance", "Domestic", "Medical", "Fire", \
"Suspicious Person", "Welfare Check", "Theft", "Burglary", "Pursuit", "Arrest", "Alarm", \
"Status Update", "Records Check", "Radio Chatter", "Other"."""


def _nullable(t: dict) -> dict:
    return {"anyOf": [t, {"type": "null"}]}


_STR = {"type": "string"}

OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["chatter", "type", "kind", "service", "severity", "call_line", "speakers",
                 "self_id", "redact", "codes", "units", "location", "incident",
                 "incident_title", "incident_summary", "people", "vehicles"],
    "properties": {
        "chatter": {"type": "boolean"},
        "type": _STR,
        "kind": {"type": "string", "enum": KINDS},
        "service": {"type": "string", "enum": SERVICES},
        "severity": {"type": "string", "enum": SEVERITIES},
        "call_line": _STR,
        "speakers": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["who", "text"],
            "properties": {"who": _STR, "text": _STR}}},
        "self_id": _nullable(_STR),
        "redact": {"type": "array", "items": _STR},
        "codes": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["code", "meaning"],
            "properties": {"code": _STR, "meaning": _STR}}},
        "units": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["callsign", "status", "service", "role"],
            "properties": {
                "callsign": _STR,
                "status": {"type": "string", "enum": UNIT_STATUSES},
                "service": {"type": "string", "enum": SERVICES},
                "role": _nullable(_STR)}}},
        "location": {
            "type": "object", "additionalProperties": False,
            "required": ["as_said", "house_number", "street", "cross_street", "place", "city"],
            "properties": {
                "as_said": _nullable(_STR), "house_number": _nullable(_STR),
                "street": _nullable(_STR), "cross_street": _nullable(_STR),
                "place": _nullable(_STR), "city": _nullable(_STR)}},
        "incident": {
            "type": "object", "additionalProperties": False, "required": ["action", "id"],
            "properties": {
                "action": {"type": "string", "enum": ["attach", "new", "none"]},
                "id": _nullable({"type": "integer"})}},
        "incident_title": _nullable(_STR),
        "incident_summary": _nullable(_STR),
        "people": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["role", "desc"],
            "properties": {"role": _STR, "desc": _STR}}},
        "vehicles": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["desc", "note"],
            "properties": {"desc": _STR, "note": _nullable(_STR)}}},
    },
}


# -----------------------------------------------------------------------------
# Small helpers
# -----------------------------------------------------------------------------
def callsign_key(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r"\s+", " ", s)


def fmt_local(ts: int | None) -> str:
    if not ts:
        return "?"
    return datetime.fromtimestamp(ts, TZ).strftime("%-I:%M %p").lower()


def block_label(house_number: str | None) -> str | None:
    if not house_number:
        return None
    m = re.match(r"\d+", str(house_number).strip())
    if not m:
        return None
    n = int(m.group(0))
    base = (n // 100) * 100
    return "Unit block" if base == 0 else f"{base} block"


def public_location(loc: dict) -> tuple[str | None, str | None]:
    """Return (public location text, precision) — never exposes a house number."""
    street = (loc.get("street") or "").strip() or None
    cross = (loc.get("cross_street") or "").strip() or None
    place = (loc.get("place") or "").strip() or None
    city = (loc.get("city") or "").strip() or None
    blk = block_label(loc.get("house_number"))
    if street and blk:
        return f"{blk} of {street}", "block"
    if street and cross:
        return f"{street} & {cross}", "intersection"
    if place:
        return place + (f", {street}" if street else ""), "place"
    if street:
        return street, "street"
    if city:
        return city, "city"
    return None, None


def apply_redactions(text: str | None, redact: list[str]) -> str | None:
    """Replace private substrings with ⟦…⟧ markers the UI renders as a blur."""
    if not text:
        return text
    out = text
    for r in sorted({r for r in redact if r and len(r.strip()) >= 2}, key=len, reverse=True):
        out = out.replace(r, "⟦" + "•" * min(len(r), 12) + "⟧")
    return out


def _call_srcs(metadata_json: str | None) -> list[int]:
    try:
        md = json.loads(metadata_json or "{}")
    except Exception:
        return []
    out = []
    for s in md.get("srcList") or []:
        src = s.get("src")
        if isinstance(src, int) and src > 0 and src not in out:
            out.append(src)
    return out


# -----------------------------------------------------------------------------
# Geocoding (Nominatim, region-bounded, cached in geocoded_locations)
# -----------------------------------------------------------------------------
_NOMINATIM_LOCK = threading.Lock()
_NOMINATIM_LAST = 0.0
NOMINATIM_HEADERS = {"User-Agent": "jafo/1.0 (public-safety radio observatory; +https://github.com/Drew-CodeRGV/jafo)"}


def _region_viewbox(region: dict) -> str:
    n, s, e, w = (region.get("bbox_north"), region.get("bbox_south"),
                  region.get("bbox_east"), region.get("bbox_west"))
    if None in (n, s, e, w):
        lat, lng = region.get("default_lat") or 0, region.get("default_lng") or 0
        n, s, e, w = lat + 0.7, lat - 0.7, lng + 0.8, lng - 0.8
    return f"{w},{n},{e},{s}"


def geocode(conn, region: dict, query: str) -> tuple[float, float] | None:
    global _NOMINATIM_LAST
    q = (query or "").strip()
    if len(q) < 4:
        return None
    key = f"{region.get('slug')}|{q.lower()}"
    row = conn.execute("SELECT lat, lng FROM geocoded_locations WHERE location_text = ?", (key,)).fetchone()
    if row:
        return (row["lat"], row["lng"]) if row["lat"] is not None else None
    with _NOMINATIM_LOCK:
        wait = 1.1 - (time.time() - _NOMINATIM_LAST)
        if wait > 0:
            time.sleep(wait)
        _NOMINATIM_LAST = time.time()
    coords = None
    err = None
    try:
        r = requests.get("https://nominatim.openstreetmap.org/search",
                         params={"q": q, "format": "json", "limit": 1, "countrycodes": "us",
                                 "viewbox": _region_viewbox(region), "bounded": 1},
                         headers=NOMINATIM_HEADERS, timeout=8)
        r.raise_for_status()
        res = r.json() or []
        if res:
            coords = (float(res[0]["lat"]), float(res[0]["lon"]))
    except Exception as e:  # network errors are cached briefly as misses
        err = str(e)[:200]
    conn.execute("INSERT OR REPLACE INTO geocoded_locations (location_text, lat, lng, source, error, created_at) "
                 "VALUES (?, ?, ?, 'nominatim', ?, ?)",
                 (key, coords[0] if coords else None, coords[1] if coords else None, err, int(time.time())))
    return coords


_AGENCY_WORDS = re.compile(r"\b(fire|fd|pd|police|ems|sheriff|so|dispatch|dept|department|rescue|"
                           r"public safety|ops|operations|disp|marshal|constable)\b", re.I)


def clean_city(c: str | None) -> str:
    c = _AGENCY_WORDS.sub(" ", c or "")
    return re.sub(r"\s+", " ", c).strip(" ,-")


def geocode_location(conn, region: dict, loc: dict) -> tuple[float, float, str] | None:
    """Try progressively coarser queries: block address, intersection, place,
    street (with and without city), then the city itself as a rough pin."""
    city = clean_city(loc.get("city") or loc.get("city_hint"))
    suffix = ", ".join(x for x in [city, "Texas"] if x)
    street = (loc.get("street") or "").strip()
    cross = (loc.get("cross_street") or "").strip()
    place = (loc.get("place") or "").strip()
    attempts = []
    m = re.match(r"\d+", str(loc.get("house_number") or ""))
    if street and m:
        n = int(m.group(0))
        attempts.append((f"{max((n // 100) * 100, 1) + 50} {street}, {suffix}", "block"))
    if street and cross:
        attempts.append((f"{street} & {cross}, {suffix}", "intersection"))
        attempts.append((f"{street} and {cross}, {suffix}", "intersection"))
    if place:
        attempts.append((f"{place}, {suffix}", "place"))
    if street:
        attempts.append((f"{street}, {suffix}", "street"))
        if city:
            attempts.append((f"{street}, Texas", "street"))
    if city:
        attempts.append((f"{city}, Texas", "city"))
    for q, precision in attempts:
        c = geocode(conn, region, q)
        if c:
            return c[0], c[1], precision
    return None


# -----------------------------------------------------------------------------
# Context gathering
# -----------------------------------------------------------------------------
_TG_CACHE: dict[str, tuple[float, dict]] = {}


def talkgroup_meta(region_slug: str | None) -> dict[int, dict]:
    """{tg: {name, desc, tag, city}} from DATA_DIR/config/talkgroups-<slug>.csv
    (hub) or the node's active talkgroups.csv (edge). Re-read every 10 min."""
    import csv
    from common import DATA_DIR
    paths = []
    if region_slug:
        paths.append(DATA_DIR / "config" / f"talkgroups-{region_slug}.csv")
    paths.append(DATA_DIR / "config" / "talkgroups.csv")
    for p in paths:
        if not p.exists():
            continue
        key = str(p)
        hit = _TG_CACHE.get(key)
        if hit and time.time() - hit[0] < 600:
            return hit[1]
        out = {}
        try:
            for r in csv.DictReader(open(p, newline="", encoding="utf-8", errors="replace")):
                try:
                    out[int(r.get("Decimal") or 0)] = {
                        "name": (r.get("Alpha Tag") or "").strip(),
                        "desc": (r.get("Description") or "").strip(),
                        "tag": (r.get("Tag") or "").strip(),
                        "city": (r.get("Category") or "").strip(),
                    }
                except ValueError:
                    pass
        except OSError:
            continue
        _TG_CACHE[key] = (time.time(), out)
        return out
    return {}


def load_region(conn, region_id: int | None) -> dict:
    if region_id:
        r = conn.execute("SELECT * FROM regions WHERE id = ?", (region_id,)).fetchone()
        if r:
            return dict(r)
    return {"id": region_id, "slug": None, "name": os.environ.get("JAFO_REGION")}


def candidate_incidents(conn, region_id, at: int, talkgroup: int | None, limit: int = 14):
    rows = conn.execute("""
        SELECT * FROM incidents
        WHERE (region_id IS ? OR region_id = ?)
          AND last_call_at >= ? AND first_call_at <= ?
        ORDER BY last_call_at DESC LIMIT 60
    """, (region_id, region_id, at - CANDIDATE_WINDOW_SEC, at + 60)).fetchall()
    tg = str(talkgroup) if talkgroup else None

    def score(r):
        same_tg = 1 if tg and tg in (r["talkgroups"] or "").split(",") else 0
        open_ = 1 if r["closed_at"] is None else 0
        return (open_, same_tg, r["last_call_at"])
    return sorted(rows, key=score, reverse=True)[:limit]


def incident_units(conn, incident_id: int) -> list[dict]:
    rows = conn.execute("""
        SELECT u.id, u.callsign, u.service, u.role, u.status, u.status_since, u.incident_id
        FROM units u
        WHERE u.id IN (SELECT DISTINCT unit_id FROM unit_events WHERE incident_id = ?)
        ORDER BY u.callsign
    """, (incident_id,)).fetchall()
    return [dict(r) for r in rows]


def recent_units(conn, region_id, at: int, limit: int = 40):
    return conn.execute("""
        SELECT callsign, status, incident_id FROM units
        WHERE (region_id IS ? OR region_id = ?) AND last_heard >= ?
        ORDER BY last_heard DESC LIMIT ?
    """, (region_id, region_id, at - 4 * 3600, limit)).fetchall()


def radio_labels(conn, region_id, srcs: list[int]) -> dict[int, str]:
    out = {}
    for src in srcs:
        row = conn.execute("""
            SELECT label, hits FROM radio_ids WHERE (region_id IS ? OR region_id = ?) AND src = ?
            ORDER BY hits DESC LIMIT 1
        """, (region_id, region_id, src)).fetchone()
        if row and row["hits"] >= 2:
            out[src] = row["label"]
    return out


def build_user_message(conn, call, region: dict) -> tuple[str, list, list[int]]:
    at = call["start_time"] or int(time.time())
    srcs = _call_srcs(call["metadata_json"])
    labels = radio_labels(conn, region.get("id"), srcs)
    cands = candidate_incidents(conn, region.get("id"), at, call["talkgroup"])
    lines = []
    meta = talkgroup_meta(region.get("slug")).get(call["talkgroup"] or -1, {})
    tg_name = call["talkgroup_tag"] or meta.get("name") or ""
    extra = " — ".join(x for x in [meta.get("desc"), meta.get("tag"), meta.get("city")] if x)
    lines.append(f"Talkgroup: {call['talkgroup']}" + (f" ({tg_name})" if tg_name else "")
                 + (f" [{extra}]" if extra else ""))
    lines.append(f"Time: {fmt_local(at)}")
    if srcs:
        lines.append("Radios heard (in order): " + ", ".join(
            f"{s}" + (f" = {labels[s]}" if s in labels else "") for s in srcs))
    units = recent_units(conn, region.get("id"), at)
    if units:
        lines.append("Units recently heard: " + "; ".join(
            f"{u['callsign']} ({u['status'] or '?'}"
            + (f", incident #{u['incident_id']}" if u["incident_id"] else "") + ")" for u in units))
    if cands:
        lines.append("Open/recent incidents:")
        for r in cands:
            us = ", ".join(f"{u['callsign']}:{u['status']}" for u in incident_units(conn, r["id"])
                           if u["incident_id"] == r["id"])
            lines.append(
                f"  #{r['id']} [{'closed' if r['closed_at'] else (r['status'] or 'new')}, "
                f"{fmt_local(r['first_call_at'])}-{fmt_local(r['last_call_at'])}, {r['call_count']} calls, "
                f"TG {r['talkgroups']}] {r['title']} | {r['location_text'] or 'location unknown'}"
                + (f" | units: {us}" if us else "")
                + (f" | {r['summary']}" if r["summary"] else ""))
    else:
        lines.append("Open/recent incidents: none")
    lines.append("")
    lines.append(f"Transcript: {call['transcript']}")
    return "\n".join(lines), cands, srcs


# -----------------------------------------------------------------------------
# LLM call
# -----------------------------------------------------------------------------
class EnrichError(Exception):
    pass


def run_llm(client, region: dict, user_message: str) -> dict:
    system = SYSTEM_TEMPLATE.format(region=region_context(region.get("slug"), region.get("name")))
    resp = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_message}],
        output_config={"effort": "low",
                       "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )
    if resp.stop_reason == "refusal":
        raise EnrichError("refusal")
    if resp.stop_reason == "max_tokens":
        raise EnrichError("max_tokens")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        raise EnrichError(f"no text block (stop={resp.stop_reason})")
    return json.loads(text)


# -----------------------------------------------------------------------------
# Apply
# -----------------------------------------------------------------------------
def _upsert_unit(conn, region_id, u: dict, at: int) -> int | None:
    cs = (u.get("callsign") or "").strip()
    key = callsign_key(cs)
    if not key or key in ("dispatch", "unknown", "unit", "engine", "medic", "ladder", "truck",
                          "ground", "command", "main") or not re.search(r"\d", key) \
            or re.fullmatch(r"\d+ \d+", key) and "." in cs:
        return None
    row = conn.execute("SELECT id FROM units WHERE region_id IS ? AND callsign_key = ?",
                       (region_id, key)).fetchone()
    if row:
        conn.execute("""UPDATE units SET last_heard = MAX(COALESCE(last_heard,0), ?),
                        service = COALESCE(service, ?), role = COALESCE(role, ?) WHERE id = ?""",
                     (at, u.get("service"), u.get("role"), row["id"]))
        return row["id"]
    cur = conn.execute("""INSERT INTO units (region_id, callsign, callsign_key, service, role,
                          status, status_since, first_heard, last_heard)
                          VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)""",
                       (region_id, cs, key, u.get("service"), u.get("role"), at, at))
    return cur.lastrowid


def _derive_incident_status(conn, incident_id: int) -> str:
    rows = conn.execute("SELECT status FROM units WHERE incident_id = ?", (incident_id,)).fetchall()
    st = {r["status"] for r in rows}
    if st & {"on_scene", "transporting"}:
        return "on_scene"
    if st & {"dispatched", "en_route"}:
        return "en_route"
    had_units = conn.execute("SELECT 1 FROM unit_events WHERE incident_id = ? LIMIT 1",
                             (incident_id,)).fetchone()
    return "cleared" if had_units else "new"


def apply_result(conn, call, region: dict, res: dict, cands, srcs: list[int]) -> int | None:
    now = int(time.time())
    at = call["start_time"] or now
    region_id = region.get("id")
    redact = [r for r in (res.get("redact") or []) if isinstance(r, str)]
    speakers = [{"who": s.get("who") or "?", "text": apply_redactions(s.get("text") or "", redact)}
                for s in (res.get("speakers") or [])]
    loc = dict(res.get("location") or {})
    if not loc.get("city"):
        tg_city = talkgroup_meta(region.get("slug")).get(call["talkgroup"] or -1, {}).get("city", "")
        if tg_city and not re.search(r"county|regional|state|texas|dps|federal|interop", tg_city, re.I):
            loc["city_hint"] = tg_city.strip()
    loc_public, precision = public_location(loc)

    # ---- incident decision ------------------------------------------------
    cand_ids = {r["id"] for r in cands}
    inc = res.get("incident") or {}
    action = inc.get("action")
    inc_id = inc.get("id") if action == "attach" and inc.get("id") in cand_ids else None
    if action == "attach" and inc_id is None:
        action = "new" if not res.get("chatter") else "none"

    unit_ids = []
    for u in res.get("units") or []:
        uid = _upsert_unit(conn, region_id, u, at)
        if uid:
            unit_ids.append((uid, u))

    if action == "none" and unit_ids:
        # Chatter that names units working an open incident joins it.
        for uid, _u in unit_ids:
            row = conn.execute("""SELECT i.id FROM units u JOIN incidents i ON i.id = u.incident_id
                                  WHERE u.id = ? AND i.closed_at IS NULL""", (uid,)).fetchone()
            if row:
                inc_id, action = row["id"], "attach"
                break

    if action == "new":
        cur = conn.execute("""INSERT INTO incidents (region_id, kind, service, type, title, summary,
                severity, location_text, street, cross_street, city, geo_precision, status,
                people_json, vehicles_json, first_call_at, last_call_at, call_count, talkgroups, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, 0, ?, ?)""",
            (region_id, res.get("kind"), res.get("service"), res.get("type"),
             (res.get("incident_title") or res.get("type") or "Incident")[:90],
             res.get("incident_summary"), res.get("severity"), loc_public, loc.get("street"),
             loc.get("cross_street"), loc.get("city"), precision,
             json.dumps(res.get("people") or []), json.dumps(res.get("vehicles") or []),
             at, at, str(call["talkgroup"] or ""), now))
        inc_id = cur.lastrowid
        _geocode_incident(conn, region, inc_id, loc)
    elif action == "attach" and inc_id:
        row = conn.execute("SELECT * FROM incidents WHERE id = ?", (inc_id,)).fetchone()
        tgs = [t for t in (row["talkgroups"] or "").split(",") if t]
        if call["talkgroup"] and str(call["talkgroup"]) not in tgs:
            tgs.append(str(call["talkgroup"]))
        people = _merge_list(row["people_json"], res.get("people"), "desc")
        vehicles = _merge_list(row["vehicles_json"], res.get("vehicles"), "desc")
        sev_rank = {s: i for i, s in enumerate(["unknown", "low", "medium", "high", "critical"])}
        severity = max([row["severity"] or "unknown", res.get("severity") or "unknown"],
                       key=lambda s: sev_rank.get(s, 0))
        better_loc = loc_public and (row["location_text"] is None or
                                     _prec_rank(precision) > _prec_rank(row["geo_precision"]))
        conn.execute("""UPDATE incidents SET
                title = COALESCE(?, title), summary = COALESCE(?, summary), severity = ?,
                kind = CASE WHEN kind IS NULL OR kind = 'other' THEN ? ELSE kind END,
                people_json = ?, vehicles_json = ?, talkgroups = ?, closed_at = NULL,
                last_call_at = MAX(last_call_at, ?), first_call_at = MIN(first_call_at, ?),
                updated_at = ? WHERE id = ?""",
            ((res.get("incident_title") or None) and res["incident_title"][:90],
             res.get("incident_summary") or None, severity, res.get("kind"),
             json.dumps(people), json.dumps(vehicles), ",".join(tgs), at, at, now, inc_id))
        if better_loc:
            conn.execute("""UPDATE incidents SET location_text = ?, street = ?, cross_street = ?,
                            city = COALESCE(?, city), geo_precision = ? WHERE id = ?""",
                         (loc_public, loc.get("street"), loc.get("cross_street"), loc.get("city"),
                          precision, inc_id))
            _geocode_incident(conn, region, inc_id, loc)

    # ---- units: status + events ------------------------------------------
    for uid, u in unit_ids:
        status = u.get("status") or "unknown"
        if status != "unknown":
            new_inc = inc_id if status in ("dispatched", "en_route", "on_scene", "transporting") else None
            prev = conn.execute("SELECT status, incident_id FROM units WHERE id = ?", (uid,)).fetchone()
            if status == "busy":
                new_inc = inc_id or prev["incident_id"]
            changed = (prev["status"] != status) or (new_inc and prev["incident_id"] != new_inc)
            conn.execute("""UPDATE units SET status = ?, incident_id = ?, location_text = COALESCE(?, location_text),
                            status_since = CASE WHEN ? THEN ? ELSE status_since END WHERE id = ?""",
                         (status, new_inc if status != "available" else None, loc_public,
                          1 if changed else 0, at, uid))
            if prev["incident_id"] and prev["incident_id"] != new_inc:
                _refresh_status(conn, prev["incident_id"])
        conn.execute("""INSERT INTO unit_events (unit_id, call_id, incident_id, status, at, location_text)
                        VALUES (?, ?, ?, ?, ?, ?)""",
                     (uid, call["id"], inc_id, status, at, loc_public))

    # ---- radio-ID learning ------------------------------------------------
    self_id = (res.get("self_id") or "").strip()
    if len(srcs) == 1:
        label = None
        if self_id and callsign_key(self_id) not in ("dispatch",):
            label = self_id
        elif speakers and len(speakers) == 1 and "dispatch" in speakers[0]["who"].lower():
            label = speakers[0]["who"]
        if label:
            conn.execute("""INSERT INTO radio_ids (region_id, src, label, hits, last_seen) VALUES (?, ?, ?, 1, ?)
                            ON CONFLICT(region_id, src, label) DO UPDATE SET hits = hits + 1, last_seen = excluded.last_seen""",
                         (region_id, srcs[0], label, at))

    # ---- call row --------------------------------------------------------
    units_str = ",".join(u.get("callsign", "") for u in res.get("units") or [])
    v1 = {"type": res.get("type"), "summary": res.get("call_line"), "location": loc_public or loc.get("as_said"),
          "units": [u.get("callsign") for u in res.get("units") or []], "severity": res.get("severity"),
          "persons_mentioned": [], "vehicles": [v.get("desc") for v in res.get("vehicles") or []],
          "v2": True}
    conn.execute("""UPDATE calls SET
            incident_id = ?, call_line = ?, call_kind = ?, call_service = ?, speakers_json = ?,
            redact_json = ?, codes_json = ?, radio_srcs = ?, enriched_v2_at = ?, enrich_v2_error = NULL,
            incident_type = ?, incident_summary = ?, incident_location = ?, incident_units = ?,
            incident_severity = ?, incident_json = ?, enriched_at = ?, enrich_error = NULL
        WHERE id = ?""",
        (inc_id, res.get("call_line"), res.get("kind"), res.get("service"), json.dumps(speakers),
         json.dumps(redact), json.dumps(res.get("codes") or []), ",".join(str(s) for s in srcs), now,
         res.get("type"), apply_redactions(res.get("call_line"), redact), loc_public or loc.get("as_said"),
         units_str, res.get("severity") or "unknown", json.dumps(v1), now, call["id"]))
    if inc_id:
        conn.execute("UPDATE incidents SET call_count = (SELECT COUNT(*) FROM calls WHERE incident_id = ?) "
                     "WHERE id = ?", (inc_id, inc_id))
        _refresh_status(conn, inc_id)
    conn.commit()
    return inc_id


def _prec_rank(p: str | None) -> int:
    return {"block": 5, "intersection": 4, "place": 3, "street": 2, "city": 1}.get(p or "", 0)


def _merge_list(existing_json: str | None, new: list | None, key: str) -> list:
    try:
        cur = json.loads(existing_json or "[]")
    except Exception:
        cur = []
    seen = {callsign_key(x.get(key, "")) for x in cur}
    for x in new or []:
        k = callsign_key(x.get(key, ""))
        if k and k not in seen:
            cur.append(x)
            seen.add(k)
    return cur[:12]


def _geocode_incident(conn, region: dict, inc_id: int, loc: dict) -> None:
    try:
        g = geocode_location(conn, region, loc)
    except Exception:
        g = None
    if g:
        conn.execute("UPDATE incidents SET lat = ?, lng = ?, geo_precision = ? WHERE id = ?",
                     (g[0], g[1], g[2], inc_id))


def _refresh_status(conn, inc_id: int) -> None:
    conn.execute("UPDATE incidents SET status = ? WHERE id = ?",
                 (_derive_incident_status(conn, inc_id), inc_id))


def regeocode_missing(conn, hours: float = 48) -> int:
    """Retry placement for recent incidents without coordinates (uses the
    stored public location: block label, street, cross street, city)."""
    n = 0
    rows = conn.execute("""SELECT i.*, r.slug, r.name, r.bbox_north, r.bbox_south, r.bbox_east, r.bbox_west,
                                  r.default_lat, r.default_lng
                           FROM incidents i LEFT JOIN regions r ON r.id = i.region_id
                           WHERE i.lat IS NULL AND i.last_call_at >= ?""",
                        (int(time.time() - hours * 3600),)).fetchall()
    for r in rows:
        region = {k: r[k] for k in ("slug", "name", "bbox_north", "bbox_south", "bbox_east", "bbox_west",
                                    "default_lat", "default_lng")}
        m = re.match(r"(\d+) block of (.+)", r["location_text"] or "")
        loc = {"house_number": m.group(1) if m else None, "street": r["street"] or (m.group(2) if m else None),
               "cross_street": r["cross_street"], "city": r["city"],
               "place": (r["location_text"] if r["geo_precision"] == "place" else None)}
        if not loc["city"]:
            tg = (r["talkgroups"] or "").split(",")[0]
            if tg.isdigit():
                loc["city_hint"] = talkgroup_meta(r["slug"]).get(int(tg), {}).get("city")
        g = geocode_location(conn, region, loc)
        if g:
            conn.execute("UPDATE incidents SET lat = ?, lng = ?, geo_precision = ? WHERE id = ?",
                         (g[0], g[1], g[2], r["id"]))
            n += 1
    conn.commit()
    return n


def sweep(conn, now: int | None = None) -> int:
    """Close incidents that went quiet; release units still pinned to them."""
    now = now or int(time.time())
    rows = conn.execute("""
        SELECT id FROM incidents WHERE closed_at IS NULL AND (
            last_call_at < ? OR (status = 'cleared' AND last_call_at < ?))
    """, (now - QUIET_CLOSE_SEC, now - CLEARED_CLOSE_SEC)).fetchall()
    for r in rows:
        conn.execute("UPDATE incidents SET closed_at = ? WHERE id = ?", (now, r["id"]))
        conn.execute("""UPDATE units SET incident_id = NULL,
                        status = CASE WHEN status IN ('dispatched','en_route','on_scene','transporting') THEN 'unknown' ELSE status END
                        WHERE incident_id = ?""", (r["id"],))
    conn.commit()
    return len(rows)


# -----------------------------------------------------------------------------
# One-call entry point
# -----------------------------------------------------------------------------
PENDING_SQL = """
    SELECT id, transcript, talkgroup, talkgroup_tag, start_time, metadata_json, region_id
    FROM calls
    WHERE transcript IS NOT NULL AND enriched_v2_at IS NULL AND enrich_v2_error IS NULL
      AND status = 'kept' AND start_time >= ?
    ORDER BY start_time ASC
    LIMIT ?
"""

TRIVIAL_RE = re.compile(r"^[\W_]*(?:(?:10[- ]?4|copy|okay|ok|yes|yeah|go ahead|affirmative|thank you|thanks|"
                        r"roger|clear|negative|no)[\W_]*)+$", re.I)


def enrich_call(conn, client, call) -> int | None:
    region = load_region(conn, call["region_id"])
    transcript = (call["transcript"] or "").strip()
    srcs = _call_srcs(call["metadata_json"])
    if len(transcript) < 4 or TRIVIAL_RE.match(transcript):
        res = {"chatter": True, "type": "Radio Chatter", "kind": "other", "service": "other",
               "severity": "low", "call_line": "Acknowledgement." if transcript else "No speech.",
               "speakers": [{"who": "?", "text": transcript}] if transcript else [],
               "self_id": None, "redact": [], "codes": [], "units": [],
               "location": {}, "incident": {"action": "none", "id": None},
               "incident_title": None, "incident_summary": None, "people": [], "vehicles": []}
        return apply_result(conn, call, region, res, [], srcs)
    msg, cands, srcs = build_user_message(conn, call, region)
    res = run_llm(client, region, msg)
    return apply_result(conn, call, region, res, cands, srcs)
