// JAFO Live front door: the Briefing, with a "Near me" lens.
// Reading-first: the radio, written up like a calm local news app. The map is one tap away.
// Vanilla JS + Leaflet. Talks to /api/live/* (pi/web/live.py, pi/web/air.py).
(() => {
"use strict";
const CFG = window.JAFO_LIVE || {};
const CAN_PLAY = !!CFG.audio;
const QS = new URLSearchParams(location.search);
const DEMO = QS.get("demo") === "1";
const REGION_LABEL = CFG.regionName === "Lower Rio Grande Valley" ? "the Valley" : CFG.regionName || "the region";
const MI = 1609.344;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("jafo.brief." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("jafo.brief." + k, JSON.stringify(v)); } catch (e) {} },
};
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------------------------------------------------------- glyphs
const KIND_ICON = {
  violence: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  traffic: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3.5 16h17M7 19v-3M17 19v-3M7.5 12.5h.01M16.5 12.5h.01"/>',
  medical: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11.5h2l1-2 1.5 4 1-2h1"/>',
  property: '<path d="M4 11 12 4l8 7v9H4v-9z"/><path d="M10 20v-5h4v5"/>',
  suspicious: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
  other: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
};
const KIND_LABEL = { violence: "Violence and danger", traffic: "Traffic", medical: "Medical and welfare",
  property: "Property and alarms", suspicious: "Suspicious and disputes", fire: "Fire", other: "Other calls" };
const KIND_NOUN = { violence: "a safety call", traffic: "a traffic call", medical: "a medical call", property: "a property call",
  suspicious: "a suspicious-activity call", fire: "a fire call", other: "a call" };
