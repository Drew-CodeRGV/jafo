// JAFO Pro — the multi-pane operations console at /live/<region>/pro.
// Queue · Map · Radio · Units · Air · Detail · River, all linked: select an incident and its units,
// radio lines, timeline bar and the aircraft circling it all light up. Keyboard-first.
// Vanilla JS + Leaflet; reads /api/live/* (pi/web/live.py, pi/web/air.py).
(() => {
"use strict";
const CFG = window.JAFO_LIVE || {};
const QS = new URLSearchParams(location.search);
const DEMO = QS.get("demo") === "1";
const CAN_AUDIO = !!CFG.audio;
const RBOX = CFG.regionInfo || {};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("jafo.pro." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("jafo.pro." + k, JSON.stringify(v)); } catch (e) {} },
};
const isPhone = () => matchMedia("(max-width: 760px)").matches;

// ---------------------------------------------------------------- glyphs (kind + responder glyphs = validated set from live.js)
const KIND_ICON = {
  violence: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  traffic: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3.5 16h17M7 19v-3M17 19v-3M7.5 12.5h.01M16.5 12.5h.01"/>',
  medical: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11.5h2l1-2 1.5 4 1-2h1"/>',
  property: '<path d="M4 11 12 4l8 7v9H4v-9z"/><path d="M10 20v-5h4v5"/>',
  suspicious: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
  other: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
};
const KIND_LABEL = { violence: "Violence and danger", traffic: "Traffic", medical: "Medical and welfare", property: "Property and alarms",
  suspicious: "Suspicious and disputes", fire: "Fire", other: "Other calls" };
const KINDS = Object.keys(KIND_LABEL);
const KIND_GROUP = { violence: "danger", fire: "danger", medical: "medical", traffic: "general", property: "general", suspicious: "general", other: "neutral" };
const kico = (k) => `<span class="kico k-${esc(KIND_ICON[k] ? k : "other")}" title="${esc(KIND_LABEL[k] || "Other")}"><svg viewBox="0 0 24 24">${KIND_ICON[k] || KIND_ICON.other}</svg></span>`;
const RESP_ICON = {
  police: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z"/>',
  fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
  ems: '<path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>',
  hazmat: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/><path d="M12 8v5M12 15.8v.4"/>',
  air: '<path d="M3 5h15M11 5v3M6.5 13c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5-2.2 4-5 4-5-1.5-5-4zM16.5 12.5H22M8 20h9M10 17.3V20M14 17.3V20"/>',
  k9: '<circle cx="7" cy="9" r="1.8"/><circle cx="11" cy="6" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="18.5" cy="9.5" r="1.8"/><path d="M8 17c0-3 2-5.5 4.5-5.5S17 14 17 17c0 2-1.8 2.5-4.5 2.5S8 19 8 17z"/>',
  swat: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  command: '<path d="M5 9l7-4 7 4M5 14l7-4 7 4M5 19l7-4 7 4"/>',
  rescue: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M15 9l3-3M9 9 6 6M15 15l3 3M9 15l-3 3"/>',
  ladder: '<path d="M8 3v18M16 3v18M8 7h8M8 11h8M8 15h8M8 19h8"/>',
  tow: '<path d="M2 16V8h8v8M10 11h5l3 3v2h-3M2 16h16"/><circle cx="6" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/><path d="M18 5v3a2 2 0 0 0 4 0"/>',
  utility: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  examiner: '<path d="M8 4h8v3H8zM6 6H5v15h14V6h-1M9 12h6M9 16h4"/>',
  border: '<path d="M4 21V4M4 4h13l-2.5 4L17 12H4"/>',
  dps: '<path d="M12 3l2.6 5.6 6 .6-4.5 4 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.5-4 6-.6z"/>',
  other: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
};
const respSvg = (k) => `<svg viewBox="0 0 24 24">${RESP_ICON[k] || RESP_ICON.other}</svg>`;
function responders(it) {
  const list = [...(it.responders || [])];
  const over = airOver(it.id);
  if (over.length && !list.some((r) => r.key === "air")) list.push({ key: "air", label: over[0].kind === "helicopter" ? "Helicopter overhead" : "Aircraft overhead", n: over.length, live: true });
  return list;
}
function respStrip(it, max = 5) {
  const list = responders(it);
  if (!list.length) return "";
  return `<span class="resp">${list.slice(0, max).map((r) => `<i class="r-${esc(r.key)}${r.live ? " live" : ""}" title="${esc(r.label)}${r.n > 1 ? " ×" + r.n : ""}">${respSvg(r.key)}${r.n > 1 ? `<b>${r.n}</b>` : ""}</i>`).join("")}${list.length > max ? `<i class="more">+${list.length - max}</i>` : ""}</span>`;
}
function respChips(it) {
  const list = responders(it);
  if (!list.length) return "";
  return `<div class="rchips">${list.map((r) => `<span class="rc r-${esc(r.key)}${r.live ? " live" : ""}">${respSvg(r.key)}${esc(r.label)}${r.n > 1 ? ` <b>×${r.n}</b>` : ""}</span>`).join("")}</div>`;
}
const ST_SVG = {
  new: '<path d="M6 1v10M1 6h10M2.6 2.6l6.8 6.8M9.4 2.6 2.6 9.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  reported: '<path d="M6 1v10M1 6h10M2.6 2.6l6.8 6.8M9.4 2.6 2.6 9.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  dispatched: '<path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  en_route: '<path d="M2.5 1.5 10.5 6l-8 4.5z" fill="currentColor"/>',
  on_scene: '<circle cx="6" cy="6" r="4.6" fill="currentColor"/>',
  transporting: '<rect x="1.2" y="1.2" width="9.6" height="9.6" rx="2" fill="currentColor"/><path d="M6 3.4v5.2M3.4 6h5.2" style="stroke:var(--pane)" stroke-width="1.7"/>',
  busy: '<rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor"/>',
  available: '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  cleared: '<path d="M1.8 6.4 4.8 9.3 10.2 2.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  quiet: '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 1.8a4.2 4.2 0 0 1 0 8.4z" fill="currentColor"/>',
  ended: '<path d="M2 6h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  closed: '<path d="M2 6h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  left: '<path d="M2 6h6M6 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  unknown: '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.6"/>',
};
const INC_STATUS = { new: "New", en_route: "Units on the way", on_scene: "Units on scene", cleared: "Cleared", quiet: "Quiet", ended: "Ended" };
const UNIT_STATUS = { dispatched: "Dispatched", en_route: "On the way", on_scene: "On scene", transporting: "Transporting", busy: "Busy", available: "Available", unknown: "Heard", left: "Moved on", cleared: "Cleared" };
const stSvg = (s) => `<svg viewBox="0 0 12 12" aria-hidden="true">${ST_SVG[s] || ST_SVG.unknown}</svg>`;
const stBadge = (s, label, short) => `<span class="st st-${esc(s)}" title="${esc(label)}">${stSvg(s)}${short ? "" : `<span class="stl">${esc(label)}</span>`}</span>`;
const incSt = (s, short) => stBadge(s, INC_STATUS[s] || s, short);
const unitSt = (s, short) => stBadge(s || "unknown", UNIT_STATUS[s] || "Heard", short);
const PLANE = '<path d="M12 2c.7 0 1.2.8 1.2 1.8v5.6l8 4.6v2.1l-8-2.4v4.6l2.4 1.8v1.6L12 20.6l-3.6 1.1v-1.6l2.4-1.8v-4.6l-8 2.4V14l8-4.6V3.8C10.8 2.8 11.3 2 12 2z"/>';
const HELI = '<path d="M12 7c1.9 0 3.3 1.8 3.3 4.1v1.4c0 1.6-.9 2.9-2.2 3.4V22h-2.2v-6.1c-1.3-.5-2.2-1.8-2.2-3.4v-1.4C8.7 8.8 10.1 7 12 7z"/><path d="M2.6 3.2 21.7 9.6l-.5 1.4L2.1 4.6z"/><path d="M21.4 3.2 2.3 9.6l.5 1.4L21.9 4.6z"/><path d="M9.5 20.5h5v1.3h-5z"/>';
const acSvg = (a) => `<svg viewBox="0 0 24 24" class="${a.kind === "helicopter" ? "heli" : "plane"}">${a.kind === "helicopter" ? HELI : PLANE}</svg>`;
const ICO = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  unit: '<svg viewBox="0 0 24 24" class="ico"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
  radio: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 10h16v10H4zM8 10l9-6"/><circle cx="9" cy="15" r="2"/></svg>',
  cmd: '<svg viewBox="0 0 24 24" class="ico"><path d="m9 18 6-6-6-6"/></svg>',
};
const ROLE_LABEL = { border: "Border", medical: "Medical", police: "Police", military: "Military", news: "News" };

