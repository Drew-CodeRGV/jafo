// jafo near — "neighborhood lens": what's going on around the places I care about.
// Vanilla JS + Leaflet. Read-only against /api/live/* (pi/web/live.py).
(() => {
"use strict";
const CFG = window.JAFO_NEAR || {};
const REGION = CFG.region || "rgv";
const BOX = CFG.regionBox || {};
const DEMO = new URLSearchParams(location.search).get("demo") === "1";
const CAN_AUDIO = !!CFG.audio || !!CFG.owner;
const TZ = CFG.tz || undefined;
const MI = 1609.344;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("jafo.near." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("jafo.near." + k, JSON.stringify(v)); } catch (e) {} },
};
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- glyphs (validated set from live.js)
const KIND_ICON = {
  violence: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  traffic: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3.5 16h17M7 19v-3M17 19v-3M7.5 12.5h.01M16.5 12.5h.01"/>',
  medical: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11.5h2l1-2 1.5 4 1-2h1"/>',
  property: '<path d="M4 11 12 4l8 7v9H4v-9z"/><path d="M10 20v-5h4v5"/>',
  suspicious: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
  other: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
};
const KIND_LABEL = { violence: "Danger", traffic: "Traffic", medical: "Medical", property: "Property", suspicious: "Suspicious", fire: "Fire", other: "Other" };
const KIND_NOUN = { violence: "a safety call", traffic: "a traffic call", medical: "a medical call", property: "a property call",
  suspicious: "a suspicious-activity call", fire: "a fire call", other: "a police call" };
const KINDS = Object.keys(KIND_ICON);
const kindSvg = (k) => `<svg viewBox="0 0 24 24">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
const kico = (k) => `<span class="kico k-${esc(KIND_ICON[k] ? k : "other")}" aria-hidden="true">${kindSvg(k)}</span>`;
const svg = (p, cls = "") => `<svg viewBox="0 0 24 24" class="${cls}">${p}</svg>`;
const ICO = {
  home: '<path d="M4 11 12 4l8 7v9h-5v-6h-6v6H4z"/>',
  work: '<path d="M4 8h16v11H4zM9 8V5h6v3M4 13h16"/>',
  school: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.3 3 14.7 0 18M12 3c-3 3.3-3 14.7 0 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  arrow: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  cam: '<path d="M4 7h11v10H4zM15 10l5-3v10l-5-3"/>',
  police: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z"/>',
  fire: KIND_ICON.fire,
  ems: '<path d="M12 5v14M5 12h14"/>',
  plane: '<path d="M12 2c.8 0 1.3.8 1.3 1.8V9l7.7 4.6v2l-7.7-2.3v4.9l2.2 1.6V21L12 20l-3.5 1v-1.2l2.2-1.6v-4.9L3 15.6v-2L10.7 9V3.8C10.7 2.8 11.2 2 12 2z"/>',
  heli: '<path d="M2.5 4.5l19 15M21.5 4.5l-19 15" fill="none" stroke-width="1.7"/><ellipse cx="12" cy="11" rx="3.2" ry="4.4"/><path d="M11 15h2v6h-2z"/>',
  radio: '<path d="M5 9h14v11H5zM8 9l9-5M9 14.5h.01M15 13v3"/>',
};
const PLACE_ICONS = ["home", "work", "school", "pin"];
const STATUS = { new: "Just reported", en_route: "Units on the way", on_scene: "On scene", cleared: "Cleared", quiet: "Winding down", ended: "Handled" };
const UNIT_STATUS = { dispatched: "dispatched", en_route: "on the way", on_scene: "on scene", transporting: "transporting", busy: "busy", available: "available", unknown: "heard" };
const SVC = { police: "Police", fire: "Fire", ems: "EMS" };

// ---------------------------------------------------------------- time + geo
const tf = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const df = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ });
const dayKey = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ });
const fmtTime = (t) => tf.format(new Date(t * 1000)).replace(" AM", "a").replace(" PM", "p");
function ago(t) {
  const s = now() - t;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min ago`.replace(" 0 min", "");
  if (dayKey.format(new Date(t * 1000)) === dayKey.format(new Date())) return `today ${fmtTime(t)}`;
  if (s < 7 * 86400) return `${df.format(new Date(t * 1000))} ${fmtTime(t)}`;
  return `${Math.round(s / 86400)} days ago`;
}
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
const RFRAC = { 0.5: "½ mile", 1: "a mile", 3: "3 miles" };
// "¾ mi north" / "right here"
function relWords(x, long = true) {
  if (x.dist == null) return "location unknown";
  if (x.rough) return `somewhere in ${x.city || "town"}`;
  if (x.dist < 0.15) return "right here";
  return `${fmtMi(x.dist)} ${long ? DIR_WORD[x.dir] : x.dir}`;
}

// ---------------------------------------------------------------- state
const DEFAULT_PLACES = [{ id: "p-mcallen", name: "Downtown McAllen", icon: "pin", lat: 26.2034, lng: -98.2300, example: true }];
if (DEMO) DEFAULT_PLACES.push(
  { id: "p-work", name: "Work", icon: "work", lat: 26.2688, lng: -98.1706, example: true },
  { id: "p-school", name: "School", icon: "school", lat: 26.1625, lng: -98.0060, example: true });
const S = {
  places: store.get(DEMO ? "places-demo" : "places", null) || DEFAULT_PLACES.slice(),
  placeId: store.get(DEMO ? "sel-demo" : "sel", null),
  temp: null,                 // unsaved place from search / locate / tap
  radius: store.get("radius", 1),   // 0 = everywhere
  when: store.get("when", "3h"),
  kinds: new Set(KINDS), svc: null,
  items: [], byId: new Map(), units: [], air: null, radio: [], radioScope: "near", codes: {},
  hist: null, today: null, story: null, sel: null, picking: false, wx: null,
};
const place = () => {
  if (S.radius === 0 && S.everywhere) return null;
  if (S.temp && S.placeId === "tmp") return S.temp;
  return S.places.find((p) => p.id === S.placeId) || S.places[0] || S.temp || DEFAULT_PLACES[0];
};
const savePlaces = () => { store.set(DEMO ? "places-demo" : "places", S.places); store.set(DEMO ? "sel-demo" : "sel", S.placeId); };

