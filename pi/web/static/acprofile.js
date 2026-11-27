/* JAFO aircraft side profiles — original, parametric SVG drawings by type family,
   painted in the operator's colours. No logos or artwork from airlines.

   window.acProfile(a)  -> SVG string (a = {type, desc, callsign, reg, kind, role, operator})
   window.acTypeName(a) -> "Boeing 737-900"
   window.acAirline(a)  -> {name, ...livery} | null                                     */
(function () {
  "use strict";

  // ------------------------------------------------------------------ type names
  const TYPES = {
    A319: "Airbus A319", A320: "Airbus A320", A321: "Airbus A321", A20N: "Airbus A320neo", A21N: "Airbus A321neo", A19N: "Airbus A319neo",
    A332: "Airbus A330-200", A333: "Airbus A330-300", A339: "Airbus A330-900neo", A359: "Airbus A350-900", A35K: "Airbus A350-1000",
    A388: "Airbus A380", A343: "Airbus A340-300", BCS1: "Airbus A220-100", BCS3: "Airbus A220-300",
    B712: "Boeing 717", B733: "Boeing 737-300", B734: "Boeing 737-400", B735: "Boeing 737-500", B736: "Boeing 737-600", B737: "Boeing 737-700", B738: "Boeing 737-800",
    B739: "Boeing 737-900", B37M: "Boeing 737 MAX 7", B38M: "Boeing 737 MAX 8", B39M: "Boeing 737 MAX 9", B3XM: "Boeing 737 MAX 10",
    B752: "Boeing 757-200", B753: "Boeing 757-300", B762: "Boeing 767-200", B763: "Boeing 767-300", B764: "Boeing 767-400",
    B772: "Boeing 777-200", B77L: "Boeing 777-200LR", B77W: "Boeing 777-300ER", B778: "Boeing 777-8", B779: "Boeing 777-9",
    B788: "Boeing 787-8", B789: "Boeing 787-9", B78X: "Boeing 787-10", B744: "Boeing 747-400", B748: "Boeing 747-8", MD11: "McDonnell Douglas MD-11",
    E170: "Embraer 170", E75L: "Embraer 175", E75S: "Embraer 175", E190: "Embraer 190", E195: "Embraer 195", E290: "Embraer E190-E2", E295: "Embraer E195-E2",
    E135: "Embraer ERJ-135", E145: "Embraer ERJ-145", E45X: "Embraer ERJ-145XR", CRJ2: "Bombardier CRJ200", CRJ7: "Bombardier CRJ700", CRJ9: "Bombardier CRJ900",
    DH8D: "De Havilland Dash 8-400", AT72: "ATR 72", AT76: "ATR 72-600", AT45: "ATR 42-500", SW4: "Fairchild Metro", DHC6: "De Havilland Twin Otter",
    B350: "Beechcraft King Air 350", BE20: "Beechcraft King Air 200", BE9L: "Beechcraft King Air 90", BE30: "Beechcraft King Air 300", BE35: "Beechcraft Bonanza",
    BE36: "Beechcraft Bonanza", BE58: "Beechcraft Baron", PA31: "Piper Navajo", PA23: "Piper Aztec", PA28: "Piper Cherokee", PA32: "Piper Saratoga", PA34: "Piper Seneca",
    P46T: "Piper Malibu Meridian", PA46: "Piper Malibu", C421: "Cessna 421", C310: "Cessna 310", C414: "Cessna 414", C340: "Cessna 340",
    C150: "Cessna 150", C152: "Cessna 152", C172: "Cessna 172 Skyhawk", C182: "Cessna 182 Skylane", C82S: "Cessna 182 Skylane", C82T: "Cessna T182", C206: "Cessna 206",
    T206: "Cessna T206", C210: "Cessna 210", C208: "Cessna 208 Caravan", SR20: "Cirrus SR20", SR22: "Cirrus SR22", S22T: "Cirrus SR22T", PC12: "Pilatus PC-12",
    TBM7: "Daher TBM 700", TBM9: "Daher TBM 900", AT6T: "Air Tractor AT-602", AT8T: "Air Tractor AT-802",
    C25A: "Cessna Citation CJ2", C25B: "Cessna Citation CJ3", C25C: "Cessna Citation CJ4", C525: "Cessna CitationJet", C510: "Cessna Citation Mustang",
    C560: "Cessna Citation V", C56X: "Cessna Citation Excel", C680: "Cessna Citation Sovereign", C68A: "Cessna Citation Latitude", C700: "Cessna Citation Longitude",
    C750: "Cessna Citation X", E55P: "Embraer Phenom 300", E50P: "Embraer Phenom 100", E545: "Embraer Legacy 450", E550: "Embraer Praetor 600",
    LJ35: "Learjet 35", LJ45: "Learjet 45", LJ60: "Learjet 60", LJ75: "Learjet 75", PRM1: "Beechcraft Premier I", H25B: "Hawker 800", HA4T: "Hawker 4000",
    CL30: "Bombardier Challenger 300", CL35: "Bombardier Challenger 350", CL60: "Bombardier Challenger 600", GLEX: "Bombardier Global Express", GL5T: "Bombardier Global 5000", GL7T: "Bombardier Global 7500",
    GLF4: "Gulfstream IV", GLF5: "Gulfstream V", GLF6: "Gulfstream G650", GA5C: "Gulfstream G500", GA6C: "Gulfstream G600", G280: "Gulfstream G280",
    F900: "Dassault Falcon 900", FA7X: "Dassault Falcon 7X", FA8X: "Dassault Falcon 8X", F2TH: "Dassault Falcon 2000", FA50: "Dassault Falcon 50", HDJT: "Honda HondaJet",
    EC35: "Airbus H135", EC45: "Airbus H145", H145: "Airbus H145", EC30: "Airbus H130", AS50: "Airbus AS350 AStar", AS55: "Airbus AS355 TwinStar", EC20: "Airbus H120",
    B06: "Bell 206 JetRanger", B407: "Bell 407", B412: "Bell 412", B429: "Bell 429", B505: "Bell 505", R44: "Robinson R44", R22: "Robinson R22", R66: "Robinson R66",
    S76: "Sikorsky S-76", H60: "Sikorsky UH-60 Black Hawk", UH60: "Sikorsky UH-60 Black Hawk", A139: "Leonardo AW139", A109: "Leonardo AW109", A119: "Leonardo AW119",
    C130: "Lockheed C-130 Hercules", C30J: "Lockheed C-130J Super Hercules", C17: "Boeing C-17 Globemaster III", K35R: "Boeing KC-135", C5M: "Lockheed C-5M Galaxy",
    P8: "Boeing P-8 Poseidon", E3TF: "Boeing E-3 Sentry", F16: "Lockheed F-16", F18S: "Boeing F/A-18", F35: "Lockheed F-35", T38: "Northrop T-38 Talon",
    T6: "Beechcraft T-6 Texan II", TEX2: "Beechcraft T-6 Texan II", P3: "Lockheed P-3 Orion", DH8A: "De Havilland Dash 8-100", DH8B: "De Havilland Dash 8-200", DH8C: "De Havilland Dash 8-300",
  };

  // ------------------------------------------------------------------ families
  // L = length/height ratio of the fuselage; eng = engine layout; tail = conv | T | cruc
  const FAM = {
    narrow:   { L: 9.6, eng: "wing", n: 1, tail: "conv", wing: "swept", win: 1, nose: "jet" },
    narrowS:  { L: 8.6, eng: "wing", n: 1, tail: "conv", wing: "swept", win: 1, nose: "jet" },
    wide:     { L: 10.6, eng: "wing", n: 1, tail: "conv", wing: "swept", win: 1, nose: "jet", big: 1 },
    quad:     { L: 10.4, eng: "wing", n: 2, tail: "conv", wing: "swept", win: 1, nose: "jet", big: 1 },
    rj:       { L: 10.4, eng: "rear", tail: "T", wing: "swept", win: 1, nose: "jet" },
    ejet:     { L: 9.2, eng: "wing", n: 1, tail: "conv", wing: "swept", win: 1, nose: "jet" },
    biz:      { ts: 0.7, L: 8.0, eng: "rear", tail: "T", wing: "swept", win: 0.6, nose: "biz" },
    bizC:     { ts: 0.7, L: 8.4, eng: "rear", tail: "cruc", wing: "swept", win: 0.6, nose: "biz" },
    tprop:    { L: 9.4, eng: "prop2", tail: "T", wing: "high", win: 1, nose: "prop" },
    tpropC:   { L: 9.0, eng: "prop2", tail: "conv", wing: "high", win: 1, nose: "prop" },
    kingair:  { ts: 0.62, L: 7.2, eng: "prop2", tail: "T", wing: "low", win: 0.7, nose: "kingair" },
    twin:     { ts: 0.58, tt: 0.25, L: 6.8, eng: "prop2", tail: "conv", wing: "low", win: 0.6, nose: "kingair" },
    metro:    { L: 10.0, eng: "prop2", tail: "conv", wing: "low", win: 0.8, nose: "kingair" },
    single:   { ts: 0.46, tt: 0.32, L: 5.4, eng: "nose", tail: "conv", wing: "high", win: 0, nose: "piston", strut: 1 },
    singleLo: { ts: 0.46, tt: 0.3, L: 5.8, eng: "nose", tail: "conv", wing: "low", win: 0, nose: "piston" },
    caravan:  { ts: 0.55, tt: 0.3, L: 6.4, eng: "nose", tail: "conv", wing: "high", win: 0.5, nose: "piston", strut: 1 },
    pc12:     { ts: 0.55, tt: 0.22, L: 6.8, eng: "nose", tail: "T", wing: "low", win: 0.5, nose: "piston" },
    ag:       { ts: 0.46, tt: 0.3, L: 5.8, eng: "nose", tail: "conv", wing: "low", win: 0, nose: "piston", ag: 1 },
    herc:     { L: 7.4, eng: "prop2", n: 2, tail: "conv", wing: "high", win: 0, nose: "herc", mil: 1 },
    lifter:   { L: 8.0, eng: "wing", n: 2, tail: "T", wing: "high", win: 0, nose: "jet", mil: 1, big: 1 },
    fighter:  { ts: 0.7, L: 7.0, eng: "fighter", tail: "conv", wing: "delta", win: 0, nose: "fighter", mil: 1 },
    heli:     { heli: 1 },
  };
  const FAMILY = [
    [/^(A38|B74)/, "quad"], [/^A34/, "quad"], [/^(B7[6-8]|A3[35]|MD11|B78|K35R|E3)/, "wide"], [/^B75/, "narrow"],
    [/^(A31[89]|A19N|B73[3-6]|B37M|B712|BCS1)/, "narrowS"], [/^(A32|A2[01]N|B73|B38M|B39M|B3XM|P8|BCS3)/, "narrow"],
    [/^(E1[79]|E75|E29)/, "ejet"], [/^(CRJ|E13|E14|E45)/, "rj"],
    [/^(F900|FA[57]|FA8)/, "bizC"], [/^(C25|C5|C6|C7|E5|E50|E55|LJ|PRM|H25|HA4|CL[36]|GL|G[AL]|G28|F2T|HDJ)/, "biz"],
    [/^(DH8|AT[47])/, "tprop"], [/^DHC6/, "tpropC"], [/^(B350|BE[23]0|BE9)/, "kingair"], [/^SW[34]/, "metro"],
    [/^(PA31|PA23|PA34|BE58|C3[14]|C4[01]|C421)/, "twin"], [/^C208/, "caravan"], [/^(PC12|TBM)/, "pc12"], [/^AT[0-9]/, "ag"],
    [/^(C1[5-8]|C8[2T]|C82|C2[01]|T20|C206|T206)/, "single"], [/^(SR2|S22|PA2|PA3|BE3|P46|PA46|M20|DA4|T6|TEX)/, "singleLo"],
    [/^(C130|C30J|P3)/, "herc"], [/^(C17|C5M)/, "lifter"], [/^(F1|F2|F3|T38|F35)/, "fighter"],
    [/^(EC|AS|H1|H60|UH|B06|B4|B5|R[24]|R66|S76|A1[0-3]|S92|MI)/, "heli"],
  ];

  // ------------------------------------------------------------------ operators (colours only)
  const AIRLINES = {
    AAL: { name: "American", body: "#d8dde3", tail: "#36495a", stripes: ["#0078d2", "#c30019"] },
    ENY: { name: "American Eagle", body: "#d8dde3", tail: "#36495a", stripes: ["#0078d2", "#c30019"] },
    PDT: { name: "American Eagle", body: "#d8dde3", tail: "#36495a", stripes: ["#0078d2", "#c30019"] },
    ASH: { name: "American Eagle", body: "#d8dde3", tail: "#36495a", stripes: ["#0078d2", "#c30019"] },
    UAL: { name: "United", tail: "#0b2265", belly: "#9aa7b8", engine: "#0b2265", accent: "#1a64c8" },
    UCA: { name: "United Express", tail: "#0b2265", belly: "#9aa7b8", accent: "#1a64c8" },
    DAL: { name: "Delta", tail: "#0b2343", belly: "#0b2343", accent: "#c8102e" },
    SWA: { name: "Southwest", body: "#304cb2", belly: "#c8102e", tail: "#304cb2", accent: "#ffbf27", text: "#fff" },
    SKW: { name: "SkyWest", tail: "#1f3c6e", accent: "#8da2c0" },
    RPA: { name: "Republic", tail: "#1b365d", accent: "#9fb2cc" },
    JBU: { name: "JetBlue", tail: "#003876", accent: "#1d5fbf", belly: "#003876" },
    NKS: { name: "Spirit", body: "#ffe500", tail: "#ffe500", text: "#111", accent: "#111" },
    FFT: { name: "Frontier", tail: "#1f8a3a", belly: "#1f8a3a", accent: "#7cc142" },
    AAY: { name: "Allegiant", tail: "#f6871f", accent: "#00467f" },
    ASA: { name: "Alaska", tail: "#01426a", accent: "#48c2c5" },
    VIV: { name: "Viva", tail: "#00a650", belly: "#00a650", accent: "#a6ce39" },
    VOI: { name: "Volaris", tail: "#a12a8b", accent: "#5c2d91" },
    AMX: { name: "Aeroméxico", tail: "#0b2343", body: "#e9ecf0", accent: "#5a6b7f" },
    SLI: { name: "Aeroméxico Connect", tail: "#0b2343", body: "#e9ecf0", accent: "#5a6b7f" },
    UPS: { name: "UPS", body: "#d9d4cc", belly: "#3d2a1f", tail: "#3d2a1f", accent: "#ffb500" },
    FDX: { name: "FedEx", tail: "#4d148c", belly: "#e3e6ea", accent: "#ff6600", text: "#4d148c" },
    GTI: { name: "Atlas Air", tail: "#1d3c78", accent: "#9bb0d6" },
    ABX: { name: "ABX Air", tail: "#203a6b", accent: "#d32f2f" },
    DLH: { name: "Lufthansa", tail: "#0a1d3d", belly: "#ffffff", accent: "#0a1d3d" },
    KLM: { name: "KLM", body: "#ffffff", tail: "#00a1de", belly: "#00a1de", accent: "#00a1de" },
    ACA: { name: "Air Canada", tail: "#111111", belly: "#c8ced6", accent: "#d22630" },
    WJA: { name: "WestJet", tail: "#00a9e0", accent: "#003c71" },
    BAW: { name: "British Airways", tail: "#0e2a5a", belly: "#0e2a5a", accent: "#c8102e" },
    AFR: { name: "Air France", tail: "#0a2a6b", accent: "#e0001b" },
    VTM: { name: "Aeronaves TSM", tail: "#1f3a63", accent: "#c62828" },
    MTS: { name: "Med Jets", tail: "#b71c1c", accent: "#1f2c44" },
    TAI: { name: "Avianca", tail: "#da291c", accent: "#da291c" },
    CMP: { name: "Copa", tail: "#0032a0", accent: "#c8a75e" },
    EJA: { name: "NetJets", tail: "#1b1b1b", accent: "#8a6d3b" },
    LXJ: { name: "Flexjet", tail: "#2a2a2a", accent: "#9a7b4f" },
    XAJ: { name: "XO", tail: "#1b1b1b", accent: "#666" },
  };
  const ROLE_LIVERY = {
    border: { name: "", tail: "#14284b", belly: "#14284b", accent: "#b38e3a" },
    police: { name: "", tail: "#121212", belly: "#121212", accent: "#e8e8e8" },
    medical: { name: "", tail: "#c62828", belly: "#c62828", accent: "#1d2a44" },
    military: { name: "", body: "#8a929b", tail: "#7d858e", belly: "#6f7780", accent: "#5f666e", mil: 1 },
  };

  function prefix(cs) { const m = /^([A-Z]{3})\d/.exec((cs || "").trim().toUpperCase()); return m ? m[1] : ""; }
  function airline(a) { return AIRLINES[prefix(a.callsign)] || null; }
  function livery(a, f) {
    if (f.mil || a.kind === "military" || a.role === "military") return ROLE_LIVERY.military;
    if (ROLE_LIVERY[a.role]) return ROLE_LIVERY[a.role];
    const op = (a.operator || "").toUpperCase();
    if (/CUSTOMS|BORDER|HOMELAND/.test(op)) return ROLE_LIVERY.border;
    if (/PUBLIC SAFETY|POLICE|SHERIFF/.test(op)) return ROLE_LIVERY.police;
    return airline(a) || { name: "", tail: "#5b6b80", accent: "#9aa7b8" };
  }
  function typeCode(a) { return (a.type || "").toUpperCase().trim(); }
  function family(a) {
    const t = typeCode(a);
    if (a.kind === "helicopter") return "heli";
    for (const [re, f] of FAMILY) if (re.test(t)) return f;
    const d = (a.desc || "").toUpperCase();
    if (/HELI|ROTOR|BELL |ROBINSON|EUROCOPTER|SIKORSKY|AGUSTA/.test(d)) return "heli";
    if (a.kind === "heavy") return "wide";
    if (a.kind === "commercial" || a.kind === "jet") return "narrow";
    if (a.kind === "military") return "herc";
    if (a.kind === "light") return /CITATION|LEARJET|GULFSTREAM|FALCON|CHALLENGER|JET/.test(d) ? "biz" : "single";
    return "narrow";
  }
  function typeName(a) {
    const t = typeCode(a);
    if (TYPES[t]) return TYPES[t];
    const d = (a.desc || "").trim();
    if (d) return d.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bA-(\d)/, "A$1");
    return t || "";
  }

  // ------------------------------------------------------------------ drawing helpers
  const W = 640, H = 200;
  let uid = 0;
  const n = (v) => Math.round(v * 10) / 10;
  const P = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${n(x)} ${n(y)}`).join(" ") + "Z";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function shade(hex, k) {   // k<0 darker, k>0 lighter
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return hex;
    const v = parseInt(m[1], 16); let r = v >> 16, g = (v >> 8) & 255, b = v & 255;
    const f = (c) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
    return `#${[f(r), f(g), f(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }

  // ------------------------------------------------------------------ fixed-wing
  function plane(a, f, lv, id) {
    const big = f.big ? 1 : 0;
    const fk0 = f.big ? 1.65 : f.eng === "rear" ? 1.6 : f.nose === "piston" ? 1.05 : 1.5;
    const bl0 = f.eng === "wing" ? 0.42 : f.eng === "nose" ? 0.12 : 0.16;
    const sc = Math.min(1, (H - 18) / ((580 / f.L) * (1 + fk0 + bl0)));
    const len = 580 * sc, X0 = (W - len) / 2, X1 = X0 + len;
    const h = len / f.L;
    const finH = h * fk0, below = h * bl0;
    const yc = (H + finH - below) / 2 + 2;
    const T = yc - h / 2, B = yc + h / 2;
    const ts = f.ts || 0.8, tt = f.tt || (f.tail === "T" ? 0.12 : 0.22);
    const X = (k) => X0 + k * len;
    const body = lv.body || "#ffffff", tail = lv.tail, acc = lv.accent || shade(tail, 0.3);
    const metal = "#c7ced6", wingC = lv.mil ? shade(body, -0.08) : "#e3e7ec", wingE = lv.mil ? shade(body, -0.25) : "#b9c1cb";
    const out = [];
    const defs = `<defs>
      <linearGradient id="fb${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(body, 0.12)}"/><stop offset=".55" stop-color="${body}"/><stop offset="1" stop-color="${shade(body, -0.12)}"/></linearGradient>
      <linearGradient id="wg${id}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${shade(wingC, -0.06)}"/><stop offset="1" stop-color="${shade(wingC, 0.25)}"/></linearGradient>
      <linearGradient id="en${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(lv.engine || body, 0.1)}"/><stop offset=".6" stop-color="${lv.engine || body}"/><stop offset="1" stop-color="${shade(lv.engine || body, -0.22)}"/></linearGradient>
      <clipPath id="fc${id}"><path d="${fusePath()}"/></clipPath></defs>`;

    function fusePath() {
      const nose = f.nose;
      const tailUp = T + h * tt;
      let d;
      if (nose === "jet" || nose === "herc") {
        d = `M${n(X0)} ${n(yc + h * 0.12)} C${n(X0)} ${n(yc - h * 0.32)} ${n(X(0.045))} ${n(T + h * 0.02)} ${n(X(0.11))} ${n(T)}`;
      } else if (nose === "biz" || nose === "fighter") {
        d = `M${n(X0)} ${n(yc + h * 0.18)} C${n(X(0.03))} ${n(yc - h * 0.1)} ${n(X(0.1))} ${n(T + h * 0.05)} ${n(X(0.2))} ${n(T)}`;
      } else if (nose === "kingair") {
        d = `M${n(X0)} ${n(yc + h * 0.12)} C${n(X0)} ${n(yc - h * 0.2)} ${n(X(0.06))} ${n(T + h * 0.25)} ${n(X(0.12))} ${n(T + h * 0.15)} L${n(X(0.2))} ${n(T)}`;
      } else {   // piston/prop single — blunt nose with cowl, windscreen step
        d = `M${n(X0 + 6)} ${n(yc - h * 0.05)} C${n(X0 + 6)} ${n(T + h * 0.18)} ${n(X(0.06))} ${n(T + h * 0.15)} ${n(X(0.16))} ${n(T + h * 0.12)} L${n(X(0.27))} ${n(T - h * (f.wing === "high" ? 0.02 : 0.04))}`;
      }
      const m = (k) => X(ts + (1 - ts) * k);
      d += ` L${n(X(ts))} ${n(T)} C${n(m(0.5))} ${n(T + h * 0.02)} ${n(m(0.8))} ${n(tailUp - h * 0.04)} ${n(X1)} ${n(tailUp)}`;
      d += ` L${n(X1)} ${n(tailUp + h * 0.16)} C${n(m(0.5))} ${n(tailUp + h * 0.3)} ${n(X(ts - 0.02))} ${n(B)} ${n(X(ts - 0.18))} ${n(B)}`;
      if (nose === "piston") d += ` L${n(X(0.12))} ${n(B)} C${n(X(0.05))} ${n(B)} ${n(X0 + 6)} ${n(yc + h * 0.3)} ${n(X0 + 6)} ${n(yc + h * 0.1)}Z`;
      else d += ` L${n(X(0.12))} ${n(B)} C${n(X(0.05))} ${n(B)} ${n(X0 + 2)} ${n(yc + h * 0.38)} ${n(X0)} ${n(yc + (nose === "biz" || nose === "fighter" ? h * 0.18 : h * 0.12))}Z`;
      return d;
    }

    // --- vertical fin
    const fr = f.tail === "T" ? 0.83 : 0.8;
    const fin = f.nose === "piston" || f.nose === "kingair"
      ? [[X(0.8), T + h * tt * 0.8 + 2], [X(0.9), T - finH * 0.85], [X(0.975), T - finH], [X(0.998), T - finH * 0.97], [X(0.995), T + h * (tt + 0.1)]]
      : [[X(fr), T + 2], [X(0.925), T - finH], [X(0.985), T - finH], [X(0.975), T - finH * 0.5], [X(0.995), T + h * 0.25]];
    out.push(`<path d="${P(fin)}" fill="${tail}"/>`);
    if (lv.stripes) {
      lv.stripes.forEach((c, i) => out.push(`<path d="${P([[X(0.875 + i * 0.018), T - finH * 0.25], [X(0.94 + i * 0.018), T - finH * 0.95], [X(0.952 + i * 0.018), T - finH * 0.95], [X(0.887 + i * 0.018), T - finH * 0.25]])}" fill="${c}"/>`));
    } else if (acc && !lv.mil) {
      out.push(`<path d="${P([[X(0.89), T - finH * 0.2], [X(0.95), T - finH * 0.92], [X(0.962), T - finH * 0.92], [X(0.902), T - finH * 0.2]])}" fill="${acc}" opacity=".9"/>`);
    }
    // --- horizontal stabiliser (conventional) drawn behind the fuselage
    if (f.tail === "conv" || f.tail === "cruc") {
      const sy = f.tail === "cruc" ? T - finH * 0.35 : T + h * Math.max(0.32, tt + 0.12);
      out.push(`<path d="${P([[X(0.86), sy + h * 0.1], [X(0.965), sy - h * 0.28], [X(0.995), sy - h * 0.3], [X(0.97), sy + h * 0.1]])}" fill="url(#wg${id})" stroke="${wingE}" stroke-width=".8"/>`);
    }

    // --- far wing / high wing behind fuselage
    out.push(`<path d="${fusePath()}" fill="url(#fb${id})" stroke="${shade(body, -0.28)}" stroke-width=".9"/>`);
    // belly colour + cheatline (clipped to fuselage)
    const clip = [];
    if (lv.belly) clip.push(`<path d="M${X0} ${yc + h * 0.22} C${X(0.3)} ${yc + h * 0.18} ${X(0.7)} ${yc + h * 0.14} ${X1} ${yc - h * 0.32} L${X1} ${B + 20} L${X0} ${B + 20}Z" fill="${lv.belly}"/>`);
    if (lv.accent && !lv.belly && !lv.mil && f.nose !== "piston") clip.push(`<rect x="${X0}" y="${n(yc + h * 0.16)}" width="${len}" height="${n(h * 0.05)}" fill="${lv.accent}" opacity=".85"/>`);
    if (!lv.mil) clip.push(`<path d="M${X(0.74)} ${B + 10} C${X(0.82)} ${yc + h * 0.1} ${X(0.88)} ${T + h * 0.15} ${X(0.86)} ${T - 6} L${X1 + 10} ${T - 10} L${X1 + 10} ${B + 10}Z" fill="${tail}"/>`);
    out.push(`<g clip-path="url(#fc${id})">${clip.join("")}</g>`);

    // --- windows + doors
    if (f.win) {
      const wy = T + h * (f.nose === "biz" ? 0.33 : 0.36), ws = h * (f.big ? 0.085 : 0.1);
      const x0 = f.nose === "biz" ? 0.2 : f.nose === "kingair" ? 0.24 : 0.14, x1 = f.nose === "biz" ? 0.62 : f.nose === "kingair" ? 0.55 : 0.82;
      const step = f.nose === "biz" || f.nose === "kingair" ? ws * 3.2 : ws * 1.9;
      const winC = lv.text === "#fff" ? "#1c2b4a" : "#2c3d55";
      let s = "";
      for (let x = X(x0); x < X(x1); x += step) {
        if (f.nose === "jet" && (Math.abs(x - X(0.36)) < step * 0.8 && f.big)) continue;
        s += f.nose === "biz" || f.nose === "kingair"
          ? `<ellipse cx="${n(x)}" cy="${n(wy + ws * 0.5)}" rx="${n(ws * 0.75)}" ry="${n(ws * 0.85)}" fill="${winC}"/>`
          : `<rect x="${n(x)}" y="${n(wy)}" width="${n(ws * 0.7)}" height="${n(ws * 1.05)}" rx="${n(ws * 0.33)}" fill="${winC}"/>`;
      }
      out.push(s);
      if (f.nose === "jet") {
        const dh = h * 0.42, dw = h * 0.18, dy = T + h * 0.18;
        for (const k of f.big ? [0.085, 0.33, 0.78] : [0.085, 0.82]) out.push(`<rect x="${n(X(k))}" y="${n(dy)}" width="${n(dw)}" height="${n(dh)}" rx="${n(dw * 0.3)}" fill="none" stroke="${shade(body, -0.35)}" stroke-width=".9"/>`);
      }
    }
    // --- cockpit glazing
    if (f.nose === "jet" || f.nose === "herc") out.push(`<path d="${P([[X(0.028), yc - h * 0.12], [X(0.042), T + h * 0.16], [X(0.068), T + h * 0.11], [X(0.066), yc - h * 0.13]])}" fill="#1e2a3c"/>`);
    else if (f.nose === "biz") out.push(`<path d="${P([[X(0.07), yc - h * 0.12], [X(0.1), T + h * 0.2], [X(0.15), T + h * 0.12], [X(0.145), yc - h * 0.13]])}" fill="#1e2a3c"/>`);
    else if (f.nose === "kingair") out.push(`<path d="${P([[X(0.09), T + h * 0.3], [X(0.12), T + h * 0.18], [X(0.19), T + h * 0.1], [X(0.19), T + h * 0.34]])}" fill="#1e2a3c"/>`);
    else if (f.nose === "piston") out.push(`<path d="${P([[X(0.17), T + h * 0.14], [X(0.27), T + h * (f.wing === "high" ? 0.0 : -0.02)], [X(0.4), T + h * 0.02], [X(0.4), T + h * 0.42], [X(0.2), T + h * 0.42]])}" fill="#1e2a3c" opacity=".88"/>`);
    else if (f.nose === "fighter") out.push(`<path d="M${X(0.16)} ${T + 2} C${X(0.2)} ${T - h * 0.55} ${X(0.32)} ${T - h * 0.55} ${X(0.38)} ${T + 2}Z" fill="#3a4a5c" opacity=".85"/>`);

    // --- T-tail stabiliser on top of the fin
    if (f.tail === "T") out.push(`<path d="${P([[X(0.9), T - finH + h * 0.12], [X(0.985), T - finH - h * 0.12], [X(1.005), T - finH - h * 0.12], [X(0.995), T - finH + h * 0.12]])}" fill="url(#wg${id})" stroke="${wingE}" stroke-width=".8"/>`);

    // --- near wing
    if (f.wing === "swept") {
      const r = f.eng === "rear" ? 0.44 : 0.38;
      const tip = T - h * (f.big ? 0.55 : 0.45), rr = f.nose === "biz" ? 0.4 : r;
      out.push(`<path d="${P([[X(rr), B - h * 0.18], [X(rr + 0.22), tip], [X(rr + 0.25), tip - h * 0.02], [X(rr + 0.2), B - h * 0.38]])}" fill="url(#wg${id})" stroke="${wingE}" stroke-width=".9"/>`);
    } else if (f.wing === "high") {
      out.push(`<rect x="${n(X(f.nose === "herc" ? 0.33 : 0.3))}" y="${n(T - h * 0.1)}" width="${n(len * 0.2)}" height="${n(h * 0.17)}" rx="${n(h * 0.08)}" fill="url(#wg${id})" stroke="${wingE}" stroke-width=".9"/>`);
      if (f.strut) out.push(`<path d="M${X(0.36)} ${B - h * 0.1} L${X(0.46)} ${T + h * 0.02}" stroke="${wingE}" stroke-width="${n(h * 0.06)}" stroke-linecap="round"/>`);
    } else if (f.wing === "low") {
      out.push(`<path d="${P([[X(0.3), B - h * 0.08], [X(0.52), B - h * 0.18], [X(0.53), B - h * 0.04], [X(0.31), B + h * 0.06]])}" fill="url(#wg${id})" stroke="${wingE}" stroke-width=".9"/>`);
    } else if (f.wing === "delta") {
      out.push(`<path d="${P([[X(0.42), yc], [X(0.8), yc - h * 0.05], [X(0.84), yc + h * 0.15], [X(0.45), yc + h * 0.18]])}" fill="url(#wg${id})" stroke="${wingE}" stroke-width=".9"/>`);
    }

    // --- engines
    const nac = (x, y, l, hh, color) => {
      const c = color || `url(#en${id})`;
      return `<path d="M${n(x)} ${n(y - hh / 2)} L${n(x + l * 0.82)} ${n(y - hh * 0.42)} C${n(x + l * 0.95)} ${n(y - hh * 0.3)} ${n(x + l)} ${n(y - hh * 0.1)} ${n(x + l)} ${n(y)} C${n(x + l)} ${n(y + hh * 0.1)} ${n(x + l * 0.95)} ${n(y + hh * 0.3)} ${n(x + l * 0.82)} ${n(y + hh * 0.42)} L${n(x)} ${n(y + hh / 2)} C${n(x - hh * 0.12)} ${n(y + hh * 0.3)} ${n(x - hh * 0.12)} ${n(y - hh * 0.3)} ${n(x)} ${n(y - hh / 2)}Z" fill="${c}" stroke="${shade(body, -0.32)}" stroke-width=".9"/>
        <ellipse cx="${n(x + 1)}" cy="${n(y)}" rx="${n(hh * 0.1)}" ry="${n(hh * 0.42)}" fill="${shade(lv.engine || body, -0.45)}"/>
        <path d="M${n(x + l)} ${n(y - hh * 0.18)} L${n(x + l + hh * 0.35)} ${n(y)} L${n(x + l)} ${n(y + hh * 0.18)}Z" fill="${metal}"/>`;
    };
    if (f.eng === "wing") {
      const eh = h * (f.big ? 0.62 : 0.6), el = len * (f.big ? 0.13 : 0.125);
      if (f.n === 2) out.push(`<path d="M${X(0.47)} ${B - h * 0.38} L${X(0.47)} ${B - h * 0.1}" stroke="${wingE}" stroke-width="3"/>` + nac(X(0.44), B - h * 0.36, el * 0.9, eh * 0.85));
      out.push(`<path d="M${X(0.36)} ${B - h * 0.12} L${X(0.44)} ${B - h * 0.24}" stroke="${wingE}" stroke-width="${n(h * 0.12)}"/>` + nac(X(f.n === 2 ? 0.26 : 0.27), B + h * 0.05, el, eh));
    } else if (f.eng === "rear") {
      const eh = h * 0.46, el = len * 0.15;
      out.push(`<path d="M${X(0.7)} ${T + h * 0.3} L${X(0.74)} ${T + h * 0.05}" stroke="${wingE}" stroke-width="${n(h * 0.12)}"/>` + nac(X(0.64), T + h * 0.08, el, eh, lv.engine ? null : `url(#fb${id})`));
    } else if (f.eng === "prop2") {
      const nx = f.nose === "herc" ? [0.3, 0.38] : [0.3], ny = f.wing === "high" ? T + h * 0.05 : B - h * 0.12;
      for (const k of nx) {
        out.push(`<path d="M${n(X(k))} ${n(ny - h * 0.16)} L${n(X(k + 0.16))} ${n(ny - h * 0.1)} L${n(X(k + 0.16))} ${n(ny + h * 0.12)} L${n(X(k))} ${n(ny + h * 0.18)} C${n(X(k) - h * 0.2)} ${n(ny + h * 0.1)} ${n(X(k) - h * 0.2)} ${n(ny - h * 0.08)} ${n(X(k))} ${n(ny - h * 0.16)}Z" fill="url(#en${id})" stroke="${shade(body, -0.32)}" stroke-width=".9"/>`);
        out.push(propeller(X(k) - h * 0.22, ny, h * 0.85));
      }
    } else if (f.eng === "nose") {
      out.push(propeller(X0 + 3, yc - h * 0.04, h * 1.05));
    } else if (f.eng === "fighter") {
      out.push(`<path d="${P([[X(0.86), yc - h * 0.2], [X(1.0), yc - h * 0.12], [X(1.0), yc + h * 0.22], [X(0.86), yc + h * 0.3]])}" fill="${shade(body, -0.3)}"/>`);
    }
    if (f.ag) out.push(`<rect x="${X(0.28)}" y="${T - h * 0.15}" width="${len * 0.12}" height="${h * 0.35}" rx="4" fill="${tail}" opacity=".9"/>`);

    // --- titles + registration
    if (lv.name && !lv.mil && f.win) {
      const fs = Math.min(h * 0.27, 22);
      out.push(`<text x="${n(X(f.nose === "biz" || f.nose === "kingair" ? 0.25 : 0.14))}" y="${n(T + h * 0.3)}" font-family="'Helvetica Neue',Arial,sans-serif" font-weight="700" font-size="${n(fs)}" letter-spacing="-.3" fill="${lv.text || tail}">${esc(lv.name)}</text>`);
    }
    if (a.reg) out.push(`<text x="${n(X(f.nose === "piston" ? 0.55 : 0.68))}" y="${n(yc + h * (f.nose === "piston" ? 0.12 : 0.1))}" font-family="'Helvetica Neue',Arial,sans-serif" font-weight="700" font-size="${n(Math.max(8, Math.min(h * 0.16, 12)))}" fill="${lv.text === "#fff" ? "#fff" : shade(tail, -0.1)}">${esc(a.reg)}</text>`);
    return defs + out.join("");

    function propeller(cx, cy, dia) {
      return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(dia * 0.06)}" ry="${n(dia / 2)}" fill="#8b95a1" opacity=".22"/>
        <path d="M${n(cx)} ${n(cy - dia / 2)} L${n(cx + 1.5)} ${n(cy + dia / 2)}" stroke="#3b4350" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>
        <path d="M${n(cx + dia * 0.02)} ${n(cy - dia * 0.11)} C${n(cx - dia * 0.12)} ${n(cy - dia * 0.08)} ${n(cx - dia * 0.12)} ${n(cy + dia * 0.08)} ${n(cx + dia * 0.02)} ${n(cy + dia * 0.11)}Z" fill="${tail}"/>`;
    }
  }

  // ------------------------------------------------------------------ helicopter
  function heli(a, lv, id) {
    const body = lv.body || "#ffffff", tail = lv.tail, acc = lv.accent || shade(tail, 0.3);
    const twin = /EC45|H145|EC35|AS55|B412|B429|S76|A139|A109|H60|UH60|S92/.test(typeCode(a));
    const mil = /H60|UH60/.test(typeCode(a));
    const out = [`<defs><linearGradient id="hb${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(body, 0.12)}"/><stop offset=".55" stop-color="${body}"/><stop offset="1" stop-color="${shade(body, -0.15)}"/></linearGradient>
      <clipPath id="hc${id}"><path id="hp${id}" d="M150 150 C110 150 98 120 112 98 C124 80 160 66 210 64 L300 62 C330 62 350 70 360 84 L560 98 L572 100 L572 110 L356 122 C340 140 310 152 270 152Z"/></clipPath></defs>`];
    // tail fin + tail rotor
    out.push(`<path d="M540 100 L566 46 L590 46 L582 106 L556 112Z" fill="${tail}"/>`);
    out.push(`<path d="M520 118 L556 112 L560 122 L524 126Z" fill="${shade(tail, -0.1)}"/>`);
    out.push(`<ellipse cx="584" cy="70" rx="26" ry="26" fill="#8b95a1" opacity=".18"/><path d="M584 44 L584 96" stroke="#3b4350" stroke-width="2.4" opacity=".7"/><circle cx="584" cy="70" r="4" fill="#3b4350"/>`);
    // body
    out.push(`<use href="#hp${id}" fill="url(#hb${id})" stroke="${shade(body, -0.3)}" stroke-width="1"/>`);
    out.push(`<g clip-path="url(#hc${id})"><path d="M100 122 C200 128 300 120 600 96 L600 170 L100 170Z" fill="${lv.belly || tail}"/><path d="M100 116 C200 122 300 114 600 92 L600 96 C300 118 200 126 100 120Z" fill="${acc}"/></g>`);
    // canopy + windows
    out.push(`<path d="M118 100 C126 84 150 74 186 70 L196 70 L198 106 L130 108 C122 108 116 105 118 100Z" fill="#1e2a3c" opacity=".9"/>`);
    out.push(`<path d="M210 74 L262 72 L262 104 L210 106Z" fill="#1e2a3c" opacity=".85"/>${twin ? `<path d="M274 72 L318 72 C326 74 330 80 330 88 L330 102 L274 104Z" fill="#1e2a3c" opacity=".85"/>` : ""}`);
    // engine cowling + mast + rotor
    out.push(`<path d="M220 64 C230 46 300 42 340 50 C352 54 356 62 352 70 L224 68Z" fill="${shade(body, -0.06)}" stroke="${shade(body, -0.3)}" stroke-width="1"/>`);
    out.push(`<rect x="270" y="30" width="8" height="18" fill="#4a5361"/><path d="M40 30 L520 24" stroke="#3b4350" stroke-width="3.4" stroke-linecap="round" opacity=".8"/><ellipse cx="274" cy="28" rx="14" ry="5" fill="#4a5361"/>`);
    // skids or wheels
    if (mil || /S76|A139|A109|B429|S92/.test(typeCode(a))) out.push(`<circle cx="170" cy="160" r="9" fill="#2b313a"/><circle cx="320" cy="162" r="9" fill="#2b313a"/>`);
    else out.push(`<path d="M150 150 L140 170 M300 150 L310 170" stroke="#5d6672" stroke-width="5" stroke-linecap="round"/><path d="M96 172 C100 164 108 170 120 170 L360 170 C370 170 372 166 374 162" fill="none" stroke="#5d6672" stroke-width="5" stroke-linecap="round"/>`);
    if (a.reg) out.push(`<text x="410" y="${108}" font-family="'Helvetica Neue',Arial,sans-serif" font-weight="700" font-size="13" fill="${shade(tail, -0.1)}">${esc(a.reg)}</text>`);
    return out.join("");
  }

  function acProfile(a) {
    a = a || {};
    const fk = family(a), f = FAM[fk];
    const lv = livery(a, f);
    const id = ++uid;
    const inner = f.heli ? heli(a, lv, id) : plane(a, f, lv, id);
    const label = `${typeName(a) || "Aircraft"} side profile`;
    return `<svg class="ac-profile" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  }

  // A small card: profile + "Boeing 737-900 · United" caption. Styles are inline so
  // every view (map, console, briefing) can drop it in without new CSS.
  // Licensed illustrations (e.g. bought from a stock artist) can be dropped into
  // /static/ac-art/ and listed in manifest.json as {"UAL_A319": "file.webp", "A319": "…"}.
  // Airline+type wins, then type alone, else the generated drawing.
  let ART = {};
  try { fetch("/static/ac-art/manifest.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : {}).then((j) => { ART = j || {}; }).catch(() => {}); } catch (e) {}
  function artFor(a) {
    const t = typeCode(a), p = prefix(a.callsign);
    const f = (p && ART[`${p}_${t}`]) || ART[t];
    return f ? `/static/ac-art/${encodeURIComponent(f)}` : "";
  }

  function acProfileCard(a) {
    const al = airline(a), name = typeName(a);
    const cap = [name, al && al.name].filter(Boolean).join(" · ");
    const art = artFor(a);
    if (art) return `<figure class="ac-profile-card" style="margin:8px 0 4px;padding:6px 4px 8px;border-radius:12px;background:#fff;border:1px solid rgba(120,130,145,.18)">
      <img src="${esc(art)}" alt="${esc(name)}" style="display:block;width:100%;height:auto" loading="lazy">
      ${cap ? `<figcaption style="text-align:center;font:600 12.5px/1.3 system-ui,sans-serif;color:#3b4554;margin-top:2px">${esc(cap)}</figcaption>` : ""}</figure>`;
    return `<figure class="ac-profile-card" style="margin:8px 0 4px;padding:6px 4px 8px;border-radius:12px;background:linear-gradient(#fbfcfd,#eef1f4);border:1px solid rgba(120,130,145,.18)">
      ${acProfile(a).replace('<svg class="ac-profile"', '<svg class="ac-profile" style="display:block;width:100%;height:auto"')}
      ${cap ? `<figcaption style="text-align:center;font:600 12.5px/1.3 system-ui,sans-serif;color:#3b4554;margin-top:2px">${esc(cap)}</figcaption>` : ""}
      <div style="text-align:center;font:500 10.5px/1.2 system-ui,sans-serif;color:#8a93a0;margin-top:2px">Illustration, colours approximate</div></figure>`;
  }

  // One ACARS message in plain English, with the raw text one tap away.
  function acarsHuman(m) {
    const h = m.human || {};
    const al = AIRLINES[prefix(m.flight ? m.flight.replace(/^([A-Z0-9]{2})(\d)/, (x, a, d) => (IATA2ICAO[a] || a) + d) : "")];
    const who = al ? `<span style="color:#7a8493;font-weight:500"> ${esc(al.name)}</span>` : "";
    return `${who}${h.tag ? `<span style="display:inline-block;margin:0 0 0 6px;padding:1px 7px;border-radius:999px;background:rgba(70,110,170,.12);color:#2c5a96;font:600 11px/1.5 system-ui,sans-serif;vertical-align:1px">${esc(h.tag)}</span>` : ""}
      <div class="ah-text" style="font:400 13.5px/1.45 system-ui,sans-serif;margin-top:3px;white-space:normal">${esc(h.text || "")}</div>
      <details style="margin-top:2px"><summary style="cursor:pointer;font:500 11px system-ui,sans-serif;color:#8a93a0">raw message${m.label ? ` · label ${esc(m.label)}` : ""}</summary><code style="display:block;white-space:pre-wrap;font:11.5px/1.4 ui-monospace,Menlo,monospace;color:#6b7482;margin-top:3px">${esc(m.text || "")}</code></details>`;
  }
  const IATA2ICAO = { UA: "UAL", AA: "AAL", DL: "DAL", WN: "SWA", B6: "JBU", NK: "NKS", F9: "FFT", G4: "AAY", AS: "ASA", VB: "VIV", Y4: "VOI",
    AM: "AMX", "5X": "UPS", FX: "FDX", LH: "DLH", KL: "KLM", AC: "ACA", WS: "WJA", BA: "BAW", AF: "AFR", NW: "DAL", US: "AAL", CO: "UAL", OO: "SKW", YX: "RPA", MQ: "ENY" };
  window.acarsHuman = acarsHuman;
  window.acProfile = acProfile;
  window.acProfileCard = acProfileCard;
  window.acTypeName = typeName;
  window.acAirline = airline;
  window.acAirports = null;
})();