const KINDS = Object.keys(KIND_LABEL);
const kk = (k) => (KIND_ICON[k] ? k : "other");
const kindSvg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
const kico = (k, cls = "") => `<span class="kico k-${esc(kk(k))} ${cls}" title="${esc(KIND_LABEL[k] || "Other")}">${kindSvg(k)}</span>`;
const SVC_LABEL = { police: "Police", fire: "Fire", ems: "EMS", other: "Other" };
const HELI_P = '<path d="M3 5h18M12 5v3"/><path d="M6.5 13.5c0-3 2.4-5.5 5.5-5.5h1.5c2.5 0 4.5 2 4.5 4.5V14H6.5z"/><path d="M18 11h3.5M8 18h9M10 14v4M15 14v4"/>';
const I = {
  play: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" class="ico sm"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  map: '<svg viewBox="0 0 24 24" class="ico sm"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  heli: `<svg viewBox="0 0 24 24" class="ico">${HELI_P}</svg>`,
  plane: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M12 2.5c.8 0 1.3.9 1.3 2v5.3l7.2 4.3v1.9l-7.2-2.2v4.6l2.2 1.7v1.5L12 20.7l-3.5.9v-1.5l2.2-1.7v-4.6l-7.2 2.2v-1.9l7.2-4.3V4.5c0-1.1.5-2 1.3-2z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" class="ico sm"><path d="m6 9 6 6 6-6"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  share: '<svg viewBox="0 0 24 24" class="ico sm"><path d="M12 15V3M7 8l5-5 5 5M5 13v7h14v-7"/></svg>',
};
const PLACE_ICO = {
  home: '<path d="M4 11 12 4l8 7v9h-5v-6h-6v6H4z"/>',
  work: '<path d="M4 8h16v11H4zM9 8V5h6v3M4 13h16"/>',
  school: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/>',
  town: '<path d="M3 21V10l5-3v14M8 21V4l8 4v13M16 21v-9l5 2v7M3 21h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  me: '<path d="M12 2 4 20l8-4 8 4-8-18z"/>',
};
const psvg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PLACE_ICO[k] || PLACE_ICO.pin}</svg>`;
// who's working it (responders[].key from the API)
const RESP_ICON = {
  police: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z"/>',
  fire: KIND_ICON.fire,
  ems: '<path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"/>',
  hazmat: '<circle cx="12" cy="12" r="2"/><path d="M12 3a4.5 4.5 0 0 1 0 7M4.2 17a4.5 4.5 0 0 1 6-3.4M19.8 17a4.5 4.5 0 0 0-6-3.4"/>',
  air: HELI_P,
  k9: '<circle cx="6.5" cy="10" r="1.6"/><circle cx="10" cy="6" r="1.6"/><circle cx="14" cy="6" r="1.6"/><circle cx="17.5" cy="10" r="1.6"/><path d="M8.5 17.5c0-2.6 1.6-4.8 3.5-4.8s3.5 2.2 3.5 4.8c0 1.6-1.6 2.2-3.5 1.6-1.9.6-3.5 0-3.5-1.6z"/>',
  swat: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  command: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4l-5.3 3 1.2-6L3.4 9.3l6-.7z"/>',
  rescue: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="m6.3 6.3 3.2 3.2M14.5 14.5l3.2 3.2M17.7 6.3l-3.2 3.2M9.5 14.5l-3.2 3.2"/>',
  ladder: '<path d="M8 3v18M16 3v18M8 7h8M8 12h8M8 17h8"/>',
  tow: '<path d="M12 3v9.5a3 3 0 1 1-3 3"/><path d="M8 3h8"/>',
  utility: '<path d="M13 2 5 14h6l-1 8 8-12h-6z"/>',
  examiner: '<path d="M8 4h8v3H8zM6.5 5.5H5V21h14V5.5h-1.5M9 12h6M9 16h4"/>',
  border: '<path d="M12 3 4 7v4c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V7z"/><path d="m12 8 1.3 2.7 3 .4-2.2 2 .6 3L12 14.7 9.3 16l.6-3-2.2-2 3-.4z"/>',
  dps: '<path d="M6 14l1.5-6c3-1.5 6-1.5 9 0L18 14"/><path d="M3 15c3-1 6-1.5 9-1.5s6 .5 9 1.5c0 2-4 3-9 3s-9-1-9-3z"/>',
  other: KIND_ICON.other,
};
const RESP_SHORT = { police: "Police", fire: "Fire", ems: "EMS", hazmat: "Hazmat", air: "Air unit", k9: "K-9", swat: "SWAT",
  command: "Command", rescue: "Rescue", ladder: "Ladder", tow: "Tow", utility: "Utility", examiner: "Examiner", border: "Border Patrol", dps: "Troopers", other: "Units" };
function respChips(i, max = 5) {
  const rs = (i.responders || []).slice(0, max);
  return rs.map((r) => `<span class="resp r-${esc(r.key)}" title="${esc(r.label)}${r.n > 1 ? ` (${r.n})` : ""}"><svg viewBox="0 0 24 24" aria-hidden="true">${RESP_ICON[r.key] || RESP_ICON.other}</svg>${["police", "fire", "ems", "other"].includes(r.key) && r.n > 1 ? `${r.n} ` : ""}${esc(RESP_SHORT[r.key] || r.label)}</span>`).join("");
}
const STATUS = {
  new: { label: "Just reported", shape: '<path d="M12 4l2.2 5.8L20 12l-5.8 2.2L12 20l-2.2-5.8L4 12l5.8-2.2z"/>' },
  en_route: { label: "Help on the way", shape: '<path d="M4 12h13M12 6l6 6-6 6"/>' },
  on_scene: { label: "Crews on scene", shape: '<circle cx="12" cy="12" r="5" class="f"/><circle cx="12" cy="12" r="9"/>' },
  quiet: { label: "Quiet", shape: '<circle cx="12" cy="12" r="6"/>' },
  cleared: { label: "Wrapped up", shape: '<path d="m5 12.5 4.5 4.5L19 7.5"/>' },
  ended: { label: "Wrapped up", shape: '<path d="m5 12.5 4.5 4.5L19 7.5"/>' },
};
const pill = (st) => { const s = STATUS[st] || STATUS.quiet; return `<span class="pill st-${esc(st || "quiet")}"><svg viewBox="0 0 24 24" aria-hidden="true">${s.shape}</svg>${s.label}</span>`; };
const UNIT_ST = { dispatched: "Dispatched", en_route: "On the way", on_scene: "On scene", transporting: "Taking a patient", busy: "Busy", available: "Available", cleared: "Cleared", unknown: "Heard", left: "Moved on" };

// ---------------------------------------------------------------- time (always the region's clock)
const TZ = CFG.tz || undefined;
const now = () => Math.floor(Date.now() / 1000);
const tfmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const dfmt = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: TZ });
const wdfmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ });
const dayKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const fmtTime = (ts) => ts ? tfmt.format(new Date(ts * 1000)).toLowerCase().replace(" ", "\u202f") : "";
const fmtDate = (ts) => dfmt.format(new Date(ts * 1000));
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return "just now";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm && h < 3 ? `${h} hr ${mm} min` : `${h} hr`;
  const d = Math.floor(h / 24); return `${d} day${d > 1 ? "s" : ""}`;
}
const ago = (ts) => { const d = fmtDur(now() - ts); return d === "just now" ? d : d + " ago"; };
const NUMW = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
const numw = (n, lower) => { const w = n < NUMW.length ? NUMW[n] : String(n); return lower ? w.toLowerCase() : w; };
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

// ---------------------------------------------------------------- geo
function miles(a, b, c, d) {
  const R = 3958.8, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = p2 - p1, dl = (d - b) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b, c, d) {
  const p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dl = (d - b) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const DIR8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DIR_WORD = { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" };
const dir8 = (deg) => DIR8[Math.round(deg / 45) % 8];
function fmtMi(d) {
  if (d < 0.15) return "here";
  if (d < 0.375) return "¼ mi";
  if (d < 0.625) return "½ mi";
  if (d < 0.875) return "¾ mi";
  if (d < 10) return `${d.toFixed(1)} mi`;
  return `${Math.round(d)} mi`;
}
const RADII = [0.5, 1, 3, 10];
const RWORD = { 0.5: "½ mile", 1: "a mile", 3: "3 miles", 10: "10 miles" };
const RLBL = { 0.5: "½ mi", 1: "1 mi", 3: "3 mi", 10: "10 mi" };
function relWords(x, long = true) {
  if (x.dist == null) return "location unknown";
  if (x.rough) return `somewhere in ${x.city || "town"}`;
  if (x.dist < 0.15) return "right here";
  return `${fmtMi(x.dist)} ${long ? DIR_WORD[x.dir] : x.dir}`;
}

// ---------------------------------------------------------------- api
async function api(path, params = {}) {
  const u = new URL(path, location.origin);
  if (!("region" in params)) params.region = CFG.region;
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800); }

// ---------------------------------------------------------------- state
function loadPlaces() {
  let p = store.get("places", null);
  if (!p) {  // carry over places saved in the Neighborhood lens prototype
    try { const old = JSON.parse(localStorage.getItem("jafo.near.places") || "null"); if (Array.isArray(old)) p = old.filter((x) => !x.example && x.lat != null); } catch (e) {}
  }
  return Array.isArray(p) ? p.filter((x) => x && typeof x.lat === "number" && typeof x.lng === "number") : [];
}
const S = {
  items: [], wrapped: [], pulse: null, radio: [], air: null, weather: null,
  detail: new Map(), extra: new Map(),   // extra: stories opened by link that aren't in the current lists
  open: new Set(), words: new Set(),
  f: Object.assign({ svc: "", win: "active", kinds: [] }, store.get("f", {})),
  q: "", sig: "", loaded: false,
  audio: new Audio(), playing: null,
  lens: "brief",
  places: loadPlaces(), placeId: store.get("sel", null), temp: null,
  radius: RADII.includes(store.get("radius", 1)) ? store.get("radius", 1) : 1,
  hist: null, picking: false,
};
S.audio.preload = "none";
if (!["active", "4h", "8h", "12h", "24h", "7d"].includes(S.f.win)) S.f.win = "active";
const WIN_PHRASE = { "4h": "in the last 4 hours", "8h": "in the last 8 hours", "12h": "in the last 12 hours", "24h": "in the last 24 hours", "7d": "this week" };
const WIN_LABEL = { active: "Right now", "4h": "Last 4 hours", "8h": "Last 8 hours", "12h": "Last 12 hours", "24h": "Last 24 hours", "7d": "This week" };
const winPhrase = () => WIN_PHRASE[S.f.win] || "today";
const byScore = (a, b) => (b.score || 0) - (a.score || 0) || b.last_at - a.last_at;
const place = () => (S.placeId === "tmp" && S.temp) ? S.temp : (S.places.find((p) => p.id === S.placeId) || S.places[0] || S.temp || null);
const savePlaces = () => { store.set("places", S.places); store.set("sel", S.placeId); };
const allItems = () => { const m = new Map(); for (const i of [...S.extra.values(), ...S.wrapped, ...S.items]) m.set(i.id, i); return [...m.values()]; };
const findItem = (id) => S.items.find((x) => x.id === id) || S.wrapped.find((x) => x.id === id) || S.extra.get(id);

// ---------------------------------------------------------------- text helpers
function rich(text, codes = []) {
  let h = esc(text);
  h = h.replace(/⟦[^⟧]*⟧/g, '<span class="hid" title="Hidden for privacy">hidden</span>');
  for (const c of codes || []) {
    if (!c.code || c.code.length < 2) continue;
    const re = new RegExp(`(^|[^\\w-])(${esc(c.code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]?")})(?![\\w])`, "gi");
    h = h.replace(re, `$1<abbr class="code" title="${esc(c.meaning)}">$2</abbr>`);
  }
  return h;
}
const callText = (c) => c.line || (c.speakers || []).map((s) => s.text).join(" ").trim() || "(no speech)";
const isChatter = (c) => /chatter|unclear/i.test(c.type || "") || /^brief, unclear/i.test(c.line || "");
const streetOf = (i) => (i.location || "").replace(/^\d+\s*(?:hundred\s+)?block of\s+/i, "").replace(/^\d+\s+(?=\D)/, "").trim();
function placeOf(i, withPrep) {
  const st = streetOf(i), city = i.city;
  if (!st && !city) return withPrep ? "" : "Location not given";
  if (!withPrep) return [st, city].filter(Boolean).join(", ");
  const prep = /(&| and | at |\/)/i.test(st) ? "at" : "on";
  return st ? ` ${prep} ${st}${city ? " in " + city : ""}` : ` in ${city}`;
}
const onThis = (i) => (i.unit_list || []).filter((u) => u.status !== "left");
function unitsPhrase(i) {
  const list = onThis(i);
  if (list.length === 1) return { txt: list[0].callsign, one: true };
  const u = i.units || {}, parts = [];
  if (u.police) parts.push(u.police === 1 ? "a police officer" : `${numw(u.police, true)} police units`);
  if (u.fire) parts.push(u.fire === 1 ? "a fire crew" : `${numw(u.fire, true)} fire crews`);
  if (u.ems) parts.push(u.ems === 1 ? "an ambulance" : `${numw(u.ems, true)} ambulances`);
  if (!parts.length) return list.length ? { txt: `${numw(list.length, true)} units`, one: false } : null;
  return { txt: parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts.at(-1) : parts[0], one: parts.length === 1 && /^an? /.test(parts[0]) };
}
function statusClause(i) {
  const up = unitsPhrase(i);
  const who = up ? up.txt : "crews", is = up ? (up.one ? "is" : "are") : "are";
  if (i.status === "on_scene") return `${who} ${is} on scene`;
  if (i.status === "en_route") return `${who} ${is} on the way`;
  if (i.status === "new") return up ? `${who} ${is} being sent` : "it was just called in";
  if (i.closed) return "it has wrapped up";
  return "the radio has gone quiet on it";
}
function nounFor(it) {
  const t = (it.type || "").trim();
  if (t && !/^(other|unknown|radio chatter|status update)$/i.test(t)) { const n = t.toLowerCase(); return (/^(?:[aeio]|u(?![nst][aeiou])|hono|hour)/.test(n) ? "an " : "a ") + n; }
  return KIND_NOUN[it.kind] || KIND_NOUN.other;
}
function whoIsThere(it) {
  const u = it.units || {}, w = [];
  if (u.police) w.push("police"); if (u.fire) w.push("firefighters"); if (u.ems) w.push(u.ems > 1 ? "ambulances" : "an ambulance");
  return w.length ? w.join(" and ") : (it.service === "fire" ? "firefighters" : it.service === "ems" ? "an ambulance" : "crews");
}
function statusPhrase(it) {
  if (it.closed) return "wrapped up";
  switch (it.status) {
    case "on_scene": return `${whoIsThere(it)} on scene`;
    case "en_route": return `${whoIsThere(it)} on the way`;
    case "new": return "just reported";
    case "quiet": return "winding down";
    default: return "handled";
  }
}
const unitTotal = (i) => Object.values(i.units || {}).reduce((a, b) => a + (+b || 0), 0);
const SEV = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1 };
const byImportance = (a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || unitTotal(b) - unitTotal(a) || b.last_at - a.last_at;
const isDeveloping = (i) => !i.closed && ((SEV[i.severity] || 0) >= 3 || ["on_scene", "en_route"].includes(i.status) || unitTotal(i) > 0 || !!airOver(i.id));

// ---------------------------------------------------------------- filters
function passes(i) {
  const f = S.f;
  if (f.svc && i.service !== f.svc && !((i.units || {})[f.svc] > 0)) return false;
  if (f.kinds.length && !f.kinds.includes(kk(i.kind))) return false;
  if (S.q) {
    const hay = [i.title, i.summary, i.location, i.city, i.type, KIND_LABEL[i.kind], (i.unit_list || []).map((u) => u.callsign).join(" ")].join(" ").toLowerCase();
    if (!S.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
const saveF = () => store.set("f", S.f);
const filtered = () => !!(S.f.svc || S.f.kinds.length || S.q);

// ---------------------------------------------------------------- near: distances
function decorate(it, p) {
  if (p && it.lat != null && it.lng != null) {
    it.dist = miles(p.lat, p.lng, it.lat, it.lng); it.deg = bearing(p.lat, p.lng, it.lat, it.lng); it.dir = dir8(it.deg);
  } else { it.dist = null; it.deg = null; it.dir = null; }
  it.rough = !it.precision || it.precision === "city";
  return it;
}
// What the near lens is about: { inR: in radius, rough: only the town is known, far: everything else }
function nearSets() {
  const p = place(), r = S.radius, t = now();
  const pool = (S.f.win === "active" ? [...S.items, ...S.wrapped] : S.items).filter(passes);
  pool.forEach((i) => decorate(i, p));
  if (!p) return { p, inR: [], rough: [], far: pool };
  const score = (it) => it.dist + ((t - (it.last_at || t)) / 3600) * 0.5 - (it.closed ? 0 : 1.5);
  const inR = pool.filter((i) => !i.rough && i.dist != null && i.dist <= r).sort((a, b) => score(a) - score(b));
  const rough = pool.filter((i) => i.rough && i.dist != null && i.dist <= Math.max(r, 3)).sort((a, b) => b.last_at - a.last_at);
  const far = pool.filter((i) => !inR.includes(i) && !rough.includes(i)).sort((a, b) => (a.closed - b.closed) || ((a.dist ?? 999) - (b.dist ?? 999)));
  return { p, inR, rough, far };
}

// ---------------------------------------------------------------- loading
let lastWrapped = 0;
async function loadIncidents(force) {
  const p = { window: S.f.win === "active" && DEMO ? "24h" : S.f.win };
  const d = await api("/api/live/incidents", p);
  let items = d.items || [];
  if (S.f.win === "active") {
    if (DEMO) { S.wrapped = items.filter((i) => i.closed); items = items.filter((i) => !i.closed); }
    else if (force || Date.now() - lastWrapped > 60000) {
      lastWrapped = Date.now();
      const since = S.pulse?.today?.since || now() - 86400;
      try { const w = await api("/api/live/incidents", { window: "24h" }); S.wrapped = (w.items || []).filter((i) => i.closed && i.last_at >= since); } catch (e) {}
    }
  } else S.wrapped = [];
  S.items = items; S.loaded = true;
  for (const id of S.extra.keys()) if (S.items.some((x) => x.id === id) || S.wrapped.some((x) => x.id === id)) S.extra.delete(id);
  refreshOpenDetails();
  render();
}
async function refreshOpenDetails() {
  for (const id of S.open) {
    const it = findItem(id), d = S.detail.get(id);
    if (it && d && d.last_at !== it.last_at) { try { S.detail.set(id, await api(`/api/live/incidents/${id}`)); render(true); } catch (e) {} }
  }
}
async function getDetail(id) {
  const it = findItem(id), c = S.detail.get(id);
  if (c && (!it || c.last_at === it.last_at)) return c;
  const d = await api(`/api/live/incidents/${id}`); S.detail.set(id, d); return d;
}
async function loadPulse() { try { S.pulse = await api("/api/live/pulse"); renderBrief(); renderSpark(); } catch (e) {} }
async function loadRadio() { try { const d = await api("/api/live/radio", { limit: 30, hide_chatter: 1 }); S.radio = d.items || []; renderTicker(); } catch (e) {} }
async function loadAir() {
  try { S.air = await api("/api/live/air", DEMO ? { demo: 1 } : {}); } catch (e) { S.air = null; }
  renderAirRail(); renderAirCluster(); renderBrief(); if (S.lens === "near") { renderVerdict(); drawRingAir(); }
  updateMapAir(); $$(".card").forEach(updateAirChip);
  if (panelKind === "air") renderAirPanel();
}
async function loadWeather() {
  try {
    const w = S.weather = await api("/api/live/weather"); const n = w.now || {};
    if (n.temp != null) { $("#wx").hidden = false; $("#wx").innerHTML = `<b>${Math.round(n.temp)}°</b> ${esc(n.text || "")}${w.forecast?.[0] ? ` <span class="dim">· ${esc(w.forecast[0].name)} ${esc(w.forecast[0].temp)}°, ${esc((w.forecast[0].short || "").toLowerCase())}</span>` : ""}`; }
    const al = w.alerts || [];
    $("#wx-alert").hidden = !al.length;
    if (al.length) $("#wx-alert").innerHTML = al.slice(0, 2).map((a) => `<div><b>${esc(a.event || a.headline || "Weather alert")}</b> ${esc(a.headline && a.event ? a.headline : a.area || "")}</div>`).join("");
    if (S.lens === "near") renderVerdict();
  } catch (e) {}
}
async function presence() {
  let id = store.get("cid", null); if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("cid", id); }
  try { const d = await post("/api/live/presence", { client_id: id, region: CFG.region }); if (d.watching) $("#watching").textContent = `${d.watching} watching now`; } catch (e) {}
}

// ---------------------------------------------------------------- the briefing (signature paragraph)
function aircraftName(a) {
  const R = { border: "Border Patrol helicopter", medical: "medical helicopter", police: "police helicopter", news: "TV news helicopter", military: "military aircraft" };
  if (a.role && R[a.role]) return a.role === "military" && a.kind !== "helicopter" ? `military ${a.type || "aircraft"}` : (a.kind === "helicopter" || a.role === "military" ? R[a.role] : `${a.role} aircraft`);
  if (a.kind === "helicopter") return "helicopter";
  if (a.kind === "light") return "small plane";
  if (a.kind === "commercial" || a.kind === "airline") return "airliner";
  return a.kind || "aircraft";
}
function ent(i) {
  const [w0, ...rest] = String(i.title || i.type || "this call").split(" ");
  return `<a class="ent k-${esc(kk(i.kind))}" href="#i/${i.id}" data-goto="${i.id}"><span class="nw">${kindSvg(i.kind)}${esc(w0)}</span>${rest.length ? " " + esc(rest.join(" ")) : ""}</a>`;
}
function renderBrief() {
  const p = S.pulse;
  $("#dateline").textContent = fmtDate(p?.now || now()) + " · " + fmtTime(p?.now || now());
  if (S.lens !== "brief") return;
  if (!S.loaded) return;
  const act = S.items.filter((i) => !i.closed).filter(passes).sort(byImportance);
  const where = `across ${esc(REGION_LABEL)}`, fl = filtered();
  const out = [];
  $("#brief-label").textContent = WIN_LABEL[S.f.win] || "Right now";
  document.body.classList.toggle("span", S.f.win !== "active");
  if (S.f.win !== "active") out.push(...recap(fl));
  else if (!act.length) {
    const w = S.wrapped.filter(passes).length;
    out.push(`It's quiet ${where}. Nothing ${fl ? "matching your filters " : ""}is active on the radio right now${w ? `, and ${numw(w, true)} ${w === 1 ? "call has" : "calls have"} wrapped up today` : ""}.`);
  } else {
    const serious = act.filter((i) => (SEV[i.severity] || 0) >= 3).length;
    out.push(`${numw(act.length)} ${act.length === 1 ? "thing is" : "things are"} happening ${where}${serious && act.length > 1 ? `, ${serious === act.length ? "all" : numw(serious, true)} of them serious` : ""}${fl ? " that match your filters" : ""}.`);
    const [a, b, c] = act;
    out.push(`${act.length > 1 ? "The biggest: " : ""}${ent(a)}${esc(placeOf(a, true))}, where ${esc(statusClause(a))}.`);
    if (b) out.push(`Also ${ent(b)}${esc(placeOf(b, true))}${c ? `, plus ${numw(act.length - 2, true)} more below` : `, where ${esc(statusClause(b))}`}.`);
  }
  const air = S.air?.aircraft || [];
  const em = air.find((x) => x.emergency);
  const over = air.find((x) => x.near_incident && x.kind === "helicopter");
  if (em) out.push(`Overhead, <a class="ent em" href="#air" data-air="${esc(em.hex)}">${I.plane}a ${esc(aircraftName(em))} is signaling an emergency</a>${em.emergency === "7700" ? "" : ` (code ${esc(em.emergency)})`}.`);
  else if (over) {
    const inc = findItem(over.near_incident.id);
    out.push(`A ${esc(aircraftName(over))} is ${over.circling ? "circling" : "flying"} over ${inc ? ent(inc) : "an active call"}.`);
  } else {  // only name aircraft worth a sentence: helicopters and agency/medical/military flights
    const notable = air.filter((x) => x.role || x.kind === "helicopter");
    if (notable.length) out.push(`Overhead, a ${esc(aircraftName(notable[0]))}${notable.length > 1 ? ` and ${numw(notable.length - 1, true)} other aircraft worth noticing` : ""}.`);
  }
  $("#lede").innerHTML = out.join(" ");
  if (p) {
    const h = p.headline || {}, d = (h.calls_1h || 0) - (h.calls_prev_1h || 0);
    const trend = !h.calls_prev_1h ? "" : Math.abs(d) / h.calls_prev_1h < 0.12 ? "about normal" : d > 0 ? "busier than the hour before" : "quieter than the hour before";
    const wr = S.f.win === "active" && !DEMO ? S.wrapped.length : p.cleared_24h || 0;
    $("#vitals").innerHTML = `<div><b>${h.calls_1h ?? "–"}</b> radio calls in the last hour${trend ? `, ${trend}` : ""}</div>
      <div><b>${h.units_out ?? 0}</b> units out · <b>${wr}</b> wrapped up ${S.f.win === "active" && !DEMO ? "today" : "in 24 hours"}${p.pipeline?.lag_sec > 300 ? ` · <span class="lag">running ${fmtDur(p.pipeline.lag_sec)} behind</span>` : ""}</div>`;
  }
}

// A plain-English recap of a time window: how busy, what kinds, and the biggest
// incidents (server-ranked by severity, units, radio, special resources, length).
const KIND_SHORT = { violence: "safety calls", traffic: "traffic calls", medical: "medical calls", property: "property calls",
  suspicious: "suspicious-activity calls", fire: "fire calls", other: "other calls" };
function recap(fl) {
  const all = S.items.filter(passes), out = [];
  const ph = winPhrase();
  if (!all.length) return [`Nothing ${fl ? "matching your filters " : ""}came over the radio ${ph}.`];
  const kinds = {};
  for (const i of all) if (i.kind && i.kind !== "other") kinds[i.kind] = (kinds[i.kind] || 0) + 1;
  const top = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${numw(n, true)} ${KIND_SHORT[k] || "other calls"}`);
  const live = all.filter((i) => !i.closed).length;
  out.push(`${cap(ph)}, JAFO followed ${numw(all.length, true)} ${all.length === 1 ? "incident" : "incidents"} across ${esc(REGION_LABEL)}${fl ? " that match your filters" : ""}${top.length > 1 ? `: mostly ${top.slice(0, -1).join(", ")} and ${top[top.length - 1]}` : ""}.`);
  const big = all.slice().sort(byScore).slice(0, 3);
  const town = (i) => i.city && !(i.title || "").toLowerCase().includes(i.city.toLowerCase()) ? ` in ${esc(i.city)}` : "";
  const told = (i) => `${ent(i)}${town(i)}${bigDetail(i)}`;
  if (big[0]) out.push(`The biggest was ${told(big[0])}.`);
  if (big[1]) out.push(`Also notable: ${told(big[1])}${big[2] ? `, and ${told(big[2])}` : ""}.`);
  if (live) out.push(`${cap(numw(live, true))} ${live === 1 ? "is" : "are"} still going.`);
  return out;
}
function bigDetail(i) {
  const bits = [], u = (i.unit_list || []).length;
  if (u >= 2) bits.push(`${numw(u, true)} units`);
  else if ((i.calls || 0) >= 6) bits.push(`${i.calls} radio calls`);
  const sp = (i.responders || []).filter((r) => !["police", "fire", "ems", "other", "command"].includes(r.key)).map((r) => RESP_SHORT[r.key] || r.label);
  if (sp.length) bits.push(sp.slice(0, 2).join(" and "));
  const when = i.closed ? `from ${fmtTime(i.first_at)}` : `since ${fmtTime(i.first_at)}, still going`;
  return ` (${[when, ...bits].join(", ")})`;
}

// ---------------------------------------------------------------- sparkline (24h of 10-min bins)
function renderSpark() {
  const p = S.pulse; const el = $("#spark"); if (!p?.bins_10min?.length) { el.hidden = true; return; }
  el.hidden = false;
  const v = p.bins_10min.map((b) => b.calls || 0), n = v.length, W = 240, H = 44, max = Math.max(1, ...v);
  const x = (k) => (k / (n - 1)) * W, y = (c) => H - 3 - (c / max) * (H - 8);
  const line = v.map((c, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(c).toFixed(1)}`).join("");
  const t0 = p.bins_start;
  el.innerHTML = `<figcaption>Radio, last 24 hours</figcaption>
    <div class="sp-wrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Radio calls per 10 minutes over the last 24 hours, peak ${max}">
      <path class="sp-area" d="${line}L${W},${H}L0,${H}Z"/><path class="sp-line" d="${line}"/>
      <circle class="sp-now" cx="${x(n - 1)}" cy="${y(v[n - 1])}" r="2.6"/><line class="sp-x" x1="0" x2="0" y1="0" y2="${H}" hidden/>
    </svg><div class="sp-tip" hidden></div></div>
    <div class="sp-ax"><span>${fmtTime(t0)}</span><span>now</span></div>`;
  const wrap = $(".sp-wrap", el), tip = $(".sp-tip", el), xl = $(".sp-x", el);
  wrap.onpointermove = (e) => {
    const r = wrap.getBoundingClientRect(), k = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    xl.hidden = false; xl.setAttribute("x1", x(k)); xl.setAttribute("x2", x(k));
    tip.hidden = false; tip.style.left = `${(k / (n - 1)) * 100}%`;
    tip.innerHTML = `<b>${v[k]}</b> calls · ${fmtTime(t0 + k * 600)}`;
  };
  wrap.onpointerleave = () => { tip.hidden = true; xl.hidden = true; };
}

// ---------------------------------------------------------------- static map thumbnail (OSM tiles, no Leaflet)
function thumb(lat, lng, kind, z = 14, T = 104) {
  if (lat == null || lng == null) return `<div class="thumb none">${kindSvg(kind)}</div>`;
  const s = 256 * 2 ** z, X = ((lng + 180) / 360) * s;
  const r = (lat * Math.PI) / 180, Y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s;
  const L0 = X - T / 2, T0 = Y - T / 2, imgs = [];
  for (let tx = Math.floor(L0 / 256); tx <= Math.floor((L0 + T) / 256); tx++)
    for (let ty = Math.floor(T0 / 256); ty <= Math.floor((T0 + T) / 256); ty++)
      imgs.push(`<img alt="" loading="lazy" src="https://${"abc"[(tx + ty) % 3]}.tile.openstreetmap.org/${z}/${tx}/${ty}.png" style="left:${Math.round(tx * 256 - L0)}px;top:${Math.round(ty * 256 - T0)}px">`);
  return `<div class="thumb" aria-hidden="true"><span class="tw">${imgs.join("")}</span><span class="pin k-${esc(kk(kind))}">${kindSvg(kind)}</span></div>`;
}

// ---------------------------------------------------------------- story cards
function airOver(id) { return (S.air?.aircraft || []).find((a) => a.near_incident?.id === id); }
function unitChips(i) {
  const list = i.unit_list || [];
  if (!list.length) return "";
  const show = list.filter((u) => u.status !== "left").concat(list.filter((u) => u.status === "left")).slice(0, 5);
  return `<div class="c-units">${show.map((u) => `<span class="uchip s-${esc(u.service)}${u.status === "left" ? " left" : ""}"><i class="ud st-${esc(u.status)}"></i>${esc(u.callsign)}<small>${esc(UNIT_ST[u.status] || "")}</small></span>`).join("")}${list.length > 5 ? `<span class="uchip more">+${list.length - 5}</span>` : ""}</div>`;
}
function quote(i) {
  const l = i.last_line;
  if (l?.text) return `<blockquote class="pq"><p>${rich(l.text)}</p><footer>${esc(l.channel || "Radio")} · ${fmtTime(l.at)}</footer></blockquote>`;
  return i.summary ? `<p class="c-sum">${rich(i.summary)}</p>` : "";
}
function distChip(i) {
  if (S.lens !== "near" || !place() || i.dist == null) return "";
  if (i.rough) return `<span class="dchip">${esc(`Somewhere in ${i.city || "town"}`)}</span>`;
  if (i.dist < 0.15) return `<span class="dchip">Right here</span>`;
  return `<span class="dchip"><span class="needle" style="transform:rotate(${Math.round(i.deg)}deg)"><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></span>${esc(fmtMi(i.dist))} ${esc(i.dir)}</span>`;
}
function card(i) {
  const d = S.detail.get(i.id), open = S.open.has(i.id), heli = airOver(i.id);
  const svc = SVC_LABEL[i.service] || "Radio";
  return `<article class="card k-${esc(kk(i.kind))}${open ? " open" : ""}${i.closed ? " closed" : ""}${(SEV[i.severity] || 0) >= 3 && !i.closed ? " sev" : ""}" id="story-${i.id}" data-id="${i.id}">
    <div class="c-head" data-toggle="${i.id}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="c-main">
        <div class="c-eye">${kico(i.kind)}<span>${esc(KIND_LABEL[i.kind] || "Other")}</span>${svc !== KIND_LABEL[i.kind] && svc !== "Other" ? `<span class="dot">·</span><span>${esc(svc)}</span>` : ""}<span class="dot">·</span><time>${esc(i.closed ? "ended " + fmtTime(i.last_at) : ago(i.last_at))}</time></div>
        <h3 class="c-title">${i.sensitive ? '<span class="sens" title="Involves a sensitive situation">Sensitive</span>' : ""}${esc(i.title || i.type || "Call")}</h3>
        <div class="c-place">${esc(placeOf(i))}${i.precision && !["block", "point", "street"].includes(i.precision) ? ` <small>(${esc(i.precision === "city" ? "approximate" : i.precision + " level")})</small>` : ""}</div>
      </div>
      ${thumb(i.lat, i.lng, i.kind)}
    </div>
    <div class="c-row">${distChip(i)}${pill(i.closed ? "ended" : i.status)}<span class="air-slot">${heli ? airChip(heli) : ""}</span>${respChips(i)}</div>
    ${unitChips(i)}
    ${open ? "" : quote(i)}
    ${open ? `<div class="story" id="story-body-${i.id}">${d ? storyHtml(i, d) : '<div class="loading">Loading the full story…</div>'}</div>` : ""}
    <button type="button" class="c-more" data-toggle="${i.id}">${open ? "Show less" : "Read the full story"}${I.chev}</button>
  </article>`;
}
function airChip(a) { return `<span class="airchip" data-air="${esc(a.hex)}" role="button" tabindex="0">${I.heli}${esc(cap(aircraftName(a)))} overhead</span>`; }
function updateAirChip(el) { const id = +el.dataset.id, a = airOver(id), s = $(".air-slot", el); if (s) s.innerHTML = a ? airChip(a) : ""; }

const PROG_SHORT = { reported: "Reported", dispatched: "Sent", en_route: "En route", on_scene: "On scene", transporting: "To hospital", cleared: "Clearing", closed: "Closed" };
function progressHtml(i, d) {
  const h = (d.status_history || []).slice();
  if (!h.length) return "";
  const have = new Set(h.map((x) => x.status));
  const steps = h.map((x) => ({ ...x, done: true }));
  if (!d.closed) {
    if (!have.has("on_scene") && !have.has("cleared")) steps.push({ status: "on_scene", done: false });
    steps.push({ status: "closed", done: false });
  }
  const lastDone = steps.filter((s) => s.done).length - 1;
  return `<ol class="prog" aria-label="Progress">${steps.map((s, k) => `<li class="${s.done ? "done" : ""}${k === lastDone && !d.closed ? " cur" : ""}">
    <b>${esc(PROG_SHORT[s.status] || s.label || s.status)}</b>${s.done ? `<time>${fmtTime(s.at)}</time>${s.unit ? `<small>${esc(s.unit)}</small>` : ""}` : "<small>not yet</small>"}</li>`).join("")}</ol>`;
}
function storyHtml(i, d) {
  const tl = d.timeline || [];
  const dur = (d.last_at || 0) - (d.first_at || 0);
  const facts = [["First heard", fmtTime(d.first_at)], ["Latest", fmtTime(d.last_at)], ["Radio calls", d.calls ?? tl.length], ["Running", dur > 59 ? fmtDur(dur) : "under a minute"]];
  let h = progressHtml(i, d);
  const heli = airOver(i.id);
  if (heli) h += `<div class="overhead" data-air="${esc(heli.hex)}" role="button" tabindex="0">${I.heli}<span><b>${esc(cap(aircraftName(heli)))}</b> ${heli.circling ? "circling" : "flying"} ${esc(heli.near_incident.distance_mi)} mi from here, ${altTxt(heli)}</span></div>`;
  h += `${d.sensitive ? '<p class="fine">This story involves a sensitive situation. Some details are held back out of respect for the people involved.</p>' : ""}
    <p class="s-lede">${rich(d.summary || i.summary || "")}</p>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
  h += `<h4>What was said</h4><ol class="tl">${tl.map((c) => {
    const w = S.words.has(c.id);
    return `<li class="${isChatter(c) ? "chat" : ""}">
      <div class="tl-t"><time>${fmtTime(c.at)}</time>${c.audio && CAN_PLAY ? `<button type="button" class="play" data-play="${c.id}" aria-label="Play this call">${S.playing === c.id && !S.audio.paused ? I.pause : I.play}</button>` : ""}</div>
      <div class="tl-b"><p>${rich(callText(c), c.codes)}</p>
        <div class="tl-m">${esc(c.channel || "")}${c.dur ? ` · ${Math.round(c.dur)} sec` : ""}
          ${(c.speakers || []).length ? `<button type="button" class="link sm" data-words="${c.id}">${w ? "Hide the words" : "Show the words"}</button>` : ""}</div>
        ${w ? wordsHtml(c) : ""}</div></li>`;
  }).join("")}</ol>`;
  const ul = d.units_list || [];
  if (ul.length) h += `<h4>Who responded</h4><ul class="units">${ul.map((u) => `<li><span class="svc s-${esc(u.service)}">${esc(SVC_LABEL[u.service] || "")}</span><b>${esc(u.callsign)}</b>${u.role ? `<small>${esc(u.role)}</small>` : ""}<span class="ust st-${esc(u.on_this ? u.status : "left")}">${esc(u.on_this ? (UNIT_ST[u.status] || u.status || "") : "Moved on")}</span>${u.since ? `<time>since ${fmtTime(u.since)}</time>` : ""}</li>`).join("")}</ul>`;
  const pv = [...(d.people || []).map((p) => [p.role || "Person", p.desc]), ...(d.vehicles || []).map((v) => ["Vehicle", typeof v === "string" ? v : v.desc || [v.color, v.make, v.model].filter(Boolean).join(" ")])];
  if (pv.length) h += `<h4>People and vehicles mentioned</h4><ul class="pv">${pv.map(([r, t]) => `<li><b>${esc(r)}</b>${rich(t || "")}</li>`).join("")}</ul>`;
  if (d.cameras?.length) {
    const bust = Math.floor(Date.now() / 60000);
    h += `<h4>Nearby cameras</h4><div class="cams">${d.cameras.slice(0, 3).map((c) => `<figure><img loading="lazy" src="${esc(c.img)}${String(c.img).includes("?") ? "&" : "?"}t=${bust}" alt="Traffic camera ${esc(c.name)}"><figcaption>${esc(c.name)}<small>${esc(c.distance_mi)} mi away${c.dir ? ", looking " + esc(c.dir.toLowerCase()) : ""}</small></figcaption></figure>`).join("")}</div>`;
  }
  if (d.related_news?.length) h += `<h4>In the news</h4><ul class="news">${d.related_news.slice(0, 3).map((n) => `<li><a href="${esc(n.url)}">${esc(n.title)}</a></li>`).join("")}</ul>`;
  h += `<div class="s-act">${i.lat != null ? `<button type="button" class="pillbtn" data-mapto="${i.id}">${I.map}See it on the map</button>` : ""}
    <button type="button" class="pillbtn ghost" data-share="${i.id}">${I.share}Share</button>
    <button type="button" class="pillbtn ghost" data-report-inc="${i.id}">${I.flag}Report a problem</button></div>`;
  h += `<p class="fine">${CAN_PLAY ? "Audio plays only when you tap it." : "Audio stays private to the station operators."} Transcripts are machine-made and can be wrong.</p>`;
  return h;
}
function wordsHtml(c) {
  return `<div class="words">${(c.speakers || []).map((s) => `<div class="turn"><span class="who">${esc(s.who || "Speaker")}</span><span>${rich(s.text, c.codes)}</span></div>`).join("")}
    ${(c.codes || []).length ? `<dl class="codes">${c.codes.map((k) => `<div><dt>${esc(k.code)}</dt><dd>${esc(k.meaning)}</dd></div>`).join("")}</dl>` : ""}</div>`;
}
function wrapRow(i) {
  if (S.open.has(i.id)) return `<li class="wcard">${card(i)}</li>`;
  const dist = S.lens === "near" && place() && i.dist != null ? (i.rough ? (i.city ? `~${i.city}` : "approx.") : `${fmtMi(i.dist)} ${i.dist < 0.15 ? "" : i.dir}`) : "";
  return `<li class="wrow" data-toggle="${i.id}" role="button" tabindex="0" id="story-${i.id}" data-id="${i.id}">${kico(i.kind)}
    <div><b>${i.sensitive ? '<span class="sens">Sensitive</span>' : ""}${esc(i.title || i.type)}</b><span>${esc(placeOf(i))}${i.closed ? "" : ` · ${esc((STATUS[i.status] || STATUS.quiet).label.toLowerCase())}`}</span></div>${dist ? `<span class="wd">${esc(dist.trim())}</span>` : `<time>${fmtTime(i.last_at)}</time>`}</li>`;
}

// ---------------------------------------------------------------- stream
let showAllWrapped = false, showAllFar = false;
const sec = (title, note, body, cls = "") => `<section class="sec ${cls}"><header class="sec-h"><h2>${title}</h2>${note ? `<span>${note}</span>` : ""}</header>${body}</section>`;
const list = (rows, n, key) => {
  const show = rows.slice(0, n).concat(rows.slice(n).filter((i) => S.open.has(i.id)));  // an opened story never hides behind "Show all"
  return `<ul class="wlist">${show.map(wrapRow).join("")}</ul>${rows.length > show.length ? `<button type="button" class="link" data-${key}>Show all ${rows.length}</button>` : ""}`;
};
function render(force) {
  if (!S.loaded) { if (S.lens === "near") { renderPlaces(); renderVerdict(); renderRadius(); } return; }
  const near = S.lens === "near", ns = near ? nearSets() : null;
  const act = S.items.filter(passes).sort(byImportance);
  const wr = S.wrapped.filter(passes).sort((a, b) => b.last_at - a.last_at);
  const extra = [...S.extra.values()];
  const p = place();
  const sig = JSON.stringify([S.lens, near ? [p?.id, p?.lat, S.radius, ns.inR.map((i) => i.id), ns.rough.length, ns.far.length, showAllFar] : 0,
    act.map((i) => [i.id, i.last_at, i.status, i.unit_list?.length, i.last_line?.at]), wr.map((i) => i.id), extra.map((i) => i.id),
    [...S.open], [...S.open].map((id) => !!S.detail.get(id) && S.detail.get(id).last_at), [...S.words], S.playing, showAllWrapped, S.f, S.q]);
  renderBrief();
  if (near) { renderPlaces(); renderVerdict(ns); renderRadius(); drawRing(ns); }
  if (sig === S.sig && !force) return;
  S.sig = sig;
  let h = "";
  if (extra.length) h += sec("From your link", "", extra.map(card).join(""));
  if (near && p) h += nearStream(ns);
  else if (S.f.win !== "active") {
    const big = act.slice().sort(byScore).slice(0, act.length > 8 ? 5 : 3).filter((i) => (i.score || 0) >= 15);
    const bigIds = new Set(big.map((i) => i.id));
    const live = act.filter((i) => !i.closed && !bigIds.has(i.id));
    const done = act.filter((i) => i.closed && !bigIds.has(i.id)).sort((a, b) => b.last_at - a.last_at);
    if (big.length) h += sec("The big ones", `biggest ${esc(winPhrase())}`, big.map(card).join(""));
    if (live.length) h += sec("Still going", `${live.length}`, live.map(card).join(""));
    h += airSlot();
    if (done.length) h += sec(S.f.win === "7d" ? "Earlier this week" : `Everything else ${esc(winPhrase())}`, `${done.length}`, list(done, showAllWrapped ? 500 : 20, "allwrapped"), "wrapped");
    if (!act.length) h += emptyHtml();
  } else {
    const dev = act.filter(isDeveloping), rest = act.filter((i) => !isDeveloping(i));
    if (dev.length) h += sec("Developing", "crews are working these now", dev.map(card).join(""));
    h += airSlot();
    if (rest.length) h += sec("Also on the radio", "lower-key calls, still open", rest.map(card).join(""));
    if (!act.length) h += emptyHtml();
    if (wr.length) h += sec("Wrapped up today", `${wr.length}`, list(wr, showAllWrapped ? 500 : 6, "allwrapped"), "wrapped");
  }
  $("#stream").innerHTML = h;
  renderAirCluster();
  updateMapIncidents();
}
function nearStream(ns) {
  const p = place(), r = S.radius;
  let h = "";
  const live = ns.inR.filter((i) => !i.closed), done = ns.inR.filter((i) => i.closed);
  if (live.length) h += sec(`Within ${RWORD[r]} of ${esc(p.name)}`, "nearest first", live.map(card).join(""));
  else h += `<div class="empty"><p><b>Nothing ${S.f.win === "active" ? "active" : "on the radio"} within ${RWORD[r]} of ${esc(p.name)}${S.f.win === "active" ? " right now" : " " + winPhrase()}.</b> ${filtered() ? "Some stories may be hidden by your filters." : r < 3 ? "" : "That's a good thing."}</p>
      ${r < 10 ? `<button type="button" class="pillbtn ghost" data-radius="${RADII[RADII.indexOf(r) + 1]}">Widen to ${RWORD[RADII[RADII.indexOf(r) + 1]]}</button>` : ""}</div>`;
  if (done.length) h += sec(S.f.win === "active" ? "Wrapped up nearby today" : "Handled nearby", `${done.length}`, list(done, 6, "allwrapped"), "wrapped");
  if (ns.rough.length) h += sec("Somewhere in town", "the radio only named the city, so we can't say how close", list(ns.rough, 4, "allwrapped"), "wrapped");
  const farLive = ns.far.filter((i) => !i.closed);
  if (farLive.length) h += sec(`Farther away`, `${farLive.length} elsewhere in ${esc(REGION_LABEL)}`, list(farLive, showAllFar ? 500 : 5, "allfar"), "wrapped");
  h += airSlot();
  return h;
}
function emptyHtml() {
  const f = filtered();
  return `<div class="empty"><p><b>${f ? "Nothing matches right now." : "All quiet on the radio."}</b> ${f ? "Try Everything, or widen the time with More." : "When something happens, it shows up here within a minute or two."}</p>${f ? '<button type="button" class="pillbtn" data-reset>Show everything</button>' : ""}</div>`;
}

// ---------------------------------------------------------------- open / link to a story (#i/<id>)
function setHash(id) {
  const base = location.pathname + location.search;
  try { history.replaceState(null, "", id ? `${base}#i/${id}` : base); } catch (e) {}
}
async function toggleStory(id) {
  if (S.open.has(id)) { S.open.delete(id); if (location.hash === `#i/${id}`) setHash(S.open.size ? [...S.open].at(-1) : null); render(true); return; }
  S.open.add(id); setHash(id); render(true);
  try { await getDetail(id); render(true); }
  catch (e) { const b = $(`#story-body-${id}`); if (b) b.innerHTML = '<div class="loading">Couldn\'t load this story. Try again in a moment.</div>'; }
}
async function gotoStory(id) {
  if (!findItem(id)) {
    try {
      const d = await getDetail(id);
      const { timeline, units_list, people, vehicles, trails, cameras, related_news, ...brief } = d;
      brief.unit_list = (units_list || []).map((u) => ({ callsign: u.callsign, service: u.service, status: u.on_this ? u.status : "left" }));
      const last = (timeline || []).filter((c) => c.line).at(-1);
      brief.last_line = last ? { text: last.line, at: last.at, channel: last.channel } : null;
      S.extra.set(id, brief);
    } catch (e) { toast("That story couldn't be found. It may have been merged into another one."); setHash(null); return; }
  }
  if (!S.open.has(id)) await toggleStory(id); else setHash(id);
  scrollToStory(id);
}
function scrollToStory(id) {
  const el = $(`#story-${id}`); if (!el) return;
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1400);
}
function routeHash() {
  const m = location.hash.match(/^#(?:i\/|story-)(\d+)$/);
  if (m) gotoStory(+m[1]);
}
async function share(id) {
  const it = findItem(id); const url = `${location.origin}/live/${CFG.region}#i/${id}`;
  try {
    if (navigator.share) { await navigator.share({ title: it?.title || "JAFO Live", url }); return; }
    await navigator.clipboard.writeText(url); toast("Link copied");
  } catch (e) { if (e?.name !== "AbortError") toast(url); }
}

// ---------------------------------------------------------------- aircraft
const ROLE_TAG = { border: "Border Patrol", medical: "Medical flight", police: "Police", military: "Military", news: "News" };
function trailSvg(a, W = 84, H = 56) {
  const t = a.trail || []; if (t.length < 2) return "";
  const la = t.map((p) => p[0]), lo = t.map((p) => p[1]);
  const mlat = Math.cos(((Math.min(...la) + Math.max(...la)) / 2) * Math.PI / 180);
  const minx = Math.min(...lo) * mlat, maxx = Math.max(...lo) * mlat, miny = Math.min(...la), maxy = Math.max(...la);
  const span = Math.max(maxx - minx, maxy - miny, 1e-4), sc = (Math.min(W, H) - 10) / span;
  const ox = (W - (maxx - minx) * sc) / 2, oy = (H - (maxy - miny) * sc) / 2;
  const pts = t.map((p) => [ox + (p[1] * mlat - minx) * sc, H - oy - (p[0] - miny) * sc]);
  const last = pts.at(-1);
  return `<svg class="trail" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("")}"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3"/></svg>`;
}
function airTile(a, wide) {
  const isHeli = a.kind === "helicopter";
  const tag = a.emergency ? `Emergency ${a.emergency}` : ROLE_TAG[a.role] || (isHeli ? "Helicopter" : "");
  const story = a.emergency === "7700" ? "Squawking 7700, the general emergency code." : a.emergency === "7600" ? "Squawking 7600: lost radio contact." : a.emergency === "7500" ? "Squawking 7500, the hijack code. It's sometimes set by mistake." : "";
  const near = a.near_incident ? `<button type="button" class="link sm" data-goto="${a.near_incident.id}">${a.circling ? "Circling" : "Flying"} ${esc(a.near_incident.distance_mi)} mi from ${esc(a.near_incident.title)}</button>` : a.circling ? "<span>Circling</span>" : "";
  const p = S.lens === "near" ? place() : null;
  const rel = p && a.lat != null ? (() => { const d = miles(p.lat, p.lng, a.lat, a.lng); return d < 0.4 ? `right over ${p.name}` : `${fmtMi(d)} ${DIR_WORD[dir8(bearing(p.lat, p.lng, a.lat, a.lng))]} of ${p.name}`; })() : "";
  return `<div class="atile${a.emergency ? " emg" : ""}${wide ? " wide" : ""}" data-air="${esc(a.hex)}">
    <div class="a-ico"${isHeli ? "" : ` style="--rot:${a.track || 0}deg"`}>${isHeli ? I.heli : I.plane}</div>
    <div class="a-b">${tag ? `<span class="atag r-${esc(a.emergency ? "emg" : a.role || "x")}">${esc(tag)}</span>` : ""}
      <b>${esc(cap(aircraftName(a)))}</b>
      <span class="a-m">${esc(a.callsign || a.reg || a.hex)}${a.type ? " · " + esc(a.type) : ""} · ${altTxt(a)}${a.gs_kt ? ` · ${Math.round(a.gs_kt * 1.151)} mph` : ""}</span>
      ${rel ? `<span class="a-o">${esc(rel)}</span>` : ""}
      ${story ? `<span class="a-s">${story}</span>` : ""}${a.operator ? `<span class="a-o">${esc(a.operator.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))}</span>` : ""}
      ${near ? `<span class="a-n">${near}</span>` : ""}</div>
    ${trailSvg(a)}</div>`;
}
const altTxt = (a) => a.on_ground ? "on the ground" : (a.alt_ft ?? 0) < 100 ? "near the ground" : `${a.alt_ft.toLocaleString()} ft`;
const airSlot = () => `<div id="air-slot"></div>`;
function interestingAir() {
  const air = (S.air?.aircraft || []).filter((a) => a.interesting || a.emergency || a.near_incident);
  return air.sort((a, b) => (!!b.emergency - !!a.emergency) || (!!b.near_incident - !!a.near_incident) || ((b.kind === "helicopter") - (a.kind === "helicopter")));
}
function nearAir() {
  const p = place(); let air = interestingAir();
  if (S.lens === "near" && p) {
    const lim = Math.max(5, S.radius * 3);
    air = air.filter((a) => a.emergency || (a.lat != null && miles(p.lat, p.lng, a.lat, a.lng) <= lim));
  }
  return air;
}
function renderAirCluster() {
  const slot = $("#air-slot"); if (!slot) return;
  const A = S.air; if (!A) { slot.innerHTML = ""; return; }
  const air = nearAir(), c = A.counts || {}, near = S.lens === "near" && place();
  const ac = A.acars?.active && !near ? (A.acars.messages || []).slice(0, 3) : [];
  if (!air.length && !ac.length) { slot.innerHTML = c.airborne ? `<p class="air-quiet" id="air-anchor">${I.plane}${near ? `Nothing unusual in the air near ${esc(place().name)}. ` : ""}${c.airborne} aircraft over ${esc(REGION_LABEL)}, nothing unusual.</p>` : ""; return; }
  slot.innerHTML = `<section class="sec air" id="air-anchor"><header class="sec-h"><h2>${near ? "Overhead nearby" : "In the air"}</h2><span>${c.airborne ?? 0} overhead · ${c.helicopters ?? 0} helicopter${c.helicopters === 1 ? "" : "s"}${A.demo ? " · demo sky" : ""}</span></header>
    <div class="atiles">${air.map((a) => airTile(a)).join("")}</div>
    ${ac.length ? `<div class="acars"><h3>Messages from airliners <small>decoded ACARS</small></h3><ul>${ac.map((m) => `<li><time>${fmtTime(m.at)}</time><b>${esc(m.flight || m.tail)}</b><code>${esc(m.text)}</code></li>`).join("")}</ul></div>` : ""}</section>`;
}
function renderAirRail() {
  const el = $("#rail-air"); const A = S.air;
  if (!A) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;
  const air = interestingAir().slice(0, 5), c = A.counts || {};
  el.innerHTML = `<div class="rh">${I.plane}In the air <span class="rn">${c.airborne ?? 0} overhead${A.demo ? " · demo" : ""}</span></div>
    ${air.length ? `<ul class="rair">${air.map((a) => `<li data-air="${esc(a.hex)}" class="${a.emergency ? "emg" : ""}"><span class="a-ico sm"${a.kind === "helicopter" ? "" : ` style="--rot:${a.track || 0}deg"`}>${a.kind === "helicopter" ? I.heli : I.plane}</span><div><b>${esc(cap(aircraftName(a)))}</b><small>${a.emergency ? `Emergency ${esc(a.emergency)} · ` : ""}${a.near_incident ? `over ${esc(a.near_incident.title)}` : `${altTxt(a)}${a.circling ? " · circling" : ""}`}</small></div></li>`).join("")}</ul>` : `<p class="dim sm" style="margin:0;font-size:13.5px">Nothing unusual overhead.</p>`}`;
}
function renderAirPanel() {
  const A = S.air, c = A?.counts || {};
  const air = interestingAir();
  $("#panel-body").innerHTML = !A ? "<p>The aircraft feed isn't available right now.</p>" :
    `<p class="dim">Aircraft broadcasting their position (ADS-B) over ${esc(REGION_LABEL)}: ${c.airborne ?? 0} in the air, ${c.helicopters ?? 0} helicopter${c.helicopters === 1 ? "" : "s"}${A.demo ? ". This is a demo sky" : ""}. We point out helicopters, Border Patrol, medical and military flights, and emergency codes.</p>
    ${air.length ? `<div class="atiles" style="margin:0;padding-inline:2px">${air.map((a) => airTile(a)).join("")}</div>` : "<p>Nothing unusual overhead right now.</p>"}
    ${A.acars?.active && A.acars.messages?.length ? `<div class="acars"><h3>Messages from airliners <small>decoded ACARS</small></h3><ul>${A.acars.messages.slice(0, 8).map((m) => `<li><time>${fmtTime(m.at)}</time><b>${esc(m.flight || m.tail)}</b><code>${esc(m.text)}</code></li>`).join("")}</ul></div>` : ""}
    <p style="margin-top:16px"><a href="/live/${esc(CFG.region)}/map">See every aircraft on the full map</a></p>`;
}

// ---------------------------------------------------------------- radio ticker + radio sheet
function radioLine(c, full) {
  const inc = c.incident_id ? findItem(c.incident_id) : null;
  return `<li class="${isChatter(c) ? "chat" : ""}"><div class="rl-m"><time>${fmtTime(c.at)}</time><span>${esc(c.channel || "")}</span>
    ${full && c.audio && CAN_PLAY ? `<button type="button" class="play" data-play="${c.id}" aria-label="Play">${S.playing === c.id && !S.audio.paused ? I.pause : I.play}</button>` : ""}</div>
    <p>${rich(callText(c), c.codes)}</p>
    ${inc ? `<button type="button" class="rinc" data-goto="${inc.id}">${kico(inc.kind)}${esc(inc.title)}</button>` : ""}
    ${full && (c.speakers || []).length ? `<button type="button" class="link sm" data-words="${c.id}">${S.words.has(c.id) ? "Hide the words" : "Show the words"}</button>${S.words.has(c.id) ? wordsHtml(c) : ""}` : ""}</li>`;
}
let tickerTop = 0;
function renderTicker() {
  const items = S.radio.filter((c) => !isChatter(c)).slice(0, 12);
  const el = $("#ticker"); const prev = tickerTop;
  el.innerHTML = items.map((c) => radioLine(c)).join("") || '<li><p class="dim">Nothing on the radio in a while.</p></li>';
  tickerTop = items[0]?.id || 0;
  if (prev && tickerTop !== prev) el.firstElementChild?.classList.add("fresh");
  if (panelKind === "radio") renderRadioPanel();
}
let radioExtra = [];
function renderRadioPanel() {
  const all = [...S.radio, ...radioExtra.filter((x) => !S.radio.some((r) => r.id === x.id))];
  $("#panel-body").innerHTML = `<p class="dim">Every transmission, newest first, written in plain English. Tap “Show the words” for exactly what was said.</p>
    <ol class="ticker full">${all.map((c) => radioLine(c, true)).join("")}</ol>
    <button type="button" class="pillbtn ghost" data-radio-more>Load earlier calls</button>`;
}

// ---------------------------------------------------------------- audio (only ever on tap)
function findCall(id) {
  for (const d of S.detail.values()) { const c = (d.timeline || []).find((x) => x.id === id); if (c) return c; }
  return [...S.radio, ...radioExtra].find((x) => x.id === id);
}
function play(id) {
  if (!CAN_PLAY) return;
  const c = findCall(id); if (!c?.audio) return;
  if (S.playing === id && !S.audio.paused) { S.audio.pause(); return; }
  if (S.playing !== id) { S.audio.src = c.audio; S.playing = id; }
  S.audio.play().catch(() => toast("Couldn't play this call"));
  $("#player").hidden = false; $("#pl-chan").textContent = `${c.channel || "Radio"} · ${fmtTime(c.at)}`; $("#pl-line").innerHTML = rich(callText(c), c.codes);
}
function syncPlay() {
  const on = !S.audio.paused;
  $("#pp").innerHTML = on ? I.pause : I.play; $("#pp").setAttribute("aria-label", on ? "Pause" : "Play");
  $$("[data-play]").forEach((b) => (b.innerHTML = +b.dataset.play === S.playing && on ? I.pause : I.play));
}
["play", "pause", "ended"].forEach((e) => S.audio.addEventListener(e, syncPlay));

// ---------------------------------------------------------------- maps (rail minimap + quick map sheet)
const TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
let mini, miniInc, miniAir, big, bigInc, bigAir, bigMe, bigHist, showAir = true;
const R = CFG.regionBox || {};
const bounds = () => R.bbox_north != null ? [[R.bbox_south, R.bbox_west], [R.bbox_north, R.bbox_east]] : null;
const incIcon = (i, sz = 30, dim) => L.divIcon({ className: "", html: `<span class="mk k-${esc(kk(i.kind))}${i.closed ? " done" : ""}${(SEV[i.severity] || 0) >= 3 && !i.closed ? " sev" : ""}${dim ? " dim" : ""}" style="--s:${sz}px">${kindSvg(i.kind)}</span>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
const airIcon = (a) => L.divIcon({ className: "", html: `<span class="amk${a.emergency ? " emg" : ""}${a.interesting ? " int" : ""}"${a.kind === "helicopter" ? "" : ` style="--rot:${a.track || 0}deg"`}>${a.kind === "helicopter" ? I.heli : I.plane}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
function initMini() {
  if (mini || !window.L || getComputedStyle($(".rail")).display === "none" || S.lens === "near") return;
  mini = L.map("minimap", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
  const b = bounds(); b ? mini.fitBounds(b, { padding: [-30, -30] }) : mini.setView([R.default_lat || 26.2, R.default_lng || -98.2], 10);
  L.tileLayer(TILE, { subdomains: "abc", className: "basemap-tiles" }).addTo(mini);
  miniInc = L.layerGroup().addTo(mini); miniAir = L.layerGroup().addTo(mini);
  mini.on("click", () => openMap());
  updateMapIncidents(); updateMapAir();
}
function openMap(focusId) {
  if (!window.L) { location.href = `/live/${CFG.region}/map`; return; }
  $("#mapsheet").hidden = false; document.body.classList.add("noscroll");
  if (!big) {
    big = L.map("bigmap", { zoomControl: innerWidth >= 760, attributionControl: true });
    const live = S.items.filter(passes).filter((i) => i.lat != null && !i.closed), b = bounds(), p = S.lens === "near" ? place() : null;
    if (p) big.setView([p.lat, p.lng], 13);
    else if (live.length > 1) big.fitBounds(L.latLngBounds(live.map((i) => [i.lat, i.lng])).pad(0.15), { maxZoom: 13, paddingTopLeft: [0, 60] });
    else b ? big.fitBounds(b) : big.setView([R.default_lat || 26.2, R.default_lng || -98.2], 11);
    L.tileLayer(TILE, { subdomains: "abc", maxZoom: 19, className: "basemap-tiles", attribution: ATTR }).addTo(big);
    bigHist = L.layerGroup().addTo(big); bigAir = L.layerGroup().addTo(big); bigInc = L.layerGroup().addTo(big);
    big.on("click", () => { $("#ms-card").hidden = true; bigHist.clearLayers(); });
  }
  setTimeout(() => big.invalidateSize(), 30);
  updateMapIncidents(); updateMapAir(); renderLegend();
  if (bigMe) { bigMe.remove(); bigMe = null; }
  const p = S.lens === "near" ? place() : null;
  if (p) bigMe = L.circleMarker([p.lat, p.lng], { radius: 8, color: "#fff", weight: 3, fillColor: css("--home") || "#c46a12", fillOpacity: 1 }).bindTooltip(esc(p.name)).addTo(big);
  if (focusId) { const i = findItem(focusId); if (i?.lat != null) { big.setView([i.lat, i.lng], 15); msIncident(i); } }
}
function closeMap() { $("#mapsheet").hidden = true; document.body.classList.remove("noscroll"); }
function renderLegend() {
  const n = S.items.filter(passes).length, a = (S.air?.aircraft || []).length;
  const w = S.f.win === "active" ? S.wrapped.filter(passes).length : 0;
  $("#ms-legend").innerHTML = `<span class="lg">${n} open${w ? ` · ${w} wrapped up` : ""}</span><button type="button" class="lg tog${showAir ? " on" : ""}" data-toggle-air aria-pressed="${showAir}">${I.plane}${a} aircraft</button>`;
}
function updateMapIncidents() {
  const lst = [...S.items, ...(S.f.win === "active" ? S.wrapped : []), ...S.extra.values()].filter(passes).filter((i) => i.lat != null);
  if (miniInc) {
    miniInc.clearLayers(); const live = lst.filter((i) => !i.closed);
    live.forEach((i) => L.marker([i.lat, i.lng], { icon: incIcon(i, 20), interactive: false }).addTo(miniInc));
    if (!mini._fitted && live.length) { mini._fitted = true; mini.fitBounds(L.latLngBounds(live.map((i) => [i.lat, i.lng])).pad(0.25), { maxZoom: 12 }); }
  }
  if (bigInc && !$("#mapsheet").hidden) {
    bigInc.clearLayers();
    lst.sort((a, b) => a.closed - b.closed).reverse().forEach((i) => L.marker([i.lat, i.lng], { icon: incIcon(i, i.closed ? 22 : 32), zIndexOffset: i.closed ? 0 : 500, keyboard: true, title: i.title }).on("click", (e) => { L.DomEvent.stop(e); msIncident(i); }).addTo(bigInc));
    renderLegend();
  }
}
function updateMapAir() {
  const air = (S.air?.aircraft || []).filter((a) => a.lat != null);
  if (miniAir) { miniAir.clearLayers(); air.filter((a) => a.interesting || a.emergency).forEach((a) => L.marker([a.lat, a.lng], { icon: airIcon(a), interactive: false }).addTo(miniAir)); }
  if (bigAir && !$("#mapsheet").hidden) {
    bigAir.clearLayers(); if (!showAir) return;
    air.forEach((a) => {
      if (a.trail?.length > 1) L.polyline(a.trail.map((p) => [p[0], p[1]]), { className: "atrail" + (a.emergency ? " emg" : a.interesting ? " int" : ""), weight: 2, interactive: false }).addTo(bigAir);
      L.marker([a.lat, a.lng], { icon: airIcon(a), zIndexOffset: 1000, title: a.callsign || a.hex }).on("click", (e) => { L.DomEvent.stop(e); msAir(a); }).addTo(bigAir);
    });
  }
}
function msIncident(i) {
  const c = $("#ms-card"); c.hidden = false;
  c.innerHTML = `<div class="c-eye">${kico(i.kind)}<span>${esc(KIND_LABEL[i.kind] || "Other")}</span><span class="dot">·</span><time>${esc(i.closed ? "ended " + fmtTime(i.last_at) : ago(i.last_at))}</time></div>
    <h3 class="c-title">${i.sensitive ? '<span class="sens">Sensitive</span>' : ""}${esc(i.title)}</h3><div class="c-place">${esc(placeOf(i))}</div><div class="c-row">${pill(i.closed ? "ended" : i.status)}${respChips(i, 3)}</div>
    <button type="button" class="pillbtn" data-readstory="${i.id}">Read the story</button>`;
}
async function msAir(a) {
  const c = $("#ms-card"); c.hidden = false; c.innerHTML = airTile(a, true);
  if (!bigHist || a.source === "demo" || !a.hex) return;
  bigHist.clearLayers();
  try {  // longer track from the persisted history (up to 6 hours)
    const h = await api("/api/live/air/history", { hex: a.hex, hours: 6, region: undefined });
    if ((h.points || []).length > 1) {
      L.polyline(h.points.map((p) => [p[0], p[1]]), { className: "atrail hist", weight: 2, interactive: false }).addTo(bigHist);
      const span = h.last_at - h.first_at;
      if (span > 900) { const n = document.createElement("p"); n.className = "fine"; n.textContent = `Faint line: its track over the last ${fmtDur(span)}.`; c.appendChild(n); }
    }
  } catch (e) {}
}

// ---------------------------------------------------------------- Near me: places, verdict, ring map, history
function renderPlaces() {
  $("#near").classList.toggle("noplace", !place());
  const r = S.radius, live = S.items.filter((i) => !i.closed && i.lat != null && !(!i.precision || i.precision === "city"));
  const cnt = (pl) => live.filter((i) => miles(pl.lat, pl.lng, i.lat, i.lng) <= r).length;
  const cur = place();
  const chip = (pl, sel) => { const n = cnt(pl); return `<button type="button" class="pl" role="tab" aria-selected="${sel}" data-place="${esc(pl.id)}">${psvg(pl.icon)}${esc(pl.name)}${n ? `<span class="n" title="${n} active within ${RWORD[r]}">${n}</span>` : ""}</button>`; };
  let h = "";
  if (S.temp) h += chip(S.temp, S.placeId === "tmp") + `<button type="button" class="pl save" data-act="save-temp">${psvg("plus")}Save</button>`;
  h += S.places.map((pl) => chip(pl, !!cur && cur.id === pl.id && S.placeId !== "tmp")).join("");
  h += `<button type="button" class="pl add" data-act="manage">${psvg(S.places.length ? "pin" : "plus")}${S.places.length ? "Your places" : "Add a place"}</button>`;
  $("#places").innerHTML = h;
}
function renderRadius() {
  $("#radius").innerHTML = RADII.map((r) => `<button type="button" role="radio" aria-checked="${S.radius === r}" data-radius="${r}">${RLBL[r]}</button>`).join("");
}
function townsHeard() {
  const by = new Map();
  for (const i of [...S.items, ...S.wrapped]) {
    if (!i.city || i.lat == null) continue;
    const t = by.get(i.city) || { name: i.city, lat: 0, lng: 0, n: 0 }; t.lat += i.lat; t.lng += i.lng; t.n++; by.set(i.city, t);
  }
  return [...by.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((t) => ({ name: t.name, lat: t.lat / t.n, lng: t.lng / t.n }));
}
let townCache = [];
function renderVerdict(ns) {
  const el = $("#verdict"), p = place();
  if (!p) {
    townCache = townsHeard();
    el.className = "verdict onboard";
    el.innerHTML = `<h1 id="near-h">What's going on near you?</h1>
      <p>Pick a place you care about, like home, work or a school, and JAFO will show what's on the radio around it, nearest first. Places stay on this device.</p>
      <div class="towns"><button type="button" class="pillbtn" data-act="locate">${psvg("me").replace("<svg", '<svg class="ico sm"')}Use my location</button>
      ${townCache.map((t, k) => `<button type="button" class="pl" data-town="${k}">${psvg("town")}${esc(t.name)}</button>`).join("")}</div>`;
    return;
  }
  if (!S.loaded) { el.className = "verdict"; el.innerHTML = `<div class="eyebrow"><span class="pulse-dot"></span>${esc(p.name)}</div><h1 id="near-h">Checking around ${esc(p.name)}…</h1>`; return; }
  ns = ns || nearSets();
  const live = ns.inR.filter((i) => !i.closed), done = ns.inR.filter((i) => i.closed);
  const danger = live.some((i) => ["violence", "fire"].includes(i.kind) && (i.dist ?? 99) < 1);
  el.className = "verdict " + (live.length ? (danger ? "busy alerting" : "busy") : "quiet");
  const where = `near ${esc(p.name)}`, rTxt = `within ${RWORD[S.radius]}`;
  const phrase = winPhrase();
  let h1; const ps = [];
  if (!live.length) {
    h1 = done.length ? `<em>Calm</em> ${where}` : `<em>Quiet</em> ${where}`;
    if (done.length) ps.push(`${cap(done.length === 1 ? "one call" : `${numw(done.length, true)} calls`)} ${rTxt} ${phrase}, all wrapped up: ${done.slice(0, 2).map((i) => `${esc(nounFor(i))} ${esc(relWords(i))} (${esc(ago(i.last_at))})`).join("; ")}.`);
    else ps.push(`Nothing on the radio ${rTxt} ${S.f.win === "active" ? "right now" : phrase}${filtered() ? " that matches your filters" : ""}.`);
    const others = ns.far.filter((i) => !i.closed && i.dist != null && !i.rough).sort((a, b) => a.dist - b.dist);
    if (others[0]) ps.push(`The closest active call is ${esc(nounFor(others[0]))} ${esc(relWords(others[0]))}.`);
  } else {
    const n = live.length;
    h1 = `<em>${n === 1 ? "1 thing" : `${n} things`}</em> going on ${where}`;
    ps.push(live.slice(0, 3).map((i) => `${ent({ ...i, title: cap(nounFor(i)) })} ${esc(relWords(i))}: ${esc(statusPhrase(i))}.`).join(" "));
    if (live.length > 3) ps.push(`${numw(live.length - 3)} more below.`);
    if (done.length) ps.push(`${cap(numw(done.length, true))} more ${rTxt} already wrapped up ${phrase}.`);
  }
  if (ns.rough.length) ps.push(`${ns.rough.length === 1 ? "One more call" : `${numw(ns.rough.length)} more calls`} somewhere in ${esc([...new Set(ns.rough.map((x) => x.city).filter(Boolean))].slice(0, 2).join(" and ") || "town")}; the exact spot wasn't said on the radio.`);
  const facts = [];
  const otw = live.flatMap((i) => (i.unit_list || []).filter((u) => ["dispatched", "en_route"].includes(u.status)));
  if (otw.length) facts.push(`<span class="vfact">${I.arrow}${otw.length} unit${otw.length > 1 ? "s" : ""} on the way</span>`);
  const air = nearAir();
  const emg = air.find((a) => a.emergency), heli = air.find((a) => a.kind === "helicopter" && !a.emergency);
  const rel = (a) => { if (a.lat == null) return ""; const d = miles(p.lat, p.lng, a.lat, a.lng); return d < 0.4 ? "overhead" : `${fmtMi(d)} ${dir8(bearing(p.lat, p.lng, a.lat, a.lng))}`; };
  if (heli) facts.push(`<button type="button" class="vfact" data-air="${esc(heli.hex)}">${I.heli}${esc(cap(aircraftName(heli)))} ${heli.circling ? "circling" : ""} ${esc(rel(heli))}</button>`);
  if (emg) facts.push(`<button type="button" class="vfact emg" data-air="${esc(emg.hex)}">${I.plane}${esc(cap(aircraftName(emg)))} squawking ${esc(emg.emergency)}</button>`);
  if (S.weather?.alerts?.length) facts.push(`<span class="vfact emg">${esc(S.weather.alerts[0].event || S.weather.alerts[0].headline || "Weather alert")}</span>`);
  const lc = S.pulse?.last_call?.at || S.pulse?.last_call?.start_time || S.radio[0]?.at;
  el.innerHTML = `<div class="eyebrow"><span class="pulse-dot" aria-hidden="true"></span>${esc(p.name)} · ${esc(RLBL[S.radius])}${lc ? ` · last radio call ${esc(ago(lc))}` : ""}</div>
    <h1 id="near-h">${h1}</h1>${ps.map((x) => `<p>${x}</p>`).join("")}${facts.length ? `<div class="vfacts">${facts.join("")}</div>` : ""}`;
}

let ring, ringRings, ringInc, ringAir, ringFitKey = "";
function initRing() {
  if (ring || !window.L || $("#near").hidden) return;
  ring = L.map("ringmap", { zoomControl: false, attributionControl: true, zoomSnap: 0.25, scrollWheelZoom: false });
  ring.setView([R.default_lat || 26.2, R.default_lng || -98.2], 11);
  L.tileLayer(TILE, { subdomains: "abc", maxZoom: 19, className: "basemap-tiles", attribution: ATTR }).addTo(ring);
  ring.createPane("rings"); ring.getPane("rings").style.zIndex = 380;
  ringRings = L.layerGroup().addTo(ring); ringAir = L.layerGroup().addTo(ring); ringInc = L.layerGroup().addTo(ring);
  ring.on("click", (e) => { if (!S.picking) return; setPicking(false); setTemp({ name: "Dropped pin", lat: e.latlng.lat, lng: e.latlng.lng }, true); });
}
function drawRing(ns) {
  initRing(); if (!ring) return;
  const p = place();
  $("#ringbox").hidden = false;
  ringRings.clearLayers(); ringInc.clearLayers();
  const home = css("--home") || "#c46a12";
  if (p) {
    for (const r of RADII) {
      if (r > Math.max(3, S.radius)) continue;
      const on = r === S.radius;
      L.circle([p.lat, p.lng], { pane: "rings", radius: r * MI, color: home, weight: on ? 2 : 1.2, opacity: on ? 0.9 : 0.5, dashArray: on ? null : "3 6", fill: on, fillColor: home, fillOpacity: 0.06, interactive: false }).addTo(ringRings);
      L.marker([p.lat + r / 69.05, p.lng], { pane: "rings", interactive: false, icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<span class="ringlbl">${RLBL[r]}</span>` }) }).addTo(ringRings);
    }
    L.marker([p.lat, p.lng], { zIndexOffset: 1000, keyboard: false, title: p.name, icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="homepin"><i></i></div>' }) }).addTo(ringRings);
  }
  ns = ns || nearSets();
  const show = [...ns.inR, ...ns.rough, ...ns.far.filter((i) => !i.closed)].filter((i) => i.lat != null);
  for (const i of show) {
    const inside = ns.inR.includes(i);
    L.marker([i.lat, i.lng], { icon: incIcon(i, inside ? 28 : 20, !inside), zIndexOffset: inside && !i.closed ? 500 : 0, title: i.title })
      .on("click", (e) => { L.DomEvent.stop(e); if (!S.picking) gotoStory(i.id); }).addTo(ringInc);
  }
  const key = p ? `${p.id}|${p.lat}|${S.radius}` : "none";
  if (key !== ringFitKey) {
    ringFitKey = key;
    setTimeout(() => {
      ring.invalidateSize();
      if (p) ring.fitBounds(L.latLng(p.lat, p.lng).toBounds(S.radius * 2.3 * MI), { animate: false });
      else { const b = bounds(); b ? ring.fitBounds(b) : 0; }
    }, 20);
  }
  drawRingAir();
}
function drawRingAir() {
  if (!ringAir) return; ringAir.clearLayers();
  nearAir().filter((a) => a.lat != null).forEach((a) => {
    if (a.trail?.length > 1) L.polyline(a.trail.map((t) => [t[0], t[1]]), { className: "atrail int", weight: 2, interactive: false }).addTo(ringAir);
    L.marker([a.lat, a.lng], { icon: airIcon(a), zIndexOffset: 1000, title: a.callsign || a.hex }).on("click", (e) => { L.DomEvent.stop(e); openMap(); if (big) big.setView([a.lat, a.lng], 13); msAir(a); }).addTo(ringAir);
  });
}
function setPicking(on) { S.picking = on; $("#pick-hint").hidden = !on; if (ring) ring.getContainer().style.cursor = on ? "crosshair" : ""; }

let histKey = "";
async function loadHist(force) {
  const p = place(); if (!p || S.lens !== "near") { $("#hist").innerHTML = ""; return; }
  const key = `${p.lat},${p.lng}|${S.radius}`;
  if (key === histKey && !force && S.hist) return;
  histKey = key;
  try { const d = await api("/api/live/incidents", { window: "7d", near: `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, radius: S.radius, limit: 1000 }); if (histKey === key) S.hist = d.items || []; }
  catch (e) { S.hist = null; }
  renderHist();
}
function renderHist() {
  const el = $("#hist"), p = place();
  if (!p || !S.hist || S.lens !== "near") { el.innerHTML = ""; return; }
  const days = [];
  for (let k = 6; k >= 0; k--) { const d = new Date(Date.now() - k * 86400000); days.push({ key: dayKey.format(d), lbl: k === 0 ? "Today" : wdfmt.format(d), n: 0 }); }
  const ix = new Map(days.map((d, k) => [d.key, k])), mix = {};
  for (const it of S.hist) {
    const k = ix.get(dayKey.format(new Date((it.first_at || it.last_at) * 1000)));
    mix[kk(it.kind)] = (mix[kk(it.kind)] || 0) + 1;
    if (k !== undefined) days[k].n++;
  }
  const total = S.hist.length, top = Object.entries(mix).sort((a, b) => b[1] - a[1]);
  const short = { violence: "danger", traffic: "traffic", medical: "medical", property: "property and alarms", suspicious: "suspicious activity", fire: "fire", other: "other calls" };
  const mostly = !top.length ? "" : top[0][1] / total >= 0.4 ? `, mostly ${short[top[0][0]]}` : `, a mix of ${top.slice(0, 2).map((x) => short[x[0]]).join(" and ")}`;
  const mx = Math.max(1, ...days.map((d) => d.n));
  el.innerHTML = `<div class="hist-top"><p><b>${total}</b> ${total === 1 ? "story" : "stories"} within ${RWORD[S.radius]} of ${esc(p.name)} in the last 7 days${esc(mostly)}.</p>
    <div><div class="bars" role="img" aria-label="${days.map((d) => `${d.lbl}: ${d.n}`).join(", ")}">${days.map((d, k) => `<span class="${k === 6 ? "today" : ""}" style="height:${d.n ? Math.max(8, (d.n / mx) * 100) : 4}%" title="${esc(d.lbl)}: ${d.n}"></span>`).join("")}</div>
    <div class="blabels">${days.map((d) => `<span>${esc(d.lbl.slice(0, 2))}</span>`).join("")}</div></div></div>`;
}

function selectPlace(id) {
  S.placeId = id;
  savePlaces(); showAllFar = false; S.sig = ""; render(); loadHist(true);
}
function setTemp(p, ask) {
  S.temp = { id: "tmp", icon: "pin", ...p }; S.placeId = "tmp";
  showAllFar = false; S.sig = ""; render(); loadHist(true);
  if (ask) savePrompt();
}
function savePrompt() {
  const t = S.temp; if (!t) return;
  openPanel("save", "Save this place?", `<form class="saveform" id="saveform"><p class="dim" style="margin:0">Saved places stay on this device only. One tap to check on them later.</p>
    <div class="namechips">${["Home", "Work", "School", "Family"].map((n) => `<button type="button" data-name="${n}">${n}</button>`).join("")}</div>
    <input id="pname" value="${esc(["Dropped pin", "My location"].includes(t.name) ? "" : t.name)}" placeholder="Name it, like Mom's house" maxlength="30" aria-label="Place name">
    <div class="ffoot"><button type="button" class="pillbtn ghost" data-close="panel">Not now</button><button type="submit" class="pillbtn">Save place</button></div></form>`);
  $("#saveform").addEventListener("submit", (e) => { e.preventDefault(); doSave(); });
}
function doSave() {
  const name = ($("#pname").value || "").trim() || S.temp.name || "My place";
  const icon = /^(home|house)/i.test(name) ? "home" : /^(work|office)/i.test(name) ? "work" : /school|college|campus/i.test(name) ? "school" : "pin";
  const id = "p-" + Date.now().toString(36);
  S.places.unshift({ id, name, icon, lat: S.temp.lat, lng: S.temp.lng });
  S.temp = null; S.placeId = id; savePlaces(); closePanel(); toast(`Saved ${name}`); S.sig = ""; render();
}
function managePlaces() {
  openPanel("places", "Your places", `<p class="dim">Add a place by searching above, using your location, or dropping a pin on the map. Places are kept in this browser only.</p>
    ${S.places.length ? `<ul class="placelist">${S.places.map((p) => `<li>${psvg(p.icon)}${esc(p.name)}<button type="button" class="pillbtn ghost" data-delplace="${esc(p.id)}">Remove</button></li>`).join("")}</ul>` : "<p>No saved places yet.</p>"}
    <div class="ffoot" style="justify-content:flex-start"><button type="button" class="pillbtn" data-act="locate">Use my location</button><button type="button" class="pillbtn ghost" data-act="pick">Drop a pin</button><button type="button" class="pillbtn ghost" data-act="focus-find">Search</button></div>`);
}
function locate() {
  closePanel();
  if (!navigator.geolocation) { toast("This browser can't share its location. Try search instead."); return; }
  toast("Finding you…");
  navigator.geolocation.getCurrentPosition((pos) => setTemp({ name: "My location", icon: "me", lat: pos.coords.latitude, lng: pos.coords.longitude }, true),
    () => toast("Location is off. Search or drop a pin instead."), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}
// place search: GET /api/live/places (JAFO's own towns/blocks, then OpenStreetMap)
let pqT = 0, pqSeq = 0, pqRes = [];
async function placeSearch(q) {
  const box = $("#presults"), seq = ++pqSeq;
  if (q.length < 2) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<div class="empty">Searching…</div>';
  let items = [];
  try { items = (await api("/api/live/places", { q })).items || []; } catch (e) { if (seq === pqSeq) box.innerHTML = '<div class="empty">Place search isn\'t available right now.</div>'; return; }
  if (seq !== pqSeq) return;
  pqRes = items;
  box.innerHTML = items.length ? `<h4>Places</h4>${items.map((p, k) => `<button type="button" data-pres="${k}">${psvg(p.kind === "town" ? "town" : "pin")}<span>${esc(p.label)}<small>${esc(p.sub || "")}</small></span></button>`).join("")}`
    : `<div class="empty">No places match “${esc(q)}”. Try a street with a town, like “10th St McAllen”.</div>`;
}

// ---------------------------------------------------------------- lens
function setLens(l, user) {
  S.lens = l === "near" ? "near" : "brief";
  document.body.classList.toggle("lens-near", S.lens === "near");
  $("#brief").hidden = S.lens !== "brief"; $("#near").hidden = S.lens !== "near";
  $$(".lens [data-lens]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.lens === S.lens)));
  if (user) {
    store.set("lens", S.lens);
    const u = new URL(location.href);
    if (S.lens === "near") u.searchParams.set("lens", "near"); else u.searchParams.delete("lens");
    try { history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) {}
  }
  document.title = `JAFO ${S.lens === "near" ? "Near me" : "Live"} · ${CFG.regionName}`;
  S.sig = ""; showAllFar = false;
  render(true); renderAirCluster();
  if (S.lens === "near") { setTimeout(() => { initRing(); drawRing(); }, 0); loadHist(); } else { initMini(); setTimeout(() => mini?.invalidateSize(), 30); }
}

// ---------------------------------------------------------------- alerts (web push), same flow as the map page
const PUSH = { reg: null, sub: null, level: store.get("pushLevel", "off") };
function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function initPush() {
  if (!("serviceWorker" in navigator)) { PUSH.unsupported = true; markBell(); return; }
  try {
    PUSH.reg = await navigator.serviceWorker.register("/live/sw.js", { scope: "/live/" });
    PUSH.sub = await PUSH.reg.pushManager?.getSubscription();
  } catch (e) { /* insecure origin or blocked: the popover explains */ }
  if (!PUSH.sub) PUSH.level = "off";
  markBell();
}
function markBell() {
  const on = PUSH.level !== "off";
  $(".bell-dot").hidden = !on;
  $("#menu-bell-l").textContent = !on ? "Alerts" : PUSH.level === "all" ? "Alerts: all" : "Alerts: priority";
}
function renderBell() {
  const ios = /iphone|ipad/i.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const supported = PUSH.reg && "PushManager" in window;
  $("#bell-pop").innerHTML = `<b>Alerts on this device</b>
    <div class="seg" role="group" aria-label="Alert level">${[["off", "Off"], ["priority", "Priority"], ["all", "All"]].map(([v, l]) => `<button type="button" data-push="${v}" class="${PUSH.level === v ? "on" : ""}" aria-pressed="${PUSH.level === v}">${l}</button>`).join("")}</div>
    <p><b>Priority</b>: shootings, pursuits, major fires and crashes, officer emergencies, high-severity incidents only. <b>All</b> adds medium-severity incidents. Capped at 20 per hour. ${esc(CFG.regionName)} only.</p>
    ${!supported ? `<p>${ios && !standalone ? "On iPhone, add JAFO to your Home Screen first (Share, then Add to Home Screen), then turn alerts on from the app." : "This browser doesn't support push alerts here."}</p>` : ""}`;
}
function toggleBell(force) {
  const pop = $("#bell-pop"), show = force ?? pop.hidden;
  if (show) { renderBell(); $("#menu").hidden = true; }
  pop.hidden = !show; $("#btn-bell").setAttribute("aria-expanded", String(show));
}
async function setPush(level) {
  try {
    if (level === "off") {
      if (PUSH.sub) { await post("/api/live/push/unsubscribe", { endpoint: PUSH.sub.endpoint }); await PUSH.sub.unsubscribe(); }
      PUSH.sub = null;
    } else {
      if (!PUSH.reg || !("PushManager" in window)) { toast("Push alerts aren't available here"); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Notifications are blocked for this site"); return; }
      if (!PUSH.sub) {
        const { key } = await api("/api/live/push/key", { region: undefined });
        PUSH.sub = await PUSH.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      }
      await post("/api/live/push/subscribe", { subscription: PUSH.sub.toJSON(), level, region: CFG.region });
      toast(level === "all" ? "You'll get all alerts" : "You'll get priority alerts");
    }
    PUSH.level = level; store.set("pushLevel", level);
  } catch (e) { toast("Couldn't change alerts"); }
  markBell(); renderBell();
}

// ---------------------------------------------------------------- panels
let panelKind = null;
function openPanel(kind, title, html) {
  panelKind = kind; $("#panel").hidden = false; document.body.classList.add("noscroll");
  $("#panel-h").textContent = title; $("#panel-body").innerHTML = html || '<div class="loading">Loading…</div>';
  $("#panel .panel-in").scrollTop = 0;
}
function closePanel() { $("#panel").hidden = true; panelKind = null; if ($("#mapsheet").hidden) document.body.classList.remove("noscroll"); }
function setTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("jafo.live.theme", next); } catch (e) {}
  if (S.lens === "near") drawRing();
}
async function openNamed(name) {
  $("#menu").hidden = true; $("#btn-menu").setAttribute("aria-expanded", "false");
  if (name === "map") return openMap();
  if (name === "bell") return toggleBell(true);
  if (name === "theme") return setTheme();
  if (name === "radio") { openPanel("radio", "Live radio"); renderRadioPanel(); return; }
  if (name === "air") { openPanel("air", "In the air"); renderAirPanel(); return; }
  if (name === "codes") {
    openPanel("codes", "Radio codes, explained");
    try { const d = await api("/api/live/codes"); $("#panel-body").innerHTML = `<p class="dim">Codes heard on ${esc(CFG.regionName)} radio lately and what they usually mean. Learned from the traffic itself, so treat them as a guide.</p><dl class="codes big">${(d.items || []).map((c) => `<div><dt>${esc(c.code)}</dt><dd>${esc(c.meaning)}</dd></div>`).join("") || "<p>Not enough traffic yet.</p>"}</dl>`; }
    catch (e) { $("#panel-body").innerHTML = "<p>Couldn't load the codes. Try again in a moment.</p>"; }
    return;
  }
  if (name === "cams") {
    openPanel("cams", "Traffic cameras");
    try { const d = await api("/api/live/cameras"); const bust = Math.floor(Date.now() / 60000);
      $("#panel-body").innerHTML = (d.items || []).length ? `<p class="dim">TxDOT camera stills. They refresh about once a minute.</p><div class="cams">${d.items.slice(0, 48).map((c) => `<figure><img loading="lazy" src="${esc(c.img)}${String(c.img).includes("?") ? "&" : "?"}t=${bust}" alt="${esc(c.name)}"><figcaption>${esc(c.name)}${c.dir ? `<small>Looking ${esc(c.dir.toLowerCase())}</small>` : ""}</figcaption></figure>`).join("")}</div>` : "<p>No cameras for this region.</p>"; }
    catch (e) { $("#panel-body").innerHTML = "<p>Couldn't load cameras.</p>"; }
    return;
  }
  if (name === "about") return openPanel("about", "How this works", `<div class="prose">
    <p><b>JAFO listens to public-safety radio</b> in ${esc(CFG.regionName)} with its own receivers, the same way a scanner does.</p>
    <p>Each transmission is recorded and turned into text by speech recognition. Then an AI model writes it as one plain-English line, notes who's speaking, explains radio codes, and decides which story it belongs to. Stories get a place (rounded to the block), the units working them, and a status: <i>just reported</i>, <i>help on the way</i>, <i>crews on scene</i>, <i>quiet</i>, or <i>wrapped up</i>.</p>
    <p>The <b>Briefing</b> paragraph is written on your device from those stories, ordered by how serious they are, how many crews are involved, and how recent they are. <b>Near me</b> sorts the same stories by distance from places you choose. Saved places stay in this browser; place search looks things up through JAFO's server, which uses its own records and OpenStreetMap.</p>
    <p><b>In the air</b> comes from aircraft broadcasting their position (ADS-B). We point out helicopters, Border Patrol, medical and military flights, and emergency codes.</p>
    <p>Civilian names, phone numbers, plates and exact house numbers are hidden automatically. ${CAN_PLAY ? "Recordings play only when you tap them, and they aren't edited, so they may contain details the written version leaves out." : "Audio stays private to the station operators."} Encrypted channels aren't heard at all.</p>
    <p>Everything here is automated and unconfirmed. Transcripts, summaries and locations can be wrong; <button type="button" class="link" data-open="report">tell us</button> when they are. <b>This is not an emergency service. Call 911 if you need help.</b></p></div>`);
  if (name === "report") return openReport(null, null);
}
function openReport(callId, incId) {
  openPanel("report", "Report a problem", `<p class="dim">Reports help us fix bad transcripts, wrong locations and anything that shouldn't be public.</p>
    <form class="rform" id="rform"><label>What's wrong?<select name="reason" required><option value="">Choose one</option><option>Wrong location</option><option>Transcript is wrong</option><option>Wrong incident / grouping</option><option>Private information showing</option><option>Wrong unit or status</option><option>Something else</option></select></label>
    <label>Anything else? <small>(optional)</small><textarea name="note" rows="3"></textarea></label>
    <div class="ffoot"><button type="button" class="pillbtn ghost" data-close="panel">Cancel</button><button type="submit" class="pillbtn">Send report</button></div></form>`);
  $("#rform").addEventListener("submit", async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try { await post("/api/live/report", { call_id: callId || null, incident_id: incId || null, reason: fd.get("reason"), note: fd.get("note") }); toast("Report sent. Thank you."); }
    catch (err) { toast("Couldn't send the report. Try again."); }
    closePanel();
  });
}

// ---------------------------------------------------------------- controls
function syncChips() {
  $$("#chips-service [data-svc]").forEach((b) => b.classList.toggle("on", b.dataset.svc === S.f.svc && !(b.dataset.svc === "" && S.f.kinds.length)));
  $$("#seg-window [data-win], #when [data-win]").forEach((b) => b.classList.toggle("on", b.dataset.win === S.f.win));
  $("#kchips").innerHTML = KINDS.map((k) => `<button type="button" data-kind="${k}" class="${S.f.kinds.includes(k) ? "on" : ""}" aria-pressed="${S.f.kinds.includes(k)}">${kico(k)}${esc(KIND_LABEL[k])}</button>`).join("");
  const more = S.f.win === "7d" || S.f.kinds.length;
  $("#chip-more").textContent = more ? `More · ${[S.f.win === "7d" ? "week" : "", S.f.kinds.length ? `${S.f.kinds.length} kind${S.f.kinds.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ")}` : "More";
  $("#chip-more").classList.toggle("on", !!more);
  const qn = $("#qnote"); qn.hidden = !S.q; if (S.q) qn.innerHTML = `Showing stories that mention “${esc(S.q)}” <button type="button" class="link sm" data-clearq>Clear</button>`;
}
function closeFloaters(except) {
  if (except !== "menu") { $("#menu").hidden = true; $("#btn-menu").setAttribute("aria-expanded", "false"); }
  if (except !== "bell") { $("#bell-pop").hidden = true; $("#btn-bell").setAttribute("aria-expanded", "false"); }
  if (except !== "find") $("#presults").hidden = true;
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-toggle], [data-air], a, li[data-air]");
  if (!e.target.closest("#menu, #btn-menu, #bell-pop, #btn-bell, #find")) closeFloaters();
  else if (!e.target.closest("#find")) $("#presults").hidden = true;
  if (!t) return;
  if (t.tagName === "A" && (t.dataset.goto || t.dataset.air)) e.preventDefault();
  const ds = t.dataset;
  if (ds.goto) { e.stopPropagation(); if (!$("#mapsheet").hidden) closeMap(); if (panelKind) closePanel(); gotoStory(+ds.goto); return; }
  if (ds.play) { play(+ds.play); return; }
  if (ds.words) { const id = +ds.words; S.words.has(id) ? S.words.delete(id) : S.words.add(id); render(true); if (panelKind === "radio") renderRadioPanel(); return; }
  if (ds.reportInc) { openReport(null, +ds.reportInc); return; }
  if (ds.share) { share(+ds.share); return; }
  if (ds.mapto) { openMap(+ds.mapto); return; }
  if (ds.readstory) { closeMap(); gotoStory(+ds.readstory); return; }
  if (ds.toggleAir !== undefined) { showAir = !showAir; updateMapAir(); renderLegend(); return; }
  if (ds.toggle) { toggleStory(+ds.toggle); return; }
  if (ds.air) {
    const a = (S.air?.aircraft || []).find((x) => x.hex === ds.air); if (!a) return;
    if (panelKind) closePanel();
    openMap(); if (big && a.lat != null) big.setView([a.lat, a.lng], 13); msAir(a); return;
  }
  if (ds.lens) { setLens(ds.lens, true); return; }
  if (ds.push) { setPush(ds.push); return; }
  if (ds.open) { openNamed(ds.open); return; }
  if (ds.close === "map") { closeMap(); return; }
  if (ds.close === "panel") { closePanel(); return; }
  if (ds.allwrapped !== undefined) { showAllWrapped = true; render(true); return; }
  if (ds.allfar !== undefined) { showAllFar = true; render(true); return; }
  if (ds.reset !== undefined) { S.f = { svc: "", win: "active", kinds: [] }; S.q = ""; $("#q").value = ""; saveF(); syncChips(); loadIncidents(true); return; }
  if (ds.clearq !== undefined) { S.q = ""; $("#q").value = ""; syncChips(); render(true); return; }
  if (ds.svc !== undefined) { S.f.svc = ds.svc; if (ds.svc === "") S.f.kinds = []; saveF(); syncChips(); render(true); return; }
  if (ds.win) { S.f.win = ds.win; showAllWrapped = false; saveF(); syncChips(); $("#stream").innerHTML = '<div class="loading">Loading…</div>'; S.sig = ""; S.loaded = false; loadIncidents(true).catch(() => {}); return; }
  if (ds.kind) { const k = ds.kind; S.f.kinds = S.f.kinds.includes(k) ? S.f.kinds.filter((x) => x !== k) : [...S.f.kinds, k]; saveF(); syncChips(); render(true); return; }
  if (ds.radius) { S.radius = +ds.radius; store.set("radius", S.radius); showAllFar = false; S.sig = ""; render(); loadHist(true); return; }
  if (ds.place) { selectPlace(ds.place); return; }
  if (ds.town !== undefined) { const tw = townCache[+ds.town]; if (tw) setTemp({ name: tw.name, icon: "town", lat: tw.lat, lng: tw.lng }, false); return; }
  if (ds.pres !== undefined) { const p = pqRes[+ds.pres]; if (p) { $("#presults").hidden = true; $("#pq").value = ""; $("#pq").blur(); setTemp({ name: p.label.split(",")[0], icon: p.kind === "town" ? "town" : "pin", lat: p.lat, lng: p.lng }, false); } return; }
  if (ds.delplace) {
    S.places = S.places.filter((p) => p.id !== ds.delplace);
    if (S.placeId === ds.delplace) S.placeId = S.places[0]?.id || null;
    savePlaces(); managePlaces(); S.sig = ""; render(); loadHist(true); return;
  }
  if (ds.name) { $("#pname").value = ds.name; return; }
  if (ds.radioMore !== undefined) {
    const all = [...S.radio, ...radioExtra]; const oldest = Math.min(...all.map((c) => c.at));
    try { const d = await api("/api/live/radio", { limit: 40, before: oldest, hide_chatter: 1 }); radioExtra = radioExtra.concat(d.items || []); renderRadioPanel(); } catch (err) { toast("Couldn't load earlier calls"); }
    return;
  }
  switch (ds.act) {
    case "locate": locate(); return;
    case "manage": managePlaces(); return;
    case "save-temp": savePrompt(); return;
    case "pick": closePanel(); setPicking(true); $("#ringbox").scrollIntoView({ behavior: "smooth", block: "center" }); return;
    case "cancel-pick": setPicking(false); return;
    case "focus-find": closePanel(); $("#pq").focus(); return;
  }
  if (t.id === "chip-more") { const m = $("#more"); m.hidden = !m.hidden; t.setAttribute("aria-expanded", String(!m.hidden)); return; }
  if (t.id === "btn-search") { const f = $("#searchbar"); f.hidden = !f.hidden; t.setAttribute("aria-expanded", String(!f.hidden)); if (!f.hidden) $("#q").focus(); return; }
  if (t.id === "q-clear") { $("#searchbar").hidden = true; return; }
  if (t.id === "minimap-open") { openMap(); return; }
  if (t.id === "btn-theme") { setTheme(); return; }
  if (t.id === "btn-bell") { toggleBell(); return; }
  if (t.id === "btn-menu") { const m = $("#menu"); closeFloaters("menu"); m.hidden = !m.hidden; t.setAttribute("aria-expanded", String(!m.hidden)); return; }
  if (t.id === "pp") { S.audio.paused ? S.audio.play() : S.audio.pause(); return; }
  if (t.id === "pl-x") { S.audio.pause(); S.playing = null; $("#player").hidden = true; syncPlay(); return; }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (panelKind) closePanel(); else if (!$("#mapsheet").hidden) closeMap(); else if (S.picking) setPicking(false); else closeFloaters();
  }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-toggle][role=button]")) { e.preventDefault(); toggleStory(+e.target.dataset.toggle); }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-air][role=button]")) { e.preventDefault(); e.target.click(); }
  if ((e.key === "Enter" || e.key === " ") && e.target.id === "minimap") { e.preventDefault(); openMap(); }
});
let qT;
$("#q").addEventListener("input", (e) => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); syncChips(); render(true); }, 180); });
$("#searchbar").addEventListener("submit", (e) => { e.preventDefault(); $("#searchbar").hidden = true; });
$("#pq").addEventListener("input", (e) => { clearTimeout(pqT); const q = e.target.value.trim(); if (q.length < 2) { pqSeq++; $("#presults").hidden = true; return; } pqT = setTimeout(() => placeSearch(q), 400); });
$("#pq").addEventListener("focus", () => { if (pqRes.length && $("#pq").value.trim().length >= 2) $("#presults").hidden = false; });
$("#find").addEventListener("submit", (e) => { e.preventDefault(); const b = $("#presults [data-pres]"); if (b) b.click(); });
addEventListener("hashchange", routeHash);