// ---------------------------------------------------------------- time (always region TZ)
const TZ = CFG.tz || undefined;
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }).toLowerCase().replace(" ", "") : "";
const fmtClock = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "";
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
const tzOffset = (() => { const d = new Date(); const l = new Date(d.toLocaleString("en-US", { timeZone: TZ })); const u = new Date(d.toLocaleString("en-US", { timeZone: "UTC" })); return Math.round((l - u) / 1000); })();
let clockSkew = 0;
const now = () => Math.floor(Date.now() / 1000) + clockSkew;
function age(ts) {
  const s = Math.max(0, now() - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function dur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}
const num = (n) => (n ?? 0).toLocaleString("en-US");

// ---------------------------------------------------------------- api
async function api(path, params = {}) {
  const u = new URL(path, location.origin);
  if (!("region" in params)) params.region = CFG.region;
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------------------------------------------------------- state
const S = {
  incidents: [], units: [], radio: [], channels: [], air: null, pulse: null, codes: [], cams: null,
  f: Object.assign({ window: "active", service: "", kinds: [] }, store.get("filters", {})),
  q: "",
  sort: store.get("sort", { key: "age", dir: "desc" }),
  unitsScope: store.get("unitsScope", "out"),
  hiddenCh: new Set(store.get("hiddenCh", [])),
  hideChatter: store.get("hideChatter", false), radioIncOnly: false, airOnly: store.get("airOnly", false),
  words: store.get("words", true), lines: store.get("lines", true),
  layers: Object.assign({ inc: true, units: true, air: true, cams: false }, store.get("layers", {})),
  sel: null,            // {type: incident|unit|air, id}
  selInc: null,         // incident id that every pane highlights
  detail: null,         // last loaded detail payload
  dcache: new Map(),    // incident id -> detail (status_history for River segments)
  airTrack: null,       // {hex, points} longer persisted track for the selected aircraft
  focus: "queue", cur: { queue: 0, radio: 0, units: 0, air: 0, river: -1 },
  listening: false, follow: false,
  audio: new Audio(), playing: null, playQueue: [],
  seenInc: new Set(), seenRadio: new Set(), firstLoad: true,
  riverAt: store.get("riverAt", "strip"),
  rv: { span: store.get("riverSpan", 21600), pan: 0, inc: new Map(), calls: new Map(), callIds: new Set(), air: [], airAt: 0, lastFetch: "" },
};
S.audio.preload = "auto";
if (DEMO && S.f.window === "active") S.f.window = "active";

// ---------------------------------------------------------------- transcript text
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function rich(text, codes = [], units = []) {
  let h = esc(text);
  h = h.replace(/⟦[^⟧]*⟧/g, '<span class="redacted" title="Hidden for privacy">hidden</span>');
  for (const c of codes || []) {
    if (!c.code || c.code.length < 2) continue;
    const re = new RegExp(`(^|[^\\w-])(${reEsc(esc(c.code)).replace(/-/g, "[- ]?")})(?![\\w])`, "gi");
    h = h.replace(re, `$1<span class="code" title="${esc(c.code)}: ${esc(c.meaning)}">$2</span>`);
  }
  for (const u of units || []) {
    if (!u.callsign || u.callsign.length < 3) continue;
    const re = new RegExp(`(^|[^\\w>])(${reEsc(esc(u.callsign))})(?![\\w<])`, "g");
    h = h.replace(re, `$1<span class="unit-ref"${u.id ? ` data-unit="${u.id}"` : ""}>$2</span>`);
  }
  return h;
}
function codesFor(call) {
  if (call.codes && call.codes.length) return call.codes;
  const said = (call.speakers || []).map((s) => s.text).join(" ");
  if (!said) return [];
  return S.codes.filter((c) => c.code && c.code.length >= 3 &&
    new RegExp(`(^|[^\\w-])${reEsc(c.code).replace(/-/g, "[- ]?")}(?![\\w])`, "i").test(said));
}
function turnsHtml(call, units, max = 99) {
  const seen = new Set(); const out = [];
  for (const s of call.speakers || []) {
    const k = (s.who || "") + "|" + s.text; if (seen.has(k)) continue; seen.add(k);
    out.push(`<div class="t"><span class="who">${esc(s.who || "")}</span><span>${rich(s.text, codesFor(call), units)}</span></div>`);
    if (out.length >= max) break;
  }
  return out.length ? `<div class="turns">${out.join("")}</div>` : "";
}
const isChatter = (c) => !c.incident_id && (c.kind === "other" || !c.kind) && /chatter|unclear/i.test((c.type || "") + " " + (c.line || ""));

// ---------------------------------------------------------------- theme
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
  $('meta[name="theme-color"]').content = t === "dark" ? "#0b0e13" : "#fbfcfd";
  if (S.pulse) renderSpark();
  if (map) { renderMapIncidents(); renderAirMap(); drawFocus(); }
  renderRiver();
}

// ================================================================= MAP
let map, incLayer, unitLayer, airLayer, trailLayer, camLayer, aptLayer, focusLayer, placeLayer;
function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true, worldCopyJump: false });
  L.control.zoom({ position: "topright" }).addTo(map);
  map.setView([RBOX.default_lat || 26.2, RBOX.default_lng || -98.2], RBOX.default_zoom || 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abc", className: "basemap-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  map.createPane("trails").style.zIndex = 440;
  map.createPane("air").style.zIndex = 600;
  map.createPane("units").style.zIndex = 620;
  map.createPane("incs").style.zIndex = 640;
  trailLayer = L.layerGroup().addTo(map);
  aptLayer = L.layerGroup().addTo(map);
  camLayer = L.layerGroup();
  focusLayer = L.layerGroup().addTo(map);
  placeLayer = L.layerGroup().addTo(map);
  unitLayer = L.layerGroup().addTo(map);
  airLayer = L.layerGroup().addTo(map);
  incLayer = L.layerGroup().addTo(map);
  let fitted = false;
  new ResizeObserver(() => { map.invalidateSize({ pan: false });
    if (!mapVisible()) return;
    if (S._pendingPan) { const [a, b, z] = S._pendingPan; S._pendingPan = null; fitted = true; map.setView([a, b], z); }
    else if (!fitted) { fitted = true; fitRegion(); } }).observe($("#map"));
  $("#maplegend").innerHTML = `<span><i style="background:var(--danger)"></i>Danger</span><span><i style="background:var(--medical)"></i>Medical</span>
    <span><i style="background:var(--general)"></i>General</span><span><i style="background:var(--neutral)"></i>Other</span>
    <span><svg viewBox="0 0 24 24" width="12" height="12" style="fill:var(--air)">${PLANE}</svg>Interesting aircraft</span>`;
}
const mapVisible = () => $("#map").clientHeight > 60 && $("#map").clientWidth > 60;
function fitRegion() {
  if (!map || !mapVisible()) return;
  if (RBOX.bbox_north != null) map.fitBounds([[RBOX.bbox_south, RBOX.bbox_west], [RBOX.bbox_north, RBOX.bbox_east]], { padding: [10, 10] });
  else map.setView([RBOX.default_lat || 26.2, RBOX.default_lng || -98.2], RBOX.default_zoom || 10);
}
function incIcon(i) {
  const sel = S.selInc === i.id, hl = !sel && S.focus === "queue" && visibleIncidents()[S.cur.queue]?.id === i.id;
  const cls = ["mk", i.closed ? "closed" : "", sel ? "sel" : "", hl ? "hl" : "", S._pulseInc === i.id ? "pulse" : "", S.selInc && !sel ? "dimmed" : ""].join(" ");
  const label = sel || hl ? `<span class="ml">${esc(i.title)}</span>` : "";
  return L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="${cls}">${kico(i.kind)}<span class="ms st-${esc(i.status)}">${stSvg(i.status)}</span>${label}</div>` });
}
function renderMapIncidents() {
  if (!map) return;
  incLayer.clearLayers();
  if (!S.layers.inc) return;
  const list = visibleIncidents().slice();
  // the selected incident stays on the map even if the queue's window/filter hides it
  if (S.selInc && !list.some((i) => i.id === S.selInc)) { const x = incById(S.selInc); if (x) list.push(x); }
  for (const i of list) {
    if (i.lat == null) continue;
    const m = L.marker([i.lat, i.lng], { pane: "incs", icon: incIcon(i), zIndexOffset: S.selInc === i.id ? 1000 : (i.closed ? -100 : 0), keyboard: false });
    m.on("click", () => select("incident", i.id, { pan: false }));
    if (S.selInc !== i.id) m.bindTooltip(`${esc(i.title)}<br><span style="color:var(--text-3)">${esc(placeOf(i))} · ${age(i.last_at)} ago</span>`, { direction: "top", offset: [0, -12] });
    m.addTo(incLayer);
  }
}
function renderMapUnits() {
  if (!map) return;
  unitLayer.clearLayers();
  if (!S.layers.units) return;
  const groups = new Map();
  for (const u of S.units) {
    if (u.lat == null || u.status === "available") continue;
    const k = u.lat.toFixed(5) + "," + u.lng.toFixed(5);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  for (const list of groups.values()) {
    const hl = S.selInc && list.some((u) => u.incident_id === S.selInc);
    const html = `<div class="ub${hl ? " hl" : ""}${S.selInc && !hl ? " dimmed" : ""}">${list.slice(0, 6).map((u) => `<span class="s-${esc(u.status)}" title="${esc(u.callsign)} — ${esc(UNIT_STATUS[u.status] || "")}">${esc(shortCs(u.callsign))}</span>`).join("")}${list.length > 6 ? `<span>+${list.length - 6}</span>` : ""}</div>`;
    const m = L.marker([list[0].lat, list[0].lng], { pane: "units", keyboard: false, icon: L.divIcon({ className: "", html, iconSize: null, iconAnchor: [-16, 24] }) });
    m.on("click", () => select("unit", list[0].id));
    m.addTo(unitLayer);
  }
}
const shortCs = (cs) => String(cs || "").replace(/^Medic\s*/i, "M").replace(/^Engine\s*/i, "E").replace(/^Ladder\s*/i, "L").replace(/^Rescue\s*/i, "R").replace(/^Common\s*/i, "C").replace(/^Brush\s*/i, "B").replace(/^Battalion\s*/i, "BC");
function acColorVar(a) { return a.emergency ? "--emerg" : a.interesting ? "--air" : "--text-3"; }
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const airLinked = (a) => S.selInc && a.near_incident?.id === S.selInc;
function acIcon(a) {
  const sel = (S.sel?.type === "air" && S.sel.id === a.hex) || airLinked(a);
  const showLabel = a.interesting || a.emergency || sel;
  const cls = ["ac", a.emergency ? "emg" : "", a.interesting ? "int" : "", sel ? "sel" : ""].join(" ");
  const lbl = a.emergency ? `${a.callsign || a.hex} · ${a.emergency}` : [a.callsign || a.reg || a.hex, a.role, a.circling ? "circling" : ""].filter(Boolean).join(" · ");
  return L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="${cls}"><div style="transform:rotate(${a.kind === "helicopter" ? 0 : (a.track || 0)}deg)">${acSvg(a)}</div>${showLabel ? `<span class="al">${esc(lbl)}</span>` : ""}</div>` });
}
function renderAirMap() {
  if (!map || !S.air) return;
  airLayer.clearLayers(); aptLayer.clearLayers();
  if (!S.layers.air) return;
  for (const p of S.air.airports || []) {
    L.marker([p.lat, p.lon], { keyboard: false, interactive: true, icon: L.divIcon({ className: "", html: `<span class="apt">${esc(p.icao)}</span>`, iconSize: null, iconAnchor: [12, 8] }) })
      .bindTooltip(esc(p.name), { direction: "top" }).addTo(aptLayer);
  }
  const selHex = S.sel?.type === "air" ? S.sel.id : null;
  // the longer persisted track for the selected aircraft
  if (selHex && S.airTrack?.hex === selHex && S.airTrack.points.length > 1) {
    L.polyline(S.airTrack.points.map((p) => [p[0], p[1]]), { pane: "trails", color: cssVar("--air"), weight: 2, opacity: 0.55, dashArray: "1 5", lineCap: "round", interactive: false }).addTo(airLayer);
  }
  for (const a of airList()) {
    if (a.lat == null) continue;
    const sel = selHex === a.hex || airLinked(a);
    if (a.trail && a.trail.length > 1) {
      L.polyline(a.trail.map((p) => [p[0], p[1]]).concat([[a.lat, a.lng]]), { pane: "trails", color: cssVar(sel ? "--brand" : acColorVar(a)),
        weight: sel ? 3 : (a.interesting ? 2 : 1.3), opacity: sel ? 0.95 : (a.interesting ? 0.75 : 0.4), dashArray: a.interesting || sel ? null : "2 4", interactive: false }).addTo(airLayer);
    }
    const m = L.marker([a.lat, a.lng], { pane: "air", icon: acIcon(a), keyboard: false, zIndexOffset: a.emergency ? 500 : (a.interesting ? 200 : 0) });
    m.on("click", () => select("air", a.hex));
    m.bindTooltip(esc(a.label || a.callsign || a.hex), { direction: "top", offset: [0, -12] });
    m.addTo(airLayer);
  }
}
async function toggleCams(on) {
  if (!on) { map.removeLayer(camLayer); return; }
  camLayer.addTo(map);
  if (!S.cams) {
    try { S.cams = (await api("/api/live/cameras")).items || []; } catch (e) { S.cams = []; }
    for (const c of S.cams) {
      if (c.lat == null) continue;
      L.marker([c.lat, c.lng], { keyboard: false, icon: L.divIcon({ className: "", html: '<div class="cam-mk"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
        .bindPopup(`<b>${esc(c.name)}</b><br><img src="${esc(c.img)}" alt="" style="width:240px;aspect-ratio:16/9;object-fit:cover;margin-top:4px;border-radius:4px" loading="lazy">`, { maxWidth: 260 })
        .addTo(camLayer);
    }
  }
}
function drawFocus() {
  if (!map) return;
  focusLayer.clearLayers(); trailLayer.clearLayers();
  const d = S.detail;
  if (!d || S.sel?.type !== "incident") return;
  for (const t of d.trails || []) {
    const [a, b] = t.points || [];
    if (!a || !b) continue;
    L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { pane: "trails", color: cssVar("--brand"), weight: 2.2, dashArray: "3 6", opacity: 0.9, interactive: false }).addTo(trailLayer);
  }
  if (d.lat != null) L.circle([d.lat, d.lng], { radius: d.precision === "block" ? 120 : 300, color: cssVar("--brand"), weight: 1, fillOpacity: 0.06, interactive: false }).addTo(focusLayer);
}

// ---- place search (map pane) — /api/live/places, debounced
const PL = { items: [], on: 0, seq: 0, t: 0 };
function placeQuery(q) {
  clearTimeout(PL.t);
  const box = $("#place-res");
  if (q.length < 2) { box.hidden = true; PL.items = []; return; }
  PL.t = setTimeout(async () => {
    const seq = ++PL.seq;
    box.hidden = false; box.innerHTML = '<li class="none">Searching…</li>';
    try {
      const d = await api("/api/live/places", { q });
      if (seq !== PL.seq) return;
      PL.items = d.items || []; PL.on = 0; renderPlaces();
    } catch (e) { if (seq === PL.seq) box.innerHTML = '<li class="none">Place search is unavailable right now</li>'; }
  }, 380);
}
function renderPlaces() {
  const box = $("#place-res");
  box.hidden = false;
  box.innerHTML = PL.items.length ? PL.items.map((p, n) => `<li class="it ${n === PL.on ? "on" : ""}" data-place="${n}" role="option"><span class="pk-k">${esc(p.kind === "town" ? "town" : p.kind === "block" ? "block" : "map")}</span><b>${esc(p.label)}</b><span class="ps">${esc(p.sub || "")}</span></li>`).join("")
    : '<li class="none">No matching place in this region</li>';
}
function goPlace(n = PL.on) {
  const p = PL.items[n]; if (!p) return;
  $("#place-res").hidden = true; $("#place-q").blur();
  if (isPhone()) $("#p-map").scrollIntoView({ block: "start", behavior: "smooth" });
  panTo(p.lat, p.lng, p.zoom || 14, true);
  placeLayer.clearLayers();
  L.marker([p.lat, p.lng], { keyboard: false, interactive: false, icon: L.divIcon({ className: "", html: `<div class="placepin"><i></i><span>${esc(p.label)}</span></div>`, iconSize: null, iconAnchor: [7, 7] }) }).addTo(placeLayer);
  clearTimeout(goPlace._t); goPlace._t = setTimeout(() => placeLayer.clearLayers(), 15000);
  focusPane("map");
}

// ================================================================= QUEUE
const STATUS_RANK = { on_scene: 0, en_route: 1, new: 2, quiet: 3, cleared: 4, ended: 5 };
const unitTotal = (i) => (i.unit_list && i.unit_list.length) || Object.values(i.units || {}).reduce((a, b) => a + (b || 0), 0);
const placeOf = (i) => [i.location, i.city].filter(Boolean).join(", ") || "Location not given";
const incById = (id) => S.incidents.find((i) => i.id === id) || S.rv.inc.get(id) || (S.detail?.id === id ? S.detail : null) || S.dcache.get(id);
function visibleIncidents() {
  let list = S.incidents.slice();
  if (S.f.kinds.length) list = list.filter((i) => S.f.kinds.includes(i.kind));
  const { key, dir } = S.sort, m = dir === "asc" ? 1 : -1;
  const val = { status: (i) => STATUS_RANK[i.status] ?? 9, kind: (i) => KINDS.indexOf(i.kind), title: (i) => (i.title || "").toLowerCase(),
    age: (i) => i.last_at, units: unitTotal, calls: (i) => i.calls }[key] || ((i) => i.last_at);
  list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * m || (b.last_at - a.last_at); });
  return list;
}
function airOver(incId) { return (S.air?.aircraft || []).filter((a) => a.near_incident?.id === incId); }
function renderQueue() {
  const list = visibleIncidents();
  S.cur.queue = Math.min(S.cur.queue, Math.max(0, list.length - 1));
  $("#queue-count").textContent = list.length;
  const open = list.filter((i) => !i.closed).length;
  $("#queue-sub").textContent = S.f.window === "active" ? `${open} open` : `${open} open · ${list.length - open} ended`;
  $("#queue-lines").setAttribute("aria-pressed", S.lines);
  $$(".queue th").forEach((th) => { th.classList.toggle("sorted", th.dataset.sort === S.sort.key); th.classList.toggle("asc", S.sort.dir === "asc"); });
  $("#queue-body").innerHTML = list.map((i, n) => {
    const u = unitTotal(i), ac = airOver(i.id);
    const fresh = !S.firstLoad && !S.seenInc.has(i.id + ":" + i.last_at);
    const ll = S.lines && i.last_line ? `<div class="qll" title="${esc(i.last_line.channel || "")} · ${fmtTime(i.last_line.at)}">${respStrip(i, 4)}<span class="tm">${fmtTime(i.last_line.at)}</span>${rich(i.last_line.text)}</div>` : "";
    return `<tr data-inc="${i.id}" class="${S.selInc === i.id ? "sel" : ""} ${S.focus === "queue" && n === S.cur.queue ? "cur" : ""} ${i.closed ? "closed" : ""} ${fresh ? "fresh" : ""}">
      <td class="stc">${incSt(i.status, true)}</td>
      <td>${kico(i.kind)}</td>
      <td><div class="qt">${esc(i.title)}</div>
        <div class="qp">${incSt(i.status)}<span>·</span><span class="qpl">${esc(placeOf(i))}</span>${i.sensitive ? '<span class="sens" title="Sensitive incident">Sensitive</span>' : ""}${ac.length ? `<span class="air-tag" title="Aircraft overhead">✈ ${esc(ac.map((a) => (a.callsign || a.hex) + (a.circling ? " circling" : "")).join(", "))}</span>` : ""}</div>
        ${ll || (respStrip(i) ? `<div class="qll">${respStrip(i)}</div>` : "")}</td>
      <td class="n" title="Last radio ${fmtTime(i.last_at)}">${age(i.last_at)}</td>
      <td class="n" title="${esc((i.unit_list || []).map((x) => x.callsign + (x.status === "left" ? " (moved on)" : "")).join(", "))}">${u || "·"}</td>
      <td class="n">${i.calls}</td></tr>`;
  }).join("");
  for (const i of list) S.seenInc.add(i.id + ":" + i.last_at);
  const e = $("#queue-empty");
  e.hidden = list.length > 0;
  if (!list.length) e.innerHTML = S.q || S.f.kinds.length || S.f.service
    ? "<b>No incidents match these filters</b>Clear the search or kind filters, or widen the time window."
    : S.f.window === "active"
      ? `<b>Nothing open right now</b>The radio is quiet. Press <kbd>]</kbd> to look back further, or watch the River below.`
      : "<b>No incidents in this window</b>Try a longer window.";
}

// ================================================================= UNITS BOARD
const LANE_LABEL = { transporting: "Transport", en_route: "On the way" };
const LANES = ["dispatched", "en_route", "on_scene", "transporting", "busy", "available"];
function selUnitNames() {
  if (!S.selInc) return new Map();
  const i = incById(S.selInc);
  const list = (S.detail?.id === S.selInc && S.detail.units_list) || i?.unit_list || [];
  return new Map(list.map((u) => [String(u.callsign).toLowerCase(), u.on_this === false || u.status === "left" ? "was" : "on"]));
}
function renderBoard() {
  const lanes = S.unitsScope === "all" ? [...LANES, "unknown"] : LANES;
  const by = Object.fromEntries(lanes.map((l) => [l, []]));
  for (const u of S.units) (by[u.status] || by.unknown || by.busy).push(u);
  for (const l of lanes) by[l].sort((a, b) => (b.since || b.last_heard || 0) - (a.since || a.last_heard || 0));
  S._unitOrder = lanes.flatMap((l) => by[l]);
  const curId = S._unitOrder[S.cur.units]?.id;
  const names = selUnitNames();
  $("#units-count").textContent = S.units.length;
  const working = S.units.filter((u) => ["dispatched", "en_route", "on_scene", "transporting"].includes(u.status)).length;
  $("#units-sub").textContent = S.selInc && names.size ? `${working} on calls · ${names.size} on #${S.selInc}` : `${working} on calls`;
  const board = $("#board");
  board.style.gridTemplateColumns = isPhone() ? "" : lanes.map((l) => by[l].length ? "minmax(0, 1fr)" : "minmax(70px, 0.5fr)").join(" ");
  board.innerHTML = lanes.map((l) => `<div class="lane"><h3>${stBadge(l, LANE_LABEL[l] || UNIT_STATUS[l])}<span class="n">${by[l].length}</span></h3><ul>${
    by[l].length ? by[l].map((u) => {
      const rel = S.selInc ? (u.incident_id === S.selInc ? "hl" : names.get(String(u.callsign).toLowerCase()) === "was" ? "was" : "") : "";
      return `<li><button type="button" class="uc svc-${esc(u.service)} ${rel} ${S.focus === "units" && u.id === curId ? "cur" : ""}" data-unit="${u.id}">
      <div class="r1"><span class="cs">${esc(u.callsign)}</span><span class="ag" title="In this status since ${fmtTime(u.since || u.last_heard)}">${u.since || u.last_heard ? age(u.since || u.last_heard) : ""}</span></div>
      <div class="r2">${u.incident_id ? `${kico(u.incident_kind)}<span>${esc(u.incident_sensitive ? "Sensitive call" : u.incident_title || "")}</span>` : `<span>${esc(u.role || u.service || "")}${u.location ? " · " + esc(u.location) : ""}</span>`}</div>
    </button></li>`; }).join("") : '<li class="none">—</li>'}</ul></div>`).join("");
  if (!S.units.length) board.insertAdjacentHTML("beforeend", '<div class="empty board-empty"><b>No units working</b>Units appear here as dispatch and crews call in.</div>');
}

// ================================================================= AIR
function airList() {
  const list = (S.air?.aircraft || []).slice();
  const score = (a) => (a.emergency ? 0 : airLinked(a) ? 0.5 : a.near_incident ? 1 : a.kind === "helicopter" && a.interesting ? 2 : a.interesting ? 3 : 5);
  list.sort((a, b) => score(a) - score(b) || (a.alt_ft || 0) - (b.alt_ft || 0));
  return S.airOnly ? list.filter((a) => a.interesting || a.emergency) : list;
}
function rxText(r) {
  if (!r) return "";
  if (r.override) return `RX manual: ${r.override}`;
  if (!r.enabled) return r.state ? `RX ${String(r.state).toUpperCase()}` : "";
  const st = r.state === "acars" ? "ACARS window" : r.state === "adsb" ? "ADS-B" : String(r.state || "").toUpperCase();
  return `RX ${st} · share ${r.config || ""}${r.smart ? " smart" : ""}`;
}
function renderAir() {
  const d = S.air; if (!d) return;
  const list = airList();
  S.cur.air = Math.min(S.cur.air, Math.max(0, list.length - 1));
  const c = d.counts || {};
  $("#air-count").textContent = c.total ?? list.length;
  $("#air-sub").textContent = [c.helicopters ? `${c.helicopters} heli` : "", c.interesting ? `${c.interesting} interesting` : "", c.emergency ? `${c.emergency} emergency` : "", d.demo ? "demo sky" : ""].filter(Boolean).join(" · ");
  $("#air-only").setAttribute("aria-pressed", S.airOnly);
  const rx = (d.receivers || [])[0], rxe = $("#air-rx");
  rxe.hidden = !rx || DEMO;
  if (rx) { rxe.textContent = rxText(rx); rxe.className = "rx" + (rx.state === "acars" ? " acars" : ""); rxe.title = `${rx.node || "receiver"}${rx.note ? " · " + rx.note : ""}${rx.last_hour ? ` · last hour ADS-B ${rx.last_hour.adsb_pct}% / ACARS ${rx.last_hour.acars_pct}%` : ""}`; }
  $("#air-list").innerHTML = list.length ? list.map((a, n) => {
    const sel = (S.sel?.type === "air" && S.sel.id === a.hex) || airLinked(a);
    return `<button type="button" class="ar ${a.emergency ? "emg" : ""} ${a.interesting ? "int" : ""} ${sel ? "sel" : ""} ${S.focus === "air" && n === S.cur.air ? "cur" : ""}" data-air="${esc(a.hex)}">
      <span class="ag" style="transform:rotate(${a.kind === "helicopter" ? 0 : (a.track || 0)}deg)">${acSvg(a)}</span>
      <span class="a1"><span class="cs">${esc(a.callsign || a.reg || a.hex)}</span>
        ${a.emergency ? `<span class="tag emg">Squawk ${esc(a.emergency)}</span>` : ""}
        ${a.role ? `<span class="tag role">${esc(ROLE_LABEL[a.role] || a.role)}</span>` : ""}
        ${a.circling ? '<span class="tag circ">Circling</span>' : ""}
        <span class="ty">${esc(a.desc || a.type || a.kind || "")}${a.operator ? " · " + esc(a.operator) : ""}</span></span>
      <span class="alt">${a.on_ground ? "ground" : a.alt_ft != null ? num(a.alt_ft) + " ft" : "—"}</span>
      <span class="a2">${a.near_incident ? `<span class="tag near" data-inc="${a.near_incident.id}">Over: ${esc(a.near_incident.title)} · ${a.near_incident.distance_mi} mi</span>` : esc(a.label || "")}</span>
      <span class="spd">${a.gs_kt != null ? a.gs_kt + " kt" : ""}</span></button>`;
  }).join("") : `<div class="empty"><b>${S.airOnly && (d.aircraft || []).length ? "Nothing notable overhead" : "No aircraft in range"}</b>${S.airOnly && (d.aircraft || []).length ? `${d.aircraft.length} routine aircraft hidden. <button type="button" class="linkbtn" data-act="air-all">Show all</button>` : DEMO ? "" : 'The sky is quiet. <a href="?demo=1">See a demo sky</a>.'}</div>`;
  const ac = d.acars || {}, box = $("#acars");
  const msgs = (ac.messages || []).filter((m) => (m.text || "").trim());
  box.hidden = !msgs.length;
  if (!box.hidden) box.innerHTML = `<h4>ACARS · aircraft datalink${ac.active ? "" : ` <span class="dim">· last ${ac.last_at ? age(ac.last_at) + " ago" : "—"}</span>`}</h4><ul>${msgs.slice(0, 10).map((m) => `<li><span class="tm">${fmtClock(m.at)}</span><b>${esc(m.flight || m.tail || "")}</b> ${m.label ? `<span class="tm">[${esc(m.label)}]</span>` : ""}${esc(String(m.text).trim().slice(0, 240))}</li>`).join("")}</ul>`;
}

// ================================================================= RADIO
function visibleRadio() {
  return S.radio.filter((c) => !S.hiddenCh.has(c.channel) && (!S.radioIncOnly || !S.selInc || c.incident_id === S.selInc));
}
function radioItemHtml(c, n) {
  const inc = c.incident_id ? (incById(c.incident_id) || c.incident) : null;
  const hl = S.selInc && c.incident_id === S.selInc;
  const fresh = !S.firstLoad && !S.seenRadio.has(c.id);
  const playing = S.playing?.id === c.id;
  return `<li class="rl ${c.incident_id ? "inc" : ""} ${hl ? "hl" : ""} ${S.selInc && !hl ? "dim" : ""} ${playing ? "playing" : ""} ${fresh ? "fresh" : ""} ${S.focus === "radio" && n === S.cur.radio ? "cur" : ""}" data-call="${c.id}" ${c.incident_id ? `data-inc="${c.incident_id}"` : ""}>
    <span class="tm">${fmtTime(c.at)}<small>${dur(c.dur)}</small></span>
    <div><div class="mh">${c.incident_id || c.kind !== "other" ? kico(c.kind) : ""}<span class="ch">${esc(c.channel)}</span>${inc ? `<span>›</span><span class="it">${esc(inc.title)}</span>` : ""}${inc?.sensitive || c.sensitive ? '<span class="sens">Sensitive</span>' : ""}</div>
      <div class="ln ${isChatter(c) ? "chat" : ""}">${rich(c.line || "(no speech)", codesFor(c))}</div>${turnsHtml(c, null, 4)}</div>
    ${CAN_AUDIO && c.audio ? `<button type="button" class="pb ${playing ? "on" : ""}" data-play="${c.id}" title="Play this call" aria-label="Play">${playing ? ICO.pause : ICO.play}</button>` : "<span></span>"}</li>`;
}
function renderRadio() {
  const el = $("#stream"), list = visibleRadio();
  S.cur.radio = Math.min(S.cur.radio, Math.max(0, list.length - 1));
  const keepTop = el.scrollTop > 8, beforeH = el.scrollHeight, beforeTop = el.scrollTop;
  el.innerHTML = list.length ? list.map(radioItemHtml).join("") : `<li class="empty"><b>No calls to show</b>${S.radio.length ? 'Turn more channels back on, or clear "This incident".' : "Waiting for the first transmission."}</li>`;
  if (keepTop) el.scrollTop = beforeTop + (el.scrollHeight - beforeH);
  for (const c of S.radio) S.seenRadio.add(c.id);
  $("#radio-count").textContent = list.length;
  $("#radio-chan-n").textContent = S.hiddenCh.size ? `${S.channels.length - S.hiddenCh.size}/${S.channels.length}` : "all";
  $("#radio-chatter").setAttribute("aria-pressed", S.hideChatter);
  $("#radio-inc").setAttribute("aria-pressed", S.radioIncOnly);
  $("#radio-inc").hidden = !S.selInc;
}
function renderChanPop() {
  const p = $("#chanpop");
  p.innerHTML = `<div class="cf"><button type="button" class="chipbtn" data-ch-all="1">All on</button><button type="button" class="chipbtn" data-ch-none="1">All off</button><span class="sp"></span><button type="button" class="x" data-ch-close="1" aria-label="Close">×</button></div>` +
    S.channels.map((c) => `<label><input type="checkbox" data-ch="${esc(c.name)}" ${S.hiddenCh.has(c.name) ? "" : "checked"}>${esc(c.name)}<span class="n">${c.calls_24h}</span></label>`).join("");
}
function renderSpark() {
  const p = S.pulse; if (!p || !p.bins_10min) return;
  const bins = p.bins_10min, max = Math.max(1, ...bins.map((b) => b.calls)), n = bins.length;
  $("#spark").innerHTML = `<svg viewBox="0 0 ${n} 24" preserveAspectRatio="none" role="img" aria-label="Radio calls per 10 minutes over 24 hours">${bins.map((b, i) => {
    const h = Math.max(b.calls ? 1.2 : 0, (b.calls / max) * 22);
    return `<rect class="b" data-i="${i}" x="${i + 0.12}" y="${24 - h}" width="0.76" height="${h}" rx="0.3"/>`;
  }).join("")}</svg><span class="cap">24h · ${num(p.headline?.calls_1h)} calls last hr</span>`;
}
function sparkHover(e) {
  const p = S.pulse; if (!p) return;
  const el = $("#spark"), r = el.getBoundingClientRect(), pad = 8;
  const n = p.bins_10min.length, i = Math.floor(((e.clientX - r.left - pad) / (r.width - pad * 2)) * n);
  $$("#spark rect.h").forEach((x) => x.classList.remove("h"));
  let tip = $(".tip", el);
  if (i < 0 || i >= n) { if (tip) tip.remove(); return; }
  const b = p.bins_10min[i]; $(`#spark rect[data-i="${i}"]`)?.classList.add("h");
  if (!tip) { tip = document.createElement("span"); tip.className = "tip"; el.appendChild(tip); }
  const t = p.bins_start + i * 600;
  tip.textContent = `${fmtTime(t)}–${fmtTime(t + 600)} · ${b.calls} calls`;
  tip.style.left = Math.min(r.width - 70, Math.max(70, e.clientX - r.left)) + "px";
  tip.style.top = "32px";
}

// ================================================================= RIVER (timeline pane)
const OPEN = (i) => !i.closed && !["cleared", "ended", "quiet"].includes(i.status);
const RV_KIND_ORDER = { violence: 0, fire: 1, medical: 2, traffic: 3, property: 4, suspicious: 5, other: 6 };
const HIST_SEG = { reported: "new", dispatched: "en_route", en_route: "en_route", on_scene: "on_scene", transporting: "on_scene", cleared: "cleared", closed: "cleared" };
function rvRange() {
  const W = $("#river").clientWidth || 800;
  const pad = Math.max(S.rv.span * 0.035, (64 / W) * S.rv.span);
  const tR = now() - S.rv.pan + pad;
  return [tR - S.rv.span, tR];
}
function rvEnd(i) { return OPEN(i) ? Math.max(i.last_at, now()) : i.last_at; }
function rvPasses(i) {
  if (S.f.kinds.length && !S.f.kinds.includes(i.kind || "other")) return false;
  if (S.f.service) { const u = i.units || {}; if (i.service !== S.f.service && !(u[S.f.service] > 0)) return false; }
  if (S.q) {
    const hay = [i.title, i.location, i.city, i.summary, i.type, "#" + i.id, ...(i.unit_list || []).map((u) => u.callsign)].join(" ").toLowerCase();
    if (!S.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
function rvIncidents() {
  const [t0, t1] = rvRange();
  const m = new Map(S.rv.inc);
  for (const i of S.incidents) if (!m.has(i.id)) m.set(i.id, i);
  return [...m.values()].filter((i) => rvEnd(i) >= t0 - 60 && i.first_at <= t1 && rvPasses(i));
}
function rvAddCall(c) {
  if (!c.incident_id || S.rv.callIds.has(c.id)) return;
  S.rv.callIds.add(c.id);
  const a = S.rv.calls.get(c.incident_id) || [];
  a.push(c.at); S.rv.calls.set(c.incident_id, a);
}
// Aircraft for the river: persisted history merged with the live sky (history started recently; live fills gaps).
function rvAircraft() {
  const m = new Map();
  for (const a of S.rv.air) m.set(a.hex, { ...a, near_incidents: [...(a.near_incidents || [])] });
  for (const a of S.air?.aircraft || []) {
    if (!a.interesting && !a.emergency) continue;
    const t = S.air.now || now();
    const h = m.get(a.hex) || { hex: a.hex, callsign: a.callsign, reg: a.reg, type: a.type, kind: a.kind, role: a.role, operator: a.operator,
      first_at: (a.trail?.[0]?.[3]) || t, last_at: t, interesting: true, near_incidents: [], circled: false, points: [] };
    h.last_at = Math.max(h.last_at || 0, t - (a.seen_sec || 0)); h.live = true; h.emergency = a.emergency;
    h.circled = h.circled || a.circling; h.circling = a.circling;
    if (a.near_incident && !h.near_incidents.includes(a.near_incident.id)) h.near_incidents.push(a.near_incident.id);
    m.set(a.hex, h);
  }
  return [...m.values()];
}
const acName = (a) => a.callsign || a.reg || a.hex;
function pack(items, gap) {
  const ends = [];
  for (const it of items) {
    let L = ends.findIndex((e) => e + gap <= it.a);
    if (L < 0) { L = ends.length; ends.push(-1e9); }
    ends[L] = it.b; it.lane = L;
  }
  return ends.length;
}
function tickStep(span) {
  if (span <= 3 * 3600) return [900, 1800];
  if (span <= 6 * 3600) return [1800, 3600];
  if (span <= 12 * 3600) return [3600, 2 * 3600];
  return [3600, 3 * 3600];
}
const STAGES = [["en_route_at", "en_route", "Units en route"], ["on_scene_at", "on_scene", "On scene"], ["transport_at", "transporting", "Transporting"], ["cleared_at", "cleared", "Units clearing"]];
// Status segments from the list item's stage times (no detail fetch); detail adds unit names to the marks.
function rvSegments(i, X, a0) {
  const end = rvEnd(i), lastSolid = i.last_at;
  const hist = S.dcache.get(i.id)?.status_history || [];
  const unitAt = new Map(hist.map((h) => [h.status === "dispatched" ? "en_route" : h.status, h.unit]));
  let pts = STAGES.filter(([k]) => i[k] != null).map(([k, st, label]) => ({ at: Math.max(i[k], i.first_at), s: HIST_SEG[st] || "new", st, label }));
  if (!pts.length && hist.length) pts = hist.slice(1).filter((h) => h.at != null && h.status !== "closed").map((h) => ({ at: Math.max(h.at, i.first_at), s: HIST_SEG[h.status] || "new", st: h.status, label: h.label }));
  pts.sort((a, b) => a.at - b.at);
  pts.unshift({ at: i.first_at, s: "new", st: "reported", label: "Reported" });
  const segs = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k].at, b = k + 1 < pts.length ? pts[k + 1].at : Math.max(lastSolid, a);
    if (b > a || k === pts.length - 1) segs.push({ s: pts[k].s, a, b: Math.min(Math.max(b, a), end) });
  }
  const marks = pts.slice(1).map((p) => { const u = unitAt.get(p.st); return `<i class="ms-mark" style="left:${(X(p.at) - a0).toFixed(1)}px" title="${esc(p.label)} ${fmtTime(p.at)}${u ? " · " + esc(u) : ""}"></i>`; }).join("");
  return { segs, marks };
}
function renderRiver() {
  const pane = $("#p-river");
  if (!pane || pane.hidden || S.riverAt === "off") return;
  const box = $("#river"), W = box.clientWidth;
  if (!W) return;
  const [t0, t1] = rvRange(), span = t1 - t0;
  const X = (t) => ((t - t0) / span) * W;
  S.rv.layout = { X, t0, t1, W };
  const nx = X(now());
  // ---- axis + grid
  const [minor, major] = tickStep(S.rv.span);
  let ax = "";
  for (let t = Math.ceil((t0 + tzOffset) / minor) * minor - tzOffset; t <= t1; t += minor) {
    const isMaj = (t + tzOffset) % major === 0, isDay = (t + tzOffset) % 86400 === 0;
    const nearNow = X(t) > nx - 90 && X(t) < nx + 30;
    ax += `<div class="gl${isMaj ? " maj" : ""}${isDay ? " day" : ""}" style="left:${X(t).toFixed(1)}px">${isMaj && !nearNow ? `<span>${isDay ? fmtDay(t) : fmtTime(t)}</span>` : ""}</div>`;
  }
  ax += `<div class="future" style="left:${Math.min(W, nx).toFixed(1)}px"></div>`;
  $("#r-axis").innerHTML = ax;
  const nl = $("#r-now"); nl.style.left = `${nx.toFixed(1)}px`; nl.hidden = nx > W + 2 || nx < 0;
  $("#r-now-l").textContent = S.rv.pan ? fmtTime(now()) : `now ${fmtTime(now())}`;
  $("#river-live").hidden = S.rv.pan === 0;
  $$("#river-span button").forEach((b) => b.setAttribute("aria-checked", +b.dataset.v === S.rv.span));

  // ---- sky lane: aircraft from history + live
  const air = rvAircraft().filter((a) => (a.last_at || 0) >= t0 && (a.first_at || 0) <= t1)
    .sort((a, b) => (b.emergency ? 1 : 0) - (a.emergency ? 1 : 0) || (a.first_at - b.first_at));
  const aItems = air.map((h) => {
    const a = X(Math.max(h.first_at, t0 - 60)), live = h.live && now() - h.last_at < 120;
    const b = Math.max(X(live ? now() : h.last_at), a + 4);
    const lw = 30 + acName(h).length * 7 + (h.role ? 52 : 0) + (h.circled ? 52 : 0);
    const inside = b - a > lw + 6;
    const left = !inside && b + lw + 8 > W;
    return { h, a, b, live, inside, left, s0: left ? a - lw - 8 : a, e0: inside || left ? b : b + lw + 6 };
  });
  const tmpA = aItems.map((x) => ({ a: x.s0, b: x.e0 })); pack(tmpA, 8); tmpA.forEach((x, k) => (aItems[k].lane = Math.min(x.lane, 3)));
  const aLanes = Math.max(1, Math.min(4, 1 + Math.max(-1, ...aItems.map((x) => x.lane))));
  const AH = 19;
  const airIn = $("#r-air-in");
  $("#r-air").style.height = `${aLanes * AH + 8}px`;
  const selHex = S.sel?.type === "air" ? S.sel.id : null;
  airIn.innerHTML = aItems.map((x) => {
    const h = x.h, linked = S.selInc && h.near_incidents.includes(S.selInc);
    const lab = `${acSvg(h)}<b>${esc(acName(h))}</b>${h.role ? `<em>${esc(ROLE_LABEL[h.role] || h.role)}</em>` : ""}${h.circled ? "<em>circled</em>" : ""}`;
    return `<div class="abar${h.kind === "helicopter" ? " heli" : ""}${h.emergency ? " emerg" : ""}${x.live ? " live" : ""}${selHex === h.hex || linked ? " sel" : ""}" data-air="${esc(h.hex)}" style="left:${x.a.toFixed(1)}px;width:${(x.b - x.a).toFixed(1)}px;top:${x.lane * AH + 4}px" title="${esc(acName(h))} · ${fmtTime(h.first_at)}–${x.live ? "now" : fmtTime(h.last_at)}${h.near_incidents.length ? " · over #" + h.near_incidents.join(", #") : ""}">
      <span class="alab${x.inside ? "" : x.left ? " outl" : " out"}">${lab}</span></div>`;
  }).join("") || `<div class="lane-empty">${S.air ? "No notable aircraft logged in this window" + (S.rv.air.length ? "" : " · aircraft history began recently") : "Listening to the sky…"}</div>`;

  // ---- incident swimlanes
  const linksByInc = new Map();
  for (const h of rvAircraft()) for (const id of h.near_incidents) { const L = linksByInc.get(id) || []; L.push(h); linksByInc.set(id, L); }
  const inc = rvIncidents().sort((a, b) => a.first_at - b.first_at || (RV_KIND_ORDER[a.kind] ?? 9) - (RV_KIND_ORDER[b.kind] ?? 9));
  S.rv.order = inc.map((i) => i.id);
  const items = inc.map((i) => {
    const a = X(i.first_at), solidB = Math.max(X(i.last_at), a + 6), b = Math.max(X(rvEnd(i)), solidB);
    const air = linksByInc.get(i.id) || [];
    const lw = 28 + Math.min((i.title || "").length, 44) * 6.3 + (i.sensitive ? 66 : 0) + air.slice(0, 2).reduce((s, h) => s + 40 + acName(h).length * 6.5 + (h.circled ? 48 : 0), 0);
    const inside = solidB - Math.max(a, 0) > lw + 8;
    const left = !inside && Math.max(b, solidB + lw + 8) > W && a - lw - 6 > 0;
    return { i, a, b, solidB, air, inside, left, s0: left ? a - lw - 6 : a, e0: inside || left ? b : Math.max(b, solidB + lw + 6) };
  });
  const tmp = items.map((x) => ({ a: x.s0, b: x.e0 })); const nL = pack(tmp, 10); tmp.forEach((x, k) => (items[k].lane = x.lane));
  const LH = 34;
  const inner = $("#r-inc-in");
  inner.style.height = `${Math.max(nL, 1) * LH + 14}px`;
  inner.innerHTML = items.map((x) => rvBar(x, X, LH, W)).join("") ||
    `<div class="lane-empty big">${S.rv.loaded ? (S.q || S.f.kinds.length || S.f.service ? "<b>Nothing matches these filters</b> in this stretch of time." : `<b>No incidents in the last ${dur(S.rv.span)}</b> The radio has been quiet; try a longer window.`) : "Loading the timeline…"}</div>`;
  box.classList.toggle("has-sel", !!(S.selInc && items.some((x) => x.i.id === S.selInc)));
  const open = items.filter((x) => OPEN(x.i)).length;
  $("#river-count").textContent = items.length;
  $("#river-sub").textContent = `${open} open`;
}
function rvBar(x, X, LH, W) {
  const i = x.i, k = i.kind || "other", top = x.lane * LH + 10, w = x.b - x.a, solidW = x.solidB - x.a;
  const { segs, marks } = rvSegments(i, X, x.a);
  const segHtml = segs.map((p) => `<i class="rseg s-${p.s}" style="left:${(X(p.a) - x.a).toFixed(1)}px;width:${Math.max(X(p.b) - X(p.a), 2).toFixed(1)}px"></i>`).join("");
  const done = !OPEN(i);
  const ticks = []; let lastT = -9;
  const times = [...new Set([...(i.call_times || []), ...(S.rv.calls.get(i.id) || [])])].sort((a, b) => a - b);
  for (const t of times) { const tx = X(t) - x.a; if (tx - lastT >= 2.5) { ticks.push(`<i class="tick" style="left:${tx.toFixed(1)}px"></i>`); lastT = tx; } }
  const tail = !done && x.b - x.solidB > 2 ? `<i class="tail" style="left:${solidW.toFixed(1)}px;width:${(x.b - x.solidB).toFixed(1)}px"></i>` : "";
  const cap = done ? `<i class="rcap" style="left:${(solidW - 1).toFixed(1)}px"></i>` : "";
  const badges = x.air.slice(0, 2).map((h) => `<em class="abadge${h.circling || h.live ? " live" : ""}" data-air="${esc(h.hex)}">${acSvg(h)}${esc(acName(h))}${h.circled ? " circling" : ""}</em>`).join("");
  const sel = S.selInc === i.id, cur = S.focus === "river" && S.rv.order?.[S.cur.river] === i.id;
  return `<div class="bar kc-${k}${done ? " done" : " open"}${i.severity === "high" ? " hi" : ""}${sel ? " sel" : ""}${cur ? " cur" : ""}" data-inc="${i.id}" style="left:${x.a.toFixed(1)}px;top:${top}px;width:${Math.max(w, 6).toFixed(1)}px">
    <div class="body" style="width:${Math.max(solidW, 6).toFixed(1)}px">${segHtml}${ticks.join("")}${marks}</div>${tail}${cap}
    <span class="blab${x.inside ? "" : x.left ? " out outl" : " out"}" style="${x.inside ? (x.a < 0 ? `left:${(7 - x.a).toFixed(1)}px` : "") : x.left ? `right:${(w + 5).toFixed(1)}px;left:auto` : `left:${(Math.max(solidW, 6) + 5).toFixed(1)}px;max-width:${Math.max(60, W - x.a - Math.max(solidW, 6) - 8).toFixed(0)}px`}">${kico(k)}<b>${esc(i.title || i.type || "Incident")}</b>${i.sensitive ? '<em class="sens">Sensitive</em>' : ""}${badges}</span>
  </div>`;
}
function rvTip(e) {
  const tip = $("#r-tip"), bar = e.target.closest(".bar"), box = $("#river");
  if (!bar || S._rvDrag) { tip.hidden = true; return; }
  const i = incById(+bar.dataset.inc); if (!i) { tip.hidden = true; return; }
  const d = S.dcache.get(i.id);
  const hist = (d?.status_history || []).map((h) => `<span>${esc(h.label)} <b>${fmtTime(h.at)}</b></span>`).join("");
  tip.innerHTML = `<div class="tt">${kico(i.kind)}<b>${esc(i.title)}</b></div>
    <div class="tm">${incSt(i.status)} · ${fmtTime(i.first_at)}–${OPEN(i) ? "now" : fmtTime(i.last_at)} · ${i.calls} call${i.calls === 1 ? "" : "s"}${(i.unit_list || []).length ? ` · ${i.unit_list.length} unit${i.unit_list.length === 1 ? "" : "s"}` : ""}</div>
    ${hist ? `<div class="th">${hist}</div>` : ""}
    ${i.last_line ? `<div class="tq">“${esc(i.last_line.text)}”</div>` : ""}${respStrip(i, 6)}`;
  tip.hidden = false;
  const r = box.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  tip.style.left = Math.min(r.width - tip.offsetWidth - 6, Math.max(6, x + 14)) + "px";
  tip.style.top = (y + 18 + tip.offsetHeight > r.height ? Math.max(4, y - tip.offsetHeight - 10) : y + 16) + "px";
}
function rvScrollToSel() {
  const b = $(`#r-inc-in .bar[data-inc="${S.selInc}"]`), sc = $("#r-inc");
  if (!b || !sc) return;
  const top = b.offsetTop, h = sc.clientHeight;
  if (top < sc.scrollTop + 4 || top > sc.scrollTop + h - 40) sc.scrollTo({ top: Math.max(0, top - h / 3), behavior: "smooth" });
}
function rvSetSpan(v) {
  S.rv.span = v; store.set("riverSpan", v); renderRiver(); loadRiver(true);
}
function rvPan(sec) {
  S.rv.pan = Math.max(0, Math.min(7 * 86400 - S.rv.span, S.rv.pan + sec));
  renderRiver();
  clearTimeout(rvPan._t); rvPan._t = setTimeout(() => loadRiver(true), 400);
}
function rvDrag(e) {
  if (e.button !== 0 || e.target.closest("button")) return;
  const box = $("#river"), x0 = e.clientX, p0 = S.rv.pan, W = box.clientWidth;
  let moved = false;
  const mv = (ev) => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 4) return;
    moved = true; S._rvDrag = true; box.classList.add("dragging"); $("#r-tip").hidden = true;
    S.rv.pan = Math.max(0, Math.min(7 * 86400 - S.rv.span, p0 + (dx / W) * S.rv.span));
    renderRiver();
  };
  const up = () => {
    removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
    box.classList.remove("dragging");
    if (moved) { setTimeout(() => (S._rvDrag = false), 0); loadRiver(true); }
  };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}