// ---------------------------------------------------------------- api
async function api(path, params = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set("region", REGION);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region: REGION, ...body }) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------------------------------------------------------------- derived
const WHEN = {
  now: { label: "Now", win: "active", phrase: "right now" },
  "3h": { label: "Last 3 h", win: "6h", phrase: "in the last 3 hours", secs: 3 * 3600 },
  today: { label: "Today", win: "24h", phrase: "today" },
  week: { label: "This week", win: "7d", phrase: "this week" },
};
const isLive = (it) => !it.closed && !["cleared", "ended"].includes(it.status);
function decorate(it, p) {
  if (p && it.lat != null && it.lng != null) {
    it.dist = miles(p.lat, p.lng, it.lat, it.lng);
    it.deg = bearing(p.lat, p.lng, it.lat, it.lng);
    it.dir = dir8(it.deg);
  } else { it.dist = null; it.dir = null; it.deg = null; }
  it.rough = !it.precision || it.precision === "city";   // only the town is known: distance is meaningless
  return it;
}
// what this view is about: time scope + kind/service filters + radius
function inScope(it) {
  if (!S.kinds.has(KIND_ICON[it.kind] ? it.kind : "other")) return false;
  if (S.svc && !(it.service === S.svc || (it.units && it.units[S.svc] > 0))) return false;
  const w = WHEN[S.when];
  if (!DEMO) {
    if (w.secs && (it.last_at || it.first_at) < now() - w.secs) return false;
    if (S.when === "today" && S.today && (it.last_at || 0) < S.today) return false;
  }
  return true;
}
function nearItems() {
  const p = place();
  const all = S.items.map((it) => decorate(it, p)).filter(inScope);
  S.rough = [];
  if (!S.radius || !p) return all.sort((a, b) => (isLive(b) - isLive(a)) || (b.last_at - a.last_at));
  const t = now();
  S.rough = all.filter((it) => it.rough && it.dist != null && it.dist <= Math.max(S.radius, 3)).sort((a, b) => b.last_at - a.last_at);
  return all.filter((it) => !it.rough && it.dist != null && it.dist <= S.radius).sort((a, b) => score(a) - score(b));
  const score = (it) => it.dist + ((t - (it.last_at || t)) / 3600) * (S.when === "week" ? 0.08 : 0.6) - (isLive(it) ? 1.5 : 0);
}
function nounFor(it) {
  const t = (it.type || "").trim();
  if (t && !/^(other|unknown|radio chatter|status update)$/i.test(t)) {
    const n = t.toLowerCase();
    return (/^[aeiou]/.test(n) ? "an " : "a ") + n;
  }
  return KIND_NOUN[it.kind] || KIND_NOUN.other;
}
function whoIsThere(it) {
  const u = it.units || {}, w = [];
  if (u.police) w.push("police"); if (u.fire) w.push("firefighters"); if (u.ems) w.push(u.ems > 1 ? "ambulances" : "an ambulance");
  return w.length ? w.join(" and ") : (it.service === "fire" ? "firefighters" : it.service === "ems" ? "an ambulance" : "police");
}
function statusPhrase(it) {
  switch (it.status) {
    case "on_scene": return `${whoIsThere(it)} on scene`;
    case "en_route": return `${whoIsThere(it)} on the way`;
    case "new": return "just reported";
    case "quiet": return "winding down";
    default: return "handled";
  }
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function placeName(p) { return p ? p.name : "the Valley"; }

// ---------------------------------------------------------------- map
const map = L.map("map", { zoomControl: false, attributionControl: true, zoomSnap: 0.25 })
  .setView([BOX.default_lat || 26.2, BOX.default_lng || -98.2], 13);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
map.createPane("rings"); map.getPane("rings").style.zIndex = 380;
map.createPane("air"); map.getPane("air").style.zIndex = 640;
const ringLayer = L.layerGroup().addTo(map);
const incLayer = L.layerGroup().addTo(map);
const airLayer = L.layerGroup().addTo(map);
const storyLayer = L.layerGroup().addTo(map);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawRings(fit) {
  ringLayer.clearLayers();
  const p = place();
  if (!p) { if (fit) fitRegion(); return; }
  const home = css("--home") || "#d9822b";
  for (const r of [0.5, 1, 3]) {
    const on = r === S.radius;
    L.circle([p.lat, p.lng], { pane: "rings", radius: r * MI, color: home, weight: on ? 2 : 1.2, opacity: on ? 0.9 : 0.5,
      dashArray: on ? null : "3 6", fill: on, fillColor: home, fillOpacity: 0.07, interactive: false }).addTo(ringLayer);
    L.marker([p.lat + r / 69.05, p.lng], { pane: "rings", interactive: false,
      icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<span class="ringlbl">${r === 0.5 ? "½" : r} mi</span>` }) }).addTo(ringLayer);
  }
  L.marker([p.lat, p.lng], { zIndexOffset: 1000, keyboard: false, title: p.name,
    icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="homepin"><i></i></div>' }) }).addTo(ringLayer);
  if (fit) fitPlace();
}
function fitPlace() {
  const p = place();
  if (!p) return fitRegion();
  const r = (S.radius || 3) * 1.12 * MI;
  map.fitBounds(L.latLng(p.lat, p.lng).toBounds(r * 2), { animate: true, padding: [10, 10] });
}
function fitRegion() {
  if (BOX.bbox_north) map.fitBounds([[BOX.bbox_south, BOX.bbox_west], [BOX.bbox_north, BOX.bbox_east]], { padding: [10, 10] });
}
function drawIncidents(list) {
  incLayer.clearLayers();
  for (const it of list) {
    if (it.lat == null) continue;
    const live = isLive(it);
    const k = KIND_ICON[it.kind] ? it.kind : "other";
    const m = L.marker([it.lat, it.lng], { zIndexOffset: live ? 500 : 0, title: it.title,
      icon: L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<div class="mk k-${k}${live ? " live" : " past"}${it.rough ? " rough" : ""}${S.sel === it.id ? " sel" : ""}">${kindSvg(k)}</div>` }) });
    m.bindTooltip(`${esc(it.title)}<br><span style="font-weight:500">${esc(STATUS[it.status] || "")} · ${esc(ago(it.last_at))}</span>`, { direction: "top", offset: [0, -14] });
    m.on("click", () => openStory(it.id));
    m.addTo(incLayer);
  }
}
const PICK = { set(on) { S.picking = on; $("#pick-hint").hidden = !on; map.getContainer().style.cursor = on ? "crosshair" : ""; } };
map.on("click", (e) => {
  if (!S.picking) return;
  PICK.set(false);
  setTemp({ name: "Dropped pin", lat: e.latlng.lat, lng: e.latlng.lng }, true);
});

// ---------------------------------------------------------------- aircraft
const ROLE_NAME = { border: "Border Patrol", medical: "Medical", police: "Police", military: "Military", news: "News" };
const KIND_NAME = { airline: "Airliner", commercial: "Airliner", heavy: "Large jet", jet: "Jet", light: "Small plane", helicopter: "Helicopter", military: "Military aircraft", uav: "Drone" };
const SQUAWK = { 7700: "declared an emergency", 7600: "lost radio contact", 7500: "is squawking hijack (7500)" };
const SQUAWK_WHY = { 7700: "7700 is the general emergency code — usually a medical or mechanical problem on board.",
  7600: "7600 means the pilot can't talk to air traffic control; they follow standard procedures.", 7500: "7500 signals unlawful interference; it is sometimes set by mistake." };
