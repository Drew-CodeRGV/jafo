/* JAFO River — /live redesign concept. Time is the primary axis: every incident is a
   swimlane bar on a live timeline (now at the right edge on desktop, at the top on phones),
   with the sky above it and every radio transmission below it. ?demo=1 replays the last 24 h
   as if active and uses the demo sky. */
"use strict";
const CFG = window.JAFO_LIVE || {};
const QS = new URLSearchParams(location.search);
const DEMO = QS.get("demo") === "1";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem("jafo.river." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("jafo.river." + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------------------------------------------------------------- vocabulary (shared with /live)
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
const KIND_SHORT = { violence: "Danger", traffic: "Traffic", medical: "Medical", property: "Property", suspicious: "Suspicious", fire: "Fire", other: "Other" };
const KINDS = Object.keys(KIND_LABEL);
const kindSvg = (k) => `<svg viewBox="0 0 24 24" class="kg">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
const kico = (k) => `<span class="kico k-${esc(k || "other")}">${kindSvg(k)}</span>`;
const AIR_ICON = {
  heli: '<path d="M3 5.5h18M12 5.5v3"/><path d="M6.5 13c0-2.6 2.5-4.5 5.5-4.5s5.5 1.9 5.5 4.5-2.5 3.5-5.5 3.5-5.5-.9-5.5-3.5z"/><path d="M17.3 12.2H22M22 10v4.4M8.5 20h7M10 16.4 9.3 20M14 16.4l.7 3.6"/>',
  plane: '<path d="M12 2.8c.8 0 1.2.9 1.2 2v5l7.3 4.3v1.8l-7.3-2.2v4.5l2.2 1.7v1.6L12 20.6l-3.4 1v-1.6l2.2-1.7v-4.5l-7.3 2.2v-1.8l7.3-4.3v-5c0-1.1.4-2 1.2-2z"/>',
};
const airSvg = (a, cls = "ag") => `<svg viewBox="0 0 24 24" class="${cls}${a.kind === "helicopter" ? "" : " fillg"}">${a.kind === "helicopter" ? AIR_ICON.heli : AIR_ICON.plane}</svg>`;
const ROLE_LABEL = { border: "Border Patrol", medical: "Medical", police: "Police", military: "Military", news: "News" };
const STATUS_LABEL = { new: "New", en_route: "Units on the way", on_scene: "Units on scene", cleared: "Cleared", quiet: "Quiet", ended: "Ended" };
const UNIT_STATUS = { dispatched: "Dispatched", en_route: "On the way", on_scene: "On scene", transporting: "Transporting", busy: "Busy", available: "Clear", unknown: "Heard" };
const SVC_LABEL = { police: "Police", fire: "Fire", ems: "EMS", other: "Other" };
const SVC_ROWS = ["police", "fire", "ems", "other"];
const OPEN = (i) => !i.closed && !["cleared", "ended"].includes(i.status);

// ---------------------------------------------------------------- time
const TZ = CFG.tz || undefined;
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: TZ }).toLowerCase().replace(" ", "\u202f") : "";
const fmtClock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: TZ }).toLowerCase().replace(" ", "\u202f");
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
const hourOf = (ts) => +new Date(ts * 1000).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: TZ }) % 24;
const tzOffset = (() => { // seconds to add to UTC to get region-local wall time (for tick alignment)
  const d = new Date(); const l = new Date(d.toLocaleString("en-US", { timeZone: TZ })); const u = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((l - u) / 1000);
})();
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} sec`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${h} hr ${mm} min` : `${h} hr`;
  return `${Math.floor(h / 24)} d`;
}
let clockSkew = 0;   // server now - local now
const now = () => Math.floor(Date.now() / 1000) + clockSkew;

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

// ---------------------------------------------------------------- text
function richText(text, codes = [], units = []) {
  let h = esc(text);
  h = h.replace(/⟦[^⟧]*⟧/g, '<span class="redacted" title="Hidden for privacy">hidden</span>');
  for (const c of codes || []) {
    if (!c.code || c.code.length < 2) continue;
    const re = new RegExp(`(^|[^\\w-])(${esc(c.code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]?")})(?![\\w])`, "gi");
    h = h.replace(re, `$1<span class="code" title="${esc(c.code)}: ${esc(c.meaning)}">$2</span>`);
  }
  for (const u of units || []) {
    if (!u.callsign || u.callsign.length < 3) continue;
    const re = new RegExp(`(^|[^\\w>])(${esc(u.callsign).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w<])`, "g");
    h = h.replace(re, `$1<b class="unit-ref">$2</b>`);
  }
  return h;
}
const plain = (t) => esc(String(t || "").replace(/⟦[^⟧]*⟧/g, "▒▒"));
function callText(c) {
  if (c.line) return c.line;
  const t = (c.speakers || []).map((s) => s.text).join(" ").trim();
  return t ? `“${t}”` : "(no speech)";
}
const isChatter = (c) => /chatter/i.test(c.type || "") || /^brief, unclear/i.test(c.line || "");

// ---------------------------------------------------------------- state
const S = {
  span: store.get("span", DEMO ? 21600 : 10800), pan: 0,
  kinds: new Set(), svc: "", q: "", near: null, hideChatter: store.get("hideChatter", false),
  inc: new Map(), detail: new Map(), detailAt: new Map(), unitSteps: new Map(),
  radio: new Map(), radioOldest: null, radioNewest: 0,
  air: new Map(), airLinks: new Map(), acars: null, airCounts: null,
  pulse: null, units: [], weather: null,
  sel: null, hover: null, lastOk: 0, mapOn: store.get("mapOn", true),
  layout: null, phone: false, sheet: "peek",
};
const DEMO_STATUS = ["on_scene", "en_route", "new", "on_scene", "quiet"];
function demoize(i) {
  if (!DEMO || !["ended", "cleared"].includes(i.status)) return i;
  // ?demo=1 — like the wall displays: the last 24 h is treated as live. Only fairly recent
  // incidents get a live tail to "now", so the river still reads truthfully.
  const st = DEMO_STATUS[i.id % 5];
  return { ...i, status: st, closed: false, _demoTail: now() - i.last_at < 2 * 3600 };
}

// ---------------------------------------------------------------- loaders
async function loadIncidents() {
  const reach = S.pan + S.span;
  const win = reach <= 3600 ? "1h" : reach <= 6 * 3600 ? "6h" : reach <= 86400 ? "24h" : "7d";
  try {
    const [w, a] = await Promise.all([api("/api/live/incidents", { window: DEMO && win !== "7d" ? "24h" : win }), api("/api/live/incidents", { window: "active" })]);
    if (w.now) clockSkew = w.now - Math.floor(Date.now() / 1000);
    const m = new Map();
    for (const i of [...w.items, ...a.items]) m.set(i.id, demoize(i));
    S.inc = m; S.lastOk = Date.now();
    render(); queueDetails();
  } catch (e) { S.failing = true; renderConn(); }
}
async function loadRadioNew() {
  try {
    const since = S.radioNewest || now() - 900;
    const d = await api("/api/live/radio", { since: since + 1, limit: 300 });
    for (const c of d.items) addCall(c);
    if (!S.radioOldest) await backfillRadio();
    render();
  } catch (e) {}
}
async function backfillRadio() {
  // Page backwards until the left edge of the view is covered (max ~12 pages).
  const want = now() - S.pan - S.span - 600;
  for (let n = 0; n < 12; n++) {
    if (S.radioOldest && S.radioOldest <= want) break;
    const before = S.radioOldest || now() + 60;
    let d;
    try { d = await api("/api/live/radio", { before, limit: 300 }); } catch (e) { break; }
    if (!d.items.length) { S.radioOldest = want; break; }
    for (const c of d.items) addCall(c);
    S.radioOldest = Math.min(...d.items.map((c) => c.at));
    if (n % 3 === 2) render();
  }
}
function addCall(c) {
  S.radio.set(c.id, c);
  if (c.at > S.radioNewest) S.radioNewest = c.at;
}
async function loadAir() {
  try {
    const d = await api("/api/live/air", { demo: DEMO ? 1 : undefined });
    S.airCounts = d.counts; S.acars = d.acars; S.airports = d.airports || [];
    const t = d.now || now();
    for (const a of d.aircraft || []) {
      let h = S.air.get(a.hex);
      if (!h) { h = { pts: [], first: Infinity, circ: [] }; S.air.set(a.hex, h); }
      h.a = a; h.last = t - (a.seen_sec || 0);
      for (const p of a.trail || []) if (!h.pts.length || p[3] > h.pts[h.pts.length - 1][3]) h.pts.push(p);
      h.first = Math.min(h.first, a.trail?.[0]?.[3] || h.last);
      if (a.circling) h.circ.push(h.last);
      if (a.near_incident) {
        const L = S.airLinks.get(a.near_incident.id) || new Map();
        const r = L.get(a.hex) || { hex: a.hex, a, t0: h.last, t1: h.last };
        r.t1 = h.last; r.a = a; r.circling = r.circling || a.circling; L.set(a.hex, r);
        S.airLinks.set(a.near_incident.id, L);
      }
    }
    for (const [k, h] of S.air) if (t - h.last > 86400) S.air.delete(k);
    persistAir(); render(); renderMapAir();
  } catch (e) {}
}
function persistAir() {
  try {
    const keep = [...S.air.entries()].filter(([, h]) => h.a.interesting).map(([k, h]) => [k, { a: { ...h.a, trail: [] }, pts: h.pts.slice(-400), first: h.first, last: h.last, circ: h.circ.slice(-200) }]);
    sessionStorage.setItem("jafo.river.air" + (DEMO ? ".demo" : ""), JSON.stringify(keep));
  } catch (e) {}
}
function restoreAir() {
  try { for (const [k, h] of JSON.parse(sessionStorage.getItem("jafo.river.air" + (DEMO ? ".demo" : "")) || "[]")) S.air.set(k, h); } catch (e) {}
}
async function loadPulse() {
  try { S.pulse = await api("/api/live/pulse"); renderHeadline(); renderConn(); } catch (e) {}
}
async function loadUnits() {
  try { S.units = (await api("/api/live/units", { scope: "out" })).items || []; if (!S.sel) renderPanel(); } catch (e) {}
}
async function loadWeather() {
  try {
    const w = await api("/api/live/weather"); S.weather = w;
    if (w.now?.temp != null) { $("#wx-temp").textContent = `${w.now.temp}°`; $("#wx-chip").hidden = false; }
    const al = (w.alerts || [])[0];
    $("#wx-alert").hidden = !al; if (al) $("#wx-alert").textContent = al.event || al.headline || "Weather alert";
  } catch (e) {}
}
async function presence() {
  let id = store.get("cid", null);
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("cid", id); }
  try { const d = await post("/api/live/presence", { client_id: id, region: CFG.region }); $("#watching-n").textContent = d.watching; } catch (e) {}
}

// Incident details carry units + per-call timeline; fetch them for what's in view.
let detailBusy = 0; const detailQ = [];
function queueDetails() {
  const [t0] = viewRange();
  const want = [...S.inc.values()].filter((i) => endOf(i) >= t0)
    .filter((i) => !S.detail.has(i.id) || (OPEN(i) && Date.now() - (S.detailAt.get(i.id) || 0) > 60000))
    .sort((a, b) => b.last_at - a.last_at).slice(0, 40);
  for (const i of want) if (!detailQ.includes(i.id)) detailQ.push(i.id);
  pumpDetails();
}
function pumpDetails() {
  while (detailBusy < 3 && detailQ.length) {
    const id = detailQ.shift(); detailBusy++;
    api(`/api/live/incidents/${id}`).then((d) => {
      S.detail.set(id, d); S.detailAt.set(id, Date.now());
      for (const c of d.timeline || []) if (!S.radio.has(c.id) && c.at >= (S.radioOldest || 0)) S.radio.set(c.id, { ...c, incident_id: id });
      scheduleRender();
      if (S.sel === id) renderPanel();
    }).catch(() => {}).finally(() => { detailBusy--; pumpDetails(); });
  }
}
let _rt = 0; function scheduleRender() { clearTimeout(_rt); _rt = setTimeout(render, 120); }

// ---------------------------------------------------------------- filters
function haversineMi(a, b, c, d) {
  const R = 3958.8, r = Math.PI / 180, dl = (c - a) * r, dg = (d - b) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function passes(i) {
  if (S.kinds.size && !S.kinds.has(i.kind || "other")) return false;
  if (S.svc) {
    const u = i.units || {};
    if (i.service !== S.svc && !(u[S.svc] > 0)) return false;
  }
  if (S.near) { if (i.lat == null || haversineMi(S.near[0], S.near[1], i.lat, i.lng) > 3) return false; }
  if (S.q) {
    const d = S.detail.get(i.id);
    const hay = [i.title, i.location, i.city, i.summary, i.type, KIND_LABEL[i.kind], ...(d?.units_list || []).map((u) => u.callsign)].join(" ").toLowerCase();
    if (!S.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
function callPasses(c) {
  if (S.hideChatter && isChatter(c)) return false;
  if (S.svc && (c.service || "other") !== S.svc) return false;
  if (S.kinds.size && !(c.incident_id && S.kinds.has(S.inc.get(c.incident_id)?.kind))) return false;
  if (S.q) { const hay = `${c.line} ${c.channel} ${(c.speakers || []).map((s) => s.text).join(" ")}`.toLowerCase(); if (!S.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false; }
  if (S.near && !(c.incident_id && S.inc.has(c.incident_id) && passes(S.inc.get(c.incident_id)))) return false;
  return true;
}

// ---------------------------------------------------------------- geometry
function viewRange() {
  const pad = S.phone ? S.span * 0.02 : S.span * 0.045;   // a little "future" after now
  const tR = now() - S.pan + pad;
  return [tR - S.span, tR];
}
function endOf(i) {
  const open = OPEN(i) && (!DEMO || i._demoTail !== false);
  return open ? Math.max(i.last_at, now()) : i.last_at;
}
// Status phases along an incident's bar, from what units said and when.
function phases(i) {
  const d = S.detail.get(i.id), end = endOf(i);
  const steps = S.unitSteps.get(i.id);
  let tEn = null, tOn = null;
  const ev = steps || (d?.units_list || []).filter((u) => u.on_this !== false).map((u) => ({ at: u.since, status: u.status }));
  for (const e of ev) {
    if (!e.at) continue;
    if (["dispatched", "en_route"].includes(e.status)) tEn = tEn == null ? e.at : Math.min(tEn, e.at);
    if (["on_scene", "transporting"].includes(e.status)) tOn = tOn == null ? e.at : Math.min(tOn, e.at);
  }
  if (!ev.length) {   // no unit detail yet: colour the bar by its current status
    const st = ["cleared", "ended"].includes(i.status) ? "on_scene" : i.status === "quiet" ? "on_scene" : i.status;
    return [{ s: st, a: i.first_at, b: i.last_at }];
  }
  const out = []; let cur = i.first_at;
  const push = (s, b) => { b = Math.min(b, i.last_at); if (b > cur) { out.push({ s, a: cur, b }); cur = b; } };
  if (tEn != null && (tOn == null || tEn < tOn)) { push("new", tEn); push("en_route", tOn ?? i.last_at); }
  else if (tOn != null) push("new", tOn);
  if (tOn != null) push("on_scene", i.last_at);
  if (cur < i.last_at || !out.length) out.push({ s: tOn != null ? "on_scene" : tEn != null ? "en_route" : "new", a: cur, b: Math.max(i.last_at, cur) });
  return out.map((p) => ({ ...p, b: Math.min(p.b, end) }));
}
function tickStep(span) {
  if (span <= 3600) return [600, 1800];
  if (span <= 10800) return [900, 1800];
  if (span <= 21600) return [1800, 3600];
  return [3600, 3 * 3600];
}

// ---------------------------------------------------------------- render: shared
function render() {
  S.phone = matchMedia("(max-width: 760px)").matches;
  $("#app").classList.toggle("phone", S.phone);
  document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
  if (S.phone) renderV(); else renderH();
  renderHeadline(); renderConn(); renderMapInc();
  $("#live-btn").hidden = S.pan === 0;
  if (!S.sel && (!render._panelAt || Date.now() - render._panelAt > 15000)) { renderPanel(); render._panelAt = Date.now(); }
}
function visibleIncidents() {
  const [t0, t1] = viewRange();
  return [...S.inc.values()].filter((i) => endOf(i) >= t0 - 60 && i.first_at <= t1 && passes(i));
}
function airVisible() {
  const [t0] = viewRange();
  return [...S.air.entries()].map(([hex, h]) => ({ hex, ...h })).filter((h) => h.a.interesting && h.last >= t0 && h.pts.length)
    .sort((a, b) => (b.a.emergency ? 1 : 0) - (a.a.emergency ? 1 : 0) || a.first - b.first);
}
function airTitle(a) {
  return `${a.callsign || a.reg || a.hex}`.trim();
}
function airSub(a) {
  return [a.emergency ? `Squawk ${a.emergency}` : null, ROLE_LABEL[a.role], a.kind === "helicopter" ? "Helicopter" : a.desc || a.type].filter(Boolean).join(" · ");
}
function pack(items, gap) {
  // items: {a, b} in px along time; greedy first-fit lanes. Returns lane index per item.
  const ends = [];
  for (const it of items) {
    let L = ends.findIndex((e) => e + gap <= it.a);
    if (L < 0) { L = ends.length; ends.push(-1e9); }
    ends[L] = it.b; it.lane = L;
  }
  return ends.length;
}
const KIND_ORDER = { violence: 0, fire: 1, medical: 2, traffic: 3, property: 4, suspicious: 5, other: 6 };

// ---------------------------------------------------------------- render: desktop (time → right)
function renderH() {
  const cv = $("#canvas"), W = cv.clientWidth;
  if (!W) return;
  const [t0, t1] = viewRange(), span = t1 - t0;
  const X = (t) => ((t - t0) / span) * W;
  S.layout = { X, t0, t1, W, T: (x) => t0 + (x / W) * span };
  const nx = X(now());
  // axis + grid
  const [minor, major] = tickStep(S.span);
  let ax = "";
  for (let t = Math.ceil((t0 + tzOffset) / minor) * minor - tzOffset; t <= t1; t += minor) {
    const isMaj = (t + tzOffset) % major === 0, isDay = (t + tzOffset) % 86400 === 0;
    const nearNow = X(t) > nx - 120 && X(t) < nx + 12;
    ax += `<div class="gl${isMaj ? " maj" : ""}${isDay ? " day" : ""}" style="left:${X(t).toFixed(1)}px">${(isMaj || S.span <= 3600) && !nearNow ? `<span>${isDay ? fmtDay(t) : fmtTime(t)}</span>` : ""}</div>`;
  }
  ax += `<div class="future" style="left:${nx.toFixed(1)}px"></div>`;
  $("#axis").innerHTML = ax;
  $("#nowline").style.left = `${nx.toFixed(1)}px`;
  $("#nowline").hidden = nx > W + 2;
  $("#now-l").textContent = S.pan ? fmtTime(now()) : `now ${fmtTime(now())}`;

  // ---- air lane
  const air = airVisible();
  const aItems = air.map((h) => {
    const a = X(Math.max(h.first, t0 - 60)), live = now() - h.last < 90;
    const b = Math.max(X(live ? now() : h.last), a + 4);
    const lw = 34 + airTitle(h.a).length * 7.2 + Math.min(airSub(h.a).length, 30) * 5.9;
    const inside = b - a > lw + 8, left = !inside && b + lw + 10 > W;
    return { h, a, b, live, lw, inside, left, s0: left ? a - lw - 10 : a, ext: inside || left ? b : b + lw + 8 };
  });
  const tmp = aItems.map((x) => ({ a: x.s0, b: x.ext })); const aL = pack(tmp, 10); tmp.forEach((x, k) => (aItems[k].lane = Math.min(x.lane, 5)));
  const aLanes = Math.max(1, Math.min(6, aL));
  const AH = 21;
  $("#lane-air").style.height = `${aLanes * AH + 8}px`;
  $(".rl-air").style.height = `${aLanes * AH + 8}px`;
  $("#lane-air").innerHTML = aItems.map((x) => {
    const a = x.h.a, inside = x.inside;
    const circ = (x.h.circ || []).filter((t) => t >= t0).map((t) => X(t));
    const circMarks = []; let lastC = -99; for (const cx of circ) if (cx - lastC > 18) { circMarks.push(cx); lastC = cx; }
    const near = [...S.airLinks.entries()].find(([, L]) => L.has(x.h.hex));
    return `<div class="abar${a.emergency ? " emerg" : ""}${x.live ? " live" : ""}${a.kind === "helicopter" ? " heli" : ""}" data-air="${esc(x.h.hex)}" style="left:${x.a.toFixed(1)}px;width:${(x.b - x.a).toFixed(1)}px;top:${x.lane * AH + 4}px">
      ${circMarks.map((cx) => `<i class="circ" style="left:${(cx - x.a - 5).toFixed(1)}px" title="Circling"></i>`).join("")}
      <span class="alab${inside ? "" : x.left ? " outl" : " out"}">${airSvg(a)}<b>${esc(airTitle(a))}</b><em>${esc(airSub(a))}${near ? ` · over #${near[0]}` : ""}</em></span></div>`;
  }).join("") || `<div class="lane-empty">${S.airCounts ? `Sky quiet — no notable aircraft in view${S.airCounts.total ? ` (${S.airCounts.total} routine)` : ""}` : "Listening to the sky…"}</div>`;

  // ---- incident swimlanes
  const inc = visibleIncidents().sort((a, b) => a.first_at - b.first_at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const items = inc.map((i) => {
    const a = X(i.first_at), b = Math.max(X(endOf(i)), a + 8), solidB = Math.max(X(i.last_at), a + 8);
    const lw = 34 + Math.min(i.title?.length || 8, 46) * 6.6 + (i.sensitive ? 70 : 0) + (S.airLinks.has(i.id) ? 120 : 0);
    const inside = solidB - a > lw + 10;
    const left = !inside && solidB + lw + 12 > Math.min(W, X(now()) - 4) && a - lw - 8 > 0;
    return { i, a, b, solidB, lw, inside, left, s0: left ? a - lw - 8 : a, ext: inside || left ? b : Math.max(b, solidB + lw + 8) };
  });
  const tmp2 = items.map((x) => ({ a: x.s0, b: x.ext })); const nL = pack(tmp2, 12); tmp2.forEach((x, k) => (items[k].lane = x.lane));
  const LH = S.span >= 86400 ? 32 : 38;
  const inner = $("#inc-inner");
  inner.style.height = `${Math.max(nL, 1) * LH + 16}px`;
  inner.innerHTML = items.map((x) => barH(x, X, LH)).join("") ||
    `<div class="lane-empty big">${S.inc.size ? "Nothing matches these filters in this stretch of time." : "Waiting for the first incident…"}</div>`;

  // ---- load strip: how many incidents were open at each moment
  const step = 3, pts = [];
  let peak = 0;
  for (let x = 0; x <= Math.min(W, nx); x += step) {
    const t = t0 + (x / W) * span;
    let n = 0; for (const it of items) if (it.i.first_at <= t && endOf(it.i) >= t) n++;
    pts.push([x, n]); peak = Math.max(peak, n);
  }
  const LHh = 34, sc = (n) => LHh - 4 - (n / Math.max(peak, 4)) * (LHh - 10);
  let d = `M0 ${LHh}`; for (const [x, n] of pts) d += `L${x} ${sc(n).toFixed(1)}`; d += `L${pts.length ? pts[pts.length - 1][0] : 0} ${LHh}Z`;
  let dl = ""; pts.forEach(([x, n], k) => (dl += `${k ? "L" : "M"}${x} ${sc(n).toFixed(1)}`));
  const cur = pts.length ? pts[pts.length - 1][1] : 0;
  S.layout.load = pts;
  $("#lane-load").innerHTML = `<svg width="${W}" height="${LHh}" class="loadsvg"><path d="${d}" class="la"/><path d="${dl}" class="ll"/></svg>
    <span class="load-cap">${cur} open now · peak ${peak} in view</span>`;

  drawRadioH(X, t0, t1, W);
  if (S.sel) markSelection();
}
function barH(x, X, LH) {
  const i = x.i, k = i.kind || "other", top = x.lane * LH + 8, w = x.b - x.a, solidW = x.solidB - x.a;
  const ph = phases(i);
  const segs = ph.map((p) => `<i class="seg s-${p.s}" style="left:${(X(p.a) - x.a).toFixed(1)}px;width:${Math.max(X(p.b) - X(p.a), 2).toFixed(1)}px"></i>`).join("");
  const done = !OPEN(i);
  // radio ticks for this incident
  const ticks = []; let lastT = -9;
  const calls = [...S.radio.values()].filter((c) => c.incident_id === i.id).sort((a, b) => a.at - b.at);
  for (const c of calls) { const tx = X(c.at) - x.a; if (tx - lastT >= 2.5) { ticks.push(`<i class="tick" style="left:${tx.toFixed(1)}px"></i>`); lastT = tx; } }
  // unit markers
  const d = S.detail.get(i.id);
  const um = (d?.units_list || []).filter((u) => u.since && u.since >= i.first_at - 60).map((u) =>
    `<i class="um u-${esc(u.status)}" style="left:${(Math.max(0, X(u.since) - x.a) - 4).toFixed(1)}px" title="${esc(u.callsign)} · ${esc(UNIT_STATUS[u.status] || u.status)} ${fmtTime(u.since)}"></i>`).join("");
  // aircraft overhead
  const L = S.airLinks.get(i.id);
  const am = L ? [...L.values()].map((r) => `<span class="am" style="left:${(X(r.t0) - x.a - 8).toFixed(1)}px;width:${Math.max(16, X(r.t1) - X(r.t0) + 16).toFixed(1)}px" title="${esc(airTitle(r.a))} ${r.circling ? "circling" : "overhead"}">${airSvg(r.a)}</span>`).join("") : "";
  const tail = !done && x.b - x.solidB > 2 ? `<i class="tail" style="left:${solidW.toFixed(1)}px;width:${(x.b - x.solidB).toFixed(1)}px"></i>` : "";
  const cap = done ? `<i class="cap" style="left:${(solidW - 1).toFixed(1)}px" title="${esc(STATUS_LABEL[i.status] || "Ended")}"></i>` : "";
  return `<div class="bar k-${k}${done ? " done" : " open"}${i.severity === "high" ? " hi" : ""}${S.sel === i.id ? " sel" : ""}" data-inc="${i.id}" style="left:${x.a.toFixed(1)}px;top:${top}px;width:${w.toFixed(1)}px">
    <div class="body" style="width:${Math.max(solidW, 8).toFixed(1)}px">${segs}${ticks.join("")}</div>${tail}${cap}${um}${am}
    <span class="blab${x.inside ? "" : x.left ? " out outl" : " out"}" style="${x.inside ? "" : x.left ? `right:${(w + 6).toFixed(1)}px;left:auto` : `left:${(Math.max(solidW, 8) + 5).toFixed(1)}px`}">${kico(k)}<b>${esc(i.title || i.type || "Incident")}</b>${i.sensitive ? '<em class="sens">sensitive</em>' : ""}${L ? [...L.values()].slice(0, 2).map((r) => `<em class="abadge">${airSvg(r.a)}${esc(airTitle(r.a))}${r.circling ? " circling" : ""}</em>`).join("") : ""}</span>
  </div>`;
}
let radioPts = [];
function drawRadioH(X, t0, t1, W) {
  const c = $("#radio-cv") || (() => { const e = document.createElement("canvas"); e.id = "radio-cv"; $("#lane-radio").appendChild(e); return e; })();
  const H = $("#lane-radio").clientHeight || 86, dpr = devicePixelRatio || 1;
  c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px";
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const col = (k) => css.getPropertyValue(`--k-${k}`).trim();
  const ink3 = css.getPropertyValue("--ink3").trim(), rule = css.getPropertyValue("--rule").trim();
  const rowH = 15, top = 6;
  g.strokeStyle = rule; g.lineWidth = 1;
  SVC_ROWS.forEach((_, r) => { g.beginPath(); g.moveTo(0, top + r * rowH + rowH / 2 + .5); g.lineTo(W, top + r * rowH + rowH / 2 + .5); g.stroke(); });
  // call-rate histogram along the bottom
  const binN = 72, bw = (t1 - t0) / binN, bins = new Array(binN).fill(0);
  radioPts = [];
  for (const cl of S.radio.values()) {
    if (cl.at < t0 || cl.at > t1 || !callPasses(cl)) continue;
    const b = Math.floor((cl.at - t0) / bw); if (b >= 0 && b < binN) bins[b]++;
    const row = Math.max(0, SVC_ROWS.indexOf(cl.service || "other")), x = X(cl.at), y = top + row * rowH + rowH / 2;
    radioPts.push({ x, y, c: cl });
  }
  const mx = Math.max(4, ...bins), hb = 18, by = H - 2;
  g.fillStyle = rule;
  bins.forEach((n, b) => { if (!n) return; const h = (n / mx) * hb; g.fillRect(X(t0 + b * bw) + 1, by - h, Math.max(1, W / binN - 2), h); });
  radioPts.sort((a, b) => (a.c.incident_id ? 1 : 0) - (b.c.incident_id ? 1 : 0));
  // Honest gaps: long silences in what we heard (receiver or pipeline down) are marked, not hidden.
  const ats = [...S.radio.values()].map((c) => c.at).filter((t) => t >= t0 - 3600 && t <= t1).sort((a, b) => a - b);
  let gh = "";
  if (S.radioOldest && S.radioOldest < t1) {
    const pts = [Math.max(S.radioOldest, t0), ...ats, Math.min(now(), t1)];
    for (let k = 1; k < pts.length; k++) {
      const a = Math.max(pts[k - 1], t0), b = pts[k];
      if (b - a >= 25 * 60 && X(b) - X(a) > 40) gh += `<div class="gap" style="left:${X(a).toFixed(1)}px;width:${(X(b) - X(a)).toFixed(1)}px"><span>${X(b) - X(a) > 150 ? `Nothing heard ${fmtTime(a)}–${fmtTime(b)}` : "Silent"}</span></div>`;
    }
  }
  const gl = $("#gaps") || (() => { const e = document.createElement("div"); e.id = "gaps"; $("#lane-radio").appendChild(e); return e; })();
  gl.innerHTML = gh;
  for (const p of radioPts) {
    const inc = p.c.incident_id && S.inc.get(p.c.incident_id), k = inc ? inc.kind : null;
    const chat = isChatter(p.c), r = Math.min(5, 2.2 + Math.sqrt(p.c.dur || 3) * 0.45);
    g.beginPath(); g.arc(p.x, p.y, chat ? 1.8 : r, 0, 7);
    if (k) { g.fillStyle = col(k) || ink3; g.fill(); }
    else if (chat) { g.strokeStyle = ink3; g.lineWidth = 1; g.stroke(); }
    else { g.fillStyle = ink3; g.globalAlpha = .55; g.fill(); g.globalAlpha = 1; }
    if (S.sel && p.c.incident_id === S.sel) { g.strokeStyle = css.getPropertyValue("--ink").trim(); g.lineWidth = 1.5; g.beginPath(); g.arc(p.x, p.y, r + 2.5, 0, 7); g.stroke(); }
    if (S.playing === p.c.id) { g.strokeStyle = css.getPropertyValue("--brand").trim(); g.lineWidth = 2; g.beginPath(); g.arc(p.x, p.y, r + 3.5, 0, 7); g.stroke(); }
  }
}
function markSelection() {
  $$(".bar").forEach((b) => b.classList.toggle("sel", +b.dataset.inc === S.sel));
  $("#river").classList.toggle("has-sel", !!S.sel);
}

// ---------------------------------------------------------------- render: phone (time ↓, now on top)
function renderV() {
  const cv = $("#canvas"), W = cv.clientWidth || 360;
  const [t0, t1] = viewRange(), span = t1 - t0;
  const PPS = (S.span <= 3600 ? 1200 : S.span <= 10800 ? 2400 : S.span <= 21600 ? 3200 : 6400) / span;
  const H = Math.round(span * PPS);
  const Y = (t) => (t1 - t) * PPS;
  S.layout = { Y, t0, t1, H, T: (y) => t1 - y / PPS };
  cv.style.height = `${H + 30}px`;
  const colAxis = 42, colRadio = 34, colAir = 11;
  const [minor, major] = tickStep(S.span);
  let ax = "";
  for (let t = Math.ceil((t0 + tzOffset) / minor) * minor - tzOffset; t <= t1; t += minor) {
    const isMaj = (t + tzOffset) % major === 0;
    ax += `<div class="glv${isMaj ? " maj" : ""}" style="top:${Y(t).toFixed(1)}px"><span>${isMaj || (t + tzOffset) % 1800 === 0 ? fmtTime(t) : ""}</span></div>`;
  }
  $("#axis").innerHTML = ax;
  $("#nowline").style.left = ""; $("#nowline").style.top = `${Y(now()).toFixed(1)}px`; $("#nowline").hidden = false;
  $("#now-l").textContent = `now ${fmtTime(now())}`;
  // air: narrow columns next to radio
  const air = airVisible().slice(0, 4);
  const airX0 = colAxis + colRadio + 6;
  $("#lane-air").innerHTML = air.map((h, k) => {
    const live = now() - h.last < 90, ya = Y(live ? now() : h.last), yb = Y(Math.max(h.first, t0));
    return `<div class="abar v${h.a.emergency ? " emerg" : ""}${live ? " live" : ""}" data-air="${esc(h.hex)}" style="left:${airX0 + k * colAir}px;top:${ya.toFixed(1)}px;height:${Math.max(yb - ya, 10).toFixed(1)}px">${airSvg(h.a)}</div>`;
  }).join("");
  const incX0 = airX0 + Math.max(air.length, 1) * colAir + 8;
  // incidents: vertical bars in packed columns + annotated labels on the right
  const inc = visibleIncidents().sort((a, b) => endOf(b) - endOf(a));
  const items = inc.map((i) => ({ i, a: Y(endOf(i)), b: Math.max(Y(i.first_at), Y(endOf(i)) + 10) }));
  const tmp = items.map((x) => ({ a: x.a, b: x.b })); pack(tmp, 6);
  const maxCols = 5, colW = 10;
  tmp.forEach((x, k) => (items[k].col = Math.min(x.lane, maxCols - 1)));
  const nCols = Math.min(maxCols, Math.max(1, ...items.map((x) => x.col + 1)));
  const labX = incX0 + nCols * colW + 12, labW = W - labX - 6;
  // labels: wanted at the bar's top, pushed down to avoid collisions
  let bottom = -1e9; const LABH = 58;
  const labs = items.slice().sort((a, b) => a.a - b.a).map((x) => { const y = Math.max(x.a - 4, bottom + 4); bottom = y + LABH; return { x, y }; });
  let svg = "", html = "";
  for (const { x, y } of labs) {
    const i = x.i, bx = incX0 + x.col * colW + colW / 2 + 4;
    svg += `<path d="M${bx} ${x.a + 4} C ${labX - 8} ${x.a + 4}, ${labX - 14} ${y + 12}, ${labX - 2} ${y + 12}" class="lead k-${i.kind || "other"}"/>`;
    html += `<div class="vlab${S.sel === i.id ? " sel" : ""}${OPEN(i) ? " open" : " done"}" data-inc="${i.id}" style="top:${y.toFixed(1)}px;left:${labX}px;width:${labW}px">
      ${kico(i.kind)}<div><b>${esc(i.title || i.type)}</b><span>${statusPill(i, true)} ${fmtTime(i.first_at)}</span></div></div>`;
  }
  const bars = items.map((x) => {
    const i = x.i, left = incX0 + x.col * colW + 4, done = !OPEN(i);
    const segs = phases(i).map((p) => `<i class="seg s-${p.s}" style="top:${(Y(p.b) - x.a).toFixed(1)}px;height:${Math.max(Y(p.a) - Y(p.b), 2).toFixed(1)}px"></i>`).join("");
    const solidTop = Y(i.last_at) - x.a;
    return `<div class="bar v k-${i.kind || "other"}${done ? " done" : " open"}${S.sel === i.id ? " sel" : ""}" data-inc="${i.id}" style="left:${left}px;top:${x.a.toFixed(1)}px;height:${(x.b - x.a).toFixed(1)}px;width:${colW - 3}px">
      ${!done && solidTop > 2 ? `<i class="tail v" style="height:${solidTop.toFixed(1)}px"></i>` : ""}<div class="body v" style="top:${Math.max(0, solidTop).toFixed(1)}px">${segs}</div></div>`;
  }).join("");
  const inner = $("#inc-inner"); inner.style.height = `${Math.max(H, bottom + 10)}px`;
  inner.innerHTML = `<svg class="leads" width="${W}" height="${Math.max(H, bottom + 10)}">${svg}</svg>${bars}${html}` ||
    `<div class="lane-empty big">Nothing in this stretch of time.</div>`;
  if (!items.length) inner.innerHTML += `<div class="lane-empty big" style="top:80px;left:${labX}px">Nothing matches in this stretch of time.</div>`;
  // radio column dots (canvas)
  const c = $("#radio-cv") || (() => { const e = document.createElement("canvas"); e.id = "radio-cv"; $("#lane-radio").appendChild(e); return e; })();
  const dpr = devicePixelRatio || 1; c.width = colRadio * dpr; c.height = H * dpr; c.style.width = colRadio + "px"; c.style.height = H + "px";
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, colRadio, H);
  const css = getComputedStyle(document.documentElement), ink3 = css.getPropertyValue("--ink3").trim();
  radioPts = [];
  for (const cl of S.radio.values()) {
    if (cl.at < t0 || cl.at > t1 || !callPasses(cl)) continue;
    const row = Math.max(0, SVC_ROWS.indexOf(cl.service || "other")), y = Y(cl.at), x = 5 + row * 8;
    const k = cl.incident_id && S.inc.get(cl.incident_id)?.kind;
    g.beginPath(); g.arc(x, y, 2.4, 0, 7); g.fillStyle = k ? css.getPropertyValue(`--k-${k}`).trim() : ink3; g.globalAlpha = k ? 1 : .5; g.fill(); g.globalAlpha = 1;
    radioPts.push({ x: x + colAxis, y, c: cl });
  }
  $("#lane-radio").style.left = colAxis + "px";
}
const STATUS_SHORT = { new: "New", en_route: "On the way", on_scene: "On scene", cleared: "Cleared", quiet: "Quiet", ended: "Ended" };
function statusPill(i, short) {
  const s = i.status || "new";
  return `<span class="st st-${esc(s)}"><i></i>${esc((short ? STATUS_SHORT : STATUS_LABEL)[s] || s)}</span>`;
}

// ---------------------------------------------------------------- headline / conn
function renderHeadline() {
  const vis = [...S.inc.values()].filter((i) => OPEN(i) && (!DEMO || i._demoTail !== false));
  const onScene = vis.filter((i) => i.status === "on_scene").length, enr = vis.filter((i) => i.status === "en_route").length;
  const h = S.pulse?.headline || {};
  const em = [...S.air.values()].find((x) => x.a.emergency && now() - x.last < 300);
  const helis = [...S.air.values()].filter((x) => x.a.kind === "helicopter" && now() - x.last < 120).length;
  $("#headline").innerHTML = `
    <span class="hl"><b>${vis.length}</b> open</span>
    <span class="hl sub">${onScene} on scene · ${enr} on the way</span>
    <span class="hl"><b>${h.calls_1h ?? "–"}</b> calls/hr${h.calls_prev_1h ? `<em class="${h.calls_1h > h.calls_prev_1h ? "up" : "down"}">${h.calls_1h > h.calls_prev_1h ? "▲" : "▼"}</em>` : ""}</span>
    <span class="hl"><b>${h.units_out ?? S.units.length}</b> units out</span>
    <span class="hl air">${airSvg({ kind: "helicopter" }, "ag")}<b>${helis}</b> heli${helis === 1 ? "" : "s"} up</span>
    ${em ? `<button type="button" class="hl emerg" data-air="${esc(em.a.hex)}">Squawk ${esc(em.a.emergency)} · ${esc(airTitle(em.a))}</button>` : ""}`;
}
function renderConn() {
  const ok = Date.now() - S.lastOk < 60000;
  const lag = S.pulse?.pipeline?.lag_sec || 0;
  $("#conn").textContent = !S.lastOk ? "Connecting" : !ok ? "Reconnecting" : lag > 300 ? `Live · ${fmtDur(lag)} behind` : "Live";
  $("#livedot").classList.toggle("bad", !ok);
  $("#demo-tag").hidden = !DEMO;
}

// ---------------------------------------------------------------- side panel
function renderPanel() {
  const p = $("#panel");
  if (renderPanel._mode !== (S.sel || 0)) { p.scrollTop = 0; renderPanel._mode = S.sel || 0; }
  if (S.sel) return renderStory();
  const open = [...S.inc.values()].filter((i) => OPEN(i) && (!DEMO || i._demoTail !== false) && passes(i))
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || b.last_at - a.last_at);
  const air = [...S.air.values()].filter((h) => h.a.interesting && now() - h.last < 600)
    .sort((a, b) => (b.a.emergency ? 2 : 0) + (b.a.circling ? 1 : 0) - (a.a.emergency ? 2 : 0) - (a.a.circling ? 1 : 0));
  const bySvc = {}; for (const u of S.units) (bySvc[u.service || "other"] ||= []).push(u);
  const wx = S.weather;
  p.innerHTML = `
    <div class="ph">${S.phone && S.sheet === "full" ? '<button type="button" class="back sheet-x" data-act="peek">Hide ▾</button>' : ""}<span class="eyebrow">Right now</span><h2>${open.length ? `${open.length} open incident${open.length > 1 ? "s" : ""}` : "All quiet"}</h2></div>
    <div class="openlist">${open.slice(0, 12).map((i) => `<button type="button" class="orow" data-inc="${i.id}">${kico(i.kind)}<span><b>${esc(i.title)}</b><em>${statusPill(i)} ${esc(i.city || i.location || "")} · ${fmtDur(now() - i.first_at)}</em></span></button>`).join("") || '<p class="muted">No open incidents. The river is calm.</p>'}</div>
    <div class="sect"><h3>${airSvg({ kind: "helicopter" }, "ag")} In the air</h3>
      ${air.length ? air.map((h) => `<button type="button" class="arow${h.a.emergency ? " emerg" : ""}" data-air="${esc(h.a.hex)}">${airSvg(h.a)}<span><b>${esc(airTitle(h.a))}</b> <em>${esc(airSub(h.a))}</em><small>${h.a.alt_ft ? `${h.a.alt_ft.toLocaleString()} ft` : "on ground"}${h.a.gs_kt ? ` · ${h.a.gs_kt} kt` : ""}${h.a.circling ? " · circling" : ""}${h.a.near_incident ? ` · over “${esc(h.a.near_incident.title)}”` : ""}</small></span></button>`).join("") : `<p class="muted">${S.airCounts?.total ? `${S.airCounts.total} routine aircraft overhead, nothing notable.` : "Nothing notable overhead."}</p>`}
      ${S.acars?.active && S.acars.messages?.length ? `<div class="acars"><span class="eyebrow">ACARS datalink</span>${S.acars.messages.slice(0, 4).map((m) => `<div><time>${fmtTime(m.at)}</time><b>${esc(m.flight || m.tail)}</b><code>${esc(m.text)}</code></div>`).join("")}</div>` : ""}
    </div>
    <div class="sect"><h3>Units out</h3>
      ${Object.keys(bySvc).length ? Object.entries(bySvc).map(([s, us]) => `<div class="ugrp"><span class="svc">${esc(SVC_LABEL[s] || s)}</span>${us.slice(0, 14).map((u) => `<button type="button" class="uchip u-${esc(u.status)}" ${u.incident_id ? `data-inc="${u.incident_id}"` : ""} title="${esc(u.role || "")}${u.incident_title ? " · " + esc(u.incident_title) : ""}"><i></i>${esc(u.callsign)}<em>${esc(UNIT_STATUS[u.status] || u.status)}</em></button>`).join("")}${us.length > 14 ? `<span class="muted">+${us.length - 14}</span>` : ""}</div>`).join("") : '<p class="muted">No units out.</p>'}
    </div>
    ${wx?.now ? `<div class="sect wx"><h3>Weather</h3><p><b>${wx.now.temp}°</b> ${esc(wx.now.text || "")}${wx.now.wind_mph ? ` · wind ${esc(wx.now.wind_dir)} ${wx.now.wind_mph} mph` : ""}</p>
      ${(wx.alerts || []).map((a) => `<p class="warnline">${esc(a.event || a.headline)}</p>`).join("")}
      <div class="fc">${(wx.forecast || []).slice(0, 3).map((f) => `<span><em>${esc(f.name)}</em><b>${f.temp}°</b>${esc(f.short)}</span>`).join("")}</div></div>` : ""}
    <div class="sect links"><a href="/live/${esc(CFG.region)}">Classic map</a><a href="/live/${esc(CFG.region)}#highlights">Highlights &amp; replay</a><button type="button" data-act="codes">Radio codes</button><button type="button" data-act="report">Report a problem</button></div>`;
}
async function selectInc(id, opts = {}) {
  if (!id) {
    S.sel = null; renderPanel(); markSelection(); render(); highlightMap(null); setSheet("peek");
    const R = CFG.regionInfo || {}; if (mapOk() && R.bbox_north) map.flyToBounds([[R.bbox_south, R.bbox_west], [R.bbox_north, R.bbox_east]], { duration: .5 });
    return;
  }
  S.sel = id;
  setSheet("full");
  renderPanel(); markSelection(); render();
  const i = S.inc.get(id);
  if (i?.lat != null && mapOk()) map.flyTo([i.lat, i.lng], Math.max(map.getZoom(), 13), { duration: .6 });
  // bring the bar into view if it's off the left edge
  if (i && !opts.noPan) {
    const [t0] = viewRange();
    if (endOf(i) < t0) { S.pan = Math.max(0, now() - i.last_at - S.span * 0.5); await loadIncidents(); }
  }
  if (!S.detail.has(id) || OPEN(i || {})) {
    try { const d = await api(`/api/live/incidents/${id}`); S.detail.set(id, d); S.detailAt.set(id, Date.now()); } catch (e) {}
    if (S.sel === id) { renderPanel(); render(); }
  }
  loadUnitSteps(id);
  if (S.phone) $("#side").scrollTop = 0;
}
async function loadUnitSteps(id) {
  const d = S.detail.get(id); if (!d?.units_list?.length) return;
  const steps = [];
  await Promise.all(d.units_list.slice(0, 8).map(async (u) => {
    try { const r = await api(`/api/live/units/${u.id}`); for (const a of r.activity || []) if (a.incident_id === id) steps.push({ at: a.at, status: a.status, unit: u.callsign, until: a.until }); } catch (e) {}
  }));
  if (steps.length) { S.unitSteps.set(id, steps.sort((a, b) => a.at - b.at)); if (S.sel === id) { renderPanel(); render(); } }
}
function renderStory() {
  const id = S.sel, i = S.inc.get(id) || S.detail.get(id), d = S.detail.get(id) || {};
  const p = $("#panel");
  if (!i) { p.innerHTML = `<div class="ph"><button type="button" class="back" data-act="close">‹ Back</button><p class="muted">Loading…</p></div>`; return; }
  const tl = (d.timeline || []).slice().sort((a, b) => a.at - b.at);
  const units = d.units_list || [];
  const steps = S.unitSteps.get(id) || [];
  const L = S.airLinks.get(id);
  // A merged plain-English story: calls + unit status changes, in order.
  const events = [
    ...tl.map((c) => ({ at: c.at, type: "call", c })),
    ...steps.map((s) => ({ at: s.at, type: "unit", s })),
    ...(L ? [...L.values()].map((r) => ({ at: r.t0, type: "air", r })) : []),
  ].sort((a, b) => a.at - b.at);
  const ph = phases(i);
  const end = endOf(i), dur = end - i.first_at;
  const mini = ph.map((x) => `<i class="seg s-${x.s}" style="left:${((x.a - i.first_at) / Math.max(dur, 1) * 100).toFixed(2)}%;width:${Math.max(((x.b - x.a) / Math.max(dur, 1)) * 100, 1).toFixed(2)}%" title="${esc(STATUS_LABEL[x.s])}"></i>`).join("")
    + tl.map((c) => `<i class="tick" style="left:${((c.at - i.first_at) / Math.max(dur, 1) * 100).toFixed(2)}%"></i>`).join("");
  p.innerHTML = `
    <div class="ph story k-${esc(i.kind || "other")}">
      <button type="button" class="back" data-act="close">‹ All of now</button>
      <div class="kline">${kico(i.kind)}<span>${esc(KIND_LABEL[i.kind] || "Incident")}${i.type ? ` · ${esc(i.type)}` : ""}</span>${statusPill(i)}${i.sensitive ? '<span class="sens">sensitive</span>' : ""}</div>
      <h2>${esc(i.title)}</h2>
      <p class="loc">${esc(i.location || "Location not given")}${i.city ? `, ${esc(i.city)}` : ""}</p>
      <div class="span"><span>${fmtTime(i.first_at)}</span><div class="minibar k-${esc(i.kind || "other")}">${mini}</div><span>${OPEN(i) ? "now" : fmtTime(i.last_at)}</span></div>
      <p class="meta">${fmtDur(dur)} · ${tl.length || i.calls} call${(tl.length || i.calls) === 1 ? "" : "s"} · ${units.length} unit${units.length === 1 ? "" : "s"}</p>
    </div>
    ${i.summary ? `<p class="summary">${richText(i.summary, [], units)}</p>` : ""}
    ${L ? `<div class="sect airover">${[...L.values()].map((r) => `<div>${airSvg(r.a)}<span><b>${esc(airTitle(r.a))}</b> ${esc(airSub(r.a))} ${r.circling ? "circled" : "flew"} overhead from ${fmtTime(r.t0)}${r.t1 > r.t0 + 60 ? ` to ${fmtTime(r.t1)}` : ""}</span></div>`).join("")}</div>` : ""}
    ${units.length ? `<div class="sect"><h3>Units</h3><div class="ulist">${units.map((u) => `<div class="urow u-${esc(u.status)}"><i></i><b>${esc(u.callsign)}</b><span>${esc(u.role || SVC_LABEL[u.service] || "")}</span><em>${esc(UNIT_STATUS[u.status] || u.status)}${u.since ? ` · ${fmtTime(u.since)}` : ""}</em></div>`).join("")}</div></div>` : ""}
    <div class="sect"><h3>How it unfolded</h3><ol class="story-tl">${events.map((e) => {
      if (e.type === "unit") return `<li class="ev unit"><time>${fmtTime(e.at)}</time><div><span class="ustep u-${esc(e.s.status)}"><i></i>${esc(e.s.unit)} · ${esc(UNIT_STATUS[e.s.status] || e.s.status)}</span></div></li>`;
      if (e.type === "air") return `<li class="ev air"><time>${fmtTime(e.at)}</time><div>${airSvg(e.r.a)} ${esc(airTitle(e.r.a))} ${e.r.circling ? "circling overhead" : "overhead"}</div></li>`;
      const c = e.c;
      return `<li class="ev call${isChatter(c) ? " chatter" : ""}" data-call="${c.id}"><time>${fmtTime(c.at)}</time><div>
        <p class="ln">${CFG.audio && c.audio ? `<button type="button" class="play${S.playing === c.id ? " on" : ""}" data-play="${c.id}" title="Play">${S.playing === c.id ? "❚❚" : "▶"}</button>` : ""}${richText(callText(c), c.codes, units)}</p>
        <details><summary>Words · ${esc(c.channel || "")}${c.dur ? ` · ${Math.round(c.dur)}s` : ""}</summary>
          <div class="words">${(c.speakers || []).map((s) => `<div class="turn"><span class="who">${esc(s.who || "Speaker")}</span><span class="tx">${richText(s.text, c.codes, units)}</span></div>`).join("") || '<p class="muted">No words transcribed.</p>'}
          ${(c.codes || []).length ? `<div class="codes">${c.codes.map((k) => `<span><b>${esc(k.code)}</b> ${esc(k.meaning)}</span>`).join("")}</div>` : ""}
          <button type="button" class="flag" data-report-call="${c.id}">Report this call</button></div></details></div></li>`;
    }).join("") || '<li class="muted">Loading the calls…</li>'}</ol></div>
    ${(d.people || []).length || (d.vehicles || []).length ? `<div class="sect"><h3>People &amp; vehicles</h3>${(d.people || []).map((x) => `<p class="pv"><b>${esc(x.role || "Person")}</b> ${richText(x.desc || "")}</p>`).join("")}${(d.vehicles || []).map((v) => `<p class="pv"><b>Vehicle</b> ${richText([v.color, v.year, v.make, v.model, v.desc].filter(Boolean).join(" "))}</p>`).join("")}</div>` : ""}
    ${(d.cameras || []).length ? `<div class="sect"><h3>Nearby cameras</h3><div class="cams">${d.cameras.slice(0, 4).map((c) => `<figure><img loading="lazy" src="${esc(c.img)}" alt="Traffic camera ${esc(c.name)}"><figcaption>${esc(c.name)} · ${c.distance_mi} mi ${esc(c.dir || "")}</figcaption></figure>`).join("")}</div></div>` : ""}
    ${(d.related_news || []).length ? `<div class="sect"><h3>In the news</h3>${d.related_news.map((n) => `<a class="news" href="${esc(n.url)}">${esc(n.title)}</a>`).join("")}</div>` : ""}
    <div class="sect links"><button type="button" data-report-inc="${id}">Report a problem with this incident</button><a href="/live/${esc(CFG.region)}?incident=${id}">Open on the classic map</a></div>`;
}

// ---------------------------------------------------------------- map
let map = null, incLayer = null, airLayer = null, hiLayer = null;
function mapOk() {
  if (!map || !($("#map").offsetWidth > 0 && $("#map").offsetHeight > 0)) return false;
  const z = map.getSize(); if (!z.x || !z.y || Math.abs(z.x - $("#map").offsetWidth) > 2) map.invalidateSize(false);
  return true;
}
function initMap() {
  if (!window.L) return;
  const R = CFG.regionInfo || {};
  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([R.default_lat || 26.2, R.default_lng || -98.2], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  incLayer = L.layerGroup().addTo(map); airLayer = L.layerGroup().addTo(map); hiLayer = L.layerGroup().addTo(map);
  if (R.bbox_north && mapOk()) map.fitBounds([[R.bbox_south, R.bbox_west], [R.bbox_north, R.bbox_east]], { padding: [8, 8] });
}
function renderMapInc() {
  if (!incLayer) return;
  incLayer.clearLayers();
  for (const i of visibleIncidents()) {
    if (i.lat == null) continue;
    const ic = L.divIcon({ className: "", html: `<div class="pin k-${esc(i.kind || "other")}${OPEN(i) ? " open" : " done"}${S.sel === i.id ? " sel" : ""}" data-inc="${i.id}">${kindSvg(i.kind)}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    L.marker([i.lat, i.lng], { icon: ic, zIndexOffset: S.sel === i.id ? 1000 : OPEN(i) ? 100 : 0 }).on("click", () => selectInc(i.id, { noPan: true }))
      .on("mouseover", (e) => showTip(e.originalEvent, incTip(i))).on("mouseout", hideTip).addTo(incLayer);
  }
}
function renderMapAir() {
  if (!airLayer) return;
  airLayer.clearLayers();
  for (const [hex, h] of S.air) {
    if (now() - h.last > 120 || !h.a.lat) continue;
    const a = h.a;
    if (a.interesting && h.pts.length > 1) L.polyline(h.pts.slice(-80).map((p) => [p[0], p[1]]), { className: `atrail${a.emergency ? " emerg" : ""}`, weight: 2 }).addTo(airLayer);
    const ic = L.divIcon({ className: "", html: `<div class="aplane${a.interesting ? " int" : ""}${a.emergency ? " emerg" : ""}" style="transform:rotate(${a.kind === "helicopter" ? 0 : a.track || 0}deg)">${airSvg(a)}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
    L.marker([a.lat, a.lng], { icon: ic, zIndexOffset: 500 }).on("mouseover", (e) => showTip(e.originalEvent, airTip(h))).on("mouseout", hideTip).on("click", () => focusAir(hex)).addTo(airLayer);
  }
}
function highlightMap(i) {
  if (!hiLayer) return;
  hiLayer.clearLayers();
  if (i?.lat != null) L.circleMarker([i.lat, i.lng], { radius: 20, className: `hiring k-${i.kind || "other"}`, weight: 2, fill: false }).addTo(hiLayer);
}
function focusAir(hex) {
  const h = S.air.get(hex); if (!h) return;
  if (mapOk() && h.a.lat) map.flyTo([h.a.lat, h.a.lng], 12, { duration: .6 });
  if (h.a.near_incident) selectInc(h.a.near_incident.id, { noPan: true });
}

// ---------------------------------------------------------------- tooltips
const tip = () => $("#tip");
function showTip(ev, html) {
  const t = tip(); t.innerHTML = html; t.hidden = false;
  const r = t.getBoundingClientRect(), pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  t.style.left = Math.max(8, x) + "px"; t.style.top = Math.max(8, y) + "px";
}
function hideTip() { tip().hidden = true; }
function incTip(i) {
  const d = S.detail.get(i.id), units = d?.units_list || [];
  return `<div class="tt-h">${kico(i.kind)}<b>${esc(i.title)}</b></div>
    <div class="tt-r">${statusPill(i)} <span>${fmtTime(i.first_at)}–${OPEN(i) ? "now" : fmtTime(i.last_at)} · ${fmtDur(endOf(i) - i.first_at)}</span></div>
    <div class="tt-r muted">${esc(i.location || "")}${i.city ? `, ${esc(i.city)}` : ""} · ${i.calls} call${i.calls === 1 ? "" : "s"}</div>
    ${units.length ? `<div class="tt-u">${units.slice(0, 6).map((u) => `<span class="u-${esc(u.status)}"><i></i>${esc(u.callsign)}</span>`).join("")}</div>` : ""}
    ${i.summary ? `<p>${plain(i.summary.length > 180 ? i.summary.slice(0, 178) + "…" : i.summary)}</p>` : ""}`;
}
function airTip(h) {
  const a = h.a;
  return `<div class="tt-h">${airSvg(a)}<b>${esc(airTitle(a))}</b>${a.emergency ? `<span class="sq">${esc(a.emergency)}</span>` : ""}</div>
    <div class="tt-r">${esc(airSub(a))}</div><div class="tt-r muted">${esc(a.label || "")}${a.operator ? ` · ${esc(a.operator)}` : ""}</div>
    <div class="tt-r muted">${a.alt_ft ? `${a.alt_ft.toLocaleString()} ft` : "on ground"}${a.gs_kt ? ` · ${a.gs_kt} kt` : ""}${a.circling ? " · circling" : ""} · seen ${fmtTime(h.first)}–${fmtTime(h.last)}</div>
    ${a.near_incident ? `<div class="tt-r">Over: <b>${esc(a.near_incident.title)}</b> (${a.near_incident.distance_mi} mi)</div>` : ""}`;
}
function callTip(c) {
  const inc = c.incident_id && S.inc.get(c.incident_id);
  return `<div class="tt-h"><b>${esc(c.channel || "Radio")}</b><span class="muted">${fmtClock(c.at)}${c.dur ? ` · ${Math.round(c.dur)}s` : ""}</span></div>
    <p>${plain(callText(c))}</p>${inc ? `<div class="tt-r">${kico(inc.kind)} ${esc(inc.title)}</div>` : ""}
    <div class="tt-r muted">${CFG.audio && c.audio ? "Click to play" : "Click for the words"}</div>`;
}
function nearestCall(mx, my) {
  let best = null, bd = 64;
  for (const p of radioPts) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bd) { bd = d; best = p; } }
  return best;
}

// ---------------------------------------------------------------- audio
const audio = () => $("#audio");
function playCall(c) {
  if (!CFG.audio || !c?.audio) { openCall(c); return; }
  const a = audio();
  if (S.playing === c.id && !a.paused) { a.pause(); return; }
  a.src = c.audio; a.play().catch(() => toast("Couldn't play this call"));
  S.playing = c.id;
  $("#player").hidden = false; $("#pl-t").textContent = c.channel || "Radio"; $("#pl-s").innerHTML = `${fmtClock(c.at)} · ${plain(callText(c))}`;
  render(); if (S.sel) renderStory();
}
function openCall(c) {
  if (!c) return;
  if (c.incident_id && S.inc.has(c.incident_id)) { selectInc(c.incident_id, { noPan: true }); return; }
  openModal(`<h2>${esc(c.channel || "Radio call")}</h2><p class="muted">${fmtDay(c.at)} ${fmtClock(c.at)}${c.dur ? ` · ${Math.round(c.dur)} sec` : ""}</p>
    <p class="summary">${richText(callText(c), c.codes)}</p>
    <div class="words">${(c.speakers || []).map((s) => `<div class="turn"><span class="who">${esc(s.who || "Speaker")}</span><span class="tx">${richText(s.text, c.codes)}</span></div>`).join("")}</div>
    ${(c.codes || []).length ? `<div class="codes">${c.codes.map((k) => `<span><b>${esc(k.code)}</b> ${esc(k.meaning)}</span>`).join("")}</div>` : ""}
    <div class="ffoot">${CFG.audio && c.audio ? `<button type="button" class="primary" data-play-modal="${c.id}">▶ Play</button>` : ""}<button type="button" data-report-call="${c.id}">Report this call</button></div>`);
}

// ---------------------------------------------------------------- modal, menu, report, codes
function openModal(html) { $("#modal-body").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; }
function openReport(callId, incId) {
  openModal(`<h2>Report a problem</h2><p class="muted">Reports help fix bad transcripts, wrong locations and things that shouldn't be public.</p>
    <form class="report-form" id="report-form"><select name="reason" required>
      <option value="">What's wrong?</option><option>Wrong location</option><option>Transcript is wrong</option><option>Wrong incident / grouping</option>
      <option>Private information showing</option><option>Wrong unit or status</option><option>Something else</option></select>
      <textarea name="note" rows="3" placeholder="Anything else? (optional)"></textarea>
      <div class="ffoot"><button type="button" data-act="close-modal">Cancel</button><button type="submit" class="primary">Send report</button></div></form>`);
  $("#report-form").addEventListener("submit", async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try { await post("/api/live/report", { call_id: callId || null, incident_id: incId || null, reason: fd.get("reason"), note: fd.get("note") }); toast("Report sent. Thank you."); }
    catch (err) { toast("Couldn't send the report. Try again."); }
    closeModal();
  });
}
async function openCodes() {
  openModal(`<h2>Radio codes</h2><p class="muted">Loading…</p>`);
  try {
    const d = await api("/api/live/codes");
    $("#modal-body").innerHTML = `<h2>Radio codes</h2><p class="muted">Codes heard on ${esc(CFG.regionName)} radio in the last 30 days, learned from the traffic. Treat them as a guide.</p>
      <div class="codes-list">${(d.items || []).map((c) => `<div><b>${esc(c.code)}</b><span>${esc(c.meaning)}</span></div>`).join("") || "<p>Not enough traffic yet.</p>"}</div>`;
  } catch (e) { $("#modal-body").innerHTML = `<h2>Radio codes</h2><p>Couldn't load codes.</p>`; }
}
function openAbout() {
  openModal(`<h2>Reading the river</h2>
    <p>Time flows from left to right; <b>now</b> is the bright line on the right. Each bar is one incident, from its first radio call to its last. Concurrent incidents stack, so a tall river means a busy city.</p>
    <div class="key">
      <div><i class="kb s-new"></i><span><b>New</b> outlined: reported, no units yet</span></div>
      <div><i class="kb s-en_route"></i><span><b>Units on the way</b> striped</span></div>
      <div><i class="kb s-on_scene"></i><span><b>On scene</b> solid</span></div>
      <div><i class="kb tailk"></i><span><b>Still open</b> dotted tail to now, no radio since</span></div>
      <div><i class="kb capk"></i><span><b>Cleared</b> square end cap</span></div>
      <div><i class="kb tickk"></i><span><b>Radio call</b> thin tick on the bar</span></div>
      <div><i class="kb umk"></i><span><b>Unit</b> marker where a unit reported its status</span></div>
    </div>
    <p>The <b>Air</b> lane shows notable aircraft (helicopters, Border Patrol, medical, military, emergencies); a loop marks circling, and a helicopter glyph on an incident bar means it was overhead. The <b>Radio</b> lane has a dot for every transmission, by service; coloured dots belong to an incident. Drag or scroll sideways to go back in time.</p>
    <p class="muted">Everything is machine-transcribed from public radio and may be wrong. Locations are rounded to the block.</p>`);
}
function toggleMenu(show) {
  const m = $("#menu");
  if (show === false || !m.hidden) { m.hidden = true; return; }
  const others = (CFG.concepts || []).filter((c) => c !== CFG.concept);
  m.innerHTML = `<button type="button" data-act="about">How to read the river</button>
    <button type="button" data-act="chatter">${S.hideChatter ? "Show" : "Hide"} radio chatter</button>
    <button type="button" data-act="codes">Radio codes</button>
    <a href="/live/${esc(CFG.region)}#highlights">Highlights &amp; replay</a>
    <a href="/live/${esc(CFG.region)}">Classic map view</a>
    <button type="button" data-act="report">Report a problem</button>
    <hr><span class="eyebrow">Other concepts</span>${others.map((c) => `<a href="/live/${esc(CFG.region)}/v/${esc(c)}${DEMO ? "?demo=1" : ""}">${esc(c)}</a>`).join("")}
    <a href="?${DEMO ? "" : "demo=1"}">${DEMO ? "Leave demo" : "Demo mode"}</a>`;
  m.hidden = false;
}
function setSheet(state) {
  S.sheet = state;
  $("#side").dataset.sheet = state;
  if (map) setTimeout(() => { map.invalidateSize(); const i = S.sel && S.inc.get(S.sel); if (i?.lat != null && mapOk()) map.setView([i.lat, i.lng], 14); }, 60);
}

// ---------------------------------------------------------------- input
function bind() {
  // kind chips
  $("#kinds").innerHTML = KINDS.filter((k) => k !== "other").map((k) => `<button type="button" class="kchip k-${k}" data-kind="${k}" title="${esc(KIND_LABEL[k])}">${kindSvg(k)}<span>${esc(KIND_SHORT[k])}</span></button>`).join("");
  $("#legend").innerHTML = `<span class="lg"><i class="kb s-new"></i>New</span><span class="lg"><i class="kb s-en_route"></i>On the way</span><span class="lg"><i class="kb s-on_scene"></i>On scene</span><span class="lg"><i class="kb tailk"></i>Open, quiet</span><span class="lg"><i class="kb capk"></i>Cleared</span><span class="lg"><i class="kb tickk"></i>Radio call</span><span class="lg"><i class="kb umk"></i>Unit status</span><span class="lg"><svg viewBox="0 0 24 24" class="ag">${AIR_ICON.heli}</svg>Aircraft overhead</span><button type="button" class="lg more" data-act="about">How to read this</button>`;
  $("#zoomseg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.span === S.span));
  document.addEventListener("click", onClick);
  $("#q").addEventListener("input", (e) => { S.q = e.target.value.trim(); render(); if (!S.sel) renderPanel(); });
  const cv = $("#canvas");
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerleave", () => { hideTip(); $("#cursor").hidden = true; setHover(null); });
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("wheel", (e) => {
    if (S.phone) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault(); const dx = e.shiftKey ? e.deltaY : e.deltaX;
      panBy((dx / cv.clientWidth) * S.span);
    }
  }, { passive: false });
  addEventListener("keydown", (e) => {
    if (e.target.matches("input,textarea,select")) return;
    if (e.key === "Escape") { if (!$("#modal").hidden) closeModal(); else selectInc(null); }
    if (e.key === "ArrowLeft") panBy(-S.span * 0.15);
    if (e.key === "ArrowRight") panBy(S.span * 0.15);
    if ("1234".includes(e.key) && e.key.length === 1) setSpan([3600, 10800, 21600, 86400][+e.key - 1]);
  });
  addEventListener("resize", () => { clearTimeout(bind._r); bind._r = setTimeout(() => { render(); map?.invalidateSize(); }, 150); });
  const a = audio();
  a.addEventListener("timeupdate", () => { $("#pl-prog").style.width = `${(a.currentTime / (a.duration || 1)) * 100}%`; });
  a.addEventListener("play", () => ($("#pl-btn").textContent = "❚❚"));
  a.addEventListener("pause", () => ($("#pl-btn").textContent = "▶"));
  a.addEventListener("ended", () => { S.playing = null; $("#player").hidden = true; render(); if (S.sel) renderStory(); });
  $("#pl-btn").addEventListener("click", () => (a.paused ? a.play() : a.pause()));
  $("#pl-x").addEventListener("click", () => { a.pause(); S.playing = null; $("#player").hidden = true; render(); });
  $("#side").addEventListener("click", (e) => { if (S.phone && S.sheet === "peek" && !e.target.closest("button,a,#map")) { setSheet("full"); renderPanel(); } });
}
function setSpan(s) {
  S.span = s; store.set("span", s);
  $$("#zoomseg button").forEach((b) => b.classList.toggle("on", +b.dataset.span === s));
  render(); backfillRadio().then(render); loadIncidents();
}
function panBy(sec) {
  const before = S.pan;
  S.pan = Math.max(0, Math.min(7 * 86400 - S.span, S.pan - sec));
  if (S.pan !== before) {
    render();
    clearTimeout(panBy._t); panBy._t = setTimeout(() => { loadIncidents(); backfillRadio().then(render); }, 250);
  }
}
let drag = null;
function onDown(e) {
  if (S.phone || e.button !== 0) return;
  drag = { x: e.clientX, pan: S.pan, moved: false };
  const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); setTimeout(() => (drag = null), 0); $("#canvas").classList.remove("dragging"); };
  const mv = (ev) => {
    const dx = ev.clientX - drag.x; if (Math.abs(dx) > 4) { drag.moved = true; $("#canvas").classList.add("dragging"); }
    if (drag.moved) { const sec = (dx / $("#canvas").clientWidth) * S.span; const p = Math.max(0, drag.pan + sec); if (p !== S.pan) { S.pan = p; render(); clearTimeout(panBy._t); panBy._t = setTimeout(() => { loadIncidents(); backfillRadio().then(render); }, 300); } }
  };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
}
function setHover(id) {
  if (S.hover === id) return;
  S.hover = id;
  $$(".bar.hov,.vlab.hov").forEach((b) => b.classList.remove("hov"));
  if (id) $$(`[data-inc="${id}"]`).forEach((b) => b.classList.add("hov"));
  const i = id && S.inc.get(id);
  highlightMap(i || (S.sel && S.inc.get(S.sel)));
}
function onMove(e) {
  if (drag?.moved) { hideTip(); return; }
  const cv = $("#canvas"), r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (!S.phone && S.layout?.T) {
    const c = $("#cursor"); c.hidden = false; c.style.left = mx + "px";
    const t = S.layout.T(mx);
    let open = 0; if (S.layout.load) { const p = S.layout.load[Math.round(mx / 3)]; open = p ? p[1] : null; }
    c.firstElementChild.textContent = `${fmtTime(t)}${open != null && t <= now() ? ` · ${open} open` : ""}`;
  }
  const bar = e.target.closest("[data-inc]");
  if (bar) { const i = S.inc.get(+bar.dataset.inc); if (i) { setHover(i.id); showTip(e, incTip(i)); return; } }
  const ab = e.target.closest("[data-air]");
  if (ab) { const h = S.air.get(ab.dataset.air); if (h) { setHover(null); showTip(e, airTip(h)); return; } }
  setHover(null);
  const rr = $("#lane-radio").getBoundingClientRect();
  if (e.clientY >= rr.top - 4 && e.clientY <= rr.bottom && e.clientX >= rr.left - 4 && e.clientX <= rr.right + 4) {
    const p = nearestCall(e.clientX - rr.left, e.clientY - rr.top);
    if (p) { showTip(e, callTip(p.c)); cv.style.cursor = "pointer"; return; }
  }
  cv.style.cursor = ""; hideTip();
}
function onClick(e) {
  const t = e.target;
  if (!t.closest("#menu") && !t.closest("#menu-btn")) $("#menu").hidden = true;
  if (drag?.moved) return;
  const ds = t.closest("[data-act],[data-inc],[data-air],[data-play],[data-play-modal],[data-report-call],[data-report-inc],[data-kind],[data-svc],[data-span]")?.dataset;
  if (t.closest("#modal") && t === $("#modal")) { closeModal(); return; }
  if (t.closest("#lane-radio") || (S.phone && t.closest("#canvas") && !ds)) {
    const rr = $("#lane-radio").getBoundingClientRect();
    const p = S.phone ? nearestCall(e.clientX - $("#canvas").getBoundingClientRect().left, e.clientY - rr.top) : nearestCall(e.clientX - rr.left, e.clientY - rr.top);
    if (p) { playCall(p.c); return; }
  }
  if (!ds) { if (t.closest("#canvas") && !S.phone && S.sel) selectInc(null); return; }
  if (ds.span) return setSpan(+ds.span);
  if (ds.kind) { S.kinds.has(ds.kind) ? S.kinds.delete(ds.kind) : S.kinds.add(ds.kind); $$(".kchip").forEach((b) => b.classList.toggle("on", S.kinds.has(b.dataset.kind))); $("#kinds").classList.toggle("filtering", S.kinds.size > 0); render(); if (!S.sel) renderPanel(); return; }
  if (ds.svc !== undefined) { S.svc = ds.svc; $$("#svcs button").forEach((b) => b.classList.toggle("on", b.dataset.svc === S.svc)); render(); if (!S.sel) renderPanel(); return; }
  if (ds.play) { const c = S.detail.get(S.sel)?.timeline?.find((x) => x.id === +ds.play) || S.radio.get(+ds.play); playCall(c); return; }
  if (ds.playModal) { const c = S.radio.get(+ds.playModal); closeModal(); playCall({ ...c, incident_id: null }); return; }
  if (ds.reportCall) return openReport(+ds.reportCall, S.sel);
  if (ds.reportInc) return openReport(null, +ds.reportInc);
  if (ds.inc) return selectInc(+ds.inc);
  if (ds.air) return focusAir(ds.air);
  const act = ds.act;
  if (act === "close") return selectInc(null);
  if (act === "peek") { setSheet("peek"); renderPanel(); $("#side").scrollTop = 0; return; }
  if (act === "close-modal") return closeModal();
  if (act === "codes") { toggleMenu(false); return openCodes(); }
  if (act === "about") { toggleMenu(false); return openAbout(); }
  if (act === "report") { toggleMenu(false); return openReport(null, null); }
  if (act === "chatter") { S.hideChatter = !S.hideChatter; store.set("hideChatter", S.hideChatter); toggleMenu(false); render(); return; }
}
function bindTop() {
  $("#menu-btn").addEventListener("click", () => toggleMenu());
  $("#theme-btn").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const t = dark ? "light" : "dark"; document.documentElement.dataset.theme = t;
    try { localStorage.setItem("jafo.live.theme", t); } catch (e) {}
    render();
  });
  $("#live-btn").addEventListener("click", () => { S.pan = 0; render(); loadIncidents(); });
  $("#near-btn").addEventListener("click", () => {
    if (S.near) { S.near = null; $("#near-btn").setAttribute("aria-pressed", "false"); render(); return; }
    if (!navigator.geolocation) return toast("Location isn't available in this browser.");
    navigator.geolocation.getCurrentPosition((p) => {
      S.near = [p.coords.latitude, p.coords.longitude]; $("#near-btn").setAttribute("aria-pressed", "true");
      if (mapOk()) map.flyTo(S.near, 13); render(); toast("Showing incidents within 3 miles of you");
    }, () => toast("Couldn't get your location. Check location permission."), { timeout: 8000 });
  });
  $("#map-toggle").addEventListener("click", () => { S.mapOn = !S.mapOn; store.set("mapOn", S.mapOn); $("#mapbox").classList.toggle("off", !S.mapOn); setTimeout(() => map?.invalidateSize(), 220); });
  $("#mapbox").classList.toggle("off", !S.mapOn);
}

// ---------------------------------------------------------------- boot
function tickClock() { $("#clock").textContent = fmtClock(now()); }
async function boot() {
  restoreAir(); bind(); bindTop(); setSheet("peek");
  initMap();
  tickClock(); setInterval(tickClock, 1000);
  await Promise.all([loadIncidents(), loadPulse(), loadAir()]);
  loadRadioNew(); loadUnits(); loadWeather(); presence();
  setInterval(() => { if (!document.hidden) loadIncidents(); }, 15000);
  setInterval(() => { if (!document.hidden) loadRadioNew(); }, 8000);
  setInterval(() => { if (!document.hidden) loadAir(); }, 10000);
  setInterval(() => { if (!document.hidden) loadPulse(); }, 20000);
  setInterval(() => { if (!document.hidden) loadUnits(); }, 30000);
  setInterval(() => { if (!document.hidden) render(); }, 5000);
  setInterval(loadWeather, 600000);
  setInterval(() => { if (!document.hidden) presence(); }, 30000);
  const sel = +QS.get("incident"); if (sel) selectInc(sel);
}
boot();