// ---- River placement: bottom strip, or swapped in place of Units / Air / Radio
const SLOT_PANE = { units: "#p-units", air: "#p-air", radio: "#p-radio" };
function placeRiver(at, quiet) {
  if (!["strip", "units", "air", "radio", "off"].includes(at)) at = "strip";
  S.riverAt = at; store.set("riverAt", at);
  document.body.dataset.river = at;
  const river = $("#p-river");
  for (const [k, sel] of Object.entries(SLOT_PANE)) $(sel).classList.toggle("swapped", k === at);
  if (at === "strip" || at === "off") { $("#grid").appendChild($("#split-river")); $("#grid").appendChild(river); }
  else $(SLOT_PANE[at]).after(river);
  river.hidden = at === "off";
  $$("#river-at button").forEach((b) => b.setAttribute("aria-checked", b.dataset.v === at));
  if (S.focus !== "river" && SLOT_PANE[at] && S.focus === at) S.focus = "river";
  setTimeout(() => { map && map.invalidateSize({ pan: false }); renderRiver(); renderBoard(); }, 30);
  if (!quiet) toast(at === "off" ? "River hidden · press r to bring it back" : at === "strip" ? "River: bottom strip" : `River: in place of ${at[0].toUpperCase() + at.slice(1)}`);
}
function cycleRiver() {
  const order = ["strip", "units", "air", "radio", "off"];
  placeRiver(order[(order.indexOf(S.riverAt) + 1) % order.length]);
}

