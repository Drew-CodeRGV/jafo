"""
Plain-English readings of ACARS messages.

ACARS is free-form per airline, so this decodes the formats we actually hear
over the Valley (OOOI gate/takeoff/landing reports, position reports, ramp and
weather requests, ATIS requests, crew free text) and gives everything else an
honest one-line description of what kind of message it is. Ground-station
pings and link tests are marked noise so the UI can hide them.

humanize(msg) -> {"tag": short label, "text": sentence, "noise": bool,
                  "detail": [(label, value)...]}   (never raises)
"""

from __future__ import annotations

import math
import os
import re
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    _TZ = ZoneInfo(os.environ.get("JAFO_TZ", "America/Chicago"))
except Exception:   # pragma: no cover
    _TZ = timezone.utc

AIRPORTS = {
    "KMFE": "McAllen", "KHRL": "Harlingen", "KBRO": "Brownsville", "KCRP": "Corpus Christi", "KLRD": "Laredo",
    "KIAH": "Houston Intercontinental", "KHOU": "Houston Hobby", "KDFW": "Dallas–Fort Worth", "KDAL": "Dallas Love",
    "KAUS": "Austin", "KSAT": "San Antonio", "KELP": "El Paso", "KLBB": "Lubbock", "KMAF": "Midland", "KAMA": "Amarillo",
    "KATL": "Atlanta", "KORD": "Chicago O'Hare", "KMDW": "Chicago Midway", "KDEN": "Denver", "KLAS": "Las Vegas",
    "KLAX": "Los Angeles", "KSFO": "San Francisco", "KPHX": "Phoenix", "KSEA": "Seattle", "KMSY": "New Orleans",
    "KMSP": "Minneapolis", "KDTW": "Detroit", "KJFK": "New York JFK", "KEWR": "Newark", "KLGA": "New York LaGuardia",
    "KMIA": "Miami", "KFLL": "Fort Lauderdale", "KMCO": "Orlando", "KTPA": "Tampa", "KCLT": "Charlotte", "KBNA": "Nashville",
    "KMEM": "Memphis", "KSDF": "Louisville", "KCVG": "Cincinnati", "KIAD": "Washington Dulles", "KBOS": "Boston",
    "KPHL": "Philadelphia", "KSLC": "Salt Lake City", "KSAN": "San Diego", "KONT": "Ontario", "KOAK": "Oakland",
    "KSTL": "St. Louis", "KMCI": "Kansas City", "KOKC": "Oklahoma City", "KTUL": "Tulsa", "KBHM": "Birmingham",
    "KILN": "Wilmington (Ohio)", "KRFD": "Rockford",
    "MMMX": "Mexico City", "MMSM": "Mexico City Felipe Ángeles", "MMMY": "Monterrey", "MMGL": "Guadalajara",
    "MMUN": "Cancún", "MMTJ": "Tijuana", "MMMD": "Mérida", "MMVR": "Veracruz", "MMVA": "Villahermosa",
    "MMTG": "Tuxtla Gutiérrez", "MMRX": "Reynosa", "MMMA": "Matamoros", "MMNL": "Nuevo Laredo", "MMTM": "Tampico",
    "MMPR": "Puerto Vallarta", "MMSD": "Los Cabos", "MMCP": "Campeche", "MMCU": "Chihuahua", "MMHO": "Hermosillo",
    "MMAA": "Acapulco", "MMZH": "Zihuatanejo", "MMOX": "Oaxaca", "MMPB": "Puebla", "MMQT": "Querétaro",
    "MMLO": "León/Bajío", "MMSP": "San Luis Potosí", "MMAS": "Aguascalientes", "MMTC": "Torreón", "MMCZ": "Cozumel",
    "MMCL": "Culiacán", "MMMZ": "Mazatlán", "MMCE": "Ciudad del Carmen", "MMDO": "Durango", "MMZC": "Zacatecas",
    "MMSL": "Cabo San Lucas", "MMMM": "Mexico", "MMFR": "Mexico airspace", "MMLP": "La Paz", "MMTO": "Toluca", "MMIO": "Saltillo",
    "MGGT": "Guatemala City", "MSLP": "San Salvador", "MHTG": "Tegucigalpa", "MROC": "San José (Costa Rica)",
    "MPTO": "Panama City", "EHAM": "Amsterdam", "EDDF": "Frankfurt", "EGLL": "London Heathrow", "LFPG": "Paris CDG",
    "CYYZ": "Toronto", "CYUL": "Montréal",
}
IATA = {k[1:]: v for k, v in AIRPORTS.items() if k.startswith("K")}
IATA.update({"MEX": "Mexico City", "MTY": "Monterrey", "GDL": "Guadalajara", "CUN": "Cancún"})

