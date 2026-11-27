// jafo /live — incidents, units and radio on one map.
// Vanilla JS + Leaflet. Talks to /api/live/* (pi/web/live.py).
(() => {
"use strict";
const CFG = window.JAFO_LIVE || {};
const OWNER = !!CFG.owner || !!CFG.audio;   // OWNER here = "this viewer can play audio"
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("jafo.live." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("jafo.live." + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------------------------------------------------------------- icons
const KIND_ICON = {
  violence: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  traffic: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3.5 16h17M7 19v-3M17 19v-3M7.5 12.5h.01M16.5 12.5h.01"/>',
  medical: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11.5h2l1-2 1.5 4 1-2h1"/>',
  property: '<path d="M4 11 12 4l8 7v9H4v-9z"/><path d="M10 20v-5h4v5"/>',
  suspicious: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
  other: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
};
const KIND_LABEL = {
  violence: "Violence and danger", traffic: "Traffic", medical: "Medical and welfare",
  property: "Property and alarms", suspicious: "Suspicious and disputes", fire: "Fire", other: "Other calls",
};
const KINDS = Object.keys(KIND_LABEL);
// Who is responding: icons for police / fire / EMS and specialised resources.
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
  const over = (AIR.data?.aircraft || []).filter((a) => a.near_incident?.id === it.id);
  if (over.length && !list.some((r) => r.key === "air")) list.push({ key: "air", label: over[0].kind === "helicopter" ? "Helicopter overhead" : "Aircraft overhead", n: over.length, live: true });
  return list;
}
function respStrip(it, max = 5) {
  const list = responders(it);
  if (!list.length) return "";
  const shown = list.slice(0, max);
  return `<span class="resp">${shown.map((r) => `<i class="r-${r.key}${r.live ? " live" : ""}" title="${esc(r.label)}${r.n > 1 ? " ×" + r.n : ""}">${respSvg(r.key)}${r.n > 1 ? `<b>${r.n}</b>` : ""}</i>`).join("")}${list.length > max ? `<i class="more">+${list.length - max}</i>` : ""}</span>`;
}
function respChips(it) {
  const list = responders(it);
  if (!list.length) return "";
  return `<div class="resp-chips"><span class="rc-l">Responding</span>${list.map((r) => `<span class="rc r-${r.key}${r.live ? " live" : ""}">${respSvg(r.key)}${esc(r.label)}${r.n > 1 ? ` <b>×${r.n}</b>` : ""}</span>`).join("")}</div>`;
}
const kindSvg = (k) => `<svg viewBox="0 0 24 24">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
const kico = (k) => `<span class="kico k-${esc(k || "other")}">${kindSvg(k)}</span>`;
const ICO = {
  back: '<svg viewBox="0 0 24 24" class="ico"><path d="M15 5l-7 7 7 7"/></svg>',
  play: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" class="ico" style="width:15px;height:15px"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" class="ico" style="width:13px;height:13px"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" class="ico" style="width:13px;height:13px"><path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/></svg>',
  cross: '<svg viewBox="0 0 24 24" class="ico" style="width:13px;height:13px"><path d="M12 5v14M5 12h14"/></svg>',
  truck: '<svg viewBox="0 0 24 24" class="ico"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
};
const STATUS_LABEL = {
  new: "New", en_route: "Units on the way", on_scene: "Units on scene", cleared: "Cleared", quiet: "Quiet", ended: "Ended",
  dispatched: "Dispatched", transporting: "Transporting", busy: "Busy", available: "Available", unknown: "Heard",
};
const UNIT_STATUS = { dispatched: "Dispatched", en_route: "On the way", on_scene: "On scene", transporting: "Transporting",
  busy: "Busy", available: "Available", unknown: "Heard" };

// ---------------------------------------------------------------- time
const TZ = CFG.tz || undefined;   // region's timezone, so remote viewers see local radio time
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: TZ }).toLowerCase().replace(" ", "\u202f") : "";
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
const dayKey = (ts) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: TZ });
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} sec`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${h} hr ${mm} min` : `${h} hr`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? "s" : ""}`;
}
const now = () => Math.floor(Date.now() / 1000);
const ago = (ts) => fmtDur(now() - ts);

// ---------------------------------------------------------------- api
async function api(path, params = {}, opts = {}) {
  const u = new URL(path, location.origin);
  if (!("region" in params)) params.region = CFG.region;
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  const r = await fetch(u, opts);
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
  config: null,
  incidents: [], kinds: {}, endedToday: 0,
  units: [], unitsScope: "out",
  radio: [], radioNewest: 0, radioOldest: 0, channels: [], hiddenChannels: new Set(store.get("hiddenChannels", [])),
  hideChatter: store.get("hideChatter", false),
  filters: Object.assign({ window: "active", service: "", kinds: [], sort: "latest", radius: 0 }, store.get("filters", {})),
  myLoc: null, q: "",
  tab: "incidents", detail: null,     // {type:'incident'|'unit'|'filters', id}
  words: store.get("words", false),
  follow: false, listening: false,
  replay: null,                        // {day, start, end, bins, calls, t, playing, speed}
  played: new Set(), audio: new Audio(), queue: [], current: null,
};
S.audio.preload = "auto";

// ---------------------------------------------------------------- map
let map, baseLayer, satLayer, incLayer, unitLayer, trailLayer, heatLayer, radarLayer, warnLayer, trafficLayer, meMarker;
const markers = new Map();

function initMap(cfg) {
  const r = cfg.region || {};
  map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: false, worldCopyJump: false });
  if (r.bbox_north != null) map.fitBounds([[r.bbox_south, r.bbox_west], [r.bbox_north, r.bbox_east]], isMobile() ? { paddingBottomRight: [0, innerHeight * 0.45] } : { paddingTopLeft: [400, 0] });
  else map.setView([r.default_lat || 30, r.default_lng || -97.7], r.default_zoom || 11);
  baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, subdomains: "abc", className: "basemap-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery &copy; Esri" });
  map.createPane("trails"); map.getPane("trails").style.zIndex = 450;
  map.createPane("units"); map.getPane("units").style.zIndex = 620;
  map.createPane("incs"); map.getPane("incs").style.zIndex = 640;
  trailLayer = L.layerGroup().addTo(map);
  unitLayer = L.layerGroup().addTo(map);
  incLayer = L.layerGroup().addTo(map);
  warnLayer = L.layerGroup().addTo(map);
  map.on("zoomend", () => { renderMapIncidents(); renderAirMap(); });
  map.on("click", () => { if (isMobile()) setSheet("short"); });
  $("#btn-zin").onclick = () => map.zoomIn();
  $("#btn-zout").onclick = () => map.zoomOut();
  $("#btn-locate").onclick = locateMe;
  $("#btn-follow").onclick = () => {
    S.follow = !S.follow; $("#btn-follow").setAttribute("aria-pressed", S.follow);
    toast(S.follow ? "Following live — the map pans to each call as it airs" : "Stopped following");
  };
}
const isMobile = () => matchMedia("(max-width: 760px)").matches;
// Fly so the target sits in the middle of the map area the card/sheet leaves visible.
function flyToVisible(latlng, zoom) {
  zoom = zoom ?? map.getZoom();
  let dx = 0, dy = 0;
  if (isMobile()) { const card = $("#card").getBoundingClientRect(); dy = (innerHeight - card.top) / 2; }
  else dx = -($("#card").getBoundingClientRect().right) / 2;
  const p = map.project(latlng, zoom).add([dx, dy]);
  map.flyTo(map.unproject(p, zoom), zoom, { duration: 0.6 });
}
function fitVisible(bounds, maxZoom = 15) {
  const card = $("#card").getBoundingClientRect();
  const opts = isMobile() ? { paddingTopLeft: [30, 80], paddingBottomRight: [30, innerHeight - card.top + 30] }
    : { paddingTopLeft: [card.right + 30, 60], paddingBottomRight: [80, 100] };
  map.flyToBounds(bounds, { ...opts, maxZoom, duration: 0.6 });
}