// ================================================================= SELECTION + DETAIL
function select(type, id, opts = {}) {
  S.sel = { type, id };
  if (type === "incident") S.selInc = id;
  else if (type === "unit") S.selInc = S.units.find((u) => u.id === id)?.incident_id || null;
  else if (type === "air") {
    const a = (S.air?.aircraft || []).find((x) => x.hex === id);
    const h = rvAircraft().find((x) => x.hex === id);
    S.selInc = a?.near_incident?.id || (h?.near_incidents?.length ? h.near_incidents[h.near_incidents.length - 1] : null);
  }
  if (type === "incident") { const n = visibleIncidents().findIndex((i) => i.id === id); if (n >= 0) S.cur.queue = n; }
  if (type !== "air") S.airTrack = null;
  openDetailPane();
  renderAllHighlights();
  loadDetail(opts);
  if (type === "air") loadAirTrack(id);
  if (isPhone() && opts.scroll !== false) setTimeout(() => $("#p-detail").scrollIntoView({ block: "start", behavior: "smooth" }), 60);
}
function closeDetail() {
  S.sel = null; S.selInc = null; S.detail = null; S.radioIncOnly = false; S.airTrack = null;
  $("#p-detail").hidden = true; $("#split-r").hidden = true; $("#col-r").classList.remove("has-detail");
  drawFocus(); renderAllHighlights();
  setTimeout(() => map && map.invalidateSize(), 50);
}
function openDetailPane() {
  $("#p-detail").hidden = false; $("#split-r").hidden = false; $("#col-r").classList.add("has-detail");
}
function renderAllHighlights() { renderQueue(); renderMapIncidents(); renderMapUnits(); renderBoard(); renderAir(); renderAirMap(); renderRadio(); renderRiver(); if (S.selInc) setTimeout(rvScrollToSel, 30); }
async function loadDetail(opts = {}) {
  const sel = S.sel; if (!sel) return;
  const body = $("#detail-body");
  if (!S.detail || S.detail._key !== sel.type + sel.id) body.innerHTML = '<div class="loading">Loading…</div>';
  try {
    let d;
    if (sel.type === "incident") d = await api(`/api/live/incidents/${sel.id}`);
    else if (sel.type === "unit") d = await api(`/api/live/units/${sel.id}`);
    else d = (S.air?.aircraft || []).find((a) => a.hex === sel.id) || histAircraft(sel.id);
    if (!d || S.sel !== sel) return;
    d._key = sel.type + sel.id; S.detail = d;
    if (sel.type === "incident") {
      S.dcache.set(d.id, d);
      for (const c of d.timeline || []) rvAddCall({ id: c.id, at: c.at, incident_id: d.id });
      renderIncidentDetail(d, opts); renderBoard(); renderRiver();
    } else if (sel.type === "unit") renderUnitDetail(d, opts);
    else renderAirDetail(d, opts);
    drawFocus();
  } catch (e) { body.innerHTML = '<div class="empty"><b>Couldn\'t load this</b>It may have been merged or removed. Pick another from the queue.</div>'; }
}
function histAircraft(hex) {
  const h = rvAircraft().find((x) => x.hex === hex); if (!h) return null;
  const last = h.points?.[h.points.length - 1];
  return { ...h, historic: !h.live, lat: last?.[0], lng: last?.[1], alt_ft: last?.[2], trail: [] };
}
async function loadAirTrack(hex) {
  if (DEMO) return;
  try {
    const d = await api("/api/live/air/history", { hex, hours: 6, region: null });
    if (S.sel?.type !== "air" || S.sel.id !== hex) return;
    S.airTrack = { hex, points: d.points || [], first_at: d.first_at, near: d.near_incidents || [], circled: d.circled };
    renderAirMap();
    if (S.detail?.hex === hex) renderAirDetail(S.detail, { pan: false });
  } catch (e) {}
}
function panTo(lat, lng, zoom, exact) {
  if (!map || lat == null) return;
  const z = exact ? zoom : Math.max(map.getZoom() || 10, zoom || 13);
  if (!mapVisible()) { S._pendingPan = [lat, lng, z]; return; }
  map.flyTo([lat, lng], z, { duration: 0.6 });
}
function milestones(d) {
  const h = d.status_history || [];
  if (!h.length) return "";
  const t0 = h[0].at;
  return `<div class="dsec"><h4>Status <span class="n">${h.length} step${h.length === 1 ? "" : "s"}</span></h4><ol class="miles">${h.map((m, k) => `<li class="m-${esc(m.status)}">
    <i>${stSvg(m.status === "reported" ? "new" : m.status)}</i><b>${esc(m.label)}</b><span class="mt">${fmtTime(m.at)}${k ? ` <em>+${dur(m.at - t0)}</em>` : ""}</span>${m.unit ? `<span class="mu">${esc(m.unit)}</span>` : ""}</li>`).join("")}
    ${!d.closed && !h.some((m) => m.status === "closed") ? `<li class="m-now"><i></i><b>Now</b><span class="mt">${age(d.last_at)} since last radio</span></li>` : ""}</ol></div>`;
}
function renderIncidentDetail(d, opts) {
  $("#detail-h").textContent = "Incident"; $("#detail-id").textContent = "#" + d.id;
  $("#detail-play").hidden = !CAN_AUDIO; $("#detail-words").hidden = false;
  $("#detail-words").setAttribute("aria-pressed", S.words);
  const units = d.units_list || [];
  const allCodes = new Map();
  for (const c of d.timeline || []) for (const k of codesFor(c)) allCodes.set(k.code.toUpperCase(), k);
  const ac = airOver(d.id);
  const histAc = rvAircraft().filter((h) => h.near_incidents.includes(d.id) && !ac.some((a) => a.hex === h.hex));
  const timeline = (d.timeline || []).map((c) => `<li class="k-dot-${KIND_GROUP[c.kind] || "neutral"} ${S.playing?.id === c.id ? "playing" : ""}" data-call="${c.id}">
      <span class="tm">${fmtTime(c.at)}</span>
      <div><div class="ch">${esc(c.channel)} · ${dur(c.dur)}</div><div class="ln">${rich(c.line || "(no speech)", codesFor(c), units)}</div>
      ${S.words ? turnsHtml(c, units) : ""}
      <button type="button" class="flag" data-report="${c.id}">Report a problem with this call</button></div>
      ${CAN_AUDIO && c.audio ? `<button type="button" class="pb ${S.playing?.id === c.id ? "on" : ""}" data-play-tl="${c.id}" aria-label="Play">${S.playing?.id === c.id ? ICO.pause : ICO.play}</button>` : "<span></span>"}</li>`).join("");
  $("#detail-body").innerHTML = `
    <div class="dhead">${kico(d.kind)}<h3>${esc(d.title)}</h3>
      <div class="dl">${esc(placeOf(d))}${d.precision ? ` <span style="color:var(--text-3)">· ${esc(d.precision)}-level</span>` : ""}</div>
      <div class="dm">${incSt(d.status)}<span class="svc">${esc(d.service || "")}</span><span>${esc(d.type || "")}</span>${d.sensitive ? '<span class="sens" title="Handle with care: self-harm, death, sexual assault or similar">Sensitive</span>' : ""}<span>${esc(KIND_LABEL[d.kind] || "")}</span></div></div>
    ${respChips(d)}
    ${d.summary ? `<div class="dsum">${rich(d.summary)}</div>` : ""}
    <dl class="facts"><div><dt>First heard</dt><dd>${fmtTime(d.first_at)}</dd></div><div><dt>Last radio</dt><dd>${age(d.last_at)} ago</dd></div>
      <div><dt>On air</dt><dd>${dur(d.duration_sec ?? (d.last_at - d.first_at))}</dd></div><div><dt>Calls</dt><dd>${d.calls}</dd></div></dl>
    ${milestones(d)}
    ${units.length ? `<div class="dsec"><h4>Units <span class="n">${units.length}</span></h4><div class="dunits">${units.map((u) => `<button type="button" class="du ${u.on_this ? "" : "off"}" data-unit="${u.id}" title="${esc(u.role || "")}">${unitSt(u.on_this ? u.status : "left", true)}<b>${esc(u.callsign)}</b><span style="color:var(--text-3)">${esc(UNIT_STATUS[u.status] || "")}${u.on_this ? "" : " · moved on"}</span></button>`).join("")}</div></div>` : ""}
    ${ac.length || histAc.length ? `<div class="dsec"><h4>Overhead <span class="n">${ac.length + histAc.length}</span></h4><div class="dair">${ac.map((a) => `<button type="button" data-air="${esc(a.hex)}">${acSvg(a)}<b class="mono">${esc(a.callsign || a.hex)}</b><span>${esc(a.label || "")} · ${a.near_incident.distance_mi} mi${a.circling ? " · circling" : ""}</span></button>`).join("")}${histAc.map((h) => `<button type="button" class="was" data-air="${esc(h.hex)}">${acSvg(h)}<b class="mono">${esc(acName(h))}</b><span>${esc(ROLE_LABEL[h.role] || h.kind || "")} · ${fmtTime(h.first_at)}–${fmtTime(h.last_at)}${h.circled ? " · circled" : ""}</span></button>`).join("")}</div></div>` : ""}
    ${(d.people || []).length || (d.vehicles || []).length ? `<div class="dsec"><h4>People and vehicles</h4><ul class="plist">${(d.people || []).map((p) => `<li><b>${esc(p.role || "Person")}</b> — ${rich(p.desc || "")}</li>`).join("")}${(d.vehicles || []).map((v) => `<li><b>Vehicle</b> — ${rich(v.desc || [v.color, v.make, v.model].filter(Boolean).join(" "))}</li>`).join("")}</ul></div>` : ""}
    <div class="dsec"><h4>Timeline <span class="n">${(d.timeline || []).length} calls</span>${S.words ? ' <span style="letter-spacing:0;text-transform:none;font-weight:500">· every word, by speaker</span>' : ""}</h4><ol class="tl">${timeline}</ol></div>
    ${allCodes.size ? `<div class="dsec"><h4>Codes explained</h4><dl class="codes">${[...allCodes.values()].map((c) => `<dt>${esc(c.code)}</dt><dd>${esc(c.meaning)}</dd>`).join("")}</dl></div>` : ""}
    ${(d.cameras || []).length ? `<div class="dsec"><h4>Nearby cameras <span class="n">${d.cameras.length}</span></h4><div class="cams">${d.cameras.slice(0, 4).map((c) => `<a class="cam" href="${esc(c.img)}" target="_blank" rel="noopener"><img src="${esc(c.img)}" alt="Traffic camera ${esc(c.name)}" loading="lazy"><span>${esc(c.name)} · ${c.distance_mi} mi ${esc(c.dir || "")}</span></a>`).join("")}</div></div>` : ""}
    ${(d.related_news || []).length ? `<div class="dsec"><h4>In the news</h4><div class="news">${d.related_news.map((n) => `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>`).join("")}</div></div>` : ""}
    <div class="dfoot"><button type="button" data-act="zoom">Zoom map here</button><button type="button" data-act="solo">Radio: this incident only</button>
      <a href="/live/${esc(CFG.region)}/map" title="Replay on the full map">Map ↗</a><button type="button" class="rep" data-report-inc="${d.id}">Report a problem</button></div>`;
  if (opts.pan !== false) panTo(d.lat, d.lng, 14);
}
function renderUnitDetail(d, opts) {
  $("#detail-h").textContent = "Unit"; $("#detail-id").textContent = d.callsign || "";
  $("#detail-play").hidden = true; $("#detail-words").hidden = true;
  const steps = (d.activity || []).slice().reverse();
  $("#detail-body").innerHTML = `
    <div class="dhead"><span class="kico k-other" style="background:var(--pane-3);color:var(--text)">${ICO.unit}</span><h3 class="mono">${esc(d.callsign)}</h3>
      <div class="dl">${esc(d.role || "")}${d.location ? " · " + esc(d.location) : ""}</div>
      <div class="dm">${unitSt(d.status)}<span>since ${fmtTime(d.since)}</span><span>last heard ${d.last_heard ? age(d.last_heard) + " ago" : "—"}</span></div></div>
    ${d.incident ? `<div class="dsec"><h4>Working</h4><div class="dair"><button type="button" data-inc="${d.incident.id}" style="background:var(--sel)">${kico(d.incident.kind)}<b>${esc(d.incident.title)}</b><span style="color:var(--text-3)">${esc(d.incident.location_text || "")}</span></button></div></div>` : ""}
    <div class="dsec"><h4>Activity, last 7 days <span class="n">${steps.length}</span></h4><ol class="tl">${steps.map((s) => `<li><span class="tm">${fmtTime(s.at)}</span>
      <div><div class="ch">${unitSt(s.status)} ${s.until ? "· " + dur(s.until - s.at) : ""}</div><div class="ln">${s.incident_id ? `<button type="button" class="unit-ref" data-inc="${s.incident_id}">${esc(s.title || "Incident")}</button>` : esc(s.title || "")} <span style="color:var(--text-3)">${esc(s.location || "")}</span></div></div><span></span></li>`).join("")}</ol></div>
    <div class="dsec"><h4>Radio <span class="n">${(d.radio || []).length}</span></h4><ol class="tl">${(d.radio || []).slice().reverse().slice(0, 30).map((c) => `<li data-call="${c.id}"><span class="tm">${fmtTime(c.at)}</span>
      <div><div class="ch">${esc(c.channel)}</div><div class="ln">${rich(c.line || "", codesFor(c))}</div></div>
      ${CAN_AUDIO && c.audio ? `<button type="button" class="pb" data-play-u="${c.id}" aria-label="Play">${ICO.play}</button>` : "<span></span>"}</li>`).join("")}</ol></div>`;
  S._unitRadio = d.radio || [];
  if (opts.pan !== false && d.incident?.lat != null) panTo(d.incident.lat, d.incident.lng, 13);
}
function altProfile(a) {
  const long = S.airTrack?.hex === a.hex && S.airTrack.points.length > (a.trail || []).length ? S.airTrack.points : null;
  let pts = (long || a.trail || []).map((p) => [p[3], p[2]]);
  if (!long && a.alt_ft != null && !a.historic) pts.push([S.air?.now || now(), a.alt_ft]);
  pts = pts.filter((p) => p[1] != null && p[0]);
  if (pts.length < 3) return "";
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], amax = Math.max(...pts.map((p) => p[1])), amin = Math.min(...pts.map((p) => p[1]));
  const lo = Math.max(0, amin - (amax - amin) * 0.2 - 200), hi = amax + (amax - amin) * 0.15 + 200, W = 300, H = 64;
  const xy = pts.map(([t, al]) => [((t - t0) / Math.max(1, t1 - t0)) * W, H - ((al - lo) / (hi - lo)) * H]);
  const path = xy.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  const last = xy[xy.length - 1];
  return `<div class="dsec"><h4>Altitude, ${long ? "logged track" : "recent"} · ${dur(t1 - t0)}</h4><div class="altp" title="Altitude from ${num(amin)} to ${num(amax)} ft">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${path}" class="ln"/><circle cx="${last[0]}" cy="${last[1]}" r="3.5" class="pt"/></svg>
    <span class="hi">${num(amax)} ft</span><span class="lo">${num(amin)} ft</span><span class="t0">${fmtTime(t0)}</span><span class="t1">${a.historic ? fmtTime(t1) : "now"}</span></div></div>`;
}
function renderAirDetail(a, opts) {
  $("#detail-h").textContent = "Aircraft"; $("#detail-id").textContent = a.hex || "";
  $("#detail-play").hidden = true; $("#detail-words").hidden = true;
  const vs = a.vs_fpm ? (a.vs_fpm > 0 ? `climbing ${num(a.vs_fpm)} fpm` : `descending ${num(-a.vs_fpm)} fpm`) : "level";
  const tr = S.airTrack?.hex === a.hex ? S.airTrack : null;
  const first = tr?.first_at || a.first_at || a.trail?.[0]?.[3];
  const nearIds = [...new Set([...(a.near_incident ? [a.near_incident.id] : []), ...(tr?.near || []), ...(a.near_incidents || [])])];
  const nearInc = nearIds.map((id) => incById(id) || { id, title: `Incident #${id}`, kind: "other" });
  const acarsMine = (S.air?.acars?.messages || []).filter((m) => a.callsign && m.flight && a.callsign.replace(/\D/g, "") === m.flight.replace(/\D/g, ""));
  $("#detail-body").innerHTML = `
    <div class="dhead"><span class="kico" style="background:${a.emergency ? "var(--emerg)" : a.interesting ? "var(--air)" : "var(--neutral)"}">${acSvg(a).replace("<svg", '<svg style="fill:#fff;stroke:none"')}</span>
      <h3 class="mono">${esc(a.callsign || a.reg || a.hex)}</h3>
      <div class="dl">${esc(a.desc || a.type || a.kind || "")}${a.operator ? " · " + esc(a.operator) : ""}</div>
      <div class="dm">${a.emergency ? `<span class="tag emg">Squawk ${esc(a.emergency)} · ${a.emergency === "7700" ? "general emergency" : a.emergency === "7600" ? "radio failure" : "hijack code"}</span>` : ""}${a.role ? `<span class="tag role">${esc(ROLE_LABEL[a.role] || a.role)}</span>` : ""}${a.circling ? '<span class="tag circ">Circling</span>' : a.circled || tr?.circled ? '<span class="tag circ">Circled earlier</span>' : ""}${a.historic ? '<span class="tag">Not in range now</span>' : ""}<span>${esc(a.kind || "")}</span></div></div>
    ${a.historic ? "" : `<dl class="facts"><div><dt>Altitude</dt><dd>${a.on_ground ? "ground" : num(a.alt_ft) + " ft"}</dd></div><div><dt>Speed</dt><dd>${a.gs_kt ?? "—"} kt</dd></div>
      <div><dt>Heading</dt><dd>${a.track != null ? Math.round(a.track) + "°" : "—"}</dd></div><div><dt>Squawk</dt><dd>${esc(a.squawk || "—")}</dd></div></dl>`}
    <div class="dsum">${a.historic ? `Logged ${fmtTime(a.first_at)}–${fmtTime(a.last_at)}.` : `${esc(a.label || "")}. ${esc(vs[0].toUpperCase() + vs.slice(1))}. Last seen ${a.seen_sec ?? 0}s ago.`}${first ? ` Tracked since ${fmtTime(first)}${tr?.points?.length ? ` (${tr.points.length} logged positions, dotted on the map)` : ""}.` : ""}${a.reg ? ` Registration <span class="mono">${esc(a.reg)}</span>.` : ""}</div>
    ${altProfile(a)}
    ${nearInc.length ? `<div class="dsec"><h4>Over incidents</h4><div class="dair">${nearInc.map((i) => `<button type="button" data-inc="${i.id}" style="background:var(--sel)">${kico(i.kind)}<b>${esc(i.title)}</b><span style="color:var(--text-3)">${a.near_incident?.id === i.id ? `${a.near_incident.distance_mi} mi away now` : "earlier"}</span></button>`).join("")}</div></div>` : ""}
    ${acarsMine.length ? `<div class="dsec acars"><h4>ACARS from this flight</h4><ul>${acarsMine.map((m) => `<li><span class="tm">${fmtClock(m.at)}</span>${esc(m.text)}</li>`).join("")}</ul></div>` : ""}
    <div class="dfoot">${a.lat != null ? '<button type="button" data-act="zoom-air">Zoom map to aircraft</button>' : ""}${a.hex && !S.air?.demo ? `<a href="https://globe.adsbexchange.com/?icao=${esc(a.hex)}" target="_blank" rel="noopener">ADS-B Exchange ↗</a>` : ""}</div>`;
  if (opts.pan !== false) panTo(a.lat, a.lng, 12);
}