# reference points for "where is it" phrases
PLACES = [("McAllen", 26.20, -98.23), ("Harlingen", 26.19, -97.70), ("Brownsville", 25.90, -97.50),
          ("Edinburg", 26.30, -98.16), ("Rio Grande City", 26.38, -98.82), ("Raymondville", 26.48, -97.78),
          ("South Padre Island", 26.10, -97.17), ("Kingsville", 27.52, -97.86), ("Corpus Christi", 27.80, -97.40),
          ("Laredo", 27.53, -99.48), ("Zapata", 26.91, -99.27), ("Falfurrias", 27.23, -98.14),
          ("Victoria", 28.81, -97.00), ("San Antonio", 29.42, -98.49), ("Houston", 29.76, -95.37),
          ("Reynosa", 26.08, -98.29), ("Matamoros", 25.87, -97.50), ("Monterrey", 25.69, -100.32),
          ("San Fernando", 24.85, -98.15), ("Ciudad Victoria", 23.74, -99.15), ("Tampico", 22.25, -97.86),
          ("Nuevo Laredo", 27.48, -99.52)]
DIRS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]

LABELS = {
    "H1": "Data for the cockpit or airline computers", "SA": "Data-link status", "SQ": "Ground-station ping",
    "_d": "Acknowledgement", "Q0": "Link test", "QP": "Left the gate", "QQ": "Took off", "QR": "Landed",
    "QS": "Arrived at the gate", "QA": "Out/off/on/in report", "QB": "Out/off/on/in report", "QC": "Out/off/on/in report",
    "QD": "Out/off/on/in report", "QE": "Out/off/on/in report", "QF": "Out/off/on/in report",
    "10": "Airline report", "11": "Airline report", "12": "Airline report", "15": "Position report",
    "16": "Position report", "20": "Crew sign-in", "21": "Flight details", "22": "Event times",
    "33": "Position report", "44": "Position report", "4A": "Air/ground sensor status", "4E": "Airline report",
    "80": "Airline report", "81": "Free-text message", "5U": "Weather request", "5Z": "Airline report",
    "B9": "Airport information (ATIS) request", "RA": "Message to the crew", "C1": "Message to the crew",
    "31": "Airline report", "32": "Airline report", "37": "Encrypted airline data", "B6": "Oceanic clearance request",
    "A9": "Airport information (ATIS)", "AA": "Air traffic control message", "BA": "Air traffic control message",
    "5Y": "Airline report", "2Z": "Airline report",
}


def _ap(code: str | None) -> str:
    c = (code or "").strip().upper()
    if not c or set(c) <= {"-", "*"}:
        return ""
    return AIRPORTS.get(c) or IATA.get(c) or c


def _route(a: str, b: str) -> str:
    a, b = _ap(a), _ap(b)
    return f"{a} → {b}" if a and b else a or b