function airName(a) {
  const isHeli = a.kind === "helicopter";
  let who = "";
  if (a.role === "police" && /PUBLIC SAFETY/i.test(a.operator || "")) who = "DPS";
  else if (a.role) who = ROLE_NAME[a.role] || "";
  if (a.role === "military") return `Military ${a.type || "aircraft"}${a.operator ? ` (${titleCase(a.operator)})` : ""}`;
  if (isHeli) return `${who ? who + " helicopter" : "Helicopter"}`;
  return who ? `${who} ${(KIND_NAME[a.kind] || "aircraft").toLowerCase()}` : (KIND_NAME[a.kind] || "Aircraft");
}
const titleCase = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bU S\b/i, "US");
function airDoing(a) {
  if (a.on_ground) return "on the ground";
  if (a.circling) return "circling";
  if (a.vs_fpm < -400) return "descending";
  if (a.vs_fpm > 400) return "climbing";
  return a.track != null ? `flying ${DIR_WORD[dir8(a.track)]}` : "flying";
}
function airSorted() {
  const p = place();
  const ac = (S.air?.aircraft || []).map((a) => {
    const x = { ...a };
    if (p && a.lat != null) { x.dist = miles(p.lat, p.lng, a.lat, a.lng); x.dir = dir8(bearing(p.lat, p.lng, a.lat, a.lng)); } else x.dist = null;
    return x;
  });
  const rank = (a) => (a.emergency ? 0 : a.near_incident ? 1 : a.kind === "helicopter" ? 2 : a.interesting ? 3 : 4) * 100 + (a.dist ?? 50);
  return ac.sort((a, b) => rank(a) - rank(b));
}
function drawAir() {
  airLayer.clearLayers();
  for (const a of S.air?.aircraft || []) {
    if (a.lat == null) continue;
    const cls = a.emergency ? "emg" : a.interesting ? "int" : "";
    const trail = (a.trail || []).map((t) => [t[0], t[1]]);
    if (trail.length > 1) L.polyline(trail, { pane: "air", color: a.emergency ? css("--danger") : a.interesting ? css("--ink-2") : css("--ink-3"),
      weight: 2, opacity: 0.55, dashArray: a.interesting ? null : "2 5", interactive: false }).addTo(airLayer);
    const ico = a.kind === "helicopter" ? ICO.heli : ICO.plane;
    const rot = a.kind === "helicopter" ? 0 : (a.track || 0);
    const lbl = a.interesting || a.emergency ? `<span class="ac-lbl" style="position:absolute;left:30px;top:6px">${esc(a.callsign || a.reg || "")}</span>` : "";
    const m = L.marker([a.lat, a.lng], { pane: "air", title: a.label || a.callsign,
      icon: L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<div class="ac ${cls}" style="position:relative"><span style="display:grid;transform:rotate(${rot}deg)">${svg(ico)}</span>${lbl}</div>` }) });
    m.bindTooltip(esc(a.label || airName(a)), { direction: "top", offset: [0, -12] });
    m.on("click", () => { if (a.near_incident) openStory(a.near_incident.id); });
    m.addTo(airLayer);
  }
}
function airRow(a) {
  const where = a.dist == null ? "" : a.dist < 0.4 ? "right overhead" : `${fmtMi(a.dist)} ${DIR_WORD[a.dir]}`;
  const name = airName(a);
  let line, sub;
  if (a.emergency) {
    line = `<span class="emg-tag">${esc(a.emergency)}</span>${esc(name)} ${SQUAWK[a.emergency] || "declared an emergency"}`;
    sub = `${where}${a.callsign ? ` · ${esc(a.callsign)}` : ""}. ${SQUAWK_WHY[a.emergency] || ""}`;
  } else {
    line = `${esc(name)} ${airDoing(a)} ${where}`;
    sub = a.near_incident ? `Over the ${esc(a.near_incident.title.toLowerCase())} (${fmtMi(a.near_incident.distance_mi)} away)` :
      [a.callsign, a.type, a.operator && !a.role ? titleCase(a.operator) : null].filter(Boolean).map(esc).join(" · ");
    if (a.airport_event) sub += ` · ${esc(a.airport_event)}`;
  }
  const cls = a.emergency ? "emg" : a.interesting ? "int" : "";
  const tag = a.near_incident ? "button" : "div";
  return `<${tag} class="air ${cls}"${a.near_incident ? ` type="button" data-inc="${a.near_incident.id}"` : ""}>
    <span class="plane">${svg(a.kind === "helicopter" ? ICO.heli : ICO.plane)}</span>
    <span><b>${line}</b><span>${sub}</span></span>
    <span class="alt">${a.on_ground ? "ground" : `${(a.alt_ft || 0).toLocaleString()} ft`}<small>${a.gs_kt ? `${a.gs_kt} kt` : ""}</small></span></${tag}>`;
}
function renderAir() {
  const el = $("#air");
  if (!S.air) { el.innerHTML = `<div class="none">Checking the sky…</div>`; return; }
  const p = place(), R = S.radius ? Math.max(5, S.radius * 3) : 999;
  const all = airSorted();
  const show = all.filter((a) => a.emergency || ((a.interesting || a.kind === "helicopter") && (a.dist == null || a.dist <= Math.max(R, 15))));
  const routine = all.filter((a) => !show.includes(a) && !a.on_ground && (a.dist == null || a.dist <= Math.max(R, 15)));
  let h = show.length ? show.slice(0, 6).map(airRow).join("") :
    `<div class="none">Nothing unusual in the air${p ? ` near ${esc(p.name)}` : ""}.</div>`;
  if (routine.length) {
    const kinds = [...new Set(routine.map((a) => (KIND_NAME[a.kind] || "aircraft").toLowerCase()))];
    h += `<div class="air-more">Plus ${routine.length} routine flight${routine.length > 1 ? "s" : ""} nearby (${esc(kinds.slice(0, 3).join(", "))}) — normal traffic${S.air.airports?.length ? ` around ${esc(S.air.airports[0].name)}` : ""}.</div>`;
  }
  const ac = S.air.acars;
  if (ac?.active && ac.messages?.length) {
    h += `<details class="acars"><summary>${ac.messages.length} recent messages from aircraft (ACARS)</summary><ul>${ac.messages.slice(0, 8).map((m) =>
      `<li>${fmtTime(m.at)} · <b>${esc(m.flight || m.tail || "")}</b> ${esc(m.text)}</li>`).join("")}</ul></details>`;
  }
  if (S.air.demo) h += `<div class="air-more">Showing demo aircraft.</div>`;
  el.innerHTML = h;
}

// ---------------------------------------------------------------- units on the way
function onTheWay(list) {
  const ids = new Map(list.map((it) => [it.id, it]));
  const groups = new Map();
  for (const u of S.units) {
    if (!["dispatched", "en_route"].includes(u.status) || !u.incident_id) continue;
    const it = ids.get(u.incident_id);
    if (!it) continue;
    if (!groups.has(it.id)) groups.set(it.id, { it, units: [] });
    groups.get(it.id).units.push(u);
  }
  return [...groups.values()].sort((a, b) => (a.it.dist ?? 99) - (b.it.dist ?? 99));
}
function renderOtw(groups) {
  $("#otw-block").hidden = !groups.length;
  $("#otw").innerHTML = groups.slice(0, 4).map(({ it, units }) => `<button type="button" class="otw" data-inc="${it.id}">
    <span class="arrow"${it.deg != null ? ` style="transform:rotate(${it.deg}deg)"` : ""}>${svg(ICO.arrow)}</span>
    <span><b>${units.length} unit${units.length > 1 ? "s" : ""} on the way to ${esc(it.location || it.city || "a call")}${it.dist != null ? `, ${relWords(it, false)}` : ""}</b>
    <span>${esc(units.map((u) => u.callsign).join(", "))} · ${esc(it.title)}</span></span></button>`).join("");
}

// ---------------------------------------------------------------- verdict (the headline)
function renderVerdict(list, otw) {
  const p = place(), el = $("#verdict"), w = WHEN[S.when];
  if (!S.loaded) { el.className = "verdict"; el.innerHTML = `<div class="eyebrow"><span class="dot"></span>${esc(placeName(p))}</div><h1>Checking around ${esc(placeName(p))}…</h1><p>Pulling the latest calls our receivers heard.</p>`; return; }
  const live = list.filter(isLive);
  const danger = live.some((it) => ["violence", "fire"].includes(it.kind) && (it.dist ?? 99) < 1);
  el.className = "verdict " + (live.length ? (danger ? "busy alerting" : "busy") : "quiet");
  const where = p ? `near ${esc(p.name)}` : "across the Valley";
  const rTxt = S.radius ? `within ${RFRAC[S.radius]}` : "";
  let h1, ps = [];
  if (!p) {
    h1 = live.length ? `<em>${live.length} active</em> across the Valley` : `Quiet across the Valley`;
    ps.push(`${list.length} incident${list.length === 1 ? "" : "s"} ${w.phrase}${live.length ? `, ${live.length} still active` : ""}.`);
  } else if (!list.length) {
    h1 = `<em>Quiet</em> ${where}`;
    ps.push(`Nothing ${rTxt} ${w.phrase}.`);
    const others = S.items.filter((it) => isLive(it) && it.dist != null && !it.rough).sort((a, b) => a.dist - b.dist);
    if (others[0]) ps.push(`The closest active call is ${esc(nounFor(others[0]))} ${relWords(others[0])}.`);
  } else if (!live.length) {
    h1 = `<em>Calm</em> ${where}`;
    const lead = list.slice(0, 2).map((it) => `${nounFor(it)} ${relWords(it)} (${ago(it.last_at)})`);
    ps.push(`${cap(list.length === 1 ? "one call" : `${list.length} calls`)} ${rTxt} ${w.phrase}, all handled: ${esc(lead.join("; "))}.`);
  } else {
    const n = live.length;
    h1 = `<em>${n === 1 ? "1 thing" : `${n} things`}</em> going on ${where}`;
    ps.push(live.slice(0, 3).map((it) => `${cap(esc(nounFor(it)))} ${relWords(it)} — ${esc(statusPhrase(it))}.`).join(" "));
    if (list.length > n) ps.push(`${list.length - n} more ${rTxt} ${w.phrase} already handled.`);
  }
  if (p && S.rough?.length) ps.push(`${S.rough.length === 1 ? "One more call" : `${S.rough.length} more calls`} somewhere in ${esc([...new Set(S.rough.map((x) => x.city).filter(Boolean))].slice(0, 2).join(" and ") || "town")} — the exact spot wasn't said on the radio.`);
  const facts = [];
  const ou = otw.reduce((a, g) => a + g.units.length, 0);
  if (ou) facts.push(`<button type="button" class="fact" data-act="goto-otw">${svg(ICO.arrow)} ${ou} unit${ou > 1 ? "s" : ""} on the way</button>`);
  const air = airSorted().filter((a) => a.emergency || ((a.kind === "helicopter" || a.interesting) && (a.dist ?? 99) <= Math.max(5, (S.radius || 3) * 3)));
  const heli = air.find((a) => a.kind === "helicopter" && !a.emergency);
  if (heli) facts.push(`<button type="button" class="fact" data-act="goto-air">${svg(ICO.heli)} ${esc(airName(heli))} ${airDoing(heli)} ${heli.dist != null ? fmtMi(heli.dist) + " " + heli.dir : ""}</button>`);
  const emg = airSorted().find((a) => a.emergency);
  if (emg) facts.push(`<button type="button" class="fact" data-act="goto-air"><span class="emg-tag">${esc(emg.emergency)}</span>${esc(airName(emg))} ${emg.dist != null ? `${fmtMi(emg.dist)} ${emg.dir}` : ""} reported an emergency</button>`);
  if (S.wx?.alerts?.length) facts.push(`<span class="fact" style="color:var(--alert)">⚠ ${esc(S.wx.alerts[0].event || S.wx.alerts[0].headline || "Weather alert")}</span>`);
  const pulseAt = S.lastCall ? `last radio call heard ${ago(S.lastCall)}` : "listening";
  el.innerHTML = `<div class="eyebrow"><span class="dot"></span>${p ? esc(p.name) : "Everywhere"} · ${esc(w.label.toLowerCase())} · ${pulseAt}${DEMO ? '<span class="demo" title="Demo mode: the last 24 hours count as recent, aircraft are simulated">DEMO</span>' : ""}</div>
    <h1>${h1}</h1>${ps.map((x) => `<p>${x}</p>`).join("")}${facts.length ? `<div class="facts">${facts.join("")}</div>` : ""}`;
}

// ---------------------------------------------------------------- list
let showAll = false;
function niCard(it) {
  const live = isLive(it);
  const k = KIND_ICON[it.kind] ? it.kind : "other";
  const u = it.units || {};
  const pills = ["police", "fire", "ems"].filter((s) => u[s] > 0).map((s) => `<span class="up" title="${SVC[s]}">${svg(ICO[s])}${u[s]}</span>`).join("");
  const dial = it.dist == null || it.rough ? `<div class="cdial rough">${kico(k)}</div><div class="d">${it.dist == null ? "—" : `~${esc(it.city || "town")}`}</div>` : it.dist == null ? `<div class="cdial">${kico(k)}</div><div class="d">—</div>` :
    `<div class="cdial">${it.dist >= 0.15 ? `<span class="needle" style="transform:rotate(${it.deg}deg)"></span>` : ""}${kico(k)}</div>
     <div class="d">${it.dist < 0.15 ? "here" : fmtMi(it.dist)}${it.dist >= 0.15 ? `<small>${it.dir}</small>` : ""}</div>`;
  return `<li><button type="button" class="ni${live ? "" : " past"}${S.sel === it.id ? " hl" : ""}" data-inc="${it.id}">
    <div class="compass">${dial}</div>
    <div><div class="ni-t">${esc(it.title || nounFor(it))}</div>
      <div class="ni-w">${esc([it.location, it.city].filter(Boolean).join(", ") || "Location not given")}${it.precision && it.precision !== "block" && it.precision !== "point" ? ` <span class="tag-s">approx.</span>` : ""}</div>
      <div class="ni-s"><span class="st s-${esc(it.status)}"><i></i>${esc(STATUS[it.status] || it.status)}</span><span>${esc(ago(it.last_at))}</span>${pills ? `<span class="unitpills">${pills}</span>` : ""}${it.sensitive ? '<span class="tag-s">Sensitive</span>' : ""}</div></div>
  </button></li>`;
}
function renderList(list) {
  const p = place();
  $("#list-h").textContent = p ? (S.radius ? `Within ${RFRAC[S.radius]} of ${p.name}` : `Everything, by distance from ${p.name}`) : "Across the Valley";
  const n = showAll ? list.length : 8;
  let h = list.slice(0, n).map(niCard).join("");
  if (!list.length) h = `<li class="none">Nothing to show ${p && S.radius ? `within ${RFRAC[S.radius]}` : ""} ${WHEN[S.when].phrase}. ${S.radius && S.radius < 3 ? `<button type="button" class="more" data-act="widen">Widen to 3 miles</button>` : ""}</li>`;
  if (list.length > n) h += `<li><button type="button" class="more" data-act="show-all">Show ${list.length - n} more</button></li>`;
  if (p && S.radius && S.rough?.length) h += `<li class="rough-h">Somewhere in town — the radio only named the city, so we can't say how close:</li>` + S.rough.slice(0, 4).map(niCard).join("");
  $("#list").innerHTML = h;
}

// ---------------------------------------------------------------- per-place history (7 bars)
async function loadHist() {
  const p = place(), R = S.radius || 0;
  try {
    const d = await api("/api/live/incidents", { window: "7d", near: p && R ? `${p.lat},${p.lng}` : "", radius: p && R ? R : "" });
    S.hist = { key: histKey(), items: d.items || [] };
  } catch (e) { S.hist = { key: histKey(), items: [] }; }
  renderHist();
}
const histKey = () => { const p = place(); return `${p ? p.id + p.lat : "all"}|${S.radius}`; };
function renderHist() {
  const el = $("#hist"), p = place();
  if (!S.hist) { el.innerHTML = '<div class="none">Looking back a week…</div>'; return; }
  const items = S.hist.items;
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); days.push({ key: dayKey.format(d), lbl: i === 0 ? "Today" : df.format(d), n: 0, kinds: {} }); }
  const ix = new Map(days.map((d, i) => [d.key, i]));
  const mix = {};
  for (const it of items) {
    const i = ix.get(dayKey.format(new Date((it.first_at || it.last_at) * 1000)));
    const k = KIND_ICON[it.kind] ? it.kind : "other";
    mix[k] = (mix[k] || 0) + 1;
    if (i === undefined) continue;
    days[i].n++; days[i].kinds[k] = (days[i].kinds[k] || 0) + 1;
  }
  const total = items.length, top = Object.entries(mix).sort((a, b) => b[1] - a[1]);
  const mostly = !top.length ? "" : top[0][1] / total >= 0.4 ? `, mostly ${KIND_LABEL[top[0][0]].toLowerCase()}` : `, a mix of ${top.slice(0, 2).map((x) => KIND_LABEL[x[0]].toLowerCase()).join(" and ")}`;
  const where = p && S.radius ? `within ${RFRAC[S.radius]} of ${esc(p.name)}` : "across the Valley";
  $("#hist-h").textContent = p && S.radius ? `This week near ${p.name}` : "This week in the Valley";
  const mx = Math.max(1, ...days.map((d) => d.n));
  el.innerHTML = `<p class="hist-sum"><b>${total}</b> incident${total === 1 ? "" : "s"} ${where} in the last 7 days${esc(mostly)}.</p>
    <div class="bars" role="img" aria-label="Incidents per day">${days.map((d, i) => `<button type="button" class="bar${i === 6 ? " today" : ""}" data-i="${i}" aria-label="${esc(d.lbl)}: ${d.n} incidents">
      ${d.n ? `<span class="v">${d.n}</span>` : ""}<span class="f" style="height:${d.n ? Math.max(4, (d.n / mx) * 74) : 0}%"></span></button>`).join("")}</div>
    <div class="blabels">${days.map((d) => `<span>${esc(d.lbl)}</span>`).join("")}</div>
    ${top.length ? `<div class="mix">${top.map(([k, n]) => `<span>${kico(k)}${esc(KIND_LABEL[k])} ${n}</span>`).join("")}</div>` : ""}`;
  const bars = $(".bars", el);
  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; bars.appendChild(tip);
  const show = (b) => {
    const d = days[+b.dataset.i];
    tip.innerHTML = `<b>${esc(d.lbl)}</b> · ${d.n} incident${d.n === 1 ? "" : "s"}${Object.entries(d.kinds).map(([k, n]) => `<br>${esc(KIND_LABEL[k])} ${n}`).join("")}`;
    tip.style.left = `${b.offsetLeft + b.offsetWidth / 2}px`; tip.style.top = `${Math.min(b.offsetHeight - 8, 30)}px`; tip.hidden = false;
  };
  $$(".bar", el).forEach((b) => { b.addEventListener("mouseenter", () => show(b)); b.addEventListener("focus", () => show(b));
    b.addEventListener("mouseleave", () => { tip.hidden = true; }); b.addEventListener("blur", () => { tip.hidden = true; }); });
}

// ---------------------------------------------------------------- radio
function richText(text, codes = []) {
  let h = esc(text);
  h = h.replace(/⟦[^⟧]*⟧/g, '<span class="redacted" title="Hidden for privacy"><i>•••</i>hidden</span>');
  for (const c of codes || []) {
    if (!c.code || c.code.length < 2) continue;
    const re = new RegExp(`(^|[^\\w-])(${esc(c.code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]?")})(?![\\w])`, "gi");
    h = h.replace(re, `$1<span class="code" title="${esc(c.code)}: ${esc(c.meaning)}">$2</span>`);
  }
  return h;
}
const callText = (c) => c.line || (c.speakers || []).map((s) => s.text).join(" ").trim() || "(no speech)";
function playBtn(url) {
  if (!CAN_AUDIO || !url) return "";
  return `<button type="button" class="play" data-audio="${esc(url)}" aria-label="Play this call">${svg(ICO.play)}</button>`;
}
function renderRadio() {
  const p = place();
  const nearIds = new Set(S.items.filter((it) => it.dist != null && (!S.radius || it.dist <= Math.max(S.radius, 1))).map((it) => it.id));
  const rows = S.radioScope === "near" && p ? S.radio.filter((c) => c.incident_id && nearIds.has(c.incident_id)) : S.radio;
  $("#radio-sub").textContent = S.radioScope === "near" && p ? `· calls about places ${S.radius ? `within ${RFRAC[Math.max(S.radius, 1)]}` : "near you"}` : "· everything our receivers heard";
  $$("#radio-scope button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.r === S.radioScope)));
  $("#radio").innerHTML = rows.slice(0, 14).map((c) => {
    const it = c.incident_id && S.byId.get(c.incident_id);
    return `<li class="rl"><time>${fmtTime(c.at)}</time><div><div>${richText(callText(c), c.codes)}</div>
      <div class="ch">${playBtn(c.audio)}<span>${esc(c.channel || "")}</span>${it ? `<button type="button" class="lk" data-inc="${it.id}">${esc(it.title)}${it.dist != null ? ` · ${relWords(it, false)}` : ""}</button>` : ""}</div></div></li>`;
  }).join("") || `<li class="none">No radio calls tied to places near here lately. <button type="button" class="more" data-r="all">Show everything heard</button></li>`;
}
async function loadRadio(older) {
  try {
    const params = { limit: 60, hide_chatter: 1 };
    if (older && S.radio.length) params.before = S.radio[S.radio.length - 1].at;
    const d = await api("/api/live/radio", params);
    if (older) S.radio = S.radio.concat(d.items || []);
    else {
      const seen = new Set((d.items || []).map((c) => c.id));
      S.radio = (d.items || []).concat(S.radio.filter((c) => !seen.has(c.id) && c.at < (d.items?.at(-1)?.at || 0))).slice(0, 300);
    }
    if (S.radio[0]) S.lastCall = Math.max(S.lastCall || 0, S.radio[0].at);
  } catch (e) {}
  renderRadio();
}

// ---------------------------------------------------------------- units
function renderUnits() {
  const p = place();
  const out = S.units.filter((u) => !["available", "unknown"].includes(u.status));
  out.forEach((u) => { u.dist = p && u.lat != null ? miles(p.lat, p.lng, u.lat, u.lng) : null; });
  const order = ["en_route", "dispatched", "on_scene", "transporting", "busy"];
  const h = order.map((st) => {
    const us = out.filter((u) => u.status === st).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
    if (!us.length) return "";
    return `<div class="ugrp"><h4><span class="st s-${st === "dispatched" ? "en_route" : st === "transporting" ? "en_route" : st === "busy" ? "quiet" : st}"><i></i></span>${us.length} ${esc(UNIT_STATUS[st])}</h4><div class="uchips">${us.map((u) =>
      `<button type="button" class="uc" data-unit="${u.id}"${u.incident_id ? ` data-inc="${u.incident_id}"` : ""}>${svg(ICO[u.service] || ICO.police)}${esc(u.callsign)}<small>${u.dist != null ? fmtMi(u.dist) : esc(u.location || "")}</small></button>`).join("")}</div></div>`;
  }).join("");
  $("#units").innerHTML = h || '<div class="none">No crews out on calls right now.</div>';
}
async function openUnit(id) {
  try {
    const d = await api(`/api/live/units/${id}`);
    modal(`<h2>${esc(d.callsign)}</h2><p>${esc(d.location || "")} · last heard ${esc(ago(d.last_heard))}</p>
      <div class="ulist">${(d.activity || []).slice(-6).reverse().map((a) => `<div class="urow"><span>${esc(UNIT_STATUS[a.status] || a.status)} · ${esc(a.title || a.location || "")}</span><small>${fmtTime(a.at)}</small></div>`).join("")}</div>
      <h3 style="font:700 13px var(--display);text-transform:uppercase;color:var(--ink-3);margin:16px 0 8px">Recent radio</h3>
      ${(d.radio || []).slice(0, 5).map((c) => `<div class="rl"><time>${fmtTime(c.at)}</time><div>${richText(callText(c), c.codes)} ${playBtn(c.audio)}</div></div>`).join("")}
      <div class="mfoot"><button class="btn" type="button" data-act="close">Close</button></div>`);
  } catch (e) { toast("Couldn't load that unit"); }
}

// ---------------------------------------------------------------- places bar
function renderPlaces(list) {
  const counts = new Map();
  for (const pl of S.places.concat(S.temp ? [{ ...S.temp, id: "tmp" }] : [])) {
    const r = S.radius || 1;
    counts.set(pl.id, S.items.filter((it) => isLive(it) && it.lat != null && miles(pl.lat, pl.lng, it.lat, it.lng) <= r).length);
  }
  const chip = (pl, sel) => `<button type="button" class="pl" role="tab" aria-selected="${sel}" data-place="${pl.id}">${svg(ICO[pl.icon] || ICO.pin)}${esc(pl.name)}${counts.get(pl.id) ? `<span class="n">${counts.get(pl.id)}</span>` : ""}</button>`;
  const cur = place();
  let h = "";
  if (S.temp) h += chip({ ...S.temp, id: "tmp" }, cur && S.placeId === "tmp") + `<button type="button" class="pl add" data-act="save-temp">${svg(ICO.plus)}Save</button>`;
  h += S.places.map((pl) => chip(pl, !!cur && cur.id === pl.id && S.placeId !== "tmp")).join("");
  h += `<button type="button" class="pl" role="tab" aria-selected="${!cur}" data-place="all">${svg(ICO.globe)}Everywhere</button>`;
  h += `<button type="button" class="pl add" data-act="add-place">${svg(ICO.plus)}Add place</button>`;
  $("#places").innerHTML = h;
}
function selectPlace(id) {
  if (id === "all") { S.everywhere = true; S.prevRadius = S.radius || S.prevRadius || 1; S.radius = 0; }
  else { S.everywhere = false; if (!S.radius) S.radius = S.prevRadius || 1; S.placeId = id; }
  savePlaces(); store.set("radius", S.radius);
  closeStory(true);
  S.hist = null; render(); drawRings(true); loadHist();
}
function setTemp(p, ask) {
  S.temp = { id: "tmp", icon: "pin", ...p };
  S.placeId = "tmp"; S.everywhere = false; if (!S.radius) S.radius = S.prevRadius || 1;
  closeStory(true); S.hist = null; render(); drawRings(true); loadHist();
  if (ask) savePrompt();
}
function savePrompt() {
  const t = S.temp; if (!t) return;
  modal(`<h2>Save this place?</h2><p>Saved places stay on this device only — one tap to check on them later.</p>
    <div class="namechips">${["Home", "Work", "School", "Family"].map((n) => `<button type="button" data-name="${n}">${n}</button>`).join("")}</div>
    <input id="pname" value="${esc(t.name === "Dropped pin" || t.name === "My location" ? "" : t.name)}" placeholder="Name (e.g. Mom's house)" maxlength="30">
    <div class="mfoot"><button class="btn" type="button" data-act="close">Not now</button><button class="btn primary" type="button" data-act="do-save">Save place</button></div>`);
  $$("#modal [data-name]").forEach((b) => b.addEventListener("click", () => { $("#pname").value = b.dataset.name; }));
}
function doSave() {
  const name = ($("#pname").value || "").trim() || "My place";
  const icon = /^home|house/i.test(name) ? "home" : /^work|office/i.test(name) ? "work" : /school|college|campus/i.test(name) ? "school" : "pin";
  const id = "p-" + Date.now().toString(36);
  S.places = S.places.filter((p) => !p.example || S.places.length > 1 || true);
  S.places.unshift({ id, name, icon, lat: S.temp.lat, lng: S.temp.lng });
  S.temp = null; S.placeId = id; savePlaces(); closeModal(); toast(`Saved ${name}`); render(); drawRings(false);
}
function managePlaces() {
  modal(`<h2>Your places</h2><p>Add a place by searching, using your location, or tapping the map.</p>
    <div class="mfoot" style="justify-content:flex-start;margin-bottom:14px">
      <button class="btn primary" type="button" data-act="locate">Locate me</button>
      <button class="btn" type="button" data-act="pick">Tap the map</button>
      <button class="btn" type="button" data-act="focus-search">Search</button></div>
    <div class="placelist">${S.places.map((p) => `<div><span>${svg(ICO[p.icon] || ICO.pin)} ${esc(p.name)}${p.example ? ' <small style="color:var(--ink-3)">example</small>' : ""}</span><button type="button" data-del="${p.id}">Remove</button></div>`).join("")}</div>
    <div class="mfoot"><button class="btn" type="button" data-act="close">Done</button></div>`);
  $$("#modal [data-del]").forEach((b) => b.addEventListener("click", () => {
    S.places = S.places.filter((p) => p.id !== b.dataset.del);
    if (!S.places.length) S.places = DEFAULT_PLACES.slice(0, 1);
    if (S.placeId === b.dataset.del) S.placeId = S.places[0].id;
    savePlaces(); managePlaces(); render(); drawRings(true);
  }));
}
function locate() {
  closeModal();
  if (!navigator.geolocation) { toast("This browser can't share its location — try search instead"); return; }
  toast("Finding you…");
  navigator.geolocation.getCurrentPosition((pos) => {
    setTemp({ name: "My location", lat: pos.coords.latitude, lng: pos.coords.longitude }, true);
  }, () => toast("Location is turned off — search or tap the map instead"), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
}

// ---------------------------------------------------------------- search (places + incidents)
const GAZ = [
  ["McAllen", 26.2034, -98.2300], ["Edinburg", 26.3017, -98.1633], ["Pharr", 26.1948, -98.1836], ["Mission", 26.2159, -98.3253],
  ["Weslaco", 26.1595, -97.9908], ["Harlingen", 26.1906, -97.6961], ["Brownsville", 25.9017, -97.4975], ["San Juan", 26.1892, -98.1553],
  ["Alamo", 26.1837, -98.1231], ["Donna", 26.1704, -98.0519], ["Mercedes", 26.1498, -97.9136], ["Elsa", 26.2934, -97.9930],
  ["Edcouch", 26.2940, -97.9606], ["Palmview", 26.2334, -98.3708], ["Alton", 26.2871, -98.3114], ["La Joya", 26.2470, -98.4814],
  ["Hidalgo", 26.1003, -98.2631], ["San Benito", 26.1326, -97.6311], ["Raymondville", 26.4815, -97.7831], ["Rio Hondo", 26.2348, -97.5819],
  ["Los Fresnos", 26.0717, -97.4764], ["Port Isabel", 26.0731, -97.2086], ["South Padre Island", 26.1118, -97.1681], ["Sullivan City", 26.2776, -98.5636],
  ["UTRGV Edinburg", 26.3060, -98.1740], ["McAllen Intl Airport", 26.1758, -98.2386], ["La Plaza Mall", 26.2236, -98.2365], ["DHR Health", 26.2617, -98.1872],
];
let searchT = 0, searchSeq = 0;
async function runSearch(q) {
  const box = $("#results"), seq = ++searchSeq;
  if (q.length < 2) { box.hidden = true; return; }
  const ql = q.toLowerCase();
  const places = GAZ.filter((g) => g[0].toLowerCase().includes(ql)).slice(0, 4).map((g) => ({ name: g[0], lat: g[1], lng: g[2], sub: "Town or landmark" }));
  const incs = S.items.filter((it) => `${it.title} ${it.location} ${it.city} ${it.type}`.toLowerCase().includes(ql)).slice(0, 4);
  const draw = (extra = [], srv = []) => {
    if (seq !== searchSeq) return;
    const P = places.concat(extra), I = incs.concat(srv.filter((x) => !incs.some((y) => y.id === x.id))).slice(0, 6);
    box.innerHTML = (P.length ? `<h4>Places</h4>${P.map((p, i) => `<button type="button" data-pi="${i}">${svg(ICO.pin)}<span>${esc(p.name)}<small>${esc(p.sub || "")}</small></span></button>`).join("")}` : "") +
      (I.length ? `<h4>Incidents</h4>${I.map((it) => `<button type="button" data-inc="${it.id}">${kico(it.kind)}<span>${esc(it.title)}<small>${esc([it.location, it.city].filter(Boolean).join(", "))} · ${esc(ago(it.last_at))}</small></span></button>`).join("")}` : "") ||
      `<div class="empty">No matches for “${esc(q)}”. Try a street name with a town, like “10th St McAllen”.</div>`;
    box.hidden = false;
    $$("[data-pi]", box).forEach((b) => b.addEventListener("click", () => { const p = P[+b.dataset.pi]; box.hidden = true; $("#q").value = ""; setTemp({ name: p.name.split(",")[0], lat: p.lat, lng: p.lng }, false); }));
  };
  draw();
  const geo = q.length >= 3 ? fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4&bounded=1&viewbox=${BOX.bbox_west},${BOX.bbox_north},${BOX.bbox_east},${BOX.bbox_south}&q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } })
    .then((r) => r.json()).then((rs) => rs.map((r) => ({ name: r.display_name.split(",").slice(0, 2).join(","), lat: +r.lat, lng: +r.lon, sub: r.display_name.split(",").slice(2, 4).join(",").trim() }))).catch(() => []) : Promise.resolve([]);
  const srv = api("/api/live/incidents", { window: "7d", q }).then((d) => d.items || []).catch(() => []);
  const [g, s] = await Promise.all([geo, srv]);
  draw(g, s);
}