// ================================================================= AUDIO
function findCall(id) {
  return S.radio.find((c) => c.id === id) || (S.detail?.timeline || []).find((c) => c.id === id) || (S._unitRadio || []).find((c) => c.id === id);
}
function play(call) {
  if (!CAN_AUDIO) { toast("Audio playback isn't available on this server"); return; }
  if (!call || !call.audio) return;
  if (S.playing?.id === call.id && !S.audio.paused) { S.audio.pause(); S.playing = null; S.playQueue = []; updatePlaying(); return; }
  S.playing = call; S.audio.src = call.audio;
  S.audio.play().catch(() => { toast("Tap play to allow audio"); S.playing = null; updatePlaying(); });
  updatePlaying();
}
S.audio.addEventListener("ended", () => {
  S.playing = null;
  const next = S.playQueue.shift();
  if (next) play(next); else updatePlaying();
});
function updatePlaying() {
  const p = S.playing, sb = $("#sb-play");
  sb.hidden = !p;
  if (p) sb.innerHTML = `▶ ${esc(p.channel)} · ${fmtTime(p.at)}${S.playQueue.length ? ` · ${S.playQueue.length} queued` : ""}`;
  $$("[data-play],[data-play-tl],[data-play-u]").forEach((b) => {
    const id = +(b.dataset.play || b.dataset.playTl || b.dataset.playU);
    const on = p?.id === id; b.classList.toggle("on", on); b.innerHTML = on ? ICO.pause : ICO.play;
    b.closest("li")?.classList.toggle("playing", on);
  });
}
function setListen(on) {
  if (on && !CAN_AUDIO) { toast("Live audio isn't available here; the radio stream still updates live"); on = false; }
  S.listening = on; $("#btn-listen").setAttribute("aria-pressed", on);
  if (on) toast("Listening live: new calls play as they air"); else { S.playQueue = []; }
}
function setFollow(on) {
  S.follow = on; $("#btn-follow").setAttribute("aria-pressed", on);
  toast(on ? "Following: the map pans to each call as it airs" : "Stopped following");
}