def _hhmm(s: str, at: int | None) -> str:
    """'1624' (UTC) → '10:24 am' local, on the message's day."""
    s = (s or "").strip()
    if not re.fullmatch(r"\d{4}", s):
        return ""
    h, m = int(s[:2]), int(s[2:])
    if h > 23 or m > 59:
        return ""
    base = datetime.fromtimestamp(at or 0, timezone.utc) if at else datetime.now(timezone.utc)
    t = base.replace(hour=h, minute=m, second=0, microsecond=0)
    diff = (t - base).total_seconds()
    if diff > 6 * 3600:        # e.g. 23:50 reported just after midnight
        t -= timedelta(days=1)
    elif diff < -18 * 3600:
        t += timedelta(days=1)
    return t.astimezone(_TZ).strftime("%-I:%M %p").lower()


def _where(lat: float, lng: float) -> str:
    if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return ""
    best = None
    for name, plat, plng in PLACES:
        dy = (lat - plat) * 69.0
        dx = (lng - plng) * 69.0 * math.cos(math.radians(lat))
        d = math.hypot(dx, dy)
        if best is None or d < best[0]:
            best = (d, name, dx, dy)
    d, name, dx, dy = best
    if d > 250:
        return f"at {abs(lat):.1f}°{'N' if lat >= 0 else 'S'} {abs(lng):.1f}°{'W' if lng < 0 else 'E'}"
    if d < 4:
        return f"over {name}"
    brg = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return f"{round(d)} mi {DIRS[int((brg + 22.5) // 45) % 8]} of {name}"


def _ft(v) -> str:
    try:
        n = int(str(v).strip().lstrip("+"))
    except ValueError:
        return ""
    if n <= 0:
        return ""
    if n < 600:          # flight level
        n *= 100
    return f"{n:,} ft"


def _deg(hemi: str, digits: str, deg_len: int) -> float | None:
    """N25459 → 25.765 (ddmm.m packed); W097173 → -97.288."""
    try:
        d = int(digits[:deg_len])
        m = int(digits[deg_len:]) / (10 ** (len(digits) - deg_len - 2))
        v = d + m / 60
    except (ValueError, ZeroDivisionError):
        return None
    return -v if hemi in "SW" else v


def _out(tag, text, noise=False, detail=None):
    return {"tag": tag, "text": text, "noise": noise, "detail": detail or []}


def _free_text(t: str) -> str:
    t = t.replace(".", " ").replace("\r", "")
    t = re.sub(r"[ \t]+", " ", t)
    lines = [ln.strip() for ln in t.split("\n") if ln.strip()]
    s = " ".join(lines)
    return s[:1].upper() + s[1:].lower() if s.isupper() else s


def _looks_wordy(t: str) -> bool:
    words = [w for w in re.findall(r"[A-Za-z]{3,}", t)
             if re.search(r"[AEIOUaeiou]", w) and not re.fullmatch(r"[Xx]+", w)]
    return len(t.split()) >= 4 and len({w.upper() for w in words}) >= 3 and sum(len(w) for w in words) > 0.45 * len(re.sub(r"\s", "", t))


def _scrub(t: str) -> str:
    """Drop crew names / employee ids that some sign-in messages carry."""
    t = re.sub(r"(/CN |CAPT[: ]+|F/O[: ]+)[A-Z ,.'-]+", r"\1•••", t)
    return re.sub(r"/U\d{5,}", "/U•••", t)


def humanize(m: dict) -> dict:
    try:
        return _humanize(m)
    except Exception:
        return _out(LABELS.get((m.get("label") or "").strip(), "Airline message"), "", False)


