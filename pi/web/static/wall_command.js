/* jafo — "command" wall display (ops center). Zero-interaction, polls the live APIs.
   ?demo=1 treats the last 24 h of incidents as active (for showing the display off). */
(() => {
"use strict";
const CFG = window.JAFO_WALL || {};
const REGION = CFG.region || "rgv";
const TZ = CFG.tz || undefined;
const qs = new URLSearchParams(location.search);
const DEMO = qs.get("demo") === "1";
const ROTATE_MS = 12000;

// ---------------------------------------------------------------- glyphs (shared with /live)
const KIND_ICON = {
  violence: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  traffic: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3.5 16h17M7 19v-3M17 19v-3M7.5 12.5h.01M16.5 12.5h.01"/>',
  medical: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11.5h2l1-2 1.5 4 1-2h1"/>',
  property: '<path d="M4 11 12 4l8 7v9H4v-9z"/><path d="M10 20v-5h4v5"/>',
  suspicious: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
  other: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
};
const KIND_SHORT = { violence: "Violence", traffic: "Traffic", medical: "Medical", property: "Property", suspicious: "Suspicious", fire: "Fire", other: "Other" };
const KINDS = Object.keys(KIND_SHORT);
const SVC_ICON = {
  police: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z"/>',
  fire: KIND_ICON.fire,
  ems: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/>',
  other: KIND_ICON.other,
};
const SVC_LABEL = { police: "Police", fire: "Fire", ems: "EMS", other: "Other" };
// Status is carried by shape, not a hue (status colors stay reserved; kinds own the hues).
const ST_ICON = {
  new: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="9"/>',
  en_route: '<path d="M6 5l13 7-13 7z" fill="currentColor" stroke="none"/>',
  on_scene: '<circle cx="12" cy="12" r="7.5" fill="currentColor" stroke="none"/>',
  cleared: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  quiet: '<circle cx="12" cy="12" r="7"/>',
  ended: '<path d="M6 12h12"/>',
  dispatched: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/>',
  transporting: '<path d="M4 6l6 6-6 6M12 6l6 6-6 6"/>',
  busy: '<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="currentColor" stroke="none"/>',
  available: '<circle cx="12" cy="12" r="7"/>',
  unknown: '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
};
const ST_LABEL = { new: "New", en_route: "En route", on_scene: "On scene", cleared: "Cleared", quiet: "Quiet", ended: "Ended",
  dispatched: "Dispatched", transporting: "Transporting", busy: "Busy", available: "Available", unknown: "Heard" };
const INC_ST_ORDER = ["new", "en_route", "on_scene", "quiet", "cleared", "ended"];
const UNIT_ST_ORDER = ["dispatched", "en_route", "on_scene", "transporting", "busy"];
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const PIN_SVG = '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>';

const svg = (p, cls = "g") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
const kchip = (k) => `<span class="kchip k-${esc(k || "other")}">${svg(KIND_ICON[k] || KIND_ICON.other)}</span>`;
const stMark = (s, label = true) => `<span class="st st-${esc(s)}">${svg(ST_ICON[s] || ST_ICON.unknown)}${label ? esc(ST_LABEL[s] || s) : ""}</span>`;
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
// Privacy markers ⟦•••⟧ become a blurred "hidden" pill — never stripped silently.
const rich = (t) => esc(t).replace(/⟦[^⟧]*⟧/g, '<span class="hid" title="Hidden for privacy">hidden</span>');
const nowS = () => Math.floor(Date.now() / 1000);
const fmtT = (ts, sec = false) => new Date(ts * 1000).toLocaleTimeString([], { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: sec ? "2-digit" : undefined, hourCycle: "h23" });
function fmtAge(s) {
  s = Math.max(0, s);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h < 24 ? `${h}h ${String(m).padStart(2, "0")}m` : `${Math.floor(h / 24)}d`;
}
const num = (n) => (n == null ? "–" : Number(n).toLocaleString());
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;

// ---------------------------------------------------------------- state
const S = {
  pulse: null, active: [], units: [], history: [], weather: null,
  lastOk: 0, failing: false, spotIdx: -1, spotId: null, detail: new Map(),
  lastTicker: "", recapIdx: -1,
};

async function getJSON(path, params = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set("region", REGION);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(u, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- map
const BIG = rem() >= 15;
let map, pinLayer, ghostLayer, alertLayer, reticle;
const pins = new Map();
const B = CFG.bounds || {};
const regionBounds = () => (B.bbox_north != null
  ? L.latLngBounds([B.bbox_south, B.bbox_west], [B.bbox_north, B.bbox_east])
  : L.latLng(B.default_lat || 26.2, B.default_lng || -98.2).toBounds(60000));

function initMap() {
  map = L.map("map", {
    zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
    boxZoom: false, keyboard: false, touchZoom: false, tap: false, zoomSnap: 0.1, zoomDelta: 0.5, fadeAnimation: true,
  });
  map.attributionControl.setPrefix(false);
  // On big (4K) walls use 512px tiles one zoom down, so roads and labels keep their 1080p size.
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", BIG
    ? { maxZoom: 18, tileSize: 512, zoomOffset: -1, attribution: "&copy; OpenStreetMap", keepBuffer: 4 }
    : { maxZoom: 18, attribution: "&copy; OpenStreetMap", keepBuffer: 4 }).addTo(map);
  map.createPane("reticle").style.zIndex = 590;
  map.createPane("ghosts").style.zIndex = 450;
  alertLayer = L.layerGroup().addTo(map);
  ghostLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  map.fitBounds(regionBounds(), { padding: [20, 20] });
}
const zoomOff = () => (BIG ? Math.log2(rem() / 20) : Math.log2(rem() / 10));
const PREC_ZOOM = { address: 14.2, block: 14.2, place: 13.6, street: 13.2, city: 12, county: 10.5 };

function flyTo(lat, lng, precision) {
  const size = map.getSize();
  const z = Math.min(16, (PREC_ZOOM[precision] || 13.4) + zoomOff());
  // place the target up-and-right of the spotlight card, not dead centre
  const target = L.point(size.x * 0.66, size.y * 0.40);
  const off = target.subtract(size.divideBy(2));
  const p = map.project([lat, lng], z).subtract(off);
  map.flyTo(map.unproject(p, z), z, { duration: 2.6, easeLinearity: 0.2 });
}
function flyOverview() {
  const pts = S.active.filter((i) => i.lat != null).map((i) => [i.lat, i.lng]);
  const b = pts.length > 1 ? L.latLngBounds(pts) : regionBounds();
  const s = map.getSize();
  map.flyToBounds(b, { paddingTopLeft: [s.x * 0.40, s.y * 0.14], paddingBottomRight: [s.x * 0.08, s.y * 0.14], duration: 2.6, maxZoom: 12.4 + zoomOff() });
}

function pinIcon(it, focus) {
  const px = Math.round(rem() * 4.2);
  const u = it.units || {};
  const badge = ["police", "fire", "ems", "other"].filter((k) => u[k] > 0)
    .map((k) => `<span>${svg(SVC_ICON[k])}${u[k]}</span>`).join("");
  return L.divIcon({
    className: "", iconSize: [px, px], iconAnchor: [px / 2, px / 2],
    html: `<div class="pin k-${esc(it.kind || "other")} st-${esc(it.status)}${focus ? " focus" : ""}" style="width:${px}px;height:${px}px;font-size:${px}px">
      <div class="ring"></div><div class="core">${svg(KIND_ICON[it.kind] || KIND_ICON.other)}</div>
      ${badge ? `<div class="ubadge">${badge}</div>` : ""}</div>`,
  });
}
function renderPins() {
  const seen = new Set();
  for (const it of S.active) {
    if (it.lat == null || it.lng == null) continue;
    seen.add(it.id);
    const focus = it.id === S.spotId;
    const sig = [it.kind, it.status, JSON.stringify(it.units || {}), focus].join("|");
    const ex = pins.get(it.id);
    if (ex) {
      if (ex.sig !== sig) { ex.m.setIcon(pinIcon(it, focus)); ex.sig = sig; }
      ex.m.setLatLng([it.lat, it.lng]);
      ex.m.setZIndexOffset(focus ? 1000 : 0);
    } else {
      const m = L.marker([it.lat, it.lng], { icon: pinIcon(it, focus), interactive: false, keyboard: false, zIndexOffset: focus ? 1000 : 0 }).addTo(pinLayer);
      pins.set(it.id, { m, sig });
    }
  }
  for (const [id, p] of pins) if (!seen.has(id)) { pinLayer.removeLayer(p.m); pins.delete(id); }
}
let ghostSig = "";
function renderGhosts() {
  const act = new Set(S.active.map((i) => i.id));
  const list = DEMO ? [] : S.history.filter((i) => !act.has(i.id) && i.lat != null);
  const sig = list.map((i) => i.id).join(",");
  if (sig === ghostSig) return;
  ghostSig = sig;
  ghostLayer.clearLayers();
  const px = Math.max(6, Math.round(rem() * 1.2));
  for (const i of list) {
    L.marker([i.lat, i.lng], { pane: "ghosts", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", iconSize: [px, px], html: `<div class="ghost k-${esc(i.kind || "other")}"></div>` }) }).addTo(ghostLayer);
  }
}
function setReticle(it, recap) {
  if (reticle) { map.removeLayer(reticle); reticle = null; }
  if (!it || it.lat == null) return;
  const px = Math.round(rem() * 26);
  const fs = Math.round(rem() * 1.4);
  const lat = `${Math.abs(it.lat).toFixed(4)}°${it.lat >= 0 ? "N" : "S"}`;
  const lng = `${Math.abs(it.lng).toFixed(4)}°${it.lng >= 0 ? "E" : "W"}`;
  reticle = L.marker([it.lat, it.lng], { pane: "reticle", interactive: false, keyboard: false,
    icon: L.divIcon({ className: "", iconSize: [px, px], iconAnchor: [px / 2, px / 2],
      html: `<div class="reticle${recap ? " recap" : ""}" style="width:${px}px;height:${px}px">
        <div class="rr r2"></div><div class="rr r1"></div><div class="rr r3"></div><div class="hx"></div><div class="vx"></div>
        <div class="coord" style="font-size:${fs}px;top:${Math.round(px*0.5+rem()*3.8)}px">${lat} ${lng}</div></div>` }) }).addTo(map);
}
let alertSig = "";
function renderAlertsMap(alerts) {
  const sig = alerts.map((a) => a.event + a.headline).join("|");
  if (sig === alertSig) return;
  alertSig = sig;
  alertLayer.clearLayers();
  for (const a of alerts) if (a.geometry) {
    try {
      L.geoJSON(a.geometry, { interactive: false, style: { color: "#f0a33a", weight: 1.5, dashArray: "6 6", fillColor: "#f0a33a", fillOpacity: 0.06 } }).addTo(alertLayer);
    } catch (e) { /* bad geometry: skip */ }
  }
}

// ---------------------------------------------------------------- ordering
function sortActive(list) {
  return list.slice().sort((a, b) =>
    (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4)
    || INC_ST_ORDER.indexOf(a.status) - INC_ST_ORDER.indexOf(b.status)
    || (b.last_at || 0) - (a.last_at || 0));
}

// ---------------------------------------------------------------- headline + rail
function renderHeadline() {
  const p = S.pulse || {};
  const h = p.headline || {};
  const n = DEMO ? S.active.length : (h.active ?? S.active.length);
  $("hActive").textContent = num(n);
  const by = {};
  for (const i of S.active) by[i.status] = (by[i.status] || 0) + 1;
  const mix = INC_ST_ORDER.filter((s) => by[s]).slice(0, 4)
    .map((s) => `<div class="st">${svg(ST_ICON[s])}<b>${by[s]}</b> ${esc(ST_LABEL[s].toLowerCase())}</div>`).join("");
  $("hMix").innerHTML = mix || `<div class="st">${svg(ST_ICON.quiet)}nothing open right now</div>`;

  $("hCalls").textContent = num(h.calls_1h);
  if (h.calls_prev_1h != null && h.calls_1h != null) {
    const d = h.calls_1h - h.calls_prev_1h;
    $("hCallsD").innerHTML = `<span class="${d >= 0 ? "up" : "dn"}">${d > 0 ? "▲" : d < 0 ? "▼" : "■"} ${num(Math.abs(d))}</span> vs prior hour`;
  }
  const uout = DEMO ? S.units.length : (h.units_out ?? S.units.length);
  $("hUnits").textContent = num(uout);
  const bySvc = {};
  for (const u of S.units) bySvc[u.service || "other"] = (bySvc[u.service || "other"] || 0) + 1;
  const svcTxt = ["police", "fire", "ems", "other"].filter((k) => bySvc[k]).map((k) => `${bySvc[k]} ${SVC_LABEL[k].toLowerCase()}`).slice(0, 2).join(" · ");
  $("hUnitsD").textContent = svcTxt || "all in service";
  $("hOpened").textContent = num(h.opened_24h);
  const o = p.opened_24h || {};
  const top = Object.entries(o).sort((a, b) => b[1] - a[1])[0];
  $("hOpenedD").textContent = top ? `most: ${KIND_SHORT[top[0]] || top[0]} (${top[1]})` : "";
}

function renderQueue(start = 0) {
  const el = $("qList");
  const all = S.active;
  const list = start ? all.slice(start).concat(all.slice(0, start)) : all;
  $("qCount").textContent = all.length ? `${list.length} open` : "";
  if (!list.length) {
    el.innerHTML = `<div class="empty">No open incidents. New ones appear here as soon as dispatch puts them on the air.</div>`;
    return;
  }
  const t = nowS();
  const rows = list.map((i) => `<div class="q-row${i.id === S.spotId ? " on" : ""}" data-id="${i.id}">
      ${kchip(i.kind)}
      <div style="min-width:0"><div class="q-t">${i.sensitive ? `<span class="sens-tag">Sensitive</span> ` : ""}${rich(i.title || i.type || "Incident")}</div>
      <div class="q-s">${rich([i.location, i.city].filter(Boolean).join(" · ") || "Location not given")}</div></div>
      <div class="q-m">${stMark(i.status)}<span class="mono">${fmtAge(t - (i.first_at || t))}</span></div></div>`);
  el.innerHTML = rows.join("");
  // trim to what fits, then say how many more there are
  const rowsEl = [...el.children];
  let hidden = 0;
  while (el.scrollHeight > el.clientHeight + 1 && rowsEl.length > 1) { rowsEl.pop().remove(); hidden++; }
  if (hidden) {
    const more = document.createElement("div");
    more.className = "q-more";
    more.textContent = `+ ${hidden} more open`;
    el.appendChild(more);
    while (el.scrollHeight > el.clientHeight + 1 && rowsEl.length > 1) { rowsEl.pop().remove(); hidden++; }
    more.textContent = `+ ${hidden} more open`;
  }
  // keep the spotlighted incident on the board: page the board to it when it's below the fold
  if (!start && S.spotId != null && !el.querySelector(`.q-row[data-id="${S.spotId}"]`)) {
    const i = all.findIndex((x) => x.id === S.spotId);
    if (i > 0) renderQueue(i);
  }
}

function renderUnits() {
  const el = $("uBoard");
  const list = S.units;
  $("uCount").textContent = list.length ? `${list.length}` : "";
  if (!list.length) {
    el.innerHTML = `<div class="empty">All units in service. None heard heading to a call.</div>`;
    $("uLegend").innerHTML = "";
    return;
  }
  let html = "";
  for (const g of ["police", "fire", "ems", "other"]) {
    const us = list.filter((u) => (u.service || "other") === g)
      .sort((a, b) => UNIT_ST_ORDER.indexOf(a.status) - UNIT_ST_ORDER.indexOf(b.status) || (b.since || 0) - (a.since || 0));
    if (!us.length) continue;
    html += `<div class="u-grp"><div class="u-gh">${svg(SVC_ICON[g])}${SVC_LABEL[g]} <b>${us.length}</b></div>
      <div class="u-list">${us.map((u) => `<span class="upill" title="${esc(ST_LABEL[u.status] || "")}">${svg(ST_ICON[u.status] || ST_ICON.unknown)}${esc(u.callsign)}</span>`).join("")}</div></div>`;
  }
  el.innerHTML = html;
  for (const ul of el.querySelectorAll(".u-list")) {
    const pills = [...ul.children];
    let cut = 0;
    while (ul.scrollHeight > ul.clientHeight + 1 && pills.length > 1) { pills.pop().remove(); cut++; }
    if (cut) {
      const m = document.createElement("span");
      m.className = "upill more";
      ul.appendChild(m);
      while (ul.scrollHeight > ul.clientHeight + 1 && pills.length > 1) { pills.pop().remove(); cut++; }
      m.textContent = `+${cut}`;
    }
  }
  const present = UNIT_ST_ORDER.filter((s) => list.some((u) => u.status === s));
  $("uLegend").innerHTML = present.map((s) => stMark(s)).join("");
}

// ---------------------------------------------------------------- spotlight
async function detailFor(id) {
  const c = S.detail.get(id);
  if (c && Date.now() - c.t < 25000) return c.d;
  try {
    const d = await Promise.race([getJSON(`/api/live/incidents/${id}`), new Promise((_, r) => setTimeout(() => r(new Error("slow")), 6000))]);
    S.detail.set(id, { t: Date.now(), d });
    if (S.detail.size > 60) S.detail.delete(S.detail.keys().next().value);
    return d;
  } catch (e) { return c ? c.d : null; }
}

function unitsHtml(it, d) {
  const ul = (d && d.units_list || []).filter((u) => u.on_this !== false);
  if (ul.length) {
    return ul.slice(0, 8).map((u) => `<span class="upill">${svg(SVC_ICON[u.service] || SVC_ICON.other, "g svc")}${esc(u.callsign)}
      <small>${svg(ST_ICON[u.status] || ST_ICON.unknown)}</small><small>${esc(ST_LABEL[u.status] || "")}</small></span>`).join("");
  }
  const u = it.units || {};
  const parts = ["police", "fire", "ems", "other"].filter((k) => u[k] > 0)
    .map((k) => `<span class="upill">${svg(SVC_ICON[k], "g svc")}${u[k]} ${SVC_LABEL[k].toLowerCase()}</span>`);
  return parts.join("") || `<span class="upill"><small>No units named on the air yet</small></span>`;
}
function locHtml(it) {
  const loc = [it.location, it.city].filter(Boolean).join(", ");
  if (!loc && it.lat != null) return `<div class="sp-loc">${svg(PIN_SVG)}<span>Approximate location</span><small>from radio traffic</small></div>`;
  const note = it.lat == null ? "not on map" : (["city", "street", "county"].includes(it.precision) ? "approximate" : "");
  return `<div class="sp-loc">${svg(PIN_SVG)}<span>${rich(loc || "Location not given")}</span>${note ? `<small>${note}</small>` : ""}</div>`;
}
function timelineHtml(d) {
  const tl = (d && d.timeline || []).slice().sort((a, b) => a.at - b.at).slice(-3);
  if (!tl.length) return "";
  return `<div class="sp-tl"><div class="sp-tl-h">Latest on the radio</div>
    ${tl.map((e) => `<div class="tl"><time>${fmtT(e.at)}</time><p>${e.channel ? `<em>${esc(e.channel)}</em>` : ""}${rich(e.line || (e.speakers || []).map((s) => s.text).join(" "))}</p></div>`).join("")}</div>`;
}
function spotActiveHtml(it, d) {
  const t = nowS();
  const sum = (d && d.summary) || it.summary || "";
  return `<div class="sp-eyebrow">${kchip(it.kind)}<span class="sp-kind">${esc(KIND_SHORT[it.kind] || "Other")}${it.type && it.type !== KIND_SHORT[it.kind] ? ` · ${esc(it.type)}` : ""}</span>
      <span class="spill st-${esc(it.status)}">${stMark(it.status)}</span>
      <span class="sp-age">${it.first_at ? `${fmtT(it.first_at)} · ${fmtAge(t - it.first_at)}` : ""}</span></div>
    <div class="sp-title">${it.sensitive ? `<span class="sens-tag">Sensitive</span> ` : ""}${rich(it.title || it.type || "Incident")}</div>
    ${locHtml(it)}
    <div class="sp-units">${unitsHtml(it, d)}</div>
    ${sum ? `<div class="sp-sum">${rich(sum)}</div>` : ""}
    ${timelineHtml(d)}`;
}
function spotQuietHtml(rc, d) {
  const p = S.pulse || {};
  const o = p.opened_24h || {};
  const total = Object.values(o).reduce((a, b) => a + b, 0);
  const mix = KINDS.filter((k) => o[k]).sort((a, b) => o[b] - o[a])
    .map((k) => `<span>${kchip(k)}<b>${o[k]}</b> ${esc(KIND_SHORT[k].toLowerCase())}</span>`).join("");
  let recap = "";
  if (rc) {
    const sum = (d && d.summary) || rc.summary || "";
    recap = `<div class="recap"><div class="sp-eyebrow">${kchip(rc.kind)}<span class="sp-kind">Earlier · ${esc(KIND_SHORT[rc.kind] || "Other")}</span>
        <span class="sp-age">${rc.first_at ? fmtT(rc.first_at) : ""}${rc.last_at ? ` – ${fmtT(rc.last_at)}` : ""}</span></div>
      <div class="sp-title">${rc.sensitive ? `<span class="sens-tag">Sensitive</span> ` : ""}${rich(rc.title || "Incident")}</div>${locHtml(rc)}${sum ? `<div class="sp-sum">${rich(sum)}</div>` : ""}</div>`;
  }
  return `<div class="quiet-h"><div class="qmark"><i></i></div><div><div class="quiet-t">All quiet</div>
      <div class="quiet-s">No open incidents. Radio is being monitored.</div></div></div>
    ${total ? `<div class="sp-tl-h">${num(total)} incidents in the last 24 h</div><div class="quiet-mix">${mix}</div>` : ""}
    ${recap}`;
}

let spotTimer = null;
function restartProgress() {
  const bar = $("spotBar");
  bar.style.transition = "none"; bar.style.width = "0";
  void bar.offsetWidth;
  bar.style.transition = `width ${ROTATE_MS}ms linear`; bar.style.width = "100%";
}
// Fixed-height card (no layout jumps): drop the oldest radio lines, then summary lines, until it fits.
function fitCard(inner) {
  const over = () => inner.scrollHeight > inner.clientHeight + 1;
  let tls = [...inner.querySelectorAll(".tl")];
  while (over() && tls.length > 1) tls.shift().remove();
  const sum = inner.querySelector(".sp-sum");
  for (let n = 2; over() && sum && n >= 1; n--) sum.style.webkitLineClamp = n;
  if (over()) { const tl = inner.querySelector(".sp-tl"); if (tl) tl.remove(); }
}
async function swapCard(html, kind) {
  const inner = $("spotIn");
  inner.classList.add("swap");
  await new Promise((r) => setTimeout(r, 420));
  inner.innerHTML = html;
  fitCard(inner);
  $("spot").className = `spot k-${kind || "other"}`;
  $("spot").style.removeProperty("--k");
  inner.classList.remove("swap");
}
async function rotate() {
  const list = S.active;
  if (list.length) {
    let i = list.findIndex((x) => x.id === S.spotId);
    i = (i + 1) % list.length;
    const it = list[i];
    S.spotId = it.id;
    const d = await detailFor(it.id);
    const cur = S.active.find((x) => x.id === it.id) || it;
    const same = S.lastFly === `${cur.id}|${cur.lat}|${cur.lng}`;
    S.lastFly = `${cur.id}|${cur.lat}|${cur.lng}`;
    await swapCard(spotActiveHtml(cur, d), cur.kind);
    $("spotCount").textContent = `${i + 1} / ${list.length}`;
    if (cur.lat != null) { if (!same) { flyTo(cur.lat, cur.lng, cur.precision); setReticle(cur, false); } }
    else if (!same) { setReticle(null); flyOverview(); }
    renderPins(); renderQueue();
  } else {
    S.spotId = null; S.lastFly = null;
    const hist = S.history.slice(0, 8);
    let rc = null, d = null;
    if (hist.length) {
      S.recapIdx = (S.recapIdx + 1) % hist.length;
      rc = hist[S.recapIdx];
      d = await detailFor(rc.id);
    }
    await swapCard(spotQuietHtml(rc, d), "other");
    $("spot").style.setProperty("--k", "var(--live)");
    $("spotCount").textContent = hist.length ? `recap ${S.recapIdx + 1} / ${hist.length}` : "";
    if (rc && rc.lat != null) { flyTo(rc.lat, rc.lng, rc.precision); setReticle(rc, true); }
    else { setReticle(null); map.flyToBounds(regionBounds(), { duration: 2.6 }); }
    renderPins();
  }
  restartProgress();
}
function markQueue() {
  for (const r of document.querySelectorAll(".q-row")) r.classList.toggle("on", Number(r.dataset.id) === S.spotId);
}
function startRotation() {
  if (spotTimer) return;
  rotate();
  spotTimer = setInterval(rotate, ROTATE_MS);
}

// ---------------------------------------------------------------- ticker / weather / chart
function renderTicker() {
  const lc = (S.pulse || {}).last_call;
  if (!lc || !lc.start_time) return;
  const key = `${lc.start_time}|${lc.call_line}`;
  if (key === S.lastTicker) return;
  const first = !S.lastTicker;
  S.lastTicker = key;
  const body = $("tkBody");
  const line = document.createElement("div");
  line.className = "tk-line" + (first ? "" : " in");
  line.innerHTML = `<span class="tk-time">${fmtT(lc.start_time, true)}</span>${lc.talkgroup_tag ? `<span class="tk-tg">${esc(lc.talkgroup_tag)}</span>` : ""}<span class="tk-text">${rich(lc.call_line || "")}</span>`;
  const old = [...body.children];
  body.appendChild(line);
  if (!first) setTimeout(() => {
    line.classList.remove("in");
    old.forEach((o) => o.classList.add("out"));
    setTimeout(() => old.forEach((o) => o.remove()), 700);
  }, 60); else old.forEach((o) => o.remove());
}

function renderWeather() {
  const w = S.weather;
  const el = $("wx");
  if (!w || !w.now) { el.innerHTML = ""; return; }
  const n = w.now;
  const text = n.text || (w.forecast && w.forecast[0] && w.forecast[0].short) || "";
  const wind = n.wind_mph ? `Wind ${n.wind_dir || ""} ${n.wind_mph} mph` : "Calm";
  const alerts = w.alerts || [];
  el.innerHTML = `${alerts.length ? `<div class="wx-warn">${svg(KIND_ICON.violence)}${alerts.length === 1 ? esc(alerts[0].event) : `${alerts.length} weather alerts`}</div>` : ""}
    <div class="wx-t">${n.temp != null ? Math.round(n.temp) + "°" : "–"}</div>
    <div class="wx-s"><b>${esc(text)}</b>${esc(wind)}${n.humidity != null ? ` · ${Math.round(n.humidity)}%` : ""}</div>`;
  const box = $("alerts");
  box.hidden = !alerts.length;
  box.innerHTML = alerts.slice(0, 2).map((a) => `<div class="alert"><b>${esc(a.event || "Alert")}</b><span>${esc(a.headline || "")}</span></div>`).join("");
  renderAlertsMap(alerts);
}

const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function localHM(ts) { const [h, m] = hourFmt.format(new Date(ts * 1000)).split(":").map(Number); return [h % 24, m]; }
function renderChart() {
  const p = S.pulse;
  const el = $("chart");
  if (!p || !p.bins_10min) return;
  const bins = p.bins_10min.map((b) => b.calls || 0);
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  const r = rem();
  const top = r * 2.4, bot = r * 2.6;
  const ch = H - top - bot;
  const n = bins.length, bw = W / n;
  const barW = Math.max(1, bw - 2);
  const max = Math.max(1, ...bins);
  const peakI = bins.indexOf(max);
  const rad = Math.min(4, barW / 2);
  const base = top + ch;
  let bars = "";
  bins.forEach((v, i) => {
    if (!v) return;
    const h = Math.max(2, (v / max) * ch);
    const x = i * bw + 1, y = base - h, rr = Math.min(rad, h);
    const cls = i === n - 1 ? "var(--accent)" : i >= n - 6 ? "#4a6f94" : "var(--bar)";
    bars += `<path d="M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + barW - rr}Q${x + barW},${y} ${x + barW},${y + rr}V${base}Z" fill="${cls}"/>`;
  });
  // hour ticks every 3 h on local time boundaries
  let ticks = "";
  for (let i = 0; i < n; i++) {
    const [h, m] = localHM(p.bins_start + i * 600);
    if (m < 10 && h % 3 === 0 && i < n - 4) {
      const x = i * bw;
      ticks += `<line x1="${x}" x2="${x}" y1="${base}" y2="${base + r * 0.6}" stroke="rgba(150,180,210,.25)"/>
        <text class="ax" x="${x}" y="${base + r * 2.1}" text-anchor="middle">${String(h).padStart(2, "0")}:00</text>`;
    }
  }
  const nowX = W - bw / 2;
  const pkX = peakI * bw + bw / 2;
  const pkLabel = `<text class="pk" x="${Math.min(W - r * 4, Math.max(r * 3, pkX))}" y="${base - (max / max) * ch - r * 0.7}" text-anchor="middle">${max}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Radio calls per 10 minutes over the last 24 hours">
    <line x1="0" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}" stroke="rgba(150,180,210,.16)"/>
    ${bars}${ticks}${pkLabel}
    <text class="ax now" x="${nowX}" y="${base + r * 2.1}" text-anchor="end">now</text></svg>`;
  const total = bins.reduce((a, b) => a + b, 0);
  const pkT = p.bins_start + peakI * 600;
  $("stripNote").innerHTML = `<b>${num(total)}</b> calls · busiest 10 min <b>${max}</b> at ${fmtT(pkT)}`;
}

// ---------------------------------------------------------------- clock / status
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", timeZoneName: "short" });
function tick() {
  const d = new Date();
  const [hm, s] = [d.toLocaleTimeString([], { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    d.toLocaleTimeString([], { timeZone: TZ, second: "2-digit" }).padStart(2, "0")];
  $("cTime").innerHTML = `${hm}<small>:${s.slice(-2)}</small>`;
  $("cDate").textContent = dateFmt.format(d);
  const conn = $("conn");
  const stale = S.lastOk && Date.now() - S.lastOk > 45000;
  const bad = S.failing || stale || !S.lastOk;
  conn.classList.toggle("bad", bad && !!S.lastOk);
  $("connT").textContent = !S.lastOk ? "Connecting" : bad ? "Reconnecting" : DEMO ? "Live · demo" : "Live";
  const pl = (S.pulse || {}).pipeline;
  const lagEl = $("lag");
  lagEl.hidden = !(pl && pl.lag_sec > 600);
  if (!lagEl.hidden) lagEl.innerHTML = `${svg('<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>')}Catching up · transcripts ${fmtAge(pl.lag_sec)} behind radio`;
  $("updated").textContent = S.lastOk ? `updated ${fmtAge((Date.now() - S.lastOk) / 1000)} ago` : "";
}

function renderWalls() {
  const ws = CFG.walls || [];
  $("walls").innerHTML = ws.map((w) => `<a class="${w === CFG.wall ? "on" : ""}" href="/live/${encodeURIComponent(REGION)}/wall/${encodeURIComponent(w)}${DEMO ? "?demo=1" : ""}">${esc(w)}</a>`).join("")
    + `<a href="/live/${encodeURIComponent(REGION)}">live map</a>`;
}

// ---------------------------------------------------------------- polling
function renderAll() {
  renderHeadline(); renderUnits(); renderQueue(); renderPins(); renderGhosts(); renderTicker(); renderChart();
}
function demoStatus(i) {
  if (!["ended", "cleared"].includes(i.status)) return i.status;
  return ["on_scene", "en_route", "new", "on_scene", "quiet"][i.id % 5];
}
async function pollPulse() {
  try {
    const p = await getJSON("/api/live/pulse");
    S.pulse = p;
    if (!DEMO) S.active = sortActive(p.active || []);
    S.lastOk = Date.now(); S.failing = false;
    renderAll();
    if (!spotTimer) startRotation();
  } catch (e) { S.failing = true; }
}
async function pollDemo() {
  try {
    const j = await getJSON("/api/live/incidents", { window: "24h" });
    S.active = sortActive((j.items || []).map((i) => ({ ...i, status: demoStatus(i) })));
    renderAll();
  } catch (e) { S.failing = true; }
}
async function pollUnits() {
  try {
    const j = await getJSON("/api/live/units", { scope: DEMO ? "all" : "out" });
    let items = j.items || [];
    if (DEMO) items = items.filter((u) => UNIT_ST_ORDER.includes(u.status));
    S.units = items;
    renderUnits(); renderHeadline(); renderQueue();
  } catch (e) { /* keep last good */ }
}
async function pollHistory() {
  if (DEMO) return;
  try {
    const j = await getJSON("/api/live/incidents", { window: "24h" });
    const act = new Set(S.active.map((i) => i.id));
    S.history = (j.items || []).filter((i) => !act.has(i.id)).sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
    renderGhosts();
  } catch (e) { /* keep last good */ }
}
async function pollWeather() {
  try { S.weather = await getJSON("/api/live/weather"); renderWeather(); } catch (e) { /* keep last good */ }
}
function every(ms, fn) { fn(); return setInterval(fn, ms); }

// Reload every 6 h to pick up code changes — only when the server answers, so a
// network blip never leaves the wall on a browser error page.
function scheduleReload() {
  setTimeout(async function tryReload() {
    try { const r = await fetch(location.href, { method: "HEAD", cache: "no-store" }); if (r.ok) return location.reload(); } catch (e) {}
    setTimeout(tryReload, 60000);
  }, 6 * 3600 * 1000);
}

function boot() {
  $("demoTag").hidden = !DEMO;
  renderWalls();
  initMap();
  setInterval(tick, 1000); tick();
  (async () => {
    if (DEMO) await pollDemo();
    await Promise.all([pollUnits(), pollHistory()]);
    every(15000, pollPulse);
  })();
  if (DEMO) setInterval(pollDemo, 30000);
  setInterval(pollUnits, 20000);
  setInterval(pollHistory, 60000);
  every(10 * 60000, pollWeather);
  setInterval(() => { renderQueue(); markQueue(); }, 30000);   // refresh ages
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { map.invalidateSize(); renderChart(); renderQueue(); pins.forEach((p) => (p.sig = "")); renderPins(); ghostSig = ""; renderGhosts(); }, 300); });
  scheduleReload();
}
boot();
})();