// ================================================================= LOADERS
function incParams() {
  const p = { window: S.f.window, service: S.f.service, q: S.q };
  if (DEMO && p.window === "active") p.window = "24h";
  return p;
}
async function loadIncidents() {
  try {
    const d = await api("/api/live/incidents", incParams());
    if (d.now) clockSkew = d.now - Math.floor(Date.now() / 1000);
    S.incidents = d.items || [];
    renderQueue(); renderMapIncidents(); renderRadio(); renderRiver();
  } catch (e) { console.warn(e); }
}
// River data: incidents over its window (+ open ones; items carry call_times + stage times), aircraft history.
async function loadRiver(force) {
  const reach = S.rv.pan + S.rv.span;
  const win = reach <= 3 * 3600 ? "3h" : reach <= 6 * 3600 ? "6h" : reach <= 12 * 3600 ? "12h" : reach <= 86400 ? "24h" : "7d";
  try {
    const [w, a] = await Promise.all([api("/api/live/incidents", { window: win, service: S.f.service, limit: 1000 }), api("/api/live/incidents", { window: "active", service: S.f.service })]);
    const m = new Map();
    for (const i of [...(w.items || []), ...(a.items || [])]) m.set(i.id, i);
    S.rv.inc = m; S.rv.loaded = true;
    renderRiver();
  } catch (e) { console.warn(e); }
  if (force || !S.rv.airAt || Date.now() - S.rv.airAt > 60000) loadRiverAir();
}
async function loadRiverAir() {
  if (DEMO) { S.rv.air = []; return; }
  const [t0] = rvRange();
  try {
    const d = await api("/api/live/air/history", { since: Math.floor(t0), until: now() - S.rv.pan + 60, interesting: 1 });
    S.rv.air = (d.aircraft || []).filter((a) => a.interesting); S.rv.airAt = Date.now();
    renderRiver();
  } catch (e) {}
}
async function loadUnits() {
  try { S.units = (await api("/api/live/units", { scope: S.unitsScope })).items || []; renderBoard(); renderMapUnits(); } catch (e) { console.warn(e); }
}
async function loadRadio(reset) {
  try {
    if (reset || !S.radio.length) {
      const d = await api("/api/live/radio", { limit: 120, hide_chatter: S.hideChatter ? 1 : "" });
      S.radio = d.items || []; S.channels = d.channels || [];
      for (const c of S.radio) rvAddCall(c);
      renderRadio(); return;
    }
    const d = await api("/api/live/radio", { since: S.radio[0].at, limit: 50, hide_chatter: S.hideChatter ? 1 : "" });
    if (d.channels) S.channels = d.channels;
    const have = new Set(S.radio.map((c) => c.id));
    const fresh = (d.items || []).filter((c) => !have.has(c.id)).sort((a, b) => b.at - a.at);
    if (!fresh.length) return;
    S.radio = fresh.concat(S.radio).slice(0, 400);
    for (const c of fresh) rvAddCall(c);
    renderRadio();
    onNewCalls(fresh.slice().reverse());
  } catch (e) { console.warn(e); }
}
async function loadOlderRadio() {
  const last = S.radio[S.radio.length - 1]; if (!last) return;
  try {
    const d = await api("/api/live/radio", { before: last.at, limit: 80, hide_chatter: S.hideChatter ? 1 : "" });
    const have = new Set(S.radio.map((c) => c.id));
    S.radio = S.radio.concat((d.items || []).filter((c) => !have.has(c.id)));
    renderRadio();
  } catch (e) { toast("Couldn't load earlier calls"); }
}
function onNewCalls(calls) {
  const latest = calls[calls.length - 1];
  for (const c of calls) {
    if (S.hiddenCh.has(c.channel)) continue;
    if (S.listening && c.audio) { if (!S.playing) play(c); else S.playQueue.push(c); }
  }
  if (S.follow && latest) {
    const inc = latest.incident_id && incById(latest.incident_id);
    if (inc && inc.lat != null) { panTo(inc.lat, inc.lng, 13); S._pulseInc = inc.id; renderMapIncidents(); setTimeout(() => { S._pulseInc = null; renderMapIncidents(); }, 4000); }
  }
  if (calls.some((c) => c.incident_id)) loadIncidents();
  renderRiver();
  if (S.sel?.type === "incident" && calls.some((c) => c.incident_id === S.sel.id)) loadDetail({ pan: false });
}
async function loadAir() {
  try {
    S.air = await api("/api/live/air", DEMO ? { demo: 1 } : {});
    renderAir(); renderAirMap();
    if (S.sel?.type === "air") {
      const a = S.air.aircraft.find((x) => x.hex === S.sel.id);
      if (a) { S.detail = Object.assign(a, { _key: "air" + a.hex }); renderAirDetail(a, { pan: false }); }
    }
    const emg = (S.air.aircraft || []).filter((a) => a.emergency).length;
    setMDot("air", emg ? "!" : "");
    if (!S._airQueueOnce && S.incidents.length) { S._airQueueOnce = true; renderQueue(); }
    if (!S._rvAirT || Date.now() - S._rvAirT > 15000) { S._rvAirT = Date.now(); renderRiver(); }
  } catch (e) {
    if (!S.air) $("#air-list").innerHTML = '<div class="empty"><b>Aircraft feed unavailable</b>Retrying every few seconds.</div>';
  }
}
async function loadPulse() {
  try {
    const p = S.pulse = await api("/api/live/pulse");
    renderSpark();
    const lag = p.pipeline?.lag_sec ?? 0, heard = p.pipeline?.latest_heard;
    const stale = heard && now() - heard > 900;
    $("#sb-live").classList.toggle("stale", !!stale);
    $("#sb-lag").textContent = stale ? `last call ${age(heard)} ago` : lag > 60 ? `${dur(lag)} behind` : "real time";
    const h = p.headline || {};
    $("#sb-counts").innerHTML = `<b>${h.active ?? 0}</b> open · <b>${h.units_out ?? 0}</b> units out · <b>${num(h.calls_1h)}</b> calls/hr · <b>${p.today?.incidents ?? h.opened_24h ?? 0}</b> today`;
    const lc = p.last_call;
    if (lc) $("#sb-onair").innerHTML = `Last on air <b>${fmtTime(lc.start_time)}</b> <span class="ch">${esc(lc.talkgroup_tag)}</span> — ${esc(lc.call_line || "")}`;
    setMDot("queue", h.active || "");
  } catch (e) { console.warn(e); }
}
async function loadWeather() {
  try {
    const w = S.wx = await api("/api/live/weather");
    const b = $("#wx"); b.hidden = false;
    const al = w.alerts || [];
    b.classList.toggle("alert", al.length > 0);
    b.innerHTML = `<svg viewBox="0 0 24 24" class="ico"><path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9H7z"/></svg><b>${w.now?.temp ?? "–"}°</b>${al.length ? `<span>${al.length} alert${al.length > 1 ? "s" : ""}</span>` : ""}`;
    const bar = $("#alertbar");
    bar.hidden = !al.length;
    if (al.length) bar.innerHTML = `⚠ ${esc(al[0].event || al[0].headline || "Weather alert")}${al.length > 1 ? ` (+${al.length - 1} more)` : ""} <button type="button" data-act="wx">Details</button>`;
  } catch (e) {}
}
async function presence() {
  let id = store.get("cid", null);
  if (!id) { id = Math.random().toString(36).slice(2); store.set("cid", id); }
  try { const d = await post("/api/live/presence", { client_id: id, region: CFG.region }); $("#watching-n").textContent = d.watching ?? 1; } catch (e) {}
}