function pinSize(it) { return Math.round(22 + Math.min(12, (it.calls || 1) * 1.2)); }
function pinHtml(it, selected) {
  const st = it.status || "new";
  const hot = it.last_at && now() - it.last_at < 120 && !S.replay;
  const cls = ["pin", `k-${it.kind || "other"}`, `s-${st}`, hot ? "hot" : "", selected ? "sel" : "",
    ["city", "street"].includes(it.precision) ? "rough" : ""].join(" ");
  const sz = pinSize(it);
  const label = map.getZoom() >= 14 && !["ended", "quiet"].includes(st) ? `<span class="pin-label">${esc(it.title)}</span>` : "";
  const uc = Object.values(it.units || {}).reduce((a, b) => a + b, 0);
  const cnt = uc > 1 ? `<span class="pin-count">${uc}</span>` : "";
  return { html: `<div class="pin-wrap" style="width:${sz}px;height:${sz}px"><div class="${cls}" style="width:${sz}px;height:${sz}px">${kindSvg(it.kind)}</div>${cnt}${label}</div>`, sz };
}
function renderMapIncidents() {
  if (!map) return;
  const list = visibleIncidents();
  const seen = new Set();
  const selId = S.detail?.type === "incident" ? S.detail.id : null;
  for (const it of list) {
    if (it.lat == null) continue;
    seen.add(it.id);
    const { html, sz } = pinHtml(it, it.id === selId);
    const icon = L.divIcon({ className: "", html, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
    let m = markers.get(it.id);
    if (!m) {
      m = L.marker([it.lat, it.lng], { icon, pane: "incs", riseOnHover: true, keyboard: true, title: it.title });
      m.on("click", () => openIncident(it.id));
      m.addTo(incLayer); markers.set(it.id, m);
    } else { m.setLatLng([it.lat, it.lng]); m.setIcon(icon); }
    m.setZIndexOffset(it.id === selId ? 1000 : (it.status === "ended" || it.status === "quiet" ? -500 : 0));
  }
  // keep the selected incident on the map even if filtered out
  for (const [id, m] of markers) if (!seen.has(id) && id !== selId) { incLayer.removeLayer(m); markers.delete(id); }
}

function unitBadgeHtml(u, extra = "") {
  const dot = u.service === "fire" ? '<span class="fd"></span>' : u.service === "ems" ? '<span class="md"></span>' : "";
  return `<span class="ubadge st-${esc(u.status)} ${extra}">${dot}${esc(u.callsign)}</span>`;
}
function renderMapUnits() {
  unitLayer.clearLayers();
  if (!$('[data-layer="units"]').checked || S.replay) return;
  const byInc = new Map();
  for (const u of S.units) if (u.lat != null && u.incident_id) {
    if (!byInc.has(u.incident_id)) byInc.set(u.incident_id, []);
    byInc.get(u.incident_id).push(u);
  }
  for (const [iid, us] of byInc) {
    const it = S.incidents.find((x) => x.id === iid);
    const off = it ? pinSize(it) / 2 + 6 : 16;
    us.slice(0, 6).forEach((u, i) => {
      const icon = L.divIcon({ className: "", html: unitBadgeHtml(u), iconSize: null, iconAnchor: [-off + 2, 9 - i * 21 - (us.length > 1 ? -((us.length - 1) * 10.5) : 0)] });
      const m = L.marker([u.lat, u.lng], { icon, pane: "units", keyboard: false });
      m.on("click", () => openUnit(u.id));
      m.addTo(unitLayer);
    });
  }
}

// ---------------------------------------------------------------- filters
function visibleIncidents() {
  let list = S.incidents.slice();
  const f = S.filters;
  if (f.kinds.length) list = list.filter((it) => f.kinds.includes(it.kind));
  if (f.sort === "newest") list.sort((a, b) => b.first_at - a.first_at);
  else list.sort((a, b) => b.last_at - a.last_at);
  return list;
}
function filtersActive() {
  const f = S.filters;
  return f.window !== "active" || f.service || f.kinds.length || f.radius || f.sort !== "latest";
}

// ---------------------------------------------------------------- data loads
async function loadIncidents() {
  if (S.replay) return;
  const f = S.filters;
  const p = { window: f.window, service: f.service, q: S.q };
  if (f.radius && S.myLoc) { p.near = `${S.myLoc[0]},${S.myLoc[1]}`; p.radius = f.radius; if (f.window === "active") p.window = "24h"; }
  try {
    const d = await api("/api/live/incidents", p);
    S.incidents = d.items; S.kinds = d.kinds || {}; S.endedToday = d.ended_today || 0;
  } catch (e) { console.warn(e); return; }
  $("#n-incidents").textContent = S.incidents.filter((i) => !i.closed).length || "";
  $("#filters-dot").hidden = !filtersActive();
  renderMapIncidents(); renderMapUnits();
  if (S.tab === "incidents" && !S.detail) renderIncidentList();
  if (S.detail?.type === "filters") renderFilters();
}
async function loadUnits() {
  try { const d = await api("/api/live/units", { scope: S.unitsScope }); S.units = d.items; } catch (e) { return; }
  const out = S.units.filter((u) => ["dispatched", "en_route", "on_scene", "transporting", "busy"].includes(u.status));
  $("#n-units").textContent = (S.unitsScope === "out" ? S.units.length : out.length) || "";
  renderMapUnits();
  if (S.tab === "units" && !S.detail) renderUnitList();
}
async function loadRadio(initial = false) {
  try {
    const p = initial || !S.radioNewest ? { limit: 60 } : { since: S.radioNewest, limit: 100 };
    const d = await api("/api/live/radio", p);
    S.channels = d.channels || S.channels;
    const fresh = d.items.filter((c) => !S.radio.some((x) => x.id === c.id));
    if (!fresh.length) { refreshPlayerAgo(); return; }
    if (initial || !S.radioNewest) {
      S.radio = d.items; fresh.forEach((c) => S.played.add(c.id));
    } else S.radio = fresh.concat(S.radio).slice(0, 400);
    S.radioNewest = Math.max(S.radioNewest, ...d.items.map((c) => c.at));
    S.radioOldest = Math.min(...S.radio.map((c) => c.at));
    if (!initial) onNewCalls(fresh.slice().reverse());
    else if (S.radio[0]) setNowPlaying(S.radio[0], false);
    if (S.tab === "radio" && !S.detail) renderRadio();
  } catch (e) { console.warn(e); }
}

// ---------------------------------------------------------------- views
function showView(name) {
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
}
function setTab(tab) {
  S.tab = tab; S.detail = null;
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  showView(tab);
  clearSelection();
  if (tab === "incidents") renderIncidentList();
  if (tab === "units") { renderUnitList(); loadUnits(); }
  if (tab === "radio") renderRadio();
  if (tab === "air") { renderAir(); loadAir(); }
  if (tab !== "air") AIR.sel = null;
  setHash(tab === "incidents" ? "" : tab);
}
function setHash(h) { const want = h ? "#" + h : " "; if (location.hash !== (h ? "#" + h : "")) history.replaceState(null, "", h ? "#" + h : location.pathname); }

function incRow(it) {
  const units = respStrip(it);
  const faded = ["ended", "quiet"].includes(it.status) ? " faded" : "";
  const dist = it.distance_mi != null ? ` · ${it.distance_mi} mi` : "";
  return `<div class="row${faded}" data-inc="${it.id}" tabindex="0">
    ${kico(it.kind)}
    <div class="main"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.location || it.city || "Location not given")}${dist}</div></div>
    <div class="meta"><div>${S.filters.window === "active" && !S.replay ? ago(it.first_at) : fmtTime(it.last_at)}</div><div class="u">${units}</div></div>
  </div>`;
}
function renderIncidentList() {
  const v = $('[data-view="incidents"]');
  const list = visibleIncidents();
  const f = S.filters;
  const wlabel = { active: "Now", "1h": "Last hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days" }[f.window] || "Now";
  const head = S.replay ? `Incidents at ${fmtTime(S.replay.t)}` : (S.q ? `Results for “${esc(S.q)}”` : (f.radius ? `Near you (${f.radius} mi)` : wlabel));
  let html = `<div class="sec-h">${head}${filtersActive() ? `<small><a href="#" data-act="clear-filters">Clear filters</a></small>` : ""}</div>`;
  if (!list.length) html += `<div class="empty">${S.replay ? "Nothing was happening at this moment." : S.q ? "Nothing matches that search." : f.window === "active" ? "Nothing active right now. It's quiet out there." : "No incidents in this window."}</div>`;
  else html += list.map(incRow).join("");
  if (f.window === "active" && !S.replay && !S.q && S.endedToday)
    html += `<div class="ended-row"><span>↺ ${S.endedToday} ended today</span><button type="button" data-act="show-24h">Show all</button></div>`;
  v.innerHTML = html;
}
function renderUnitList() {
  const v = $('[data-view="units"]');
  const q = S.q.toLowerCase();
  const list = S.units.filter((u) => !q || u.callsign.toLowerCase().includes(q) || (u.incident_title || "").toLowerCase().includes(q));
  const groups = { police: "Police", fire: "Fire", ems: "EMS", other: "Other" };
  let html = `<div class="sec-h">${S.unitsScope === "out" ? "Units out" : "Heard today"}
    <div class="seg" style="width:200px"><button type="button" data-scope="out" class="${S.unitsScope === "out" ? "on" : ""}">Out</button><button type="button" data-scope="all" class="${S.unitsScope === "all" ? "on" : ""}">All on duty</button></div></div>`;
  if (!list.length) html += `<div class="empty">${S.unitsScope === "out" ? "No units out on calls right now." : "No units heard yet today."}</div>`;
  for (const [g, label] of Object.entries(groups)) {
    const us = list.filter((u) => (u.service || "other") === g);
    if (!us.length) continue;
    html += `<div class="sub-h">${label} · ${us.length}</div>`;
    html += us.map((u) => `<div class="row" data-unit="${u.id}" tabindex="0">
      ${unitBadgeHtml(u)}
      <div class="main"><div class="t" style="font-weight:500">${esc(u.incident_title || UNIT_STATUS[u.status] || "Heard")}</div>
      <div class="s">${esc(u.role || "")}${u.role && u.location ? " · " : ""}${esc(u.location || "")}</div></div>
      <div class="meta"><div><span class="statusdot st-${esc(u.status)}"></span>${esc(UNIT_STATUS[u.status] || "")}</div><div class="u">${u.since ? fmtDur(now() - u.since) : ""}</div></div>
    </div>`).join("");
  }
  v.innerHTML = html;
}

// ---- transcript rendering: redactions, codes, unit references, karaoke words
function richText(text, codes = [], opts = {}) {
  let h = esc(text);
  h = h.replace(/⟦[^⟧]*⟧/g, '<span class="redacted" title="Hidden for privacy">hidden</span>');
  for (const c of codes || []) {
    if (!c.code || c.code.length < 2) continue;
    const re = new RegExp(`(^|[^\\w-])(${esc(c.code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]?")})(?![\\w])`, "gi");
    h = h.replace(re, `$1<span class="code" title="${esc(c.code)}: ${esc(c.meaning)}">$2</span>`);
  }
  if (opts.units) for (const u of opts.units) {
    if (!u.callsign || u.callsign.length < 3) continue;
    const re = new RegExp(`(^|[^\\w>])(${esc(u.callsign).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w<])`, "g");
    h = h.replace(re, `$1<span class="unit-ref" data-unit="${u.id}">$2</span>`);
  }
  return h;
}
function callText(c) {
  if (c.line) return c.line;
  const t = (c.speakers || []).map((s) => s.text).join(" ").trim();
  return t ? `“${t}”` : "(no speech)";
}
function wordsHtml(call, units) {
  return `<div class="words">${(call.speakers || []).map((s) => `<div class="turn">${s.who ? `<span class="who">${esc(s.who)}</span>` : ""}<span class="tx">${richText(s.text, call.codes, { units })}</span></div>`).join("")}
    <div class="turn"><button type="button" class="flag" data-report="${call.id}" title="Report a problem with this call">${ICO.flag}</button></div></div>`;
}

// ---------------------------------------------------------------- incident detail
async function openIncident(id, { fly = true } = {}) {
  S.detail = { type: "incident", id, tab: S.detail?.type === "incident" && S.detail.id === id ? S.detail.tab : "timeline" };
  showView("detail");
  const v = $('[data-view="detail"]');
  if (!v.dataset.loadedFor || v.dataset.loadedFor !== `i${id}`) v.innerHTML = `<div class="empty">Loading…</div>`;
  setHash(`i/${id}`);
  if (isMobile()) setSheet("mid");
  let d;
  try { d = await api(`/api/live/incidents/${id}`, {}); } catch (e) { v.innerHTML = `<div class="empty">Couldn't load that incident.</div>`; return; }
  if (S.detail?.type !== "incident" || S.detail.id !== id) return;
  S.detail.data = d;
  v.dataset.loadedFor = `i${id}`;
  renderIncidentDetail();
  if (!S.incidents.some((x) => x.id === id) && d.lat != null) { S.incidents.push(d); }
  renderMapIncidents();
  drawIncidentOverlay(d);
  if (fly && d.lat != null) flyToVisible([d.lat, d.lng], Math.max(map.getZoom(), 15));
}
function renderIncidentDetail() {
  const d = S.detail.data, tab = S.detail.tab || "timeline";
  const v = $('[data-view="detail"]');
  const ucount = d.units_list.length;
  const canReplay = OWNER && d.timeline.some((c) => c.audio);
  let html = `<div class="dhead"><button type="button" class="back" data-act="back" title="Back">${ICO.back}</button>
    <div class="dtitle">${esc(d.title)}</div>
    ${canReplay ? `<button type="button" class="pillbtn" data-act="replay-incident">${ICO.play} Replay</button>` : ""}</div>
    <div class="dmeta">${kico(d.kind)}<div><div style="color:var(--text)">${esc(d.location || "Location not given")}${d.precision && ["city", "street"].includes(d.precision) ? " <small>(approximate)</small>" : ""}</div>
    <div>${fmtTime(d.first_at)}${d.last_at - d.first_at > 120 ? ` – ${fmtTime(d.last_at)}` : ""} · ${esc(STATUS_LABEL[d.status] || d.status)}${d.city ? " · " + esc(d.city) : ""}</div></div></div>`;
  html += respChips(d);
  if (d.summary) html += `<div class="dsum">${richText(d.summary)}</div>`;
  html += `<div id="overhead-slot"></div>`;
  html += `<div class="dtabs">
    <button type="button" data-dtab="timeline" class="${tab === "timeline" ? "on" : ""}">Timeline <span class="n">${d.timeline.length}</span></button>
    <button type="button" data-dtab="involved" class="${tab === "involved" ? "on" : ""}">Involved <span class="n">${ucount + d.people.length + d.vehicles.length}</span></button>
    <button type="button" data-dtab="nearby" class="${tab === "nearby" ? "on" : ""}">Nearby${d.cameras?.length ? ` <span class="n">${d.cameras.length}</span>` : ""}</button>
    <span class="spacer"></span>
    ${tab === "timeline" ? `<button type="button" class="words-tog ${S.words ? "on" : ""}" data-act="words">${S.words ? "✓ " : ""}Words</button>` : ""}</div>`;
  if (tab === "timeline") {
    html += `<div class="tl">${d.timeline.map((c) => `<div class="tli${S.current?.id === c.id ? " playing" : ""}" data-call="${c.id}">
      <div class="tm">${fmtTime(c.at)}</div>
      <div><div class="ln">${richText(callText(c), c.codes, { units: d.units_list })}</div>
        <div class="chan">${esc(c.channel)}${c.dur ? ` · ${Math.round(c.dur)} sec` : ""}</div>
        ${S.words ? wordsHtml(c, d.units_list) : ""}</div>
      <div>${c.audio ? `<button type="button" class="pbtn" data-playcall="${c.id}" title="Play">${S.current?.id === c.id && !S.audio.paused ? ICO.pause : ICO.play}</button>` : ""}</div>
    </div>`).join("")}</div>`;
    html += `<button type="button" class="report-link" data-report-inc="${d.id}">${ICO.flag} Report a problem</button>`;
    if (!OWNER) html += `<div class="empty" style="padding-top:4px;font-size:12.5px">Audio is kept private to the station operators. Transcripts are machine-made and may be wrong.</div>`;
  } else if (tab === "involved") {
    html += `<div class="kv">`;
    if (ucount) html += `<div class="sub-h" style="padding-left:0">Units</div>` + d.units_list.map((u) => `<div class="item row" data-unit="${u.id}" style="padding:8px 4px">
        ${unitBadgeHtml(u)}<div><div class="lbl" style="font-weight:500">${esc(UNIT_STATUS[u.status] || "Heard")}${u.on_this || d.closed ? "" : " <small style='color:var(--text-3)'>(moved on)</small>"}</div><div class="sub">${esc(u.role || "")}</div></div>
        <div class="r">${u.since ? "since " + fmtTime(u.since) : ""}</div></div>`).join("");
    if (d.people.length) html += `<div class="sub-h" style="padding-left:0">People</div>` + d.people.map((p) => `<div class="item"><div><div class="lbl">${esc(p.role)}</div><div class="sub">${esc(p.desc)}</div></div></div>`).join("");
    if (d.vehicles.length) html += `<div class="sub-h" style="padding-left:0">Vehicles</div>` + d.vehicles.map((x) => `<div class="item"><div><div class="lbl">${esc(x.desc)}</div><div class="sub">${esc(x.note || "")}</div></div></div>`).join("");
    if (!ucount && !d.people.length && !d.vehicles.length) html += `<div class="empty">No units, people or vehicles identified yet.</div>`;
    html += `</div>`;
  } else {
    const near = S.incidents.filter((x) => x.id !== d.id && x.lat != null && d.lat != null)
      .map((x) => ({ ...x, dm: miles(d.lat, d.lng, x.lat, x.lng) })).filter((x) => x.dm <= 1.5).sort((a, b) => a.dm - b.dm).slice(0, 10);
    if (d.cameras?.length) html += `<div class="sub-h">Nearby cameras</div><div class="cams">${d.cameras.map(camCard).join("")}</div>`;
    html += `<div class="sub-h">Other incidents within 1½ miles</div>`;
    html += near.length ? near.map((x) => incRow({ ...x, distance_mi: Math.round(x.dm * 10) / 10 })).join("") : `<div class="empty">Nothing else nearby in the current view.</div>`;
    if (d.related_news?.length) html += `<div class="sub-h">On the News Desk</div>` + d.related_news.map((n) => `<a class="row" href="${esc(n.url)}" style="text-decoration:none;color:inherit"><div class="main"><div class="t">${esc(n.title)}</div></div></a>`).join("");
  }
  v.innerHTML = html;
}
const CAM_ICO = '<svg viewBox="0 0 24 24"><path d="M3 7h12v10H3zM15 10l6-3v10l-6-3"/></svg>';
function camCard(c) {
  const bust = Math.floor(Date.now() / 60000);
  return `<div class="cam" data-cam="${esc(c.img)}" data-camname="${esc(c.name)}"><img loading="lazy" src="${esc(c.img)}&t=${bust}" alt="${esc(c.name)}" onload="window.__camAge&&window.__camAge(this)">
    <span class="age" hidden></span><div class="cap">${esc(c.name)}${c.distance_mi != null ? `<small>${c.distance_mi} mi away${c.dir ? " · looking " + esc(c.dir.toLowerCase()) : ""}</small>` : c.dir ? `<small>Looking ${esc(c.dir.toLowerCase())}</small>` : ""}</div></div>`;
}
// Snapshot age comes back in a header; fetch it lazily (HEAD is cached 60 s server-side).
window.__camAge = async (img) => {
  try {
    const r = await fetch(img.src, { method: "HEAD" });
    const age = +r.headers.get("X-Snapshot-Age");
    const el = img.parentElement.querySelector(".age");
    if (!el || !r.headers.get("X-Snapshot-Age")) return;
    el.hidden = false;
    el.textContent = age > 900 ? "Not updating" : age < 120 ? "Just now" : `${Math.round(age / 60)} min ago`;
    el.classList.toggle("stale", age > 900);
  } catch (e) {}
};
let camCache = null;
async function loadCams() { if (!camCache) camCache = (await api("/api/live/cameras")).items || []; return camCache; }
async function openCameras() {
  openModal(`<h2>Cameras</h2><div class="empty">Loading…</div>`);
  const cams = await loadCams().catch(() => []);
  $("#modal-body").innerHTML = `<h2>Cameras <small style="font-size:13px;color:var(--text-3);font-weight:500">${cams.length} TxDOT cameras · stills refresh every minute</small></h2>
    ${cams.length ? `<div class="cams">${cams.map(camCard).join("")}</div>` : `<div class="empty">No cameras for this region.</div>`}`;
}
function openCamBig(src, name) {
  openModal(`<h2>${esc(name)}</h2><div class="cam-big"><img src="${esc(src)}&t=${Date.now()}" alt="${esc(name)}"></div>`, true);
}
let camLayer = null;
async function toggleCamLayer(on) {
  if (camLayer) { camLayer.remove(); camLayer = null; }
  if (!on) return;
  const cams = await loadCams().catch(() => []);
  camLayer = L.layerGroup(cams.map((c) => L.marker([c.lat, c.lng], { pane: "units", icon: L.divIcon({ className: "", html: `<span class="cam-pin">${CAM_ICO}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
    .on("click", () => openCamBig(c.img, c.name)))).addTo(map);
}
function miles(a, b, c, d) {
  const R = 3958.8, p1 = a * Math.PI / 180, p2 = c * Math.PI / 180, dp = p2 - p1, dl = (d - b) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function drawIncidentOverlay(d) {
  trailLayer.clearLayers();
  for (const t of d.trails || []) {
    const [a, b] = t.points;
    L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { pane: "trails", color: "#ec4647", weight: 2.5, dashArray: "3 6", opacity: 0.85 }).addTo(trailLayer);
    const u = d.units_list.find((x) => x.id === t.unit_id);
    if (u) L.marker([a.lat, a.lng], { pane: "units", icon: L.divIcon({ className: "", html: unitBadgeHtml({ ...u, status: "busy" }, "time"), iconAnchor: [-6, 9] }) }).addTo(trailLayer);
  }
}
function clearSelection() {
  trailLayer?.clearLayers();
  const v = $('[data-view="detail"]'); if (v) v.dataset.loadedFor = "";
  renderMapIncidents();
  renderMapUnits();
}

// ---------------------------------------------------------------- unit detail
async function openUnit(id) {
  S.detail = { type: "unit", id, tab: "activity" };
  showView("detail");
  const v = $('[data-view="detail"]');
  v.innerHTML = `<div class="empty">Loading…</div>`;
  setHash(`u/${id}`);
  if (isMobile()) setSheet("mid");
  let d;
  try { d = await api(`/api/live/units/${id}`, {}); } catch (e) { v.innerHTML = `<div class="empty">Couldn't load that unit.</div>`; return; }
  if (S.detail?.type !== "unit" || S.detail.id !== id) return;
  S.detail.data = d;
  renderUnitDetail();
  drawUnitTrail(d);
}
function renderUnitDetail() {
  const d = S.detail.data, tab = S.detail.tab;
  const v = $('[data-view="detail"]');
  let html = `<div class="dhead"><button type="button" class="back" data-act="back" title="Back">${ICO.back}</button><div class="dtitle">${esc(d.callsign)}</div></div>
    <div class="kv"><div class="item">${ICO.truck}<div>${esc(d.role || ({ police: "Police unit", fire: "Fire unit", ems: "EMS unit" }[d.service] || "Unit"))}</div></div>
    <div class="item"><span class="statusdot st-${esc(d.status)}" style="margin:0 5px"></span><div><div><b>${esc(UNIT_STATUS[d.status] || "Heard")}</b>${d.since ? " since " + fmtTime(d.since) : ""}</div>
      <div class="sub">${d.incident ? `<a href="#i/${d.incident.id}" data-inc-link="${d.incident.id}">${esc(d.incident.title)}</a> · ` : ""}${esc(d.location ? "Near " + d.location : "")}</div></div></div></div>
    <div class="dtabs"><button type="button" data-utab="activity" class="${tab === "activity" ? "on" : ""}">Activity</button>
      <button type="button" data-utab="radio" class="${tab === "radio" ? "on" : ""}">Radio <span class="n">${d.radio.length}</span></button>
      <span class="spacer"></span>${tab === "radio" ? `<button type="button" class="words-tog ${S.words ? "on" : ""}" data-act="words">${S.words ? "✓ " : ""}Words</button>` : ""}</div>`;
  if (tab === "activity") {
    const acts = d.activity;
    if (!acts.length) html += `<div class="empty">No activity recorded in the last week.</div>`;
    let lastDay = "", prevEnd = 0;
    const today = dayKey(now());
    acts.forEach((a, i) => {
      const day = dayKey(a.at);
      if (day !== lastDay) { html += `<div class="dayhdr">${day === today ? "Today" : fmtDay(a.at)}</div>`; lastDay = day; prevEnd = 0; }
      if (prevEnd && a.at - prevEnd > 3600) html += `<div class="gap-row">Not heard · ${fmtDur(a.at - prevEnd)}</div>`;
      const next = acts[i + 1];
      const dur = (next ? next.at : (d.status === a.status ? now() : a.until)) - a.at;
      const isNow = i === acts.length - 1 && d.incident && a.incident_id === d.incident.id;
      const title = a.title && ["dispatched", "on_scene", "transporting", "busy"].includes(a.status) ? a.title : (UNIT_STATUS[a.status] || "Heard") + (a.status === "en_route" && a.location ? "" : "");
      const label = a.status === "en_route" && a.location ? `To ${a.location}` : title;
      html += `<div class="act${isNow ? " now" : ""}" ${a.incident_id ? `data-inc-link="${a.incident_id}"` : ""}>
        <div class="tm">${fmtTime(a.at)}</div>
        <div class="ic">${a.incident_id && a.kind && a.status !== "en_route" ? `<span class="kico k-${esc(a.kind)}">${kindSvg(a.kind)}</span>` : `<span class="statusdot st-${esc(a.status)}"></span>`}</div>
        <div><div>${esc(label)}</div>${a.location && a.status !== "en_route" ? `<div class="sub">${esc(a.location)}</div>` : ""}</div>
        <div class="d">${dur > 59 ? fmtDur(dur) : ""}</div></div>`;
      prevEnd = a.until || a.at;
    });
    if (acts.length && now() - (acts[acts.length - 1].until || 0) > 3600) html += `<div class="gap-row">Not heard · ${fmtDur(now() - acts[acts.length - 1].until)}</div>`;
  } else {
    html += [...d.radio].reverse().map((c) => radioItem(c, [{ id: d.id, callsign: d.callsign }])).join("") || `<div class="empty">No radio calls yet.</div>`;
  }
  v.innerHTML = html;
}
function drawUnitTrail(d) {
  trailLayer.clearLayers();
  const since = now() - 24 * 3600;
  const pts = [];
  for (const a of d.activity) if (a.lat != null && a.at >= since && (!pts.length || pts[pts.length - 1].incident_id !== a.incident_id)) pts.push(a);
  if (!pts.length) return;
  L.polyline(pts.map((p) => [p.lat, p.lng]), { pane: "trails", color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1f6fe0", weight: 3, opacity: 0.85 }).addTo(trailLayer);
  pts.forEach((p, i) => {
    const last = i === pts.length - 1;
    L.marker([p.lat, p.lng], { pane: "units", icon: L.divIcon({ className: "", html: last ? unitBadgeHtml(d) : `<span class="ubadge time">${fmtTime(p.at)}</span>`, iconAnchor: last ? [-8, 9] : [-6, 9] }) })
      .on("click", () => p.incident_id && openIncident(p.incident_id)).addTo(trailLayer);
  });
  fitVisible(L.latLngBounds(pts.map((p) => [p.lat, p.lng])));
}

// ---------------------------------------------------------------- radio feed
function radioItem(c, units) {
  const who = (c.speakers || []).map((s) => s.who).filter(Boolean);
  const whoS = [...new Set(who)].slice(0, 3).join(", ");
  const chatter = !c.incident_id && (c.type === "Radio Chatter" || !c.line);
  const inc = c.incident || (c.incident_id ? { id: c.incident_id } : null);
  const open = S.words || S.openCalls?.has(c.id);
  return `<div class="rcall${S.current?.id === c.id ? " playing" : ""}${OWNER && c.audio && !S.played.has(c.id) ? " unplayed" : ""}" data-call="${c.id}">
    <div class="rtop"><span class="rtm">${fmtTime(c.at)}</span><span>·</span><span>${esc(c.channel)}</span>${whoS ? `<span>·</span><span class="who">${esc(whoS)}</span>` : ""}
      <span style="margin-left:auto"></span>${c.audio ? `<button type="button" class="pbtn" data-playcall="${c.id}" title="Play">${S.current?.id === c.id && !S.audio.paused ? ICO.pause : ICO.play}</button>` : ""}</div>
    <div class="rline${chatter ? " chatter" : ""}" data-toggle-words="${c.id}" style="cursor:pointer" title="Show the words">${richText(callText(c), c.codes, { units })}</div>
    ${inc && inc.title ? `<span class="rinc" data-inc-link="${inc.id}">${kico(inc.kind)}${esc(inc.title)}</span>` : ""}
    ${open ? wordsHtml(c, units) : ""}</div>`;
}
function renderRadio() {
  const v = $('[data-view="radio"]');
  const q = S.q.toLowerCase();
  const list = S.radio.filter((c) => !S.hiddenChannels.has(c.talkgroup) && (!S.hideChatter || c.incident_id || (c.type !== "Radio Chatter"))
    && (!q || (c.line || "").toLowerCase().includes(q) || (c.channel || "").toLowerCase().includes(q) || (c.speakers || []).some((s) => (s.text + " " + s.who).toLowerCase().includes(q))));
  const top = v.scrollTop;
  v.innerHTML = `<div class="rhead">
      <button type="button" class="pillbtn ${S.listening ? "on" : ""}" data-act="listen">${S.listening ? ICO.pause : ICO.play} ${OWNER ? (S.listening ? "Listening live" : "Listen live") : (S.listening ? "Following live" : "Follow live")}</button>
      <button type="button" class="pillbtn ${S.hideChatter ? "on" : ""}" data-act="chatter">${S.hideChatter ? "✓ " : ""}Hide chatter</button>
      <button type="button" class="pillbtn ${S.words ? "on" : ""}" data-act="words">${S.words ? "✓ " : ""}Words</button>
      <button type="button" class="pillbtn" data-act="channels">Channels${S.hiddenChannels.size ? ` (${S.channels.length - S.hiddenChannels.size})` : ""}</button>
    </div>
    <div id="chan-box" hidden></div>
    ${list.map((c) => radioItem(c, S.units)).join("") || `<div class="empty">No calls yet.</div>`}
    ${S.radio.length ? `<button type="button" class="more-btn" data-act="older">Show older calls</button>` : ""}`;
  v.scrollTop = top;
}
function renderChannelBox() {
  const box = $("#chan-box");
  box.hidden = !box.hidden;
  if (box.hidden) return;
  box.innerHTML = `<div class="fsec"><div class="klist">${S.channels.map((c) => `<button type="button" data-chan="${c.talkgroup}" class="${S.hiddenChannels.has(c.talkgroup) ? "off" : ""}">
    <span class="ck">${S.hiddenChannels.has(c.talkgroup) ? "" : "✓"}</span>${esc(c.name)}<span class="n">${c.calls_24h}/day</span></button>`).join("")}</div></div>`;
}

// ---------------------------------------------------------------- live listening / player
function onNewCalls(calls) {
  for (const c of calls) {
    if (S.hiddenChannels.has(c.talkgroup)) continue;
    if (S.listening) {
      if (OWNER && c.audio) S.queue.push(c);
      else { setNowPlaying(c, true); followTo(c); }
    }
  }
  if (!S.listening && calls.length) setNowPlaying(calls[calls.length - 1], false);
  if (S.listening && OWNER) pumpQueue();
}
function trimQueue() {
  // Keep it live: skip low-value chatter first, never fall more than 10 min behind.
  const limit = now() - 600;
  S.queue = S.queue.filter((c) => c.at >= limit);
  if (S.queue.length > 6) {
    const keep = S.queue.filter((c) => c.incident_id || c.type !== "Radio Chatter");
    if (keep.length) S.queue = keep;
  }
}
function pumpQueue() {
  if (!S.listening || (S.current && !S.audio.paused && !S.audio.ended)) return;
  trimQueue();
  const next = S.queue.shift();
  if (next) playCall(next, { live: true });
}
function playCall(c, { live = false } = {}) {
  if (!c.audio) return;
  S.current = c; S.played.add(c.id);
  S.audio.src = c.audio; S.audio.volume = +$("#vol").value;
  S.audio.play().catch(() => toast("Tap play to allow audio"));
  setNowPlaying(c, true);
  if (live) followTo(c);
  markPlaying();
}
function followTo(c) {
  if (!S.follow || !c.incident_id) return;
  const it = S.incidents.find((x) => x.id === c.incident_id);
  if (it?.lat != null) flyToVisible([it.lat, it.lng], Math.max(map.getZoom(), 14));
}
function setNowPlaying(c, active) {
  const inc = c.incident || S.incidents.find((x) => x.id === c.incident_id);
  $("#np-chan").textContent = c.channel || "Live";
  const a = $("#np-inc");
  a.textContent = inc?.title || ""; a.dataset.inc = inc?.id || ""; a.previousElementSibling.hidden = !inc?.title;
  const words = (c.line || (c.speakers || []).map((s) => s.text).join(" ") || "").split(/\s+/);
  $("#np-line").innerHTML = words.map((w, i) => `<span class="word" data-i="${i}">${richText(w)}</span>`).join(" ");
  $("#np-line").dataset.n = words.length;
  $("#np-ago").dataset.at = c.at; refreshPlayerAgo();
  S.np = c;
}
function refreshPlayerAgo() { const el = $("#np-ago"); if (el.dataset.at) el.textContent = ago(+el.dataset.at) + " ago"; }
function markPlaying() {
  $$("[data-call]").forEach((el) => el.classList.toggle("playing", +el.dataset.call === S.current?.id));
  $$("[data-playcall]").forEach((b) => (b.innerHTML = +b.dataset.playcall === S.current?.id && !S.audio.paused ? ICO.pause : ICO.play));
  $("#btn-play").setAttribute("aria-pressed", String(S.listening || (!S.audio.paused && !!S.current)));
}
S.audio.addEventListener("ended", () => {
  markPlaying();
  if (S.incidentQueue?.length) { playCall(S.incidentQueue.shift()); return; }
  if (S.replay?.playing && OWNER) return;
  pumpQueue();
});
S.audio.addEventListener("pause", markPlaying);
S.audio.addEventListener("play", markPlaying);
S.audio.addEventListener("timeupdate", () => {
  const n = +$("#np-line").dataset.n || 0;
  if (!n || !S.audio.duration) return;
  const i = Math.floor((S.audio.currentTime / S.audio.duration) * n);
  $$("#np-line .word").forEach((w) => w.classList.toggle("cur", +w.dataset.i === i));
});
function toggleListening(force) {
  S.listening = force ?? !S.listening;
  if (S.listening) {
    if (OWNER) {
      // prime with the last few minutes so there is something to hear immediately
      const recent = S.radio.filter((c) => c.audio && c.at > now() - 180 && !S.hiddenChannels.has(c.talkgroup)).reverse();
      S.queue = recent.slice(-4); pumpQueue();
      if (!S.queue.length && !S.current) toast("Listening — calls will play as they come in");
    } else {
      S.follow = true; $("#btn-follow").setAttribute("aria-pressed", "true");
      toast("Following live — new calls appear below as they air");
    }
  } else { S.queue = []; S.audio.pause(); }
  markPlaying();
  if (S.tab === "radio" && !S.detail) renderRadio();
}

// ---------------------------------------------------------------- filters view
function openFilters() {
  S.detail = { type: "filters" };
  showView("filters");
  renderFilters();
}
function renderFilters() {
  const f = S.filters;
  const v = $('[data-view="filters"]');
  const seg = (name, opts, cur) => `<div class="seg">${opts.map(([val, label]) => `<button type="button" data-f="${name}" data-v="${val}" class="${String(cur) === String(val) ? "on" : ""}">${label}</button>`).join("")}</div>`;
  const total = Object.values(S.kinds).reduce((a, b) => a + b, 0);
  v.innerHTML = `<div class="dhead"><button type="button" class="back" data-act="back" title="Back">${ICO.back}</button><div class="dtitle">Filters</div></div>
    <div class="fsec"><h4>Time</h4>${seg("window", [["active", "Active"], ["1h", "1h"], ["6h", "6h"], ["24h", "24h"], ["7d", "7d"]], f.window)}</div>
    <div class="fsec"><h4>Service</h4>${seg("service", [["", "All"], ["police", "Police"], ["fire", "Fire"], ["ems", "EMS"]], f.service)}</div>
    <div class="fsec"><h4>Kinds</h4><div class="klist">
      <button type="button" data-kind=""><span class="ck">${f.kinds.length ? "" : "✓"}</span><span class="kico k-other" style="background:conic-gradient(var(--danger) 0 33%, var(--general) 0 66%, var(--medical) 0)"></span>All kinds<span class="n">${total}</span></button>
      ${KINDS.map((k) => `<button type="button" data-kind="${k}" class="${f.kinds.length && !f.kinds.includes(k) ? "off" : ""}"><span class="ck">${f.kinds.includes(k) ? "✓" : ""}</span>${kico(k)}${KIND_LABEL[k]}<span class="n">${S.kinds[k] || 0}</span></button>`).join("")}
    </div></div>
    <div class="fsec"><h4>Near me</h4>${seg("radius", [[0, "Off"], [0.25, "¼ mi"], [0.5, "½ mi"], [1, "1 mi"], [3, "3 mi"]], f.radius)}</div>
    <div class="fsec"><h4>Sort by</h4>${seg("sort", [["latest", "Latest activity"], ["newest", "Newest calls"]], f.sort)}</div>
    <div class="ffoot"><button type="button" data-act="clear-filters">Clear all</button><button type="button" class="primary" data-act="back">Show ${visibleIncidents().length} incidents</button></div>`;
}
function setFilter(name, val) {
  const f = S.filters;
  if (name === "radius") {
    val = +val;
    if (val && !S.myLoc) { locateMe(() => { f.radius = val; saveFilters(); loadIncidents(); }); return; }
  }
  f[name] = val;
  saveFilters(); loadIncidents(); renderFilters();
}
function saveFilters() { store.set("filters", S.filters); }

// ---------------------------------------------------------------- location
function locateMe(cb) {
  if (!navigator.geolocation) { toast("Location isn't available in this browser"); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    S.myLoc = [p.coords.latitude, p.coords.longitude];
    if (meMarker) meMarker.remove();
    meMarker = L.circleMarker(S.myLoc, { radius: 7, color: "#fff", weight: 3, fillColor: "#1f6fe0", fillOpacity: 1 }).addTo(map);
    flyToVisible(S.myLoc, 14);
    if (typeof cb === "function") cb();
  }, () => toast("Couldn't get your location"), { enableHighAccuracy: true, timeout: 10000 });
}

// ---------------------------------------------------------------- mobile sheet
function setSheet(size) {
  const c = $("#card");
  c.classList.toggle("tall", size === "tall"); c.classList.toggle("short", size === "short");
  document.body.classList.toggle("sheet-tall", size === "tall");
  document.body.classList.toggle("sheet-short", size === "short");
  S.sheet = size;
}
function initSheet() {
  const g = $("#grip");
  let y0 = null;
  g.addEventListener("pointerdown", (e) => { y0 = e.clientY; g.setPointerCapture(e.pointerId); });
  g.addEventListener("pointerup", (e) => {
    const dy = e.clientY - (y0 ?? e.clientY); y0 = null;
    const order = ["short", "mid", "tall"], i = order.indexOf(S.sheet || "mid");
    if (Math.abs(dy) < 8) setSheet(order[(i + 1) % 3]);
    else setSheet(order[Math.max(0, Math.min(2, i + (dy < 0 ? 1 : -1)))]);
  });
}

// ---------------------------------------------------------------- weather / warnings / layers
async function loadWeather() {
  try {
    const w = await api("/api/live/weather");
    S.weather = w;
    if (w.now?.temp != null) { $("#wx-temp").textContent = `${w.now.temp}°`; $("#wx-chip").hidden = false; }
    const al = w.alerts || [];
    const chip = $("#wx-alert-chip");
    chip.hidden = !al.length; chip.textContent = al.length ? `⚠ ${al[0].event}${al.length > 1 ? ` +${al.length - 1}` : ""}` : "";
    warnLayer.clearLayers();
    if ($('[data-layer="warnings"]').checked) for (const a of al) if (a.geometry) L.geoJSON(a.geometry, { style: { color: "#d4372f", weight: 1.5, fillOpacity: 0.08 } }).bindTooltip(a.event).addTo(warnLayer);
  } catch (e) { /* weather is optional */ }
}
function renderWeatherPop() {
  const w = S.weather || {}, n = w.now || {};
  $("#wx-pop").innerHTML = `<div class="wx-now"><div class="big">${n.temp ?? "–"}°</div><div><b>${esc(n.text || "")}</b><div style="color:var(--text-3);font-size:12px">${esc(CFG.regionName)}</div></div></div>
    <div class="wx-grid"><div>Feels <b>${n.feels ?? "–"}°</b></div><div>Wind <b>${n.wind_dir || ""} ${n.wind_mph ?? "–"} mph</b></div><div>Humidity <b>${n.humidity ?? "–"}%</b></div></div>
    <div class="wx-fc">${(w.forecast || []).map((p) => `<div>${esc(p.name)}<b>${p.temp}°</b>${esc(p.short)}${p.pop ? `<div style="color:var(--accent)">${p.pop}%</div>` : ""}</div>`).join("")}</div>
    ${(w.alerts || []).length ? `<div class="wx-alerts">${w.alerts.map((a) => `<div><b>${esc(a.event)}</b><br>${esc(a.headline || "")}</div>`).join("")}</div>` : ""}
    ${w.forecast_url ? `<div style="margin-top:10px;text-align:center"><a href="${esc(w.forecast_url)}" target="_blank" rel="noopener">Full forecast ↗</a></div>` : ""}`;
}
async function toggleLayer(name, on) {
  if (name === "units") renderMapUnits();
  if (name === "cameras") toggleCamLayer(on);
  if (name === "aircraft") renderAirMap();
  if (name === "warnings") loadWeather();
  if (name === "radar") {
    if (on) {
      try {
        const j = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
        const fr = j.radar.past[j.radar.past.length - 1];
        radarLayer = L.tileLayer(`${j.host}${fr.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0.6, attribution: "Radar &copy; RainViewer" }).addTo(map);
      } catch (e) { toast("Radar unavailable"); }
    } else if (radarLayer) { radarLayer.remove(); radarLayer = null; }
  }
  if (name === "heat") {
    if (on) {
      try {
        const d = await api("/api/live/incidents", { window: "7d", limit: 1000 });
        const pts = d.items.filter((i) => i.lat != null).map((i) => [i.lat, i.lng, Math.min(1, 0.3 + (i.calls || 1) / 10)]);
        heatLayer = L.heatLayer(pts, { radius: 22, blur: 18, minOpacity: 0.25 }).addTo(map);
      } catch (e) { toast("Heat map unavailable"); }
    } else if (heatLayer) { heatLayer.remove(); heatLayer = null; }
  }
  if (name === "traffic" && window.JAFO_TOMTOM_KEY) {
    if (on) trafficLayer = L.tileLayer(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(window.JAFO_TOMTOM_KEY)}`, { opacity: 0.8 }).addTo(map);
    else if (trafficLayer) { trafficLayer.remove(); trafficLayer = null; }
  }
}

// ---------------------------------------------------------------- modals
function openModal(html, narrow = false) {
  $("#modal-body").innerHTML = html;
  $(".modal-box").classList.toggle("narrow", narrow);
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; $("#modal-body").innerHTML = ""; }
function openMenu(open) { $("#menu").hidden = !open; $("#scrim").hidden = !open; }

async function openHighlights(days = store.get("hlDays", 30), kind = "") {
  openModal(`<h2>Highlights</h2><div class="empty">Crunching the numbers…</div>`);
  let d;
  try { d = await api("/api/live/stats", { days, kind }); } catch (e) { $("#modal-body").innerHTML = `<h2>Highlights</h2><div class="empty">Couldn't load stats.</div>`; return; }
  S.hl = { d, days, kind, list: S.hl?.list || "serious", stat: S.hl?.stat || "when" };
  renderHighlights();
}
function renderHighlights() {
  const { d, days, kind, list, stat } = S.hl;
  const lists = [["serious", "Serious"], ["pursuits", "Pursuits"], ["fires", "Fires"], ["traffic", "Traffic"], ["animals", "Animals"], ["funniest", "Funniest"], ["strangest", "Strangest"], ["most_units", "Most units"], ["most_calls", "Most radio"], ["longest", "Longest"]];
  const items = d.lists[list] || [];
  const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const val = (it) => list === "longest" ? fmtDur(it.minutes * 60) : list === "most_units" || it.units ? pl(it.units ?? 0, "unit") : pl(it.calls, "call");
  let left = `<div class="hl-tabs">${lists.map(([k, l]) => `<button type="button" data-hl-list="${k}" class="${k === list ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="hl-list">${items.length ? items.map((it, i) => `<div class="it" data-inc-link="${it.id}"><span class="rk">${i + 1}</span>
      <div><div class="ti">${esc(it.title)}</div><div class="sb">${fmtDay(it.at)}, ${fmtTime(it.at)}${it.location ? " · " + esc(it.location) : ""}</div></div><span class="val">${val(it)}</span></div>`).join("") : `<div class="empty">Nothing here yet for this period.</div>`}</div>`;
  let right = `<div class="hl-tabs">${[["when", "When"], ["where", "Where"], ["response", "Response"]].map(([k, l]) => `<button type="button" data-hl-stat="${k}" class="${k === stat ? "on" : ""}">${l}</button>`).join("")}
    <span style="margin-left:auto"><select data-hl-kind style="font:inherit;font-size:12px;background:var(--raise);color:var(--text);border:1px solid var(--line-strong);border-radius:8px;padding:3px 6px">
    <option value="">All kinds</option>${KINDS.map((k) => `<option value="${k}" ${k === kind ? "selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}</select></span></div>`;
  if (stat === "when") {
    const peak = d.by_hour.indexOf(Math.max(...d.by_hour));
    const hr = (h) => h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
    const wdPeak = d.by_weekday.reduce((a, b) => (b.n > a.n ? b : a), d.by_weekday[0]);
    right += `<div class="stat-h">Busiest at ${hr(peak)}<small>${d.total} incidents · ${d.per_day}/day</small></div>
      <div class="bars" role="img" aria-label="Incidents by hour of day">${d.by_hour.map((n, h) => `<div class="b${h === peak ? " peak" : ""}" style="height:${(n / Math.max(1, ...d.by_hour)) * 100}%" data-tip="${hr(h)}: ${n} incidents"></div>`).join("")}</div>
      <div class="axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
      <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:18px;margin-top:16px"><div>
        <div class="stat-h">Busiest on ${esc(wdPeak.day)}</div>
        <div class="bars short" role="img" aria-label="Incidents by weekday">${d.by_weekday.map((w) => `<div class="b${w === wdPeak ? " peak" : ""}" style="height:${(w.n / Math.max(1, ...d.by_weekday.map((x) => x.n))) * 100}%" data-tip="${w.day}: ${w.n}"></div>`).join("")}</div>
        <div class="axis">${d.by_weekday.map((w) => `<span>${w.day[0]}</span>`).join("")}</div></div>
        <div><div class="stat-h">Busiest nights</div>${d.busiest_nights.map((b) => `<div class="hbar"><span>${new Date(b.night + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span><span>${b.n}</span></div>`).join("") || "<div class='sb'>—</div>"}</div></div>`;
  } else if (stat === "where") {
    const hb = (arr) => { const mx = Math.max(1, ...arr.map((x) => x.n)); return arr.map((x) => `<div class="hbar"><span>${esc(x.name)}</span><span>${x.n}</span><div class="track"><i style="width:${(x.n / mx) * 100}%"></i></div></div>`).join("") || `<div class="sb" style="color:var(--text-3)">Not enough located incidents yet.</div>`; };
    right += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px"><div><div class="stat-h">Streets</div>${hb(d.streets)}<div class="stat-h" style="margin-top:14px">Places</div>${hb(d.places)}</div>
      <div><div class="stat-h">Crash spots</div>${d.crash_spots.map((c, i) => `<div class="hbar"><span>${i + 1}. ${esc(c.name)}<br><small style="color:var(--text-3)">${esc(c.typical)}</small></span><span>${c.n}</span></div>`).join("") || `<div style="color:var(--text-3)">No repeat crash intersections yet.</div>`}</div></div>`;
  } else {
    const r = d.response;
    right += `<div class="hero">${r.median != null ? `${Math.round(r.median)} min` : "—"}</div><div style="color:var(--text-3);margin-bottom:10px">Median dispatch-to-arrival, from ${r.samples} unit responses heard on the radio</div>
      ${r.cities.length > 1 ? `<table class="rt"><thead><tr><th></th>${r.cities.map((c) => `<th>${esc(c === "All" ? "Everywhere" : c)}</th>`).join("")}</tr></thead><tbody>
      ${r.rows.map((row) => `<tr><td>${row.tod}</td>${r.cities.map((c) => `<td>${row[c] != null ? Math.round(row[c]) + " min" : "–"}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<div style="color:var(--text-3)">Needs a few more arrivals on the radio before it can break this down.</div>`}
      <p style="font-size:12px">Measured from when a unit is dispatched or reports en route to when it reports on scene. Only responses where both were said on the air count.</p>`;
  }
  $("#modal-body").innerHTML = `<h2>Highlights <span class="period"><span class="seg">${[[7, "Week"], [30, "30 days"], [90, "90 days"]].map(([n, l]) => `<button type="button" data-hl-days="${n}" class="${n === days ? "on" : ""}">${l}</button>`).join("")}</span></span></h2>
    <div class="hl-grid"><div class="hl-box">${left}</div><div class="hl-box">${right}</div></div>`;
}

async function openCodes() {
  openModal(`<h2>Radio codes</h2><div class="empty">Loading…</div>`, true);
  try {
    const d = await api("/api/live/codes");
    $("#modal-body").innerHTML = `<h2>Radio codes</h2><p>Codes heard on ${esc(CFG.regionName)} radio in the last 30 days, with what they usually mean. Learned automatically from the traffic, so treat them as a guide.</p>
      <div class="codes-list">${d.items.map((c) => `<div><b>${esc(c.code)}</b><span>${esc(c.meaning)}</span></div>`).join("") || "<div>Not enough traffic yet.</div>"}</div>`;
  } catch (e) { $("#modal-body").innerHTML = `<h2>Radio codes</h2><div class="empty">Couldn't load codes.</div>`; }
}
function openKey() {
  const pin = (k, s) => `<span class="pin k-${k} s-${s}" style="width:24px;height:24px">${kindSvg(k)}</span>`;
  openModal(`<h2>Map key</h2>
    <h3>Incident pins</h3><div class="key-grid">
      <div class="ki">${pin("suspicious", "new")} New — no units yet</div><div class="ki">${pin("suspicious", "en_route")} Units on the way</div>
      <div class="ki">${pin("suspicious", "on_scene")} Units on scene</div><div class="ki">${pin("suspicious", "cleared")} Cleared</div>
      <div class="ki"><span class="pin k-suspicious s-quiet" style="width:24px;height:24px">${kindSvg("suspicious")}</span> Quiet / ended</div>
      <div class="ki"><span class="pin k-suspicious rough" style="width:24px;height:24px">${kindSvg("suspicious")}</span> Rough location (street or city only)</div></div>
    <p style="font-size:12.5px">Bigger pins have more radio traffic. A halo means a call in the last two minutes.</p>
    <h3>Kinds</h3><div class="key-grid">${KINDS.map((k) => `<div class="ki">${kico(k)} ${KIND_LABEL[k]}</div>`).join("")}</div>
    <p style="font-size:12.5px">Red is danger (violence, fire), green is medical, blue is everything else — the icon tells you which kind.</p>
    <h3>Units</h3><div class="key-grid">
      <div class="ki">${unitBadgeHtml({ callsign: "B410", status: "on_scene" })} On scene</div><div class="ki">${unitBadgeHtml({ callsign: "B410", status: "en_route" })} On the way</div>
      <div class="ki">${unitBadgeHtml({ callsign: "B410", status: "busy" })} Busy</div><div class="ki">${unitBadgeHtml({ callsign: "B410", status: "available" })} Available</div>
      <div class="ki">${unitBadgeHtml({ callsign: "Eng 8", status: "on_scene", service: "fire" })} Fire unit</div><div class="ki">${unitBadgeHtml({ callsign: "Medic 3", status: "en_route", service: "ems" })} EMS unit</div></div>`, true);
}
function openAbout() {
  openModal(`<h2>How JAFO works</h2>
    <p><b>JAFO</b> listens to public-safety radio with its own receivers — software-defined radios on Raspberry Pis — and turns it into a live picture of what's happening around ${esc(CFG.regionName)}.</p>
    <h3>1. Radio</h3><p>Each transmission on the trunked P25 system is recorded on its own, and silence and noise are filtered out.</p>
    <h3>2. Words</h3><p>Speech-to-text writes down each call.</p>
    <h3>3. Meaning</h3><p>An AI model reads each call alongside everything open on the map. It writes a plain-English line, splits out who's talking, explains radio codes, tracks units (dispatched → on the way → on scene → clear) and decides whether the call belongs to an incident already on the map.</p>
    <h3>4. Map</h3><p>Calls about the same event become one incident with a running summary, placed at block level.</p>
    <h3>Privacy</h3><p>Civilian names, phone numbers, plates, dates of birth, apartment numbers and exact house numbers are hidden. Homes are shown by block. Audio stays private to the station operators. Domestic and medical details are summarized, not dramatized.</p>
    <h3>Good to know</h3><p>Everything here is automated and unconfirmed. Transcripts, summaries and locations can be wrong. Encrypted channels aren't heard at all. <b>This is not an emergency service — call 911 if you need help.</b></p>`, true);
}
const TOUR = [
  ["Live incidents", "Every pin is an incident: radio calls about the same event, grouped and summarized. Tap one to see its timeline, the units working it and what was said."],
  ["Units", "The Units tab shows who's out right now — on the way, on scene, or busy — and where they've been today."],
  ["Radio", "The Radio tab is the raw feed, one plain-English line per transmission. Tap a line to see the exact words, with codes explained."],
];
function openTour(step = 0) {
  const [t, body] = TOUR[step];
  openModal(`<h2>${t}</h2><div class="tour-step">${body}</div><div class="tour-dots">${TOUR.map((_, i) => `<i class="${i === step ? "on" : ""}"></i>`).join("")}</div>
    <div class="ffoot" style="position:static;background:none;border:0;padding:0"><button type="button" data-act="close-modal">Skip</button>
    <button type="button" class="primary" data-tour="${step + 1}">${step + 1 < TOUR.length ? "Next" : "Got it"}</button></div>`, true);
  store.set("toured", true);
}

// ---- report a problem
function openReport(callId, incId) {
  openModal(`<h2>Report a problem</h2><p>Thanks — reports help us fix bad transcripts, wrong locations and things that shouldn't be public.</p>
    <form class="report-form" id="report-form"><select name="reason" required>
      <option value="">What's wrong?</option><option>Wrong location</option><option>Transcript is wrong</option><option>Wrong incident / grouping</option>
      <option>Private information showing</option><option>Wrong unit or status</option><option>Something else</option></select>
      <textarea name="note" rows="3" placeholder="Anything else? (optional)"></textarea>
      <div class="ffoot"><button type="button" data-act="close-modal">Cancel</button><button type="submit" class="primary">Send report</button></div></form>`, true);
  $("#report-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await post("/api/live/report", { call_id: callId || null, incident_id: incId || null, reason: fd.get("reason"), note: fd.get("note") }); toast("Report sent — thank you"); }
    catch (err) { toast("Couldn't send the report"); }
    closeModal();
  });
}

// ---------------------------------------------------------------- replay
const SPEEDS = [[1, "Real time"], [6, "1 hr in 10 min"], [10, "1 hr in 6 min"], [30, "1 hr in 2 min"], [60, "1 hr in 1 min"], [180, "3 hr in 1 min"]];
async function openReplay(day) {
  closeModal(); openMenu(false);
  day = day || dayKey(now());
  let d;
  try { d = await api("/api/live/replay", { day }); } catch (e) { toast("Replay unavailable"); return; }
  const prevT = S.replay?.t;
  S.replay = { ...d, t: prevT && prevT >= d.start && prevT < d.end ? prevT : Math.min(now() - 600, d.end - 1), playing: false, speed: +$("#rp-speed").value };
  if (S.replay.t < d.start) S.replay.t = d.start + 12 * 3600;
  document.body.classList.add("replaying");
  $("#replay").hidden = false; $("#rp-day").value = d.day;
  toggleListening(false);
  drawHist(); setReplayTime(S.replay.t, true);
}
function exitReplay() {
  S.replay = null; document.body.classList.remove("replaying"); $("#replay").hidden = true;
  S.audio.pause(); loadIncidents(); loadUnits();
}
function drawHist() {
  const cv = $("#rp-canvas"), box = $("#rp-hist");
  const w = box.clientWidth, h = box.clientHeight, dpr = devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const bins = S.replay.bins, mx = Math.max(1, ...bins), bw = w / bins.length;
  const css = getComputedStyle(document.documentElement);
  const past = css.getPropertyValue("--text-3").trim() || "#999";
  const cut = Math.floor((now() - S.replay.start) / 300);
  bins.forEach((n, i) => {
    if (!n) return;
    const bh = Math.max(2, (n / mx) * (h - 4));
    ctx.globalAlpha = i > cut ? 0.2 : 0.55; ctx.fillStyle = past;
    ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  });
  ctx.globalAlpha = 1;
}
let replayFetchT = 0, replayFetchTimer = null;
function setReplayTime(t, fetchNow = false) {
  const R = S.replay; if (!R) return;
  R.t = Math.max(R.start, Math.min(R.end - 1, Math.round(t)));
  $("#rp-cursor").style.left = `${((R.t - R.start) / (R.end - R.start)) * 100}%`;
  $("#rp-time").textContent = new Date(R.t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: TZ });
  const last = [...R.calls].reverse().find((c) => c.at <= R.t);
  if (last) {
    $("#rp-now").innerHTML = `<b>${esc(last.channel)}</b> · ${fmtTime(last.at)} · ${richText(last.line || "")}`;
    if (OWNER && R.playing && R.speed === 1 && last.audio && last.id !== R.lastPlayed && R.t - last.at < 5) { R.lastPlayed = last.id; S.current = last; S.audio.src = last.audio; S.audio.play().catch(() => {}); }
  } else $("#rp-now").textContent = "";
  const due = fetchNow || Date.now() - replayFetchT > 1500;
  clearTimeout(replayFetchTimer);
  if (due) fetchReplayIncidents(); else replayFetchTimer = setTimeout(fetchReplayIncidents, 400);
}
async function fetchReplayIncidents() {
  replayFetchT = Date.now();
  const R = S.replay; if (!R) return;
  try {
    const d = await api("/api/live/incidents", { at: R.t });
    if (!S.replay) return;
    S.incidents = d.items; S.kinds = d.kinds;
    renderMapIncidents();
    if (S.tab === "incidents" && !S.detail) renderIncidentList();
  } catch (e) {}
}
function replayTick() {
  const R = S.replay;
  if (!R?.playing) return;
  const sp = SPEEDS[R.speed][0];
  setReplayTime(R.t + sp * 0.25);
  if (R.t >= Math.min(R.end - 1, now())) { R.playing = false; $("#rp-play").textContent = "▶"; }
}
setInterval(replayTick, 250);
function jumpBusy(dir) {
  const R = S.replay; if (!R) return;
  const sorted = [...R.bins].filter(Boolean).sort((a, b) => a - b);
  const thr = sorted[Math.floor(sorted.length * 0.8)] || 1;
  let i = Math.floor((R.t - R.start) / 300) + dir;
  while (i >= 0 && i < R.bins.length && R.bins[i] < thr) i += dir;
  if (i >= 0 && i < R.bins.length) setReplayTime(R.start + i * 300, true);
}
function parseJump(txt) {
  txt = txt.trim().toLowerCase();
  if (!txt) return null;
  let base = new Date(S.replay.start * 1000);
  if (/yesterday/.test(txt)) { base = new Date(); base.setDate(base.getDate() - 1); txt = txt.replace("yesterday", ""); }
  else if (/today/.test(txt)) { base = new Date(); txt = txt.replace("today", ""); }
  const md = txt.match(/([a-z]{3})[a-z]*\s+(\d{1,2})/);
  if (md) {
    const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(md[1]);
    if (mi >= 0) { base = new Date(base.getFullYear(), mi, +md[2]); if (base > new Date()) base.setFullYear(base.getFullYear() - 1); txt = txt.replace(md[0], ""); }
  }
  const tm = txt.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?/);
  let h = 12, m = 0;
  if (tm) { h = +tm[1]; m = +(tm[2] || 0); const ap = tm[3]; if (ap?.startsWith("p") && h < 12) h += 12; if (ap?.startsWith("a") && h === 12) h = 0; }
  base.setHours(h, m, 0, 0);
  return base;
}
function initReplayUi() {
  const hist = $("#rp-hist");
  const scrub = (e) => { const r = hist.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); setReplayTime(S.replay.start + x * (S.replay.end - S.replay.start)); };
  hist.addEventListener("pointerdown", (e) => { hist.setPointerCapture(e.pointerId); scrub(e); hist.onpointermove = scrub; });
  hist.addEventListener("pointerup", () => { hist.onpointermove = null; fetchReplayIncidents(); });
  $("#rp-play").onclick = () => { const R = S.replay; R.playing = !R.playing; $("#rp-play").textContent = R.playing ? "❚❚" : "▶"; if (!R.playing) S.audio.pause(); };
  $("#rp-prev").onclick = () => jumpBusy(-1);
  $("#rp-next").onclick = () => jumpBusy(1);
  $("#rp-exit").onclick = exitReplay;
  const sp = $("#rp-speed");
  const spl = () => { $("#rp-speed-l").textContent = SPEEDS[+sp.value][1]; if (S.replay) S.replay.speed = +sp.value; };
  sp.oninput = spl; spl();
  $("#rp-day").onchange = (e) => openReplay(e.target.value);
  $("#rp-jump").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const dt = parseJump(e.target.value); if (!dt) return;
    const day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    if (day !== S.replay.day) { S.replay.t = dt.getTime() / 1000; await openReplay(day); }
    setReplayTime(dt.getTime() / 1000, true); e.target.value = "";
  });
  addEventListener("resize", () => S.replay && drawHist());
}

// ---------------------------------------------------------------- events
function back() {
  const prev = S.detail;
  S.detail = null; clearSelection();
  if (prev?.type === "filters") loadIncidents();
  setTab(S.tab);
}
function onClick(e) {
  const t = e.target.closest("button, [data-inc], [data-unit], [data-inc-link], [data-toggle-words], [data-cam], [data-ac], a, .unit-ref");
  if (!t) return;
  const ds = t.dataset;
  if (t.matches(".unit-ref")) { e.preventDefault(); openUnit(+ds.unit); return; }
  if (ds.playcall) {
    const id = +ds.playcall;
    if (S.current?.id === id && !S.audio.paused) { S.audio.pause(); return; }
    const c = findCall(id); if (c) { S.incidentQueue = []; playCall(c); } return;
  }
  if (ds.inc) { openIncident(+ds.inc); return; }
  if (ds.incLink) { e.preventDefault(); closeModal(); if (S.replay && S.detail) {} openIncident(+ds.incLink); return; }
  if (ds.unit && !t.matches("button.flag")) { openUnit(+ds.unit); return; }
  if (ds.toggleWords) { S.openCalls = S.openCalls || new Set(); const id = +ds.toggleWords; S.openCalls.has(id) ? S.openCalls.delete(id) : S.openCalls.add(id); rerender(); return; }
  if (ds.report) { openReport(+ds.report, S.detail?.type === "incident" ? S.detail.id : null); return; }
  if (ds.reportInc) { openReport(null, +ds.reportInc); return; }
  if (ds.dtab) { S.detail.tab = ds.dtab; renderIncidentDetail(); return; }
  if (ds.utab) { S.detail.tab = ds.utab; renderUnitDetail(); return; }
  if (ds.scope) { S.unitsScope = ds.scope; loadUnits(); renderUnitList(); return; }
  if (ds.f) { setFilter(ds.f, ds.v); return; }
  if (ds.kind !== undefined && t.closest(".klist") && t.closest('[data-view="filters"]')) {
    const f = S.filters;
    if (!ds.kind) f.kinds = [];
    else f.kinds = f.kinds.includes(ds.kind) ? f.kinds.filter((k) => k !== ds.kind) : [...f.kinds, ds.kind];
    saveFilters(); renderFilters(); renderMapIncidents(); return;
  }
  if (ds.chan) {
    const tg = +ds.chan; S.hiddenChannels.has(tg) ? S.hiddenChannels.delete(tg) : S.hiddenChannels.add(tg);
    store.set("hiddenChannels", [...S.hiddenChannels]); renderRadio(); renderChannelBox(); return;
  }
  if (ds.push) { setPush(ds.push); return; }
  if (ds.cam) { openCamBig(ds.cam, ds.camname); return; }
  if (ds.ac) { openAircraft(ds.ac); return; }
  if (ds.hlList) { S.hl.list = ds.hlList; renderHighlights(); return; }
  if (ds.hlStat) { S.hl.stat = ds.hlStat; renderHighlights(); return; }
  if (ds.hlDays) { store.set("hlDays", +ds.hlDays); openHighlights(+ds.hlDays, S.hl.kind); return; }
  if (ds.tour !== undefined) { +ds.tour < TOUR.length ? openTour(+ds.tour) : closeModal(); return; }
  if (ds.open) {
    openMenu(false);
    ({ highlights: () => openHighlights(), cameras: openCameras, replay: () => openReplay(), codes: openCodes, key: openKey, about: openAbout, tour: () => openTour(0) })[ds.open]?.();
    return;
  }
  if (ds.themeSet !== undefined) {
    if (ds.themeSet) document.documentElement.dataset.theme = ds.themeSet; else delete document.documentElement.dataset.theme;
    store.set("theme", ds.themeSet || null); try { if (!ds.themeSet) localStorage.removeItem("jafo.live.theme"); else localStorage.setItem("jafo.live.theme", ds.themeSet); } catch (err) {}
    markTheme(); if (S.replay) drawHist(); return;
  }
  switch (ds.act) {
    case "back": back(); break;
    case "words": S.words = !S.words; store.set("words", S.words); rerender(); break;
    case "listen": toggleListening(); break;
    case "chatter": S.hideChatter = !S.hideChatter; store.set("hideChatter", S.hideChatter); renderRadio(); break;
    case "channels": renderChannelBox(); break;
    case "older": loadOlder(); break;
    case "show-24h": S.filters.window = "24h"; saveFilters(); loadIncidents(); break;
    case "clear-filters": e.preventDefault(); S.filters = { window: "active", service: "", kinds: [], sort: "latest", radius: 0 }; saveFilters(); loadIncidents(); if (S.detail?.type === "filters") renderFilters(); break;
    case "close-modal": closeModal(); break;
    case "replay-incident": {
      const tl = S.detail.data.timeline.filter((c) => c.audio);
      if (tl.length) { S.incidentQueue = tl.slice(1); playCall(tl[0]); }
      break;
    }
  }
}
function findCall(id) {
  if (S.detail?.data?.timeline) { const c = S.detail.data.timeline.find((x) => x.id === id); if (c) return c; }
  if (S.detail?.data?.radio) { const c = S.detail.data.radio.find((x) => x.id === id); if (c) return c; }
  return S.radio.find((x) => x.id === id);
}
function rerender() {
  if (S.detail?.type === "incident" && S.detail.data) renderIncidentDetail();
  else if (S.detail?.type === "unit" && S.detail.data) renderUnitDetail();
  else if (S.tab === "radio") renderRadio();
  else if (S.tab === "air") renderAir();
}
async function loadOlder() {
  try {
    const d = await api("/api/live/radio", { before: S.radioOldest, limit: 80 });
    d.items.forEach((c) => S.played.add(c.id));
    S.radio = S.radio.concat(d.items.filter((c) => !S.radio.some((x) => x.id === c.id)));
    S.radioOldest = Math.min(S.radioOldest, ...d.items.map((c) => c.at));
    renderRadio();
  } catch (e) {}
}
function markTheme() {
  const cur = document.documentElement.dataset.theme || "";
  $$("[data-theme-set]").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === cur));
}
function routeHash() {
  const h = location.hash.replace(/^#/, "");
  let m;
  if ((m = h.match(/^i\/(\d+)/))) openIncident(+m[1]);
  else if ((m = h.match(/^u\/(\d+)/))) openUnit(+m[1]);
  else if ((m = h.match(/^a\/([0-9a-f]+)/i))) { setTab("air"); loadAir().then(() => openAircraft(m[1])); }
  else if (["units", "radio", "air"].includes(h)) setTab(h);
}

function bind() {
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!$("#modal").hidden) closeModal(); else if (!$("#menu").hidden) openMenu(false); else if (S.detail) back(); }
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    if (e.key === "l") toggleListening();
    if (e.key === "f") $("#btn-follow").click();
    if (e.key === "j" || e.key === "k") {
      const rows = $$(".view:not([hidden]) .row[data-inc], .view:not([hidden]) .row[data-unit]");
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.classList.contains("hl"));
      rows.forEach((r) => r.classList.remove("hl"));
      i = Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" ? 1 : -1)));
      rows[i].classList.add("hl"); rows[i].scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") { const r = $(".row.hl"); if (r) r.click(); }
  });
  $$(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $("#btn-filters").onclick = () => (S.detail?.type === "filters" ? back() : openFilters());
  $("#btn-menu").onclick = () => openMenu(true);
  $("#scrim").onclick = () => openMenu(false);
  $("#modal-close").onclick = closeModal;
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  $("#modal").addEventListener("change", (e) => { if (e.target.matches("[data-hl-kind]")) openHighlights(S.hl.days, e.target.value); });
  $("#modal").addEventListener("mousemove", (e) => {
    const b = e.target.closest("[data-tip]"); let tip = $("#tip");
    if (!b) { if (tip) tip.hidden = true; return; }
    if (!tip) { tip = document.createElement("div"); tip.id = "tip"; tip.className = "tip"; document.body.appendChild(tip); }
    tip.hidden = false; tip.textContent = b.dataset.tip; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY - 28 + "px";
  });
  let qt;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      S.q = e.target.value.trim();
      if (S.detail && S.detail.type !== "filters") { S.detail = null; showView(S.tab); clearSelection(); }
      if (S.tab === "incidents") loadIncidents(); else rerender() || (S.tab === "units" ? renderUnitList() : renderRadio());
    }, 280);
  });
  $("#btn-play").onclick = () => {
    if (S.current && !S.audio.paused) { S.audio.pause(); S.listening = false; markPlaying(); return; }
    toggleListening(true);
  };
  $("#np-inc").onclick = (e) => { e.preventDefault(); if (e.target.dataset.inc) openIncident(+e.target.dataset.inc); };
  $("#vol").oninput = (e) => (S.audio.volume = +e.target.value);
  $("#btn-layers").onclick = (e) => { e.stopPropagation(); $("#layers-pop").hidden = !$("#layers-pop").hidden; $("#wx-pop").hidden = true; };
  $("#wx-chip").onclick = (e) => { e.stopPropagation(); renderWeatherPop(); $("#wx-pop").hidden = !$("#wx-pop").hidden; $("#layers-pop").hidden = true; };
  $("#bell-chip").onclick = (e) => { e.stopPropagation(); renderBell(); $("#bell-pop").hidden = !$("#bell-pop").hidden; $("#layers-pop").hidden = true; $("#wx-pop").hidden = true; };
  $("#wx-alert-chip").onclick = (e) => { e.stopPropagation(); renderWeatherPop(); $("#wx-pop").hidden = false; };
  document.addEventListener("click", (e) => { if (!e.target.closest(".pop, #btn-layers, #wx-chip, #wx-alert-chip, #bell-chip")) { $("#layers-pop").hidden = true; $("#wx-pop").hidden = true; $("#bell-pop").hidden = true; } });
  $$("#layers-pop [data-base]").forEach((b) => (b.onclick = () => {
    $$("#layers-pop [data-base]").forEach((x) => x.classList.toggle("on", x === b));
    if (b.dataset.base === "sat") { map.addLayer(satLayer); map.removeLayer(baseLayer); } else { map.addLayer(baseLayer); map.removeLayer(satLayer); }
  }));
  $$("#layers-pop [data-layer]").forEach((i) => (i.onchange = () => { store.set("layer." + i.dataset.layer, i.checked); toggleLayer(i.dataset.layer, i.checked); }));
  if (window.JAFO_TOMTOM_KEY) $("#tog-traffic").hidden = false;
  addEventListener("hashchange", routeHash);
  initSheet(); initReplayUi(); markTheme();
}

// ---------------------------------------------------------------- aircraft (ADS-B + ACARS)
const DEMO = new URLSearchParams(location.search).get("demo") === "1";
const AIR = { data: null, layer: null, trails: null, sel: null };
const PLANE = '<svg viewBox="0 0 24 24"><path d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.4v2l-7.7-2.2v4.3l2.3 1.8V21L12 20l-3.6 1v-1.5l2.3-1.8v-4.3L3 15.6v-2l7.7-4.4V4c0-1.1.5-2 1.3-2z"/></svg>';
const HELI = '<svg viewBox="0 0 24 24"><path d="M11 3h2v3h7v1.6h-7V9c2.7.3 4.5 2.4 4.5 5 0 2.4-1.6 4-4 4.4V20h3v1.4H7.5V20h3v-1.6c-2.4-.4-4-2-4-4.4 0-2.6 1.8-4.7 4.5-5V7.6H4V6h7V3z"/></svg>';
const ROLE_NAME = { border: "Border Patrol", medical: "Medical", police: "Police", military: "Military", news: "News" };
async function loadAir() {
  try { AIR.data = await api("/api/live/air", DEMO ? { demo: 1 } : {}); AIR.recvAt = Date.now(); } catch (e) { return; }
  const c = AIR.data.counts || {};
  $("#n-air").textContent = c.interesting || c.total || "";
  renderAirMap();
  if (S.tab === "air" && !S.detail) renderAir();
  if (S.detail?.type === "aircraft") renderAircraftDetail();
  const em = (AIR.data.aircraft || []).filter((a) => a.emergency);
  for (const a of em) if (!AIR.alerted?.has(a.hex)) {
    AIR.alerted = AIR.alerted || new Set(); AIR.alerted.add(a.hex);
    toast(`✈ ${a.callsign || a.reg || a.hex} squawking ${a.emergency} (${{ "7700": "emergency", "7600": "radio failure", "7500": "hijack" }[a.emergency]})`);
  }
  if (S.detail?.type === "incident" && S.detail.data) markOverhead();
}
function acIcon(a) {
  const cls = ["ac", a.role ? "role" : "", a.emergency ? "emergency" : "", !a.interesting && (a.alt_ft || 0) > 15000 ? "dim" : ""].join(" ");
  const tag = a.interesting && (map.getZoom() >= 11 || a.emergency || AIR.sel === a.hex) ? `<span class="tag">${a.role ? `<b>${esc(ROLE_NAME[a.role])}</b> ` : ""}${esc(a.callsign || a.reg || "")}${a.alt_ft != null && !a.on_ground ? ` · ${Math.round(a.alt_ft / 100) * 100} ft` : ""}${a.circling ? " · circling" : ""}</span>` : "";
  const rot = a.kind === "helicopter" ? 0 : (a.track || 0);
  return L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="${cls}">${(a.kind === "helicopter" ? HELI : PLANE).replace("<svg", `<svg style="transform:rotate(${rot}deg)"`)}${tag}</div>` });
}
function renderAirMap() {
  // Persistent markers keyed by ICAO hex; positions are animated between polls
  // by dead reckoning (ground speed + track), so traffic moves continuously.
  if (!map) return;
  if (!AIR.layer) { AIR.layer = L.layerGroup().addTo(map); AIR.trails = L.layerGroup().addTo(map); AIR.markers = new Map(); }
  AIR.trails.clearLayers();
  const show = $('[data-layer="aircraft"]').checked && !S.replay && AIR.data;
  const seen = new Set();
  if (show) for (const a of AIR.data.aircraft || []) {
    if (a.lat == null) continue;
    seen.add(a.hex);
    if (a.trail?.length > 1 && (a.interesting || AIR.sel === a.hex))
      L.polyline(a.trail.map((p) => [p[0], p[1]]), { pane: "trails", color: a.emergency ? "#d4372f" : a.role ? "#7a3ff2" : "#5b6575", weight: AIR.sel === a.hex ? 3 : 1.6, opacity: 0.7, dashArray: a.kind === "helicopter" ? "2 4" : null }).addTo(AIR.trails);
    const icon = acIcon(a);
    let m = AIR.markers.get(a.hex);
    if (!m) {
      m = { marker: L.marker([a.lat, a.lng], { icon, pane: "units" }).on("click", () => openAircraft(a.hex)).addTo(AIR.layer) };
      AIR.markers.set(a.hex, m);
    } else if (m.html !== icon.options.html) m.marker.setIcon(icon);
    m.html = icon.options.html;
    m.a = a; m.at = AIR.recvAt - (a.seen_sec || 0) * 1000;
    m.marker.setZIndexOffset(a.emergency ? 900 : a.interesting ? 500 : 0);
  }
  for (const [hex, m] of AIR.markers) if (!seen.has(hex)) { AIR.layer.removeLayer(m.marker); AIR.markers.delete(hex); }
  if (!AIR.anim) AIR.anim = requestAnimationFrame(animateAir);
}
function animateAir() {
  AIR.anim = null;
  if (!AIR.markers?.size || document.hidden) { AIR.anim = setTimeout(() => (AIR.anim = requestAnimationFrame(animateAir)), 500); return; }
  const now = Date.now();
  for (const m of AIR.markers.values()) {
    const a = m.a;
    if (!a || a.on_ground || !a.gs_kt || a.track == null) continue;
    const dt = Math.min(15, Math.max(0, (now - m.at) / 1000));   // never extrapolate more than 15 s
    const dist = (a.gs_kt * 1.852 / 3600) * dt;                    // km travelled
    const br = a.track * Math.PI / 180, R = 6371;
    const la1 = a.lat * Math.PI / 180, lo1 = a.lng * Math.PI / 180;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(dist / R) + Math.cos(la1) * Math.sin(dist / R) * Math.cos(br));
    const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dist / R) * Math.cos(la1), Math.cos(dist / R) - Math.sin(la1) * Math.sin(la2));
    m.marker.setLatLng([la2 * 180 / Math.PI, lo2 * 180 / Math.PI]);
  }
  AIR.anim = requestAnimationFrame(animateAir);
}
function airRow(a) {
  const cls = ["row", "airrow", a.role ? "role" : "", a.emergency ? "emergency" : ""].join(" ");
  const sub = [a.alt_ft != null && !a.on_ground ? `${a.alt_ft.toLocaleString()} ft` : a.on_ground ? "on ground" : null,
    a.gs_kt != null ? `${a.gs_kt} kt` : null, a.type].filter(Boolean).join(" · ");
  return `<div class="${cls}" data-ac="${esc(a.hex)}" tabindex="0"><span class="acico">${a.kind === "helicopter" ? HELI : PLANE}</span>
    <div class="main"><div class="t">${a.emergency ? `<span class="pill alert">${esc(a.emergency)}</span>` : ""}${a.role ? `<span class="pill role">${esc(ROLE_NAME[a.role])}</span>` : ""}${esc(a.callsign || a.reg || a.hex)}</div>
    <div class="s">${esc(sub)}${a.circling ? " · circling" : ""}${a.near_incident ? ` · over “${esc(a.near_incident.title)}”` : ""}</div></div>
    <div class="meta">${a.operator ? `<div style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.operator.toLowerCase())}</div>` : ""}</div></div>`;
}
function renderAir() {
  const v = $('[data-view="air"]');
  const d = AIR.data;
  if (!d) { v.innerHTML = `<div class="empty">Loading the sky…</div>`; return; }
  const q = S.q.toLowerCase();
  const list = (d.aircraft || []).filter((a) => !q || `${a.callsign} ${a.reg} ${a.type} ${a.operator} ${a.role}`.toLowerCase().includes(q));
  const intr = list.filter((a) => a.interesting), rest = list.filter((a) => !a.interesting);
  let html = `<div class="sec-h">In the air<small>${d.counts.airborne} airborne${d.demo ? " · demo" : ""}</small></div>`;
  if (!list.length) html += `<div class="empty">Nothing in the sky over ${esc(CFG.regionName)} right now${new Date().getHours() < 6 ? " — it's the middle of the night" : ""}. Aircraft appear here from JAFO's own ADS-B receiver and the adsb.lol network.</div>`;
  if (intr.length) html += `<div class="sub-h">Worth a look · ${intr.length}</div>` + intr.map(airRow).join("");
  if (rest.length) html += `<div class="sub-h">Other traffic · ${rest.length}</div>` + rest.map(airRow).join("");
  const ac = d.acars || {};
  const rx = (d.receivers || [])[0];
  const duty = rx ? (rx.override ? `radio in ${esc(rx.override)}` : rx.state === "acars" ? "listening now"
    : `smart time-share · ${rx.last_hour?.acars_pct ?? 0}% ACARS duty last hour · ${rx.last_hour?.acars_msgs ?? 0} msgs`) : null;
  html += `<div class="sub-h">Messages from airliners (ACARS, decoded) · ${duty || (ac.active ? "receiving now" : ac.last_at ? `receiver idle · last heard ${fmtDay(ac.last_at)}` : "receiver idle")}${ac.total ? ` · ${ac.total.toLocaleString()} archived` : ""}</div>`;
  if (rx?.note && !rx.override) html += `<div class="empty" style="padding:2px 16px 6px;text-align:left;font-size:12px">${esc(rx.note)}</div>`;
  html += (ac.messages || []).length ? `<div class="acars">${ac.messages.slice(0, 12).map((m) => `<div class="m"><b>${esc(m.flight || m.tail || "—")}</b> <span style="color:var(--text-3)">${now() - m.at > 86400 ? fmtDay(m.at) + " " : ""}${fmtTime(m.at)}</span>${m.human && window.acarsHuman ? acarsHuman(m) : `<code>${esc(m.text)}</code>`}</div>`).join("")}</div>`
    : `<div class="empty" style="padding-top:6px">No ACARS in the last few hours. The second radio switches between ADS-B and ACARS.</div>`;
  v.innerHTML = html;
}
async function openAircraft(hex) {
  S.detail = { type: "aircraft", id: hex };
  AIR.sel = hex;
  showView("detail"); setHash(`a/${hex}`);
  if (isMobile()) setSheet("mid");
  renderAircraftDetail(true);
  renderAirMap();
}
async function renderAircraftDetail(fly = false) {
  const a = (AIR.data?.aircraft || []).find((x) => x.hex === S.detail.id);
  const v = $('[data-view="detail"]');
  if (!a) { v.innerHTML = `<div class="dhead"><button type="button" class="back" data-act="back">${ICO.back}</button><div class="dtitle">Out of range</div></div><div class="empty">This aircraft isn't being heard any more.</div>`; return; }
  if (fly && a.lat != null) flyToVisible([a.lat, a.lng], Math.max(map.getZoom(), 12));
  let look = AIR.look?.[a.hex];
  v.innerHTML = `<div class="dhead"><button type="button" class="back" data-act="back" title="Back">${ICO.back}</button>
    <div class="dtitle">${esc(a.callsign || a.reg || a.hex)}</div></div>
    <div class="dmeta"><span class="acico" style="width:28px;height:28px;display:grid;place-items:center">${a.kind === "helicopter" ? HELI : PLANE}</span><div><div style="color:var(--text)">${esc(a.label)}</div>
    <div>${a.emergency ? `<span class="pill alert">Squawk ${esc(a.emergency)}</span>` : ""}${a.role ? `<span class="pill role">${esc(ROLE_NAME[a.role])}</span>` : ""}${a.circling ? `<span class="pill">Circling</span>` : ""}</div></div></div>
    ${window.acProfileCard ? `<div style="padding:0 16px">${acProfileCard({ ...a, type: a.type || look?.type_code })}</div>` : ""}
    ${look?.photo ? `<div style="padding:0 16px"><img class="ac-photo" src="${esc(look.photo)}" alt=""></div>` : ""}
    ${a.near_incident ? `<div class="overhead" data-inc-link="${a.near_incident.id}">Over <b>${esc(a.near_incident.title)}</b> · ${a.near_incident.distance_mi} mi away →</div>` : ""}
    <div class="kv">
      ${[["Registration", a.reg], ["Type", [look?.manufacturer, look?.type || a.type].filter(Boolean).join(" ")], ["Operator", look?.operator || a.operator],
         ["Altitude", a.on_ground ? "On the ground" : a.alt_ft != null ? `${a.alt_ft.toLocaleString()} ft` : null], ["Speed", a.gs_kt != null ? `${a.gs_kt} kt` : null],
         ["Heading", a.track != null ? `${Math.round(a.track)}°` : null], ["Climb", a.vs_fpm ? `${a.vs_fpm > 0 ? "+" : ""}${a.vs_fpm} ft/min` : null], ["Squawk", a.squawk],
         ["Route", look?.origin && look?.destination ? `${look.origin.iata || look.origin.icao} → ${look.destination.iata || look.destination.icao}` : null],
         ["Heard by", a.source === "verified" ? "JAFO receiver + adsb.lol" : a.source === "local" ? "JAFO's own receiver" : a.source === "demo" ? "Demo" : "adsb.lol network"], ["ICAO hex", a.hex]]
        .filter(([, v]) => v).map(([k, v]) => `<div class="item"><div class="lbl" style="font-weight:500;color:var(--text-2);width:96px">${esc(k)}</div><div>${esc(v)}</div></div>`).join("")}
    </div>`;
  if (!look && (a.reg || a.callsign) && a.source !== "demo") {
    AIR.look = AIR.look || {};
    AIR.look[a.hex] = {};
    try { AIR.look[a.hex] = await api("/api/aircraft-lookup", { reg: a.reg || "", flight: a.callsign || "", region: undefined }); } catch (e) {}
    if (S.detail?.type === "aircraft" && S.detail.id === a.hex) renderAircraftDetail();
  }
}
function markOverhead() {
  const d = S.detail.data;
  const over = (AIR.data?.aircraft || []).filter((a) => a.near_incident?.id === d.id);
  const el = $("#overhead-slot");
  if (!el) return;
  el.innerHTML = over.map((a) => `<div class="overhead" data-ac="${esc(a.hex)}">✈ <b>${esc(ROLE_NAME[a.role] || (a.kind === "helicopter" ? "Helicopter" : "Aircraft"))}</b> ${esc(a.callsign || a.reg || "")} ${a.circling ? "circling" : "flying"} ${a.near_incident.distance_mi} mi away at ${a.alt_ft?.toLocaleString?.() ?? "?"} ft</div>`).join("");
}

// ---------------------------------------------------------------- alerts (web push) + app install
const PUSH = { reg: null, sub: null, level: store.get("pushLevel", "off") };
function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function initPush() {
  if (!("serviceWorker" in navigator)) { $("#bell-chip").hidden = true; return; }
  try {
    PUSH.reg = await navigator.serviceWorker.register("/live/sw.js", { scope: "/live/" });
    PUSH.sub = await PUSH.reg.pushManager?.getSubscription();
  } catch (e) { console.warn("sw", e); }
  if (!PUSH.sub) PUSH.level = "off";
  markBell();
}
function markBell() {
  $("#bell-chip").classList.toggle("on", PUSH.level !== "off");
  $("#bell-l").textContent = PUSH.level === "off" ? "Alerts" : PUSH.level === "all" ? "All alerts" : "Priority alerts";
}
function renderBell() {
  const ios = /iphone|ipad/i.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const supported = PUSH.reg && "PushManager" in window;
  $("#bell-pop").innerHTML = `<b>Alerts on this device</b>
    <div class="seg" style="margin-top:10px">${[["off", "Off"], ["priority", "Priority"], ["all", "All"]].map(([v, l]) => `<button type="button" data-push="${v}" class="${PUSH.level === v ? "on" : ""}">${l}</button>`).join("")}</div>
    <p><b>Priority</b>: shootings, pursuits, major fires and crashes, officer emergencies — high-severity incidents only. <b>All</b> adds medium-severity incidents. Capped at 20 per hour. ${esc(CFG.regionName)} only.</p>
    ${!supported ? `<p>${ios && !standalone ? "On iPhone, add JAFO to your Home Screen first (Share → Add to Home Screen), then turn alerts on from the app." : "This browser doesn't support push alerts."}</p>` : ""}`;
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
  } catch (e) { console.warn(e); toast("Couldn't change alerts"); }
  markBell(); renderBell();
}
// Keep the screen awake while the map is open (wall / kiosk use).
let wakeLock = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepAwake(); });