// ---------------------------------------------------------------- story
async function openStory(id) {
  S.sel = id;
  const v = $("#story-view");
  $("#home-view").hidden = true; v.hidden = false;
  v.innerHTML = `<div class="story"><button type="button" class="back" data-act="back">${svg(ICO.back)} Back to ${esc(placeName(place()))}</button><p class="none">Loading the story…</p></div>`;
  scrollPanelTop();
  let d;
  try { d = await api(`/api/live/incidents/${id}`); } catch (e) { v.innerHTML = `<div class="story"><button type="button" class="back" data-act="back">${svg(ICO.back)} Back</button><p class="none">This incident couldn't be loaded. It may have been merged into another one.</p></div>`; return; }
  if (S.sel !== id) return;
  S.story = d;
  const p = place();
  decorate(d, p);
  const k = KIND_ICON[d.kind] ? d.kind : "other";
  const tl = (d.timeline || []).slice().sort((a, b) => a.at - b.at);
  const codes = new Map(); tl.forEach((c) => (c.codes || []).forEach((x) => codes.set(x.code, x.meaning)));
  const ul = d.units_list || [];
  v.innerHTML = `<article class="story">
    <button type="button" class="back" data-act="back">${svg(ICO.back)} Back to ${esc(placeName(p))}</button>
    <div class="story-h">${kico(k)}<h2>${esc(d.title)}</h2></div>
    <div class="where">${p && d.dist != null && d.rough ? `<span class="relpos">${svg(ICO.pin)}Somewhere in ${esc(d.city || "town")} — exact spot not given</span>` : p && d.dist != null ? `<span class="relpos">${svg(ICO.pin)}${d.dist < 0.15 ? `Right at ${esc(p.name)}` : `${fmtMi(d.dist)} ${DIR_WORD[d.dir]} of ${esc(p.name)}`}</span>` : ""}
      <span>${esc([d.location, d.city].filter(Boolean).join(", ") || "Location not given")}</span></div>
    <div class="ni-s"><span class="st s-${esc(d.status)}"><i></i>${esc(STATUS[d.status] || d.status)}</span><span>First heard ${fmtTime(d.first_at)} · latest ${esc(ago(d.last_at))}</span><span>${d.calls} radio call${d.calls === 1 ? "" : "s"}</span></div>
    ${d.summary ? `<p class="summary">${richText(d.summary)}</p>` : `<p class="summary" style="color:var(--ink-2)">No summary yet — the story so far is in the radio calls below.</p>`}
    ${d.sensitive ? `<p class="sens">This call involves a sensitive situation. Some details are held back out of respect for the people involved.</p>` : ""}
    ${ul.length ? `<h3>Who's responding</h3><div class="ulist">${ul.map((u) => `<div class="urow"><span>${svg(ICO[u.service] || ICO.police)} <b>${esc(u.callsign)}</b> ${u.role ? `<small>${esc(u.role)}</small>` : ""}</span><small>${esc(UNIT_STATUS[u.status] || u.status)}${u.since ? ` since ${fmtTime(u.since)}` : ""}</small></div>`).join("")}</div>` : ""}
    <h3>What was said, in order</h3>
    <ol class="tl">${tl.map((c) => `<li class="tli"><time>${fmtTime(c.at)}</time><span class="pip"></span><div>
      <div class="line">${richText(c.line || callText(c), c.codes)}</div>
      <div class="meta">${playBtn(c.audio)}<span>${esc(c.channel || "")}</span>${c.dur ? `<span>${Math.round(c.dur)} s</span>` : ""}<button type="button" class="lk" data-report-call="${c.id}" style="border:0;background:none;color:var(--ink-3);padding:0;font-size:12px">Report</button></div>
      ${(c.speakers || []).length ? `<details class="words"><summary>Hear it in their words ›</summary>${c.speakers.map((s) => `<div class="sp"><b>${esc(s.who || "Speaker")}</b>${richText(s.text, c.codes)}</div>`).join("")}
        ${(c.codes || []).length ? `<div class="codes">${c.codes.map((x) => `<span><b>${esc(x.code)}</b>${esc(x.meaning)}</span>`).join("")}</div>` : ""}</details>` : ""}
    </div></li>`).join("")}</ol>
    ${codes.size ? `<h3>Radio codes in this story</h3><div class="codes">${[...codes].map(([c, m]) => `<span><b>${esc(c)}</b>${esc(m)}</span>`).join("")}</div>` : ""}
    ${(d.people || []).length || (d.vehicles || []).length ? `<h3>People and vehicles mentioned</h3><div class="pv">${(d.people || []).map((x) => `<div><b>${esc(x.role || "Person")}</b>${richText(x.desc || "")}</div>`).join("")}${(d.vehicles || []).map((x) => `<div><b>Vehicle</b>${richText(typeof x === "string" ? x : [x.color, x.make, x.model, x.desc].filter(Boolean).join(" "))}</div>`).join("")}</div>` : ""}
    ${(d.cameras || []).length ? `<h3>Traffic cameras nearby</h3><div class="cams">${d.cameras.slice(0, 4).map((c) => `<figure class="cam"><img loading="lazy" src="${esc(c.img)}" alt="Traffic camera ${esc(c.name)}"><figcaption>${esc(c.distance_mi)} mi ${esc((c.dir || "").toLowerCase())} · ${esc(c.road && c.road !== "nowhere" ? c.road : c.name)}</figcaption></figure>`).join("")}</div>` : ""}
    ${(d.related_news || []).length ? `<h3>In the news</h3><div class="news">${d.related_news.map((n) => `<a href="${esc(n.url)}">${esc(n.title)}</a>`).join("")}</div>` : ""}
    <div class="actions"><a class="btn" href="/live/${esc(REGION)}">Open on the full map</a><button type="button" class="btn" data-report-inc="${d.id}">${svg(ICO.flag)} Report a problem</button></div>
  </article>`;
  // map: frame place + incident, bearing line, cameras, unit trails
  storyLayer.clearLayers();
  if (d.lat != null) {
    if (p) L.polyline([[p.lat, p.lng], [d.lat, d.lng]], { color: css("--home"), weight: 2, dashArray: "1 7", lineCap: "round", interactive: false }).addTo(storyLayer);
    for (const c of d.cameras || []) if (c.lat) L.marker([c.lat, c.lng], { icon: L.divIcon({ className: "", iconSize: [22, 22], html: `<div class="camk">${svg(ICO.cam)}</div>` }) })
      .bindPopup(`<img src="${esc(c.img)}" style="width:220px;border-radius:8px" alt=""><br>${esc(c.name)}`).addTo(storyLayer);
    for (const t of d.trails || []) {
      const [a, b] = t.points || [];
      if (a && b) L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: css("--ink-2"), weight: 2, dashArray: "4 6", opacity: 0.8 }).addTo(storyLayer);
    }
    const pts = [[d.lat, d.lng]]; if (p && d.dist < 6) pts.push([p.lat, p.lng]);
    map.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 16, animate: true });
  }
  drawIncidents(nearItems());
}
function closeStory(silent) {
  if (!S.sel && $("#story-view").hidden) return;
  S.sel = null; S.story = null; storyLayer.clearLayers();
  $("#story-view").hidden = true; $("#home-view").hidden = false;
  if (!silent) { render(); fitPlace(); }
}
function scrollPanelTop() {
  const panel = $("#panel");
  if (window.matchMedia("(min-width: 900px)").matches) panel.scrollTop = 0;
  else window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------- weather, report, modal
async function loadWeather() {
  try {
    const d = await api("/api/live/weather"); S.wx = d;
    if (d.now) { const b = $("#wx"); b.hidden = false; b.innerHTML = `${esc(d.now.temp)}° <small>${esc(d.now.text || "")}</small>`; }
    const a = d.alerts || [];
    $("#alerts").hidden = !a.length;
    $("#alerts").innerHTML = a.slice(0, 2).map((x) => `⚠ ${esc(x.event || x.headline)}${x.ends ? ` until ${fmtTime(x.ends)}` : ""}`).join(" · ");
  } catch (e) {}
}
function weatherModal() {
  const d = S.wx; if (!d) return;
  modal(`<h2>${esc(d.now?.temp)}° and ${esc((d.now?.text || "").toLowerCase())}</h2>
    <p>Feels like ${esc(d.now?.feels)}° · humidity ${esc(d.now?.humidity)}% · wind ${esc(d.now?.wind_dir || "")} ${esc(d.now?.wind_mph)} mph</p>
    ${(d.alerts || []).map((a) => `<p style="color:var(--alert);font-weight:600">⚠ ${esc(a.event || a.headline)}</p>`).join("")}
    <div class="ulist">${(d.forecast || []).map((f) => `<div class="urow"><span><b>${esc(f.name)}</b> ${esc(f.short)}</span><small>${esc(f.temp)}°${f.pop ? ` · ${f.pop}% rain` : ""}</small></div>`).join("")}</div>
    <div class="mfoot" style="margin-top:12px">${d.forecast_url ? `<a class="btn" href="${esc(d.forecast_url)}" target="_blank" rel="noopener">Full forecast</a>` : ""}<button class="btn" type="button" data-act="close">Close</button></div>`);
}
function report(callId, incId) {
  modal(`<h2>Report a problem</h2><p>Reports help us fix bad transcripts, wrong locations and anything that shouldn't be public.</p>
    <form id="rf"><select name="reason" required><option value="">What's wrong?</option><option>Wrong location</option><option>Transcript is wrong</option>
    <option>Wrong incident / grouping</option><option>Private information showing</option><option>Wrong unit or status</option><option>Something else</option></select>
    <textarea name="note" rows="3" placeholder="Anything else? (optional)"></textarea>
    <div class="mfoot"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Send report</button></div></form>`);
  $("#rf").addEventListener("submit", async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try { await post("/api/live/report", { call_id: callId || null, incident_id: incId || null, reason: fd.get("reason"), note: fd.get("note") }); closeModal(); toast("Report sent — thank you"); }
    catch (err) { toast("The report didn't send. Check your connection and try again."); }
  });
}
function modal(html) { $("#modal-card").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; }

// ---------------------------------------------------------------- audio
const audio = new Audio(); let playingBtn = null;
audio.addEventListener("ended", () => { if (playingBtn) { playingBtn.classList.remove("on"); playingBtn.innerHTML = svg(ICO.play); } playingBtn = null; });
function toggleAudio(btn) {
  if (playingBtn === btn && !audio.paused) { audio.pause(); btn.classList.remove("on"); btn.innerHTML = svg(ICO.play); playingBtn = null; return; }
  if (playingBtn) { playingBtn.classList.remove("on"); playingBtn.innerHTML = svg(ICO.play); }
  audio.src = btn.dataset.audio; audio.play().catch(() => toast("That recording isn't available"));
  btn.classList.add("on"); btn.innerHTML = svg(ICO.pause); playingBtn = btn;
}

// ---------------------------------------------------------------- controls
function renderControls() {
  $("#radius").innerHTML = [[0.5, "½ mi"], [1, "1 mi"], [3, "3 mi"]].map(([r, l]) =>
    `<button type="button" role="radio" aria-checked="${S.radius === r}" data-radius="${r}">${l}</button>`).join("") +
    `<button type="button" role="radio" aria-checked="${!S.radius}" data-radius="0">All</button>`;
  $("#when").innerHTML = Object.entries(WHEN).map(([k, w]) => `<button type="button" role="radio" aria-checked="${S.when === k}" data-when="${k}">${w.label}</button>`).join("");
  $("#kinds").innerHTML = KINDS.map((k) => `<button type="button" class="kchip" aria-pressed="${S.kinds.has(k)}" data-kind="${k}">${kico(k)}${KIND_LABEL[k]}</button>`).join("") +
    Object.entries(SVC).map(([s, l]) => `<button type="button" class="kchip svc" aria-pressed="${!S.svc || S.svc === s}" data-svc="${s}">${l} only</button>`).join("");
}
function render() {
  const list = nearItems();
  const otw = onTheWay(S.radius ? list : list.filter(isLive));
  renderPlaces(list); renderControls(); renderVerdict(list, otw); renderOtw(otw); renderList(list);
  renderAir(); renderRadio(); renderUnits();
  if (!S.hist || S.hist.key !== histKey()) renderHist();
  drawIncidents(S.radius ? list.concat(S.items.filter((it) => isLive(it) && !list.includes(it) && inScope(it))) : list);
  renderFoot();
}
function renderFoot() {
  $("#foot").innerHTML = `<div>Heard on public-safety radio by JAFO's own receivers, transcribed and summarized by AI. Locations are approximate (block level); it can be wrong — if something's off, tell us.</div>
    <div class="links"><a href="/live/${esc(REGION)}">Full city map</a><a href="/live/${esc(REGION)}#replay">Replay &amp; highlights</a><button type="button" data-act="report">Report a problem</button>${DEMO ? `<a href="?">Live data</a>` : `<a href="?demo=1">Demo</a>`}</div>`;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a, [data-inc]"); if (!t) {
    if (!e.target.closest("#find")) $("#results").hidden = true;
    if (!e.target.closest("#menu, #menu-btn")) $("#menu").hidden = true;
    return;
  }
  if (!t.closest("#find")) $("#results").hidden = true;
  if (!t.closest("#menu") && t.id !== "menu-btn") $("#menu").hidden = true;
  const d = t.dataset;
  if (d.audio) { toggleAudio(t); return; }
  if (d.reportCall) { report(+d.reportCall, S.sel); return; }
  if (d.reportInc) { report(null, +d.reportInc); return; }
  if (d.unit && !d.inc) { openUnit(+d.unit); return; }
  if (d.inc) { $("#results").hidden = true; closeModal(); openStory(+d.inc); return; }
  if (d.place) { selectPlace(d.place); return; }
  if (d.radius !== undefined) {
    const r = +d.radius;
    if (!r) { selectPlace("all"); return; }
    S.radius = r; S.everywhere = false; store.set("radius", r); showAll = false; S.hist = null; render(); drawRings(true); loadHist(); return;
  }
  if (d.when) { S.when = d.when; store.set("when", d.when); showAll = false; loadIncidents(); return; }
  if (d.kind) { if (S.kinds.has(d.kind) && S.kinds.size === KINDS.length) S.kinds = new Set([d.kind]); else if (S.kinds.has(d.kind)) { S.kinds.delete(d.kind); if (!S.kinds.size) S.kinds = new Set(KINDS); } else S.kinds.add(d.kind); render(); return; }
  if (d.svc) { S.svc = S.svc === d.svc ? null : d.svc; render(); return; }
  if (d.r) { S.radioScope = d.r; renderRadio(); return; }
  switch (d.act) {
    case "back": closeStory(); break;
    case "show-all": showAll = true; renderList(nearItems()); break;
    case "widen": S.radius = 3; store.set("radius", 3); S.hist = null; render(); drawRings(true); loadHist(); break;
    case "add-place": managePlaces(); break;
    case "save-temp": savePrompt(); break;
    case "do-save": doSave(); break;
    case "locate": locate(); break;
    case "pick": closeModal(); PICK.set(true); if (!window.matchMedia("(min-width: 900px)").matches) window.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "cancel-pick": PICK.set(false); break;
    case "focus-search": closeModal(); $("#q").focus(); break;
    case "recenter": if (S.sel && S.story) closeStory(); else if (place()) fitPlace(); else fitRegion(); break;
    case "close": closeModal(); break;
    case "report": report(null, S.sel); break;
    case "goto-otw": $("#otw-block").scrollIntoView({ behavior: "smooth", block: "start" }); break;
    case "goto-air": $("#air-block").scrollIntoView({ behavior: "smooth", block: "start" }); break;
  }
});
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("#modal").hidden) closeModal(); else if (S.sel) closeStory(); else PICK.set(false); } });
$("#menu-btn").addEventListener("click", () => { $("#menu").hidden = !$("#menu").hidden; });
$("#wx").addEventListener("click", weatherModal);
$("#theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark"; store.set("theme", document.documentElement.dataset.theme);
  render(); drawRings(false); drawAir();
});
$("#q").addEventListener("input", (e) => { clearTimeout(searchT); const q = e.target.value.trim(); searchT = setTimeout(() => runSearch(q), 220); });
$("#find").addEventListener("submit", (e) => { e.preventDefault(); const b = $("#results button"); if (b) b.click(); });

// ---------------------------------------------------------------- loaders
async function loadIncidents(quiet) {
  const w = WHEN[S.when];
  const win = DEMO && S.when !== "week" ? "24h" : w.win;
  try {
    const [d, act] = await Promise.all([api("/api/live/incidents", { window: win }),
      win === "active" ? Promise.resolve(null) : api("/api/live/incidents", { window: DEMO ? "24h" : "active" }).catch(() => null)]);
    const seen = new Set(), items = [];
    for (const it of (d.items || []).concat(act?.items || [])) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    S.items = items; S.byId = new Map(items.map((it) => [it.id, it]));
  } catch (e) { toast("Can't reach JAFO right now — retrying"); }
  if (!quiet) render();
}
async function loadUnits() { try { S.units = (await api("/api/live/units", { scope: "out" })).items || []; } catch (e) {} }
async function loadAir() {
  try { S.air = await api("/api/live/air", DEMO ? { demo: 1 } : {}); } catch (e) { S.air = S.air || { aircraft: [], counts: {}, acars: {} }; }
  drawAir(); renderAir();
  if ($("#story-view").hidden) { const list = nearItems(); renderVerdict(list, onTheWay(S.radius ? list : list.filter(isLive))); }
}
async function loadPulse() {
  try { const p = await api("/api/live/pulse"); S.today = p.today?.since; if (p.last_call?.start_time) S.lastCall = p.last_call.start_time; } catch (e) {}
}

(async function boot() {
  if (!S.places.find((p) => p.id === S.placeId)) S.placeId = S.places[0]?.id;
  if (S.radius === 0) { S.everywhere = true; S.prevRadius = 1; }
  drawRings(true); render();
  loadWeather();
  await Promise.all([loadPulse(), loadUnits(), loadIncidents(true)]);
  S.loaded = true; render();
  loadAir(); loadRadio(); loadHist();
  $("#radio-more").addEventListener("click", () => loadRadio(true));
  setInterval(() => { if (!document.hidden) loadUnits().then(loadIncidents); }, 20000);
  setInterval(() => { if (!document.hidden) loadAir(); }, DEMO ? 5000 : 10000);
  setInterval(() => { if (!document.hidden) loadRadio(); }, 15000);
  setInterval(() => { if (!document.hidden) { loadPulse(); loadHist(); } }, 300000);
  setInterval(loadWeather, 600000);
})();
})();