// ================================================================= MODALS
function modal(html) { $("#modal-box").innerHTML = html; $("#modal").hidden = false; $("#modal-box").querySelector("button,select,input,textarea")?.focus(); }
function closeModal() { $("#modal").hidden = true; }
function openHelp() {
  const K = [["j / k", "Move down / up in the focused pane"], ["↵", "Open the highlighted item"], ["Esc", "Close detail / dialogs"], ["/", "Search incidents"],
    ["1", "Incidents"], ["2", "Map"], ["3", "Radio"], ["4", "Units"], ["5", "Air"], ["6", "Detail"], ["7", "River timeline"], ["r", "Move River: strip → Units → Air → Radio → off"],
    ["← / →", "Pan River back / forward (River focused)"], ["0", "River back to now"], ["{ / }", "River window shorter / longer"], [".", "Jump to a place on the map"],
    ["l", "Listen live"], ["f", "Follow live"], ["p", "Play highlighted call"], ["w", "Words on / off"], ["g", "Fit map to region"], ["t", "Light / dark"],
    ["[ / ]", "Incident list window shorter / longer"], ["⌘K", "Command palette"]];
  modal(`<h2>Keyboard</h2><p>Everything here can be driven from the keyboard. Panes are numbered by their key; selecting an incident highlights its units, radio, River bar and the aircraft over it in every pane.</p>
    <div class="keygrid">${K.map(([k, d]) => `<kbd>${esc(k)}</kbd><span>${esc(d)}</span>`).join("")}</div>
    <p class="legend-h">River bars</p>
    <div class="rlegend"><span><i class="lg s-new"></i>Reported</span><span><i class="lg s-en_route"></i>Units on the way</span><span><i class="lg s-on_scene"></i>On scene</span><span><i class="lg s-cleared"></i>Clearing / quiet</span><span><i class="lg tk"></i>Radio call</span><span><i class="lg ms"></i>Status change (selected)</span></div>
    <div class="ffoot" style="margin-top:14px"><button type="button" data-act="close-modal">Close</button></div>`);
}
function openReport(callId, incId) {
  modal(`<h2>Report a problem</h2><p>Reports help fix bad transcripts, wrong locations and anything that shouldn't be public.</p>
    <form id="report-form"><select name="reason" required><option value="">What's wrong?</option><option>Wrong location</option><option>Transcript is wrong</option>
      <option>Wrong incident / grouping</option><option>Private information showing</option><option>Wrong unit or status</option><option>Something else</option></select>
      <textarea name="note" rows="3" placeholder="Anything else? (optional)"></textarea>
      <div class="ffoot"><button type="button" data-act="close-modal">Cancel</button><button type="submit" class="primary">Send report</button></div></form>`);
  $("#report-form").addEventListener("submit", async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try { await post("/api/live/report", { call_id: callId || null, incident_id: incId || null, reason: fd.get("reason"), note: fd.get("note") }); toast("Report sent"); }
    catch (err) { toast("Couldn't send the report; try again"); }
    closeModal();
  });
}
function openWeather() {
  const w = S.wx; if (!w) return;
  modal(`<h2>Weather · ${esc(CFG.regionName || "")}</h2><p>Now ${w.now?.temp ?? "–"}°F, ${esc(w.now?.text || "")} · feels ${w.now?.feels ?? "–"}° · wind ${esc(w.now?.wind_dir || "")} ${w.now?.wind_mph ?? 0} mph · humidity ${w.now?.humidity ?? "–"}%</p>
    ${(w.alerts || []).map((a) => `<div class="wxalert"><b>${esc(a.event || a.headline || "Alert")}</b><br>${esc(a.headline || a.desc || "")}</div>`).join("")}
    <div class="wxgrid">${(w.forecast || []).slice(0, 3).map((f) => `<div>${esc(f.name)}<b>${f.temp}°</b>${esc(f.short)}${f.pop ? ` · ${f.pop}% rain` : ""}</div>`).join("")}</div>
    <div class="ffoot">${w.forecast_url ? `<a href="${esc(w.forecast_url)}" target="_blank" rel="noopener" style="margin-right:auto;align-self:center;color:var(--brand)">Full forecast ↗</a>` : ""}<button type="button" data-act="close-modal">Close</button></div>`);
}