// ---------------------------------------------------------------- boot
async function presence() {
  let id = store.get("cid", null);
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("cid", id); }
  try { const d = await post("/api/live/presence", { client_id: id, region: CFG.region }); $("#watching-n").textContent = d.watching; } catch (e) {}
}
async function boot() {
  bind();
  try { S.config = await api("/api/live/config"); } catch (e) { S.config = { region: {} }; }
  initMap(S.config);
  for (const name of ["units", "heat", "radar", "warnings", "cameras"]) {
    const saved = store.get("layer." + name, null);
    const el = $(`[data-layer="${name}"]`);
    if (saved !== null && el) { el.checked = saved; if (saved && ["heat", "radar", "cameras"].includes(name)) toggleLayer(name, true); }
  }
  await Promise.all([loadIncidents(), loadUnits(), loadRadio(true)]);
  loadWeather(); presence(); initPush(); keepAwake(); loadAir();
  // Real-time air: poll every 2.5 s (hub refreshes its receiver feed every 2 s);
  // markers glide between polls in animateAir().
  setInterval(() => { if (!document.hidden && !S.replay && $('[data-layer="aircraft"]').checked) loadAir(); }, 2500);
  routeHash();
  if (!store.get("toured", false)) setTimeout(() => openTour(0), 600);
  setInterval(() => { if (!document.hidden) loadIncidents(); }, 10000);
  setInterval(() => { if (!document.hidden && !S.replay) loadUnits(); }, 15000);
  setInterval(() => { if (!document.hidden) loadRadio(); }, 5000);
  setInterval(() => { if (!document.hidden) presence(); }, 30000);
  setInterval(loadWeather, 600000);
  setInterval(() => {
    // refresh relative times + live detail
    if (S.tab === "incidents" && !S.detail) renderIncidentList();
    if (S.detail?.type === "incident" && !S.replay) openIncident(S.detail.id, { fly: false });
  }, 30000);
}
boot();
})();