// ---------------------------------------------------------------- boot + polling (paused while the tab is hidden)
window.__brief = { S, openMap, gotoStory, toggleStory, openNamed, setLens };
async function refreshAll() {
  await Promise.all([loadIncidents().catch(() => {}), loadAir(), loadRadio()]);
}
async function boot() {
  syncChips();
  const want = QS.get("lens") || (store.get("lens", "brief") === "near" ? "near" : "brief");
  if (S.placeId && S.placeId !== "tmp" && !S.places.some((p) => p.id === S.placeId)) S.placeId = S.places[0]?.id || null;
  if (!S.placeId && S.places.length) S.placeId = S.places[0].id;
  setLens(want, want === "near" && !QS.get("lens"));
  await loadPulse();
  await Promise.all([loadIncidents(true).catch(() => { $("#stream").innerHTML = '<div class="empty"><p><b>Couldn\'t reach the radio feed.</b> We\'ll keep trying every few seconds.</p></div>'; }), loadRadio(), loadAir(), loadWeather()]);
  if (S.lens === "brief") initMini(); else loadHist();
  presence(); initPush();
  routeHash();
  setInterval(() => !document.hidden && loadIncidents().catch(() => {}), 15000);
  setInterval(() => !document.hidden && loadAir(), 10000);
  setInterval(() => !document.hidden && loadRadio(), 10000);
  setInterval(() => !document.hidden && loadPulse(), 60000);
  setInterval(() => !document.hidden && presence(), 30000);
  setInterval(() => !document.hidden && loadWeather(), 600000);
  setInterval(() => { if (!document.hidden && S.lens === "near") loadHist(true); }, 300000);
  setInterval(() => { if (!document.hidden) { S.sig = ""; render(); } }, 60000);  // keep "x min ago" honest
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => { if (document.hidden) hiddenAt = Date.now(); else if (Date.now() - hiddenAt > 10000) { refreshAll(); loadPulse(); } });
  addEventListener("resize", () => { if (S.lens === "brief") initMini(); });
}
boot();
})();