// ================================================================= COMMAND PALETTE
const P = { items: [], on: 0, places: [], pseq: 0 };
function paletteSource() {
  const cmds = [
    ["Listen live", "l", () => setListen(!S.listening)], ["Follow live", "f", () => setFollow(!S.follow)],
    ["Switch light / dark", "t", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")],
    ["Fit map to region", "g", () => fitRegion()], ["Keyboard shortcuts", "?", openHelp],
    ["River: bottom strip", "", () => placeRiver("strip")], ["River: in place of Units", "", () => placeRiver("units")], ["River: in place of Air", "", () => placeRiver("air")],
    ["River: in place of Radio", "", () => placeRiver("radio")], ["River: hide", "", () => placeRiver("off")],
    ["River: last 3 hours", "", () => rvSetSpan(10800)], ["River: last 6 hours", "", () => rvSetSpan(21600)], ["River: last 12 hours", "", () => rvSetSpan(43200)], ["River: last 24 hours", "", () => rvSetSpan(86400)],
    ["Show active incidents", "", () => setFilter("window", "active")], ["Show last 24 hours", "", () => setFilter("window", "24h")], ["Show last 7 days", "", () => setFilter("window", "7d")],
    ["Police only", "", () => setFilter("service", "police")], ["Fire only", "", () => setFilter("service", "fire")], ["EMS only", "", () => setFilter("service", "ems")], ["All services", "", () => setFilter("service", "")],
    ["Hide radio chatter", "", () => { S.hideChatter = !S.hideChatter; store.set("hideChatter", S.hideChatter); loadRadio(true); }],
    ["Weather and alerts", "", openWeather], ["Briefing", "", () => (location.href = `/live/${CFG.region}`)], ["Full-screen map", "", () => (location.href = `/live/${CFG.region}/map`)],
    ...(CFG.walls || []).map((w) => [`Wall: ${w}`, "", () => (location.href = `/live/${CFG.region}/wall/${w}`)]),
    ["Report a problem", "", () => openReport(null, S.sel?.type === "incident" ? S.sel.id : null)],
    [DEMO ? "Leave demo sky" : "Demo sky (busy aircraft)", "", () => (location.search = DEMO ? "" : "?demo=1")],
  ].map(([t, k, run]) => ({ g: "Commands", t, s: k, ico: ICO.cmd, run }));
  const seen = new Set();
  const incs = [...visibleIncidents(), ...rvIncidents()].filter((i) => !seen.has(i.id) && seen.add(i.id)).map((i) => ({ g: "Incidents", t: i.title, s: `${placeOf(i)} · ${age(i.last_at)}`, ico: kico(i.kind), run: () => select("incident", i.id) }));
  const units = S.units.map((u) => ({ g: "Units", t: u.callsign, s: UNIT_STATUS[u.status] || "", ico: ICO.unit, run: () => select("unit", u.id) }));
  const chans = S.channels.map((c) => ({ g: "Channels", t: c.name, s: `${c.calls_24h} today · solo`, ico: ICO.radio,
    run: () => { S.hiddenCh = new Set(S.channels.map((x) => x.name).filter((n) => n !== c.name)); store.set("hiddenCh", [...S.hiddenCh]); renderRadio(); focusPane("radio"); toast(`Radio: only ${c.name}`); } }));
  const air = (S.air?.aircraft || []).map((a) => ({ g: "Aircraft", t: a.callsign || a.reg || a.hex, s: a.label || "", ico: `<svg viewBox="0 0 24 24" class="plane">${PLANE}</svg>`, run: () => select("air", a.hex) }));
  return [...incs, ...units, ...chans, ...air, ...cmds];
}
function openPalette() {
  $("#palette").hidden = false; const i = $("#pal-q"); i.value = ""; P.all = paletteSource(); P.places = []; runPalette(); i.focus();
}
function closePalette() { $("#palette").hidden = true; }
function scoreItem(it, q) {
  const t = it.t.toLowerCase(), s = (it.s || "").toLowerCase();
  if (t.startsWith(q)) return 100;
  if (t.split(/\W+/).some((w) => w.startsWith(q))) return 70;
  if (t.includes(q)) return 50;
  if (s.includes(q)) return 20;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => t.includes(w) || s.includes(w))) return 30;
  return 0;
}
function palPlaces(q) {
  clearTimeout(P.pt);
  if (q.length < 3) { P.places = []; return; }
  P.pt = setTimeout(async () => {
    const seq = ++P.pseq;
    try {
      const d = await api("/api/live/places", { q });
      if (seq !== P.pseq || $("#palette").hidden) return;
      P.places = (d.items || []).map((p) => ({ g: "Places", t: p.label, s: p.sub || p.kind, ico: ICO.pin, run: () => { PL.items = [p]; goPlace(0); } }));
      runPalette(true);
    } catch (e) {}
  }, 380);
}
function runPalette(keep) {
  const q = $("#pal-q").value.trim().toLowerCase();
  if (!keep) palPlaces(q);
  let items;
  if (!q) items = P.all.filter((x) => x.g === "Incidents").slice(0, 8).concat(P.all.filter((x) => x.g === "Commands").slice(0, 6));
  else items = P.all.map((x) => [x, scoreItem(x, q)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 40).map((x) => x[0]).concat(P.places);
  const order = ["Incidents", "Units", "Aircraft", "Places", "Channels", "Commands"];
  items.sort((a, b) => order.indexOf(a.g) - order.indexOf(b.g));
  const prev = keep ? P.on : 0;
  P.items = items; P.on = Math.min(prev, Math.max(0, items.length - 1));
  const hi = (t) => { const e = esc(t); if (!q) return e; const i = t.toLowerCase().indexOf(q); return i < 0 ? e : esc(t.slice(0, i)) + "<mark>" + esc(t.slice(i, i + q.length)) + "</mark>" + esc(t.slice(i + q.length)); };
  let g = "", html = "";
  items.forEach((it, n) => {
    if (it.g !== g) { g = it.g; html += `<li class="grp">${esc(g)}</li>`; }
    html += `<li class="it ${n === P.on ? "on" : ""}" data-n="${n}" role="option"><span class="pg">${it.ico}</span><span class="pt">${hi(it.t)}</span><span class="ps">${esc(it.s || "")}</span></li>`;
  });
  $("#pal-res").innerHTML = html || `<li class="none">${q.length >= 3 ? "Searching places…" : "Nothing matches. Try a street, a unit like “Medic 2”, or a channel."}</li>`;
}
function palMove(d) {
  if (!P.items.length) return;
  P.on = (P.on + d + P.items.length) % P.items.length;
  $$("#pal-res .it").forEach((x) => x.classList.toggle("on", +x.dataset.n === P.on));
  $(`#pal-res .it[data-n="${P.on}"]`)?.scrollIntoView({ block: "nearest" });
}
function palGo(n = P.on) { const it = P.items[n]; if (!it) return; closePalette(); it.run(); }

// ================================================================= FILTERS + PANES
function setFilter(k, v) {
  S.f[k] = v; store.set("filters", S.f); renderFilterBar(); loadIncidents();
  if (k === "service") loadRiver();
}
function renderFilterBar() {
  $$("#f-window button").forEach((b) => { b.setAttribute("role", "radio"); b.setAttribute("aria-checked", b.dataset.v === S.f.window); });
  $$("#f-service button").forEach((b) => { b.setAttribute("role", "radio"); b.setAttribute("aria-checked", b.dataset.v === S.f.service); });
  $$("#units-scope button").forEach((b) => { b.setAttribute("role", "radio"); b.setAttribute("aria-checked", b.dataset.v === S.unitsScope); });
  $$("#river-span button, #river-at button").forEach((b) => b.setAttribute("role", "radio"));
  const kb = $("#f-kinds");
  if (!kb.children.length) kb.innerHTML = KINDS.map((k) => `<button type="button" class="kbtn" data-kind="${k}" title="${esc(KIND_LABEL[k])}" aria-label="${esc(KIND_LABEL[k])}">${kico(k)}</button>`).join("");
  kb.classList.toggle("none", !S.f.kinds.length);
  $$(".kbtn", kb).forEach((b) => b.setAttribute("aria-pressed", S.f.kinds.includes(b.dataset.kind)));
  $$("#map-layers button").forEach((b) => b.setAttribute("aria-pressed", !!S.layers[b.dataset.l]));
}
const PANES = ["queue", "map", "radio", "units", "air", "detail", "river"];
const paneShown = (name) => { const p = $(`#p-${name}`); return p && !p.hidden && !p.classList.contains("swapped"); };
function focusPane(name) {
  if (!paneShown(name)) {
    if (name === "river") { placeRiver(S.riverAt === "off" ? "strip" : S.riverAt, true); }
    else if (SLOT_PANE[name] && S.riverAt === name) { placeRiver("strip", true); toast(`${name[0].toUpperCase() + name.slice(1)} is back; River moved to the strip`); }
    else return;
  }
  S.focus = name;
  $$(".pane").forEach((p) => p.classList.toggle("focus", p.dataset.pane === name));
  if (isPhone()) $(`#p-${name}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  $(`#p-${name}`)?.focus({ preventScroll: true });
  if (name === "river" && S.cur.river < 0) S.cur.river = Math.max(0, (S.rv.order || []).length - 1);
  renderQueue(); renderBoard(); renderAir(); renderRadio(); renderRiver();
}
function setMDot(name, v) {
  const b = $(`#mtabs button[data-m="${name}"]`); if (!b) return;
  let d = $(".dot", b); if (!v) { d?.remove(); return; }
  if (!d) { d = document.createElement("span"); d.className = "dot"; b.appendChild(d); }
  d.textContent = v;
}
function moveCursor(delta) {
  const f = S.focus;
  if (f === "detail") { $("#detail-body").scrollBy({ top: delta * 120, behavior: "smooth" }); return; }
  if (f === "map") { map.panBy([0, delta * 120]); return; }
  if (f === "river") {
    const n = (S.rv.order || []).length; if (!n) return;
    S.cur.river = Math.max(0, Math.min(n - 1, (S.cur.river < 0 ? n : S.cur.river) + delta));
    renderRiver(); $("#r-inc-in .bar.cur")?.scrollIntoView({ block: "nearest" }); return;
  }
  const len = { queue: visibleIncidents().length, radio: visibleRadio().length, units: (S._unitOrder || []).length, air: airList().length }[f];
  if (!len) return;
  S.cur[f] = Math.max(0, Math.min(len - 1, S.cur[f] + delta));
  if (f === "queue") { renderQueue(); renderMapIncidents(); scrollCur("#queue-body tr.cur"); const i = visibleIncidents()[S.cur.queue]; if (i?.lat != null && map && !map.getBounds().pad(-0.1).contains([i.lat, i.lng])) map.panTo([i.lat, i.lng]); }
  if (f === "radio") { renderRadio(); scrollCur("#stream .rl.cur"); }
  if (f === "units") { renderBoard(); scrollCur("#board .uc.cur"); }
  if (f === "air") { renderAir(); scrollCur("#air-list .ar.cur"); }
}
const scrollCur = (sel) => $(sel)?.scrollIntoView({ block: "nearest" });
function openCursor() {
  const f = S.focus;
  if (f === "queue") { const i = visibleIncidents()[S.cur.queue]; if (i) select("incident", i.id); }
  if (f === "radio") { const c = visibleRadio()[S.cur.radio]; if (c?.incident_id) select("incident", c.incident_id); else if (c) play(c); }
  if (f === "units") { const u = (S._unitOrder || [])[S.cur.units]; if (u) select("unit", u.id); }
  if (f === "air") { const a = airList()[S.cur.air]; if (a) select("air", a.hex); }
  if (f === "river") { const id = (S.rv.order || [])[S.cur.river]; if (id) select("incident", id); }
}

// ================================================================= EVENTS
function bind() {
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t.closest(".wallmenu")) { $("#wallpop").hidden = true; $("#btn-walls").setAttribute("aria-expanded", "false"); }
    if (!t.closest("#place")) $("#place-res").hidden = true;
    const pl = t.closest("[data-place]"); if (pl) return goPlace(+pl.dataset.place);
    const btn = t.closest("button, [data-inc], [data-unit], [data-air], [data-call]");
    if (!btn) return;
    if (S._rvDrag && btn.closest("#river")) return;
    const ds = btn.dataset;
    if (btn.closest("#f-window")) return setFilter("window", ds.v);
    if (btn.closest("#f-service")) return setFilter("service", ds.v);
    if (btn.closest("#units-scope")) { S.unitsScope = ds.v; store.set("unitsScope", ds.v); renderFilterBar(); return loadUnits(); }
    if (btn.closest("#river-span")) return rvSetSpan(+ds.v);
    if (btn.closest("#river-at")) return placeRiver(ds.v);
    if (ds.kind) { const k = ds.kind; S.f.kinds = S.f.kinds.includes(k) ? S.f.kinds.filter((x) => x !== k) : [...S.f.kinds, k]; store.set("filters", S.f); renderFilterBar(); renderQueue(); renderMapIncidents(); renderRiver(); return; }
    if (ds.l) { S.layers[ds.l] = !S.layers[ds.l]; store.set("layers", S.layers); renderFilterBar();
      if (ds.l === "cams") toggleCams(S.layers.cams); else { renderMapIncidents(); renderMapUnits(); renderAirMap(); } return; }
    if (ds.m) return focusPane(ds.m);
    if (ds.play) { e.stopPropagation(); return play(findCall(+ds.play)); }
    if (ds.playTl) return play(findCall(+ds.playTl));
    if (ds.playU) return play(findCall(+ds.playU));
    if (ds.report) return openReport(+ds.report, S.sel?.type === "incident" ? S.sel.id : null);
    if (ds.reportInc) return openReport(null, +ds.reportInc);
    if (ds.chAll || ds.chNone) { S.hiddenCh = ds.chAll ? new Set() : new Set(S.channels.map((c) => c.name)); store.set("hiddenCh", [...S.hiddenCh]); renderChanPop(); return renderRadio(); }
    if (ds.chClose) { $("#chanpop").hidden = true; return; }
    if (ds.act === "close-modal") return closeModal();
    if (ds.act === "wx") return openWeather();
    if (ds.act === "air-all") { S.airOnly = false; store.set("airOnly", false); renderAir(); renderAirMap(); return; }
    if (ds.act === "zoom" && S.detail) return panTo(S.detail.lat, S.detail.lng, 16);
    if (ds.act === "zoom-air" && S.detail) return panTo(S.detail.lat, S.detail.lng, 13);
    if (ds.act === "solo") { S.radioIncOnly = true; renderRadio(); return; }
    if (t.closest(".tag.near")) { e.stopPropagation(); return select("incident", +t.closest(".tag.near").dataset.inc); }
    if (ds.air) return select("air", ds.air);
    if (ds.unit) return select("unit", +ds.unit);
    if (ds.inc) return select("incident", +ds.inc, { pan: true });
  });
  $("#btn-walls").onclick = (e) => { e.stopPropagation(); const p = $("#wallpop"); p.hidden = !p.hidden; $("#btn-walls").setAttribute("aria-expanded", String(!p.hidden)); };
  $("#detail-close").onclick = closeDetail;
  $("#detail-words").onclick = () => { S.words = !S.words; store.set("words", S.words); if (S.detail && S.sel?.type === "incident") renderIncidentDetail(S.detail, { pan: false }); };
  $("#detail-play").onclick = () => {
    const tl = (S.detail?.timeline || []).filter((c) => c.audio); if (!tl.length) return;
    S.playQueue = tl.slice(1); S.playing = null; play(tl[0]);
  };
  $("#btn-listen").onclick = () => setListen(!S.listening);
  $("#btn-follow").onclick = () => setFollow(!S.follow);
  $("#btn-theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("#btn-help").onclick = openHelp;
  $("#btn-palette").onclick = openPalette;
  $("#wx").onclick = openWeather;
  $("#map-fit").onclick = fitRegion;
  $("#queue-lines").onclick = () => { S.lines = !S.lines; store.set("lines", S.lines); renderQueue(); };
  $("#air-only").onclick = () => { S.airOnly = !S.airOnly; store.set("airOnly", S.airOnly); renderAir(); renderAirMap(); };
  $("#radio-chatter").onclick = () => { S.hideChatter = !S.hideChatter; store.set("hideChatter", S.hideChatter); loadRadio(true); };
  $("#radio-inc").onclick = () => { S.radioIncOnly = !S.radioIncOnly; renderRadio(); };
  $("#radio-chan").onclick = () => { const p = $("#chanpop"); p.hidden = !p.hidden; if (!p.hidden) renderChanPop(); };
  $("#river-live").onclick = () => { S.rv.pan = 0; renderRiver(); loadRiver(true); };
  $("#chanpop").addEventListener("change", (e) => {
    const n = e.target.dataset.ch; if (!n) return;
    if (e.target.checked) S.hiddenCh.delete(n); else S.hiddenCh.add(n);
    store.set("hiddenCh", [...S.hiddenCh]); renderRadio();
  });
  $("#radio-more").onclick = loadOlderRadio;
  $("#spark").addEventListener("mousemove", sparkHover);
  $("#spark").addEventListener("mouseleave", () => { $("#spark .tip")?.remove(); $$("#spark rect.h").forEach((x) => x.classList.remove("h")); });
  $$(".queue th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    S.sort = { key: k, dir: S.sort.key === k ? (S.sort.dir === "asc" ? "desc" : "asc") : (k === "title" || k === "kind" || k === "status" ? "asc" : "desc") };
    store.set("sort", S.sort); renderQueue(); renderMapIncidents();
  }));
  let qt;
  $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value.trim(); loadIncidents(); renderRiver(); }, 300); });
  // place search
  const pq = $("#place-q");
  pq.addEventListener("input", () => placeQuery(pq.value.trim()));
  pq.addEventListener("focus", () => { if (PL.items.length && pq.value.trim().length >= 2) renderPlaces(); });
  pq.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (PL.items.length) { PL.on = (PL.on + 1) % PL.items.length; renderPlaces(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (PL.items.length) { PL.on = (PL.on - 1 + PL.items.length) % PL.items.length; renderPlaces(); } }
    else if (e.key === "Enter") { e.preventDefault(); if (PL.items.length) goPlace(); }
    else if (e.key === "Escape") { $("#place-res").hidden = true; }
  });
  // river interactions
  const rv = $("#river");
  rv.addEventListener("pointerdown", rvDrag);
  rv.addEventListener("mousemove", rvTip);
  rv.addEventListener("mouseleave", () => ($("#r-tip").hidden = true));
  rv.addEventListener("wheel", (e) => {
    if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;   // vertical wheel scrolls lanes
    e.preventDefault();
    rvPan(((e.shiftKey ? e.deltaY : e.deltaX) / rv.clientWidth) * -S.rv.span);
  }, { passive: false });
  $$(".pane").forEach((p) => p.addEventListener("pointerdown", () => { if (S.focus !== p.dataset.pane) { S.focus = p.dataset.pane; $$(".pane").forEach((x) => x.classList.toggle("focus", x === p)); } }, true));
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  $("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") return closePalette(); const it = e.target.closest(".it"); if (it) palGo(+it.dataset.n); });
  $("#pal-q").addEventListener("input", () => runPalette());
  $("#pal-q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); palMove(1); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); palMove(-1); }
    else if (e.key === "Enter") { e.preventDefault(); palGo(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  document.addEventListener("keydown", onKey);
  let rt;
  window.addEventListener("resize", () => { map && map.invalidateSize(); clearTimeout(rt); rt = setTimeout(() => { renderBoard(); renderRiver(); }, 120); });
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(renderRiver, 60); }).observe($("#river"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadRadio(); loadAir(); loadIncidents(); loadUnits(); loadPulse(); } });
}
function onKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); return $("#palette").hidden ? openPalette() : closePalette(); }
  if (!$("#palette").hidden) return;
  if (!$("#modal").hidden) { if (e.key === "Escape") closeModal(); return; }
  const t = e.target instanceof Element ? e.target : document.body;
  if (t.matches("input, textarea, select")) {
    if (e.key === "Escape") { t.blur(); focusPane(S.focus); }
    if (e.key === "Enter" && t.id === "q") { t.blur(); focusPane("queue"); }
    if (e.key === "ArrowDown" && t.id === "q") { e.preventDefault(); t.blur(); focusPane("queue"); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
  if (k === ".") { e.preventDefault(); $("#place-q").focus(); $("#place-q").select(); return; }
  if (k === "?") return openHelp();
  if (k === "Escape") { if (!$("#chanpop").hidden) { $("#chanpop").hidden = true; return; } if (!$("#wallpop").hidden) { $("#wallpop").hidden = true; return; } if (S.sel) { closeDetail(); focusPane("queue"); } return; }
  if (/^[1-7]$/.test(k)) return focusPane(PANES[+k - 1]);
  if (k === "r") return cycleRiver();
  if (k === "0") { S.rv.pan = 0; renderRiver(); return loadRiver(true); }
  if (S.focus === "river" && (k === "ArrowLeft" || k === "ArrowRight")) { e.preventDefault(); return rvPan((k === "ArrowLeft" ? 0.15 : -0.15) * S.rv.span); }
  if (k === "j" || k === "ArrowDown") { e.preventDefault(); return moveCursor(1); }
  if (k === "k" || k === "ArrowUp") { e.preventDefault(); return moveCursor(-1); }
  if (k === "Enter") { if (t.matches("button, a")) return; e.preventDefault(); return openCursor(); }
  if (k === "l") return setListen(!S.listening);
  if (k === "f") return setFollow(!S.follow);
  if (k === "t") return setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  if (k === "g") return fitRegion();
  if (k === "w") return $("#detail-words").click();
  if (k === "p") { const c = S.focus === "radio" ? visibleRadio()[S.cur.radio] : (S.detail?.timeline || []).find((x) => x.audio); return play(c); }
  if (k === "[" || k === "]") {
    const W = ["active", "1h", "6h", "24h", "7d"], i = W.indexOf(S.f.window);
    return setFilter("window", W[Math.max(0, Math.min(W.length - 1, i + (k === "]" ? 1 : -1)))]);
  }
  if (k === "{" || k === "}") {
    const W = [10800, 21600, 43200, 86400], i = Math.max(0, W.indexOf(S.rv.span));
    return rvSetSpan(W[Math.max(0, Math.min(W.length - 1, i + (k === "}" ? 1 : -1)))]);
  }
}

// ---- resizable grid
function initResize() {
  const root = document.documentElement;
  const saved = store.get("layout", {});
  for (const [k, v] of Object.entries(saved)) root.style.setProperty(k, v);
  const save = (k, v) => { saved[k] = v; store.set("layout", saved); };
  $$(".gut").forEach((g) => g.addEventListener("pointerdown", (e) => {
    e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add("dragging"); document.body.classList.add("resizing");
    const grid = $("#grid").getBoundingClientRect(), v = g.dataset.gut, rev = !!g.dataset.rev;
    const mv = (ev) => {
      const w = Math.max(280, Math.min(grid.width * 0.42, rev ? grid.right - ev.clientX - 5 : ev.clientX - grid.left - 5));
      root.style.setProperty(v, w + "px"); map.invalidateSize({ pan: false });
    };
    const up = () => { g.removeEventListener("pointermove", mv); g.classList.remove("dragging"); document.body.classList.remove("resizing"); save(v, root.style.getPropertyValue(v)); renderBoard(); renderRiver(); };
    g.addEventListener("pointermove", mv); g.addEventListener("pointerup", up, { once: true });
  }));
  $$(".split").forEach((s) => s.addEventListener("pointerdown", (e) => {
    e.preventDefault(); s.setPointerCapture(e.pointerId); s.classList.add("dragging"); document.body.classList.add("resizing", "rows");
    const px = s.dataset.splitPx;
    const col = (px ? $("#grid") : s.parentElement).getBoundingClientRect(), v = s.dataset.split || px;
    const mv = (ev) => {
      if (px) root.style.setProperty(v, Math.max(120, Math.min(col.height * 0.6, col.bottom - ev.clientY - 5)) + "px");
      else root.style.setProperty(v, Math.max(18, Math.min(85, ((ev.clientY - col.top) / col.height) * 100)) + "%");
      map.invalidateSize({ pan: false });
    };
    const up = () => { s.removeEventListener("pointermove", mv); s.classList.remove("dragging"); document.body.classList.remove("resizing", "rows"); save(v, root.style.getPropertyValue(v)); renderRiver(); };
    s.addEventListener("pointermove", mv); s.addEventListener("pointerup", up, { once: true });
  }));
}

// ================================================================= BOOT
async function boot() {
  setTheme(store.get("theme", "dark") === "light" ? "light" : "dark");
  $("#sb-demo").hidden = !DEMO;
  renderFilterBar(); bind(); initResize(); initMap();
  placeRiver(S.riverAt, true);
  focusPane("queue");
  api("/api/live/codes").then((d) => { S.codes = d.items || []; }).catch(() => {});
  await Promise.all([loadIncidents(), loadUnits(), loadRadio(true), loadPulse(), loadAir()]);
  S.firstLoad = false;
  loadRiver(true);
  loadWeather(); presence();
  const every = (ms, fn) => setInterval(() => { if (!document.hidden) fn(); }, ms);
  every(5000, () => loadRadio());
  every(5000, loadAir);
  every(15000, () => { loadIncidents(); loadUnits(); });
  every(30000, () => loadRiver());
  every(20000, renderRiver);               // keep the now-line and open tails moving
  every(60000, loadPulse);
  every(30000, presence);
  every(600000, loadWeather);
  every(30000, () => { if (S.sel?.type === "incident") loadDetail({ pan: false }); });
}
boot();
})();