def _humanize(m: dict) -> dict:
    label = (m.get("label") or "").strip()
    t = (m.get("text") or "").strip("\r\n ")
    at = m.get("at")
    up = t.upper()

    if label in ("SQ", "Q0", "_d", "_\x7f") or not t:
        return _out(LABELS.get(label, "Link message"), "Routine data-link housekeeping.", True)
    if label == "SA":
        mm = re.match(r"\d?E([VSHGX])(\d{4})\d{2}([VSHGX])?", t)
        media = {"V": "VHF radio", "S": "satellite", "H": "HF radio", "G": "VHF radio", "X": "cellular"}
        if mm:
            return _out("Data-link status", f"Data link up over {media.get(mm.group(1), 'radio')} at {_hhmm(mm.group(2), at)}.", True)
        return _out("Data-link status", "Data-link status update.", True)

    fr = re.search(r"FLR/FR\d+([^/]+)", up)
    if fr:
        words = [w for w in re.split(r"\s+", fr.group(1)) if w and not re.search(r"\d", w)]
        what = " ".join(words).strip(" ()").lower()
        return _out("Fault report", f"Maintenance fault logged{': ' + what if what else ''} (sent to the airline's engineers).")
    # ---- OOOI: out / off / on / in   e.g. KMFEKDFW1036 …  /  KDFWKMFE1531  68--OS KMFE /OPN0116/DO 1532…
    mm = re.match(r"([A-Z]{4})([A-Z]{4})\s*(\d{4})", up)
    if label in ("QP", "QQ", "QR", "QS") and mm:
        a, b, hm = mm.groups()
        tm = _hhmm(hm, at)
        fuel = re.search(r"/(?:FUL|FB)\s*(\d+)", up)
        det = [("Route", _route(a, b))] + ([("Fuel", f"{int(fuel.group(1)):,} (hundreds)")] if fuel else [])
        if label == "QP":
            return _out("Left the gate", f"Pushed back at {_ap(a)} at {tm}, headed to {_ap(b)}.", detail=det)
        if label == "QQ":
            return _out("Took off", f"Wheels up from {_ap(a)} at {tm}, bound for {_ap(b)}.", detail=det)
        if label == "QR":
            return _out("Landed", f"Touched down at {_ap(b)} at {tm}, in from {_ap(a)}.", detail=det)
        return _out("At the gate", f"Parked at the gate at {_ap(b)} at {tm} after the flight from {_ap(a)}.", detail=det)

    # ---- /15 ON EVENT  /  /12 CREW EVENT  /  /C3 GATE REQ   (United)
    mm = re.match(r"/(\w{1,2}\d?)\s+([A-Z ]+?)\s*/\s*([A-Z]{4})\s+([A-Z]{4})", up)
    if mm:
        kind, what, a, b = mm.groups()
        what = what.strip()
        tm = re.search(r"/TIME (\d{4})", up)
        tms = f" at {_hhmm(tm.group(1), at)}" if tm else ""
        phr = {"ON EVENT": f"Landed at {_ap(b)}{tms}, in from {_ap(a)}.",
               "OFF EVENT": f"Took off from {_ap(a)}{tms}, bound for {_ap(b)}.",
               "OUT EVENT": f"Pushed back from the gate at {_ap(a)}{tms}.",
               "IN EVENT": f"Parked at the gate at {_ap(b)}{tms}.",
               "GATE REQ": "",
               "LDG DATA REQ": f"Asked for landing performance numbers for {_ap(b)}"
                               + (f" runway {rw.group(1)}" if (rw := re.search(r" R(\d{1,2}[LRC]?)\s*/", up)) else "") + ".",
               "APT COND": f"Asked for current airport conditions at {_ap(b)}.",
               "METAR": f"Asked for the latest weather at {_ap(b)}.",
               "DISP MSG": f"Sent a message to the airline's dispatchers ({_route(a, b)}).",
               "APU SHUTDOWN AL": "Auxiliary power unit shut down (routine after engine start).",
               "FUEL": f"Fuel report, {_route(a, b)}.",
               "EXP TIME": f"Expected to land at {_ap(b)}"
                           + (f" at {_hhmm(eo.group(1), at)}" if (eo := re.search(r"/EON (\d{4})", up)) else "") + ".",
               "CREW EVENT": f"Crew timing report, {_route(a, b)}{tms}."}
        txt = phr.get(what) or f"{what.title()} report, {_route(a, b)}{tms}."
        if what == "SYS CONF RPT":
            return _out("System report", "Avionics configuration report (routine).", True)
        if what == "GATE REQ":
            txt = f"Asking which gate it will get on arrival ({_route(a, b)})."
        return _out({"ON EVENT": "Landed", "OFF EVENT": "Took off", "OUT EVENT": "Left the gate",
                     "IN EVENT": "At the gate", "GATE REQ": "Gate request", "LDG DATA REQ": "Landing data",
                     "APT COND": "Airport conditions", "METAR": "Weather request", "DISP MSG": "Message",
                     "APU SHUTDOWN AL": "APU", "CREW EVENT": "Crew report", "EXP TIME": "ETA"}.get(what, what.title()), txt,
                    detail=[("Route", _route(a, b))])

    # ---- POSRPT (Volaris/Viva style, label 80)
    if "POSRPT" in up:
        r = re.search(r"([A-Z]{4})/([A-Z]{4})", up)
        p = re.search(r"/POS ([NS])(\d{5,6})([EW])(\d{6,7})", up)
        alt = re.search(r"/ALT \+?(\d+)", up)
        mach = re.search(r"/MCH (\d{3})", up)
        eta = re.search(r"/ETA (\d{4})", up)
        where = ""
        if p:
            lat = _deg(p.group(1), p.group(2), 2)
            lng = _deg(p.group(3), p.group(4), 3)
            where = _where(lat, lng)
        bits = [b for b in [where, f"at {_ft(alt.group(1))}" if alt and _ft(alt.group(1)) else "",
                            f"Mach 0.{mach.group(1)}" if mach else ""] if b]
        txt = f"Position report: {', '.join(bits) or 'en route'}"
        if r:
            txt += f", flying {_route(*r.groups())}"
        if eta:
            txt += f", due in at {_hhmm(eta.group(1), at)}"
        return _out("Position", txt + ".", detail=[("Route", _route(*r.groups()) if r else "")])

    # ---- RMPSRV ramp services
    if "RMPSRV" in up:
        r = re.search(r"([A-Z]{4})/([A-Z]{4})", up)
        need = []
        wc = re.search(r"/WCH\w*\s+(\d+)", up)
        if wc and int(wc.group(1)):
            need.append(f"{int(wc.group(1))} wheelchair{'s' if int(wc.group(1)) > 1 else ''}")
        for k, nm in (("GPU", "ground power"), ("ACU", "air conditioning"), ("LAV", "lavatory service"),
                      ("CAB", "cabin cleaning")):
            if re.search(rf"/{k} Y", up):
                need.append(nm)
        eta = re.search(r"ERT (\d{4})", up)
        dest = _ap(r.group(2)) if r else "the destination"
        txt = f"Ramp request for arrival at {dest}"
        if eta:
            txt += f" (due {_hhmm(eta.group(1), at)})"
        txt += f": needs {', '.join(need)}." if need else "."
        return _out("Ramp request", txt)

    # ---- departure delay (Viva)  DEPDLY … ATD 1721/ETD 1717
    if "DEPDLY" in up:
        r = re.search(r"([A-Z]{4})/([A-Z]{4})", up)
        atd, etd = re.search(r"ATD (\d{4})", up), re.search(r"ETD (\d{4})", up)
        txt = f"Departure report{f' for {_route(*r.groups())}' if r else ''}"
        if atd:
            txt += f": left at {_hhmm(atd.group(1), at)}"
            if etd:
                txt += f" (scheduled {_hhmm(etd.group(1), at)})"
        return _out("Departed", txt + ".")
    if "FINAL WEIGHTS" in up:
        r = re.search(r"\b([A-Z]{4}) ([A-Z]{4})\b", up)
        return _out("Weights", f"Dispatch sent the final weight-and-balance numbers{f' for {_route(*r.groups())}' if r else ''}.")
    if re.search(r"V1/VR/V2|TAKEOFF DATA|TOD\b", up):
        return _out("Takeoff data", "Takeoff speeds and thrust settings sent to the crew.")
    if "NEW ROUTE FROM ATC" in up:
        return _out("Reroute", "Air traffic control issued a new route; the airline relayed it to the crew.")
    if "PDC" in up and "NO DEPARTURE CLEARANCE" in up:
        return _out("Clearance", "No digital departure clearance on file; the crew was told to call clearance delivery by voice.")
    if "ON-TIME ANALYSIS" in up:
        o = re.search(r"ACT OUT (\d{4})", up); sk = re.search(r"SKD OUT (\d{4})", up)
        txt = "On-time report"
        if o and sk:
            txt += f": pushed back {_hhmm(o.group(1), at)}, scheduled {_hhmm(sk.group(1), at)}"
        return _out("On-time", txt + ".")
    if "SVC INFO SUMMARY" in up:
        return _out("Flight info", "Dispatch summary of the flight's service details.", True)

    # ---- weather request
    if "WXRQ" in up or label == "5U":
        sts = [_ap(s) for s in re.findall(r"/STA ([A-Z]{4})", up)]
        sts = [s for s in sts if s]
        return _out("Weather request", f"Crew asked for the weather at {', '.join(sts)}." if sts else "Crew asked for weather.")
    mm = re.match(r"/W\d\s+([A-Z]{3})([A-Z]{3})\s+([A-Z]{3})", up)
    if mm:
        return _out("Weather request", f"Crew asked for the weather at {_ap(mm.group(3))}.")

    # ---- ATIS request  /KDFW.TI2/024KDFWCA18E
    mm = re.match(r"/([A-Z]{4})\.TI2", up)
    if mm or label == "B9":
        apt = _ap(mm.group(1)) if mm else ""
        return _out("ATIS request", f"Requested the latest airport conditions (ATIS) for {apt or 'its destination'}.")

    # ---- label 16  hhmmss,alt,?, ?,N2716.69 W09635.98
    mm = re.search(r"(\d{6}),\s*(\d+),.*?([NS])\s?(\d{2})(\d{2}\.\d+)\s+([EW])\s?(\d{3})(\d{2}\.\d+)", up)
    if mm:
        lat = int(mm.group(4)) + float(mm.group(5)) / 60
        lng = int(mm.group(7)) + float(mm.group(8)) / 60
        lat, lng = (-lat if mm.group(3) == "S" else lat), (-lng if mm.group(6) == "W" else lng)
        return _out("Position", f"Position report: {_where(lat, lng)} at {_ft(mm.group(2))}.")
    # ---- label 16 decimal  123754,35673,1513, 247,N 27.891 W 99.464
    mm = re.search(r"^\d{6},\s*(\d+),.*?([NS]) ?(\d+\.\d+),?\s*([EW]) ?(\d+\.\d+)", up)
    if mm:
        lat = float(mm.group(3)) * (-1 if mm.group(2) == "S" else 1)
        lng = float(mm.group(5)) * (-1 if mm.group(4) == "W" else 1)
        return _out("Position", f"Position report: {_where(lat, lng)} at {_ft(mm.group(1))}.")
    # ---- label 10  POS170041,N 26.004,W 98.156,…,34000,…
    mm = re.match(r"POS\d{6},([NS]) ?([\d.]+),([EW]) ?([\d.]+),.*?,(\d{4,5}),\d*$", up)
    if mm:
        lat = float(mm.group(2)) * (-1 if mm.group(1) == "S" else 1)
        lng = float(mm.group(4)) * (-1 if mm.group(3) == "W" else 1)
        return _out("Position", f"Position report: {_where(lat, lng)} at {_ft(mm.group(5))}.")
    # ---- label 33  96,E,26.918,-97.288,22523,*****,KBRO,KIAH,8R,8L,…
    mm = re.match(r"\d+,[A-Z],(-?\d+\.\d+),(-?\d+\.\d+),(\d+),[^,]*,([A-Z]{4}),([A-Z]{4}),([0-9]{1,2}[LRC]?)?", up)
    if mm:
        txt = f"Position report: {_where(float(mm.group(1)), float(mm.group(2)))} at {_ft(mm.group(3))}, flying {_route(mm.group(4), mm.group(5))}"
        if mm.group(6):
            txt += f", planning runway {mm.group(6)} on arrival"
        return _out("Position", txt + ".")
    # ---- (2N26498W 96517--- 48380  (label 15 short form)
    mm = re.match(r"\(2([NS])(\d{5})([EW])\s?(\d{5,6})", up)
    if mm:
        lat = _deg(mm.group(1), mm.group(2), 2)
        lng = _deg(mm.group(3), mm.group(4).rjust(6, "0"), 3)
        return _out("Position", f"Position report: {_where(lat, lng)}.")

    # ---- label 21  C54254,KMFE,KIAH,16, 6285US
    mm = re.match(r"\w+,([A-Z]{4}),([A-Z]{4}),", up)
    if mm and label == "21":
        return _out("Flight details", f"Flight set up in the cockpit: {_route(*mm.groups())}.")
    if label == "4A" and "AIR " in up:
        air = "AIR Y" in up
        return _out("Air/ground", "Sensors report the aircraft is airborne." if air else "Sensors report the aircraft is on the ground.", True)
    if label == "20" and re.search(r"COPILOT|CAPT|F/O|CAPTAIN|/CN |FI \d", up):
        return _out("Crew sign-in", "A pilot logged in to the flight's data link.", True)
    if "ATM DISPATCH" in up or "FREETEXT" in up:
        body = up.split("FREETEXT APPENDED", 1)[-1]
        return _out("Message", f"Dispatch message: “{_free_text(body.strip(' .'))}”")
    e = re.search(r"EDCT\.?\s*(\d{4})Z?", up)
    if e:
        return _out("Delay", f"Air traffic control assigned a departure slot (EDCT) of {_hhmm(e.group(1), at)}.")

    # free-text messages between crew and dispatch
    if label in ("81", "RA", "C1", "5Y") or _looks_wordy(t):
        if _looks_wordy(t):
            return _out("Message", f"“{_free_text(t)}”")

    et = re.search(r"/ET EXP TIME\s*/\s*([A-Z]{4}) ([A-Z]{4}).*?/EON (\d{4})", up)
    if et:
        return _out("ETA", f"Expected to land at {_ap(et.group(2))} at {_hhmm(et.group(3), at)}.")
    if label == "H1" and not re.search(r"\b[A-Z]{3,} [A-Z]{3,} [A-Z]{3,}\b", up):
        return _out("Aircraft data", "Engine and performance data sent to the airline (machine-readable).", True)
    if not re.search(r"[A-Za-z]{3,}", t) or len(re.findall(r"[A-Za-z]", t)) < 0.15 * len(t):
        return _out("Aircraft data", "Machine-readable data (no plain text).", True)
    if label == "H1":
        return _out("Aircraft data", "Engine and performance data sent to the airline (machine-readable).", True)
    if label in ("37",) or re.search(r"[)(][A-Z0-9]{2}[A-Z0-9,.\-]{20,}", up):
        return _out("Encrypted", "Encoded airline data (not readable).", True)
    if label == "22" or label == "11" or label == "12":
        return _out(LABELS.get(label, "Airline report"), "Routine airline timing/engine report.", True)
    r = re.search(r"\b([A-Z]{4})[ /,]+([A-Z]{4})\b", up)
    rt = _route(*r.groups()) if r and r.group(1)[0] in "KMCE" and r.group(2)[0] in "KMCE" else ""
    base = LABELS.get(label, "Airline message")
    return _out(base, f"{base}{f' for {rt}' if rt else ''}.", False)
