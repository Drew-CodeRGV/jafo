// JAFO Briefing — a reading-first /live concept. The radio, written up like a calm local news app.
// Vanilla JS + Leaflet (map is one tap away, never the default). Talks to /api/live/* (pi/web/live.py).
(() => {
"use strict";
const CFG = window.JAFO_LIVE || {};
const CAN_PLAY = !!CFG.owner || !!CFG.audio;
const QS = new URLSearchParams(location.search);
const DEMO = QS.get("demo") === "1";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("jafo.brief." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("jafo.brief." + k, JSON.stringify(v)); } catch (e) {} },
};

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
const KIND_LABEL = { violence: "Violence and danger", traffic: "Traffic", medical: "Medical and welfare",
  property: "Property and alarms", suspicious: "Suspicious and disputes", fire: "Fire", other: "Other calls" };
const KINDS = Object.keys(KIND_LABEL);
const kindSvg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
const kico = (k, cls = "") => `<span class="kico k-${esc(k || "other")} ${cls}" title="${esc(KIND_LABEL[k] || "Other")}">${kindSvg(k)}</span>`;
const SVC_LABEL = { police: "Police", fire: "Fire", ems: "EMS", other: "Other" };
const I = {
  play: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" class="ico sm"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  map: '<svg viewBox="0 0 24 24" class="ico sm"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  heli: '<svg viewBox="0 0 24 24" class="ico"><path d="M3 5h18M12 5v3"/><path d="M6.5 13.5c0-3 2.4-5.5 5.5-5.5h1.5c2.5 0 4.5 2 4.5 4.5V14H6.5z"/><path d="M18 11h3.5M8 18h9M10 14v4M15 14v4"/></svg>',
  plane: '<svg viewBox="0 0 24 24" class="ico fill"><path d="M12 2.5c.8 0 1.3.9 1.3 2v5.3l7.2 4.3v1.9l-7.2-2.2v4.6l2.2 1.7v1.5L12 20.7l-3.5.9v-1.5l2.2-1.7v-4.6l-7.2 2.2v-1.9l7.2-4.3V4.5c0-1.1.5-2 1.3-2z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" class="ico sm"><path d="m6 9 6 6 6-6"/></svg>',
  cam: '<svg viewBox="0 0 24 24" class="ico sm"><path d="M3 8h13v9H3zM16 11l5-3v9l-5-3"/></svg>',
};
const STATUS = {
  new: { label: "Just reported", shape: '<path d="M12 4l2.2 5.8L20 12l-5.8 2.2L12 20l-2.2-5.8L4 12l5.8-2.2z"/>' },
  en_route: { label: "Help on the way", shape: '<path d="M4 12h13M12 6l6 6-6 6"/>' },
  on_scene: { label: "Crews on scene", shape: '<circle cx="12" cy="12" r="5" class="f"/><circle cx="12" cy="12" r="9"/>' },
  quiet: { label: "Quiet", shape: '<circle cx="12" cy="12" r="6"/>' },
  cleared: { label: "Wrapped up", shape: '<path d="m5 12.5 4.5 4.5L19 7.5"/>' },
  ended: { label: "Wrapped up", shape: '<path d="m5 12.5 4.5 4.5L19 7.5"/>' },
};
const pill = (st) => { const s = STATUS[st] || STATUS.quiet; return `<span class="pill st-${esc(st || "quiet")}"><svg viewBox="0 0 24 24" aria-hidden="true">${s.shape}</svg>${s.label}</span>`; };
const UNIT_ST = { dispatched: "Dispatched", en_route: "On the way", on_scene: "On scene", transporting: "Taking a patient", busy: "Busy", available: "Available", unknown: "Heard" };

// ---------------------------------------------------------------- time
const TZ = CFG.tz || undefined;
const now = () => Math.floor(Date.now() / 1000);
const fmtTime = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }).toLowerCase().replace(" ", "\u202f") : "";
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: TZ });
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
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800); }

// ---------------------------------------------------------------- state
const S = {
  items: [], wrapped: [], pulse: null, radio: [], air: null, units: [], weather: null,
  detail: new Map(),            // id -> detail
  open: new Set(),              // expanded story ids
  words: new Set(),             // call ids with words shown
  f: Object.assign({ svc: "", win: "active", kinds: [] }, store.get("f", {})),
  near: null, q: "",
  audio: new Audio(), playing: null,
  sig: "",
};
S.audio.preload = "none";

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
function streetOf(i) {
  let loc = (i.location || "").replace(/^\d+\s*(?:hundred\s+)?block of\s+/i, "").replace(/^\d+\s+(?=\D)/, "").trim();
  return loc;
}
function placeOf(i, withPrep) {
  const st = streetOf(i), city = i.city;
  if (!st && !city) return withPrep ? "" : "Location not given";
  if (!withPrep) return [st, city].filter(Boolean).join(", ");
  const prep = /(&| and | at |\/)/i.test(st) ? "at" : "on";
  return st ? ` ${prep} ${st}${city ? " in " + city : ""}` : ` in ${city}`;
}
function unitsPhrase(i, d) {
  const u = i.units || {}, parts = [];
  const list = d?.units_list?.filter((x) => x.on_this) || [];
  if (list.length === 1) return { txt: list[0].callsign, one: true };
  if (u.police) parts.push(u.police === 1 ? "a police officer" : `${numw(u.police, true)} police units`);
  if (u.fire) parts.push(u.fire === 1 ? "a fire crew" : `${numw(u.fire, true)} fire crews`);
  if (u.ems) parts.push(u.ems === 1 ? "an ambulance" : `${numw(u.ems, true)} ambulances`);
  if (!parts.length) return null;
  return { txt: parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts.at(-1) : parts[0], one: parts.length === 1 && /^an? /.test(parts[0]) };
}
function statusClause(i, d) {
  const up = unitsPhrase(i, d);
  const who = up ? up.txt : "crews", is = up ? (up.one ? "is" : "are") : "are";
  if (i.status === "on_scene") return `${who} ${is} on scene`;
  if (i.status === "en_route") return `${who} ${is} on the way`;
  if (i.status === "new") return up ? `${who} ${is} being sent` : "it was just called in";
  if (i.closed) return "it has wrapped up";
  return "the radio has gone quiet on it";
}
const unitTotal = (i) => Object.values(i.units || {}).reduce((a, b) => a + (+b || 0), 0);
const SEV = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1 };
const byImportance = (a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0) || unitTotal(b) - unitTotal(a) || b.last_at - a.last_at;
const isDeveloping = (i) => !i.closed && ((SEV[i.severity] || 0) >= 3 || ["on_scene", "en_route"].includes(i.status) || unitTotal(i) > 0 || !!airOver(i.id));

// ---------------------------------------------------------------- filters
function passes(i) {
  const f = S.f;
  if (f.svc && i.service !== f.svc && !((i.units || {})[f.svc] > 0)) return false;
  if (f.kinds.length && !f.kinds.includes(i.kind)) return false;
  if (S.q) {
    const hay = [i.title, i.summary, i.location, i.city, i.type, KIND_LABEL[i.kind]].join(" ").toLowerCase();
    if (!S.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
function saveF() { store.set("f", S.f); }

// ---------------------------------------------------------------- loading
async function loadIncidents() {
  const p = { window: S.f.win };
  if (S.f.win === "active" && DEMO) p.window = "24h";
  if (S.near) { p.near = `${S.near[0].toFixed(4)},${S.near[1].toFixed(4)}`; p.radius = 5; }
  const d = await api("/api/live/incidents", p);
  let items = d.items || [], wrapped = [];
  if (S.f.win === "active") {
    if (DEMO) { wrapped = items.filter((i) => i.closed); items = items.filter((i) => !i.closed); }
    else {
      const since = S.pulse?.today?.since || now() - 86400;
      try { const w = await api("/api/live/incidents", Object.assign({}, p, { window: "24h" })); wrapped = (w.items || []).filter((i) => i.closed && i.last_at >= since); } catch (e) {}
    }
  }
  S.items = items; S.wrapped = wrapped;
  prefetchDetails();
  render();
}
async function prefetchDetails() {
  const top = S.items.filter(passes).sort(byImportance).slice(0, 10);
  const todo = top.filter((i) => { const d = S.detail.get(i.id); return !d || d.last_at !== i.last_at; });
  let changed = false;
  await Promise.all(todo.map(async (i) => { try { S.detail.set(i.id, await api(`/api/live/incidents/${i.id}`)); changed = true; } catch (e) {} }));
  if (changed) render(true);
}
async function getDetail(id) {
  const it = [...S.items, ...S.wrapped].find((x) => x.id === id);
  const c = S.detail.get(id);
  if (c && (!it || c.last_at === it.last_at)) return c;
  const d = await api(`/api/live/incidents/${id}`); S.detail.set(id, d); return d;
}
async function loadPulse() { try { S.pulse = await api("/api/live/pulse"); renderBrief(); renderSpark(); } catch (e) {} }
async function loadRadio() {
  try { const d = await api("/api/live/radio", { limit: 30, hide_chatter: 1 }); S.radio = d.items || []; renderTicker(); } catch (e) {}
}
async function loadAir() {
  try { S.air = await api("/api/live/air", DEMO ? { demo: 1 } : {}); }
  catch (e) { S.air = null; }
  renderAirRail(); renderAirCluster(); renderBrief(); updateMapAir(); $$(".card").forEach(updateAirChip);
}
async function loadWeather() {
  try {
    const w = S.weather = await api("/api/live/weather"); const n = w.now || {};
    if (n.temp != null) { $("#wx").hidden = false; $("#wx").innerHTML = `<b>${Math.round(n.temp)}°</b> ${esc(n.text || "")}${w.forecast?.[0] ? ` <span class="dim">· ${esc(w.forecast[0].name)} ${w.forecast[0].temp}°, ${esc((w.forecast[0].short || "").toLowerCase())}</span>` : ""}`; }
    const al = w.alerts || [];
    $("#wx-alert").hidden = !al.length;
    if (al.length) $("#wx-alert").innerHTML = al.slice(0, 2).map((a) => `<div><b>${esc(a.event || a.headline || "Weather alert")}</b> ${esc(a.headline && a.event ? a.headline : a.area || "")}</div>`).join("");
  } catch (e) {}
}
async function loadUnits() { try { S.units = (await api("/api/live/units", { scope: "out" })).items || []; } catch (e) {} }
async function presence() {
  let id = store.get("cid", null); if (!id) { id = Math.random().toString(36).slice(2); store.set("cid", id); }
  try { const d = await post("/api/live/presence", { client_id: id, region: CFG.region }); $("#watching").textContent = `${d.watching} watching`; } catch (e) {}
}

// ---------------------------------------------------------------- the briefing (signature)
function aircraftName(a) {
  const R = { border: "Border Patrol helicopter", medical: "medical helicopter", police: "police helicopter", news: "TV news helicopter", military: "military aircraft" };
  if (a.role && R[a.role]) return a.role === "military" && a.kind !== "helicopter" ? `military ${a.type || "aircraft"}` : (a.kind === "helicopter" || a.role === "military" ? R[a.role] : `${a.role} aircraft`);
  if (a.kind === "helicopter") return "helicopter";
  if (a.kind === "light") return "small plane";
  if (a.kind === "commercial" || a.kind === "airline") return "airliner";
  return a.kind || "aircraft";
}
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
function ent(i) {
  const [w0, ...rest] = String(i.title || i.type || "this call").split(" ");
  return `<a class="ent k-${esc(i.kind)}" href="#story-${i.id}" data-goto="${i.id}"><span class="nw">${kindSvg(i.kind)}${esc(w0)}</span>${rest.length ? " " + esc(rest.join(" ")) : ""}</a>`;
}
function renderBrief() {
  const p = S.pulse;
  $("#dateline").textContent = fmtDate(p?.now || now()) + " · " + fmtTime(p?.now || now());
  const act = S.items.filter((i) => !i.closed).filter(passes).sort(byImportance);
  const filtered = S.f.svc || S.f.kinds.length || S.q || S.near;
  const where = S.near ? "near you" : `across ${CFG.regionName === "Lower Rio Grande Valley" ? "the Valley" : esc(CFG.regionName)}`;
  const out = [];
  if (S.f.win !== "active") {
    const n = S.items.filter(passes).length;
    out.push(`${numw(n)} ${n === 1 ? "story" : "stories"} ${S.f.win === "7d" ? "this week" : "in the last 24 hours"}${filtered ? " match your filters" : ""}.`);
  } else if (!act.length) {
    out.push(`It's quiet ${where}. Nothing ${filtered ? "matching your filters " : ""}is active on the radio right now.`);
  } else {
    const serious = act.filter((i) => (SEV[i.severity] || 0) >= 3).length;
    out.push(`${numw(act.length)} ${act.length === 1 ? "thing is" : "things are"} happening ${where}${serious && act.length > 1 ? `, ${serious === act.length ? "all" : numw(serious, true)} of them serious` : ""}${filtered ? " that match your filters" : ""}.`);
    const [a, b, c] = act;
    out.push(`${act.length > 1 ? "The biggest: " : ""}${ent(a)}${esc(placeOf(a, true))}, where ${esc(statusClause(a, S.detail.get(a.id)))}.`);
    if (b) out.push(`Also ${ent(b)}${esc(placeOf(b, true))}${c ? `, plus ${numw(act.length - 2, true)} more below` : `, where ${esc(statusClause(b, S.detail.get(b.id)))}`}.`);
  }
  const air = S.air?.aircraft || [];
  const em = air.find((x) => x.emergency);
  const over = air.find((x) => x.near_incident && x.kind === "helicopter");
  if (em) out.push(`Overhead, <a class="ent em" href="#air" data-air="${esc(em.hex)}">${I.plane}a ${esc(aircraftName(em))} is signaling an emergency</a>${em.emergency === "7700" ? "" : ` (code ${esc(em.emergency)})`}.`);
  else if (over) {
    const inc = [...S.items, ...S.wrapped].find((i) => i.id === over.near_incident.id);
    out.push(`A ${esc(aircraftName(over))} is ${over.circling ? "circling" : "flying"} over ${inc ? ent(inc) : "an active call"}.`);
  } else if (!em && (S.air?.counts?.interesting || 0) > 0) {
    const first = air.find((x) => x.interesting);
    out.push(`Overhead, a ${esc(aircraftName(first))}${S.air.counts.interesting > 1 ? ` and ${numw(S.air.counts.interesting - 1, true)} other ${S.air.counts.interesting > 2 ? "aircraft" : "aircraft"} worth noticing` : ""}.`);
  }
  $("#lede").innerHTML = out.join(" ");
  // vitals line
  if (p) {
    const h = p.headline || {}, d = (h.calls_1h || 0) - (h.calls_prev_1h || 0);
    const trend = !h.calls_prev_1h ? "" : Math.abs(d) / h.calls_prev_1h < 0.12 ? "about normal" : d > 0 ? "busier than the hour before" : "quieter than the hour before";
    $("#vitals").innerHTML = `<div><b>${h.calls_1h ?? "–"}</b> radio calls in the last hour${trend ? `, ${trend}` : ""}</div>
      <div><b>${h.units_out ?? 0}</b> units out · <b>${S.wrapped.length || p.cleared_24h || 0}</b> wrapped up ${S.wrapped.length ? "today" : "in 24 h"}${p.pipeline?.lag_sec > 300 ? ` · <span class="lag">running ${fmtDur(p.pipeline.lag_sec)} behind</span>` : ""}</div>`;
  }
}

// ---------------------------------------------------------------- sparkline (single series, 24h of 10-min bins)
function renderSpark() {
  const p = S.pulse; const el = $("#spark"); if (!p?.bins_10min?.length) { el.hidden = true; return; }
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
  return `<div class="thumb" aria-hidden="true"><span class="tw">${imgs.join("")}</span><span class="pin k-${esc(kind)}">${kindSvg(kind)}</span></div>`;
}

// ---------------------------------------------------------------- story cards
function airOver(id) { return (S.air?.aircraft || []).find((a) => a.near_incident?.id === id); }
function unitChips(i, d) {
  const list = (d?.units_list || []).filter((u) => u.on_this);
  if (list.length) return list.slice(0, 6).map((u) => `<span class="uchip s-${esc(u.service)}"><i class="ud st-${esc(u.status)}"></i>${esc(u.callsign)}<small>${esc(UNIT_ST[u.status] || "")}</small></span>`).join("") + (list.length > 6 ? `<span class="uchip more">+${list.length - 6}</span>` : "");
  const u = i.units || {};
  return ["police", "fire", "ems"].filter((k) => u[k]).map((k) => `<span class="uchip s-${k}"><i class="ud"></i>${u[k]} ${k === "ems" ? (u[k] > 1 ? "ambulances" : "ambulance") : k === "fire" ? (u[k] > 1 ? "fire crews" : "fire crew") : "police"}</span>`).join("");
}
function pullQuote(d) {
  const tl = (d?.timeline || []).slice().reverse();
  const c = tl.find((x) => !isChatter(x) && x.line) || tl[0];
  if (!c) return "";
  return `<blockquote class="pq"><p>${rich(callText(c), c.codes)}</p><footer>${esc(c.channel || "Radio")} · ${fmtTime(c.at)}</footer></blockquote>`;
}
function card(i) {
  const d = S.detail.get(i.id), open = S.open.has(i.id), heli = airOver(i.id);
  const svc = SVC_LABEL[i.service] || "Radio";
  return `<article class="card k-${esc(i.kind)}${open ? " open" : ""}${i.closed ? " closed" : ""}${(SEV[i.severity] || 0) >= 3 ? " sev" : ""}" id="story-${i.id}" data-id="${i.id}">
    <div class="c-head" data-toggle="${i.id}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="c-main">
        <div class="c-eye">${kico(i.kind)}<span>${esc(KIND_LABEL[i.kind] || "Other")}</span><span class="dot">·</span><span>${esc(svc)}</span><span class="dot">·</span><time>${esc(i.closed ? "ended " + fmtTime(i.last_at) : ago(i.last_at))}</time></div>
        <h3 class="c-title">${i.sensitive ? '<span class="sens">Sensitive</span>' : ""}${esc(i.title || i.type || "Call")}</h3>
        <div class="c-place">${esc(placeOf(i))}${i.precision && i.precision !== "block" ? ` <small>(${esc(i.precision)} level)</small>` : ""}</div>
      </div>
      ${thumb(i.lat, i.lng, i.kind)}
    </div>
    <div class="c-row">${pill(i.closed ? "ended" : i.status)}<span class="air-slot">${heli ? airChip(heli) : ""}</span>${unitChips(i, d)}</div>
    ${open ? "" : d ? pullQuote(d) : i.summary ? `<p class="c-sum">${rich(i.summary)}</p>` : ""}
    ${open ? `<div class="story" id="story-body-${i.id}">${d ? storyHtml(i, d) : '<div class="loading">Loading the full story…</div>'}</div>` : ""}
    <button type="button" class="c-more" data-toggle="${i.id}">${open ? "Show less" : "Read the full story"}${I.chev}</button>
  </article>`;
}
function airChip(a) { return `<span class="airchip" data-air="${esc(a.hex)}">${I.heli}${esc(cap(aircraftName(a)))} overhead</span>`; }
function updateAirChip(el) { const id = +el.dataset.id, a = airOver(id), s = $(".air-slot", el); if (s) s.innerHTML = a ? airChip(a) : ""; }

function storyHtml(i, d) {
  const tl = d.timeline || [];
  const dur = d.duration_sec || (d.last_at - d.first_at);
  const facts = [["First heard", fmtTime(d.first_at)], ["Latest", fmtTime(d.last_at)], ["Radio calls", d.calls ?? tl.length], ["Lasted", dur > 59 ? fmtDur(dur) : "under a minute"]];
  let h = `<p class="s-lede">${rich(d.summary || i.summary || "")}</p>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>`;
  h += `<h4>What was said</h4><ol class="tl">${tl.map((c) => {
    const w = S.words.has(c.id);
    return `<li class="${isChatter(c) ? "chat" : ""}">
      <div class="tl-t"><time>${fmtTime(c.at)}</time>${c.audio && CAN_PLAY ? `<button type="button" class="play" data-play="${c.id}" aria-label="Play this call">${S.playing === c.id ? I.pause : I.play}</button>` : ""}</div>
      <div class="tl-b"><p>${rich(callText(c), c.codes)}</p>
        <div class="tl-m">${esc(c.channel || "")}${c.dur ? ` · ${Math.round(c.dur)} sec` : ""}
          ${(c.speakers || []).length ? `<button type="button" class="link sm" data-words="${c.id}">${w ? "Hide the words" : "Show the words"}</button>` : ""}</div>
        ${w ? wordsHtml(c) : ""}</div></li>`;
  }).join("")}</ol>`;
  const ul = d.units_list || [];
  if (ul.length) h += `<h4>Who responded</h4><ul class="units">${ul.map((u) => `<li><span class="svc s-${esc(u.service)}">${esc(SVC_LABEL[u.service] || "")}</span><b>${esc(u.callsign)}</b>${u.role ? `<small>${esc(u.role)}</small>` : ""}<span class="ust st-${esc(u.status)}">${esc(UNIT_ST[u.status] || u.status || "")}</span>${u.since ? `<time>since ${fmtTime(u.since)}</time>` : ""}</li>`).join("")}</ul>`;
  const pv = [...(d.people || []).map((p) => [p.role || "Person", p.desc]), ...(d.vehicles || []).map((v) => ["Vehicle", v.desc || [v.color, v.make, v.model].filter(Boolean).join(" ")])];
  if (pv.length) h += `<h4>People and vehicles mentioned</h4><ul class="pv">${pv.map(([r, t]) => `<li><b>${esc(r)}</b>${rich(t || "")}</li>`).join("")}</ul>`;
  const heli = airOver(i.id);
  if (heli) h += `<h4>Overhead</h4>${airTile(heli, true)}`;
  if (d.cameras?.length) {
    const bust = Math.floor(Date.now() / 60000);
    h += `<h4>Nearby cameras</h4><div class="cams">${d.cameras.slice(0, 3).map((c) => `<figure><img loading="lazy" src="${esc(c.img)}&t=${bust}" alt="Traffic camera ${esc(c.name)}"><figcaption>${esc(c.name)}<small>${c.distance_mi} mi away${c.dir ? ", looking " + esc(c.dir.toLowerCase()) : ""}</small></figcaption></figure>`).join("")}</div>`;
  }
  if (d.related_news?.length) h += `<h4>In the news</h4><ul class="news">${d.related_news.slice(0, 3).map((n) => `<li><a href="${esc(n.url)}">${esc(n.title)}</a></li>`).join("")}</ul>`;
  h += `<div class="s-act">${i.lat != null ? `<button type="button" class="pillbtn" data-mapto="${i.id}">${I.map}See it on the map</button>` : ""}
    <button type="button" class="pillbtn ghost" data-report-inc="${i.id}">${I.flag}Report a problem</button></div>`;
  if (!CAN_PLAY) h += `<p class="fine">Audio stays private to the station operators. Transcripts are machine-made and can be wrong.</p>`;
  return h;
}
function wordsHtml(c) {
  return `<div class="words">${(c.speakers || []).map((s) => `<div class="turn"><span class="who">${esc(s.who || "Speaker")}</span><span>${rich(s.text, c.codes)}</span></div>`).join("")}
    ${(c.codes || []).length ? `<dl class="codes">${c.codes.map((k) => `<div><dt>${esc(k.code)}</dt><dd>${esc(k.meaning)}</dd></div>`).join("")}</dl>` : ""}</div>`;
}
function wrapRow(i) {
  if (S.open.has(i.id)) return card(i);
  return `<li class="wrow" data-toggle="${i.id}" role="button" tabindex="0" id="story-${i.id}" data-id="${i.id}">${kico(i.kind)}
    <div><b>${esc(i.title || i.type)}</b><span>${esc(placeOf(i))}</span></div><time>${fmtTime(i.last_at)}</time></li>`;
}

// ---------------------------------------------------------------- stream
let showAllWrapped = false;
function render(force) {
  const act = S.items.filter(passes).sort(byImportance);
  const wr = S.wrapped.filter(passes).sort((a, b) => b.last_at - a.last_at);
  const sig = JSON.stringify([act.map((i) => [i.id, i.last_at, i.status, !!S.detail.get(i.id)]), wr.map((i) => i.id), [...S.open], [...S.words], S.playing, showAllWrapped, S.f, S.q]);
  renderBrief();
  if (sig === S.sig && !force) return;
  S.sig = sig;
  const el = $("#stream"); let h = "";
  const sec = (title, note, body, cls = "") => `<section class="sec ${cls}"><header class="sec-h"><h2>${title}</h2>${note ? `<span>${note}</span>` : ""}</header>${body}</section>`;
  if (S.f.win !== "active") {
    const live = act.filter((i) => !i.closed), done = act.filter((i) => i.closed);
    if (live.length) h += sec("Still going", `${live.length}`, live.map(card).join(""));
    h += airClusterSlot();
    if (done.length) h += sec(S.f.win === "7d" ? "Earlier this week" : "Earlier today and overnight", `${done.length}`, `<ul class="wlist">${done.slice(0, showAllWrapped ? 400 : 20).map(wrapRow).join("")}</ul>${done.length > 20 && !showAllWrapped ? `<button type="button" class="link" data-allwrapped>Show all ${done.length}</button>` : ""}`, "wrapped");
    if (!act.length) h += emptyHtml();
  } else {
    const dev = act.filter(isDeveloping), rest = act.filter((i) => !isDeveloping(i));
    if (dev.length) h += sec("Developing", "crews are working these now", dev.map(card).join(""));
    h += airClusterSlot();
    if (rest.length) h += sec("Also on the radio", "lower-key calls, still open", rest.map(card).join(""));
    if (!act.length) h += emptyHtml();
    if (wr.length) h += sec("Wrapped up today", `${wr.length}`, `<ul class="wlist">${wr.slice(0, showAllWrapped ? 400 : 6).map(wrapRow).join("")}</ul>${wr.length > 6 && !showAllWrapped ? `<button type="button" class="link" data-allwrapped>Show all ${wr.length}</button>` : ""}`, "wrapped");
  }
  el.innerHTML = h;
  renderAirCluster();
  updateMapIncidents();
}
function emptyHtml() {
  const f = S.f.svc || S.f.kinds.length || S.q || S.near;
  return `<div class="empty"><p><b>${f ? "Nothing matches right now." : "All quiet."}</b> ${f ? "Try Everything, or widen the time with More." : "When something happens on the radio, it shows up here within a minute."}</p>${f ? '<button type="button" class="pillbtn" data-reset>Show everything</button>' : ""}</div>`;
}
async function toggleStory(id) {
  if (S.open.has(id)) { S.open.delete(id); render(true); return; }
  S.open.add(id); render(true);
  try { await getDetail(id); render(true); } catch (e) { const b = $(`#story-body-${id}`); if (b) b.innerHTML = '<div class="loading">Couldn\'t load this story. Try again in a moment.</div>'; }
}
function gotoStory(id) {
  const el = $(`#story-${id}`);
  if (!S.open.has(id)) toggleStory(id).then(() => scrollTo(id)); else scrollTo(id);
  if (!el && !S.items.concat(S.wrapped).some((i) => i.id === id)) toast("That story isn't in this view");
}
function scrollTo(id) { const el = $(`#story-${id}`); if (el) { el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1400); } }

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
  const story = a.emergency === "7700" ? "Squawking 7700, the general emergency code." : a.emergency === "7600" ? "Squawking 7600: lost radio contact." : a.emergency === "7500" ? "Squawking 7500, the hijack code." : "";
  const near = a.near_incident ? `<button type="button" class="link sm" data-goto="${a.near_incident.id}">${a.circling ? "Circling" : "Flying"} ${a.near_incident.distance_mi} mi from ${esc(a.near_incident.title)}</button>` : a.circling ? "<span>Circling</span>" : "";
  return `<div class="atile${a.emergency ? " emg" : ""}${wide ? " wide" : ""}" data-air="${esc(a.hex)}">
    <div class="a-ico"${isHeli ? "" : ` style="--rot:${a.track || 0}deg"`}>${isHeli ? I.heli : I.plane}</div>
    <div class="a-b">${tag ? `<span class="atag r-${esc(a.emergency ? "emg" : a.role || "x")}">${esc(tag)}</span>` : ""}
      <b>${esc(cap(aircraftName(a)))}</b>
      <span class="a-m">${esc(a.callsign || a.reg || a.hex)}${a.type ? " · " + esc(a.type) : ""} · ${a.on_ground ? "on the ground" : `${(a.alt_ft || 0).toLocaleString()} ft`}${a.gs_kt ? ` · ${Math.round(a.gs_kt * 1.151)} mph` : ""}</span>
      ${story ? `<span class="a-s">${story}</span>` : ""}${a.operator ? `<span class="a-o">${esc(a.operator.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()))}</span>` : ""}
      ${near ? `<span class="a-n">${near}</span>` : ""}</div>
    ${trailSvg(a)}</div>`;
}
const airClusterSlot = () => `<div id="air-slot"></div>`;
function interestingAir() {
  const air = (S.air?.aircraft || []).filter((a) => a.interesting || a.emergency || a.near_incident);
  return air.sort((a, b) => (!!b.emergency - !!a.emergency) || (!!b.near_incident - !!a.near_incident) || ((b.kind === "helicopter") - (a.kind === "helicopter")));
}
function renderAirCluster() {
  const slot = $("#air-slot"); if (!slot) return;
  const A = S.air; if (!A) { slot.innerHTML = ""; return; }
  const air = interestingAir(), c = A.counts || {};
  const ac = A.acars?.active ? (A.acars.messages || []).slice(0, 3) : [];
  if (!air.length && !ac.length) { slot.innerHTML = c.airborne ? `<p class="air-quiet">${I.plane}${c.airborne} aircraft overhead, nothing unusual.</p>` : ""; return; }
  slot.innerHTML = `<section class="sec air"><header class="sec-h"><h2>In the air</h2><span>${c.airborne ?? 0} overhead · ${c.helicopters ?? 0} helicopter${c.helicopters === 1 ? "" : "s"}${A.demo ? " · demo sky" : ""}</span></header>
    <div class="atiles">${air.map((a) => airTile(a)).join("")}</div>
    ${ac.length ? `<div class="acars"><h3>Messages from airliners <small>decoded ACARS</small></h3><ul>${ac.map((m) => `<li><time>${fmtTime(m.at)}</time><b>${esc(m.flight || m.tail)}</b><code>${esc(m.text)}</code></li>`).join("")}</ul></div>` : ""}</section>`;
}
function renderAirRail() {
  const el = $("#rail-air"); const A = S.air;
  if (!A) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;
  const air = interestingAir().slice(0, 5), c = A.counts || {};
  el.innerHTML = `<div class="rh">${I.plane}In the air <span class="rn">${c.airborne ?? 0} overhead</span></div>
    ${air.length ? `<ul class="rair">${air.map((a) => `<li data-air="${esc(a.hex)}" class="${a.emergency ? "emg" : ""}"><span class="a-ico sm"${a.kind === "helicopter" ? "" : ` style="--rot:${a.track || 0}deg"`}>${a.kind === "helicopter" ? I.heli : I.plane}</span><div><b>${esc(cap(aircraftName(a)))}</b><small>${a.emergency ? `Emergency ${esc(a.emergency)} · ` : ""}${a.near_incident ? `over ${esc(a.near_incident.title)}` : `${(a.alt_ft || 0).toLocaleString()} ft${a.circling ? " · circling" : ""}`}</small></div></li>`).join("")}</ul>` : `<p class="dim sm">Nothing unusual overhead.</p>`}`;
}

// ---------------------------------------------------------------- radio ticker + radio sheet
function radioLine(c, full) {
  const inc = c.incident_id ? [...S.items, ...S.wrapped].find((i) => i.id === c.incident_id) : null;
  return `<li class="${isChatter(c) ? "chat" : ""}"><div class="rl-m"><time>${fmtTime(c.at)}</time><span>${esc(c.channel || "")}</span>
    ${full && c.audio && CAN_PLAY ? `<button type="button" class="play" data-play="${c.id}" aria-label="Play">${S.playing === c.id ? I.pause : I.play}</button>` : ""}</div>
    <p>${rich(callText(c), c.codes)}</p>
    ${inc ? `<button type="button" class="rinc" data-goto="${inc.id}">${kico(inc.kind)}${esc(inc.title)}</button>` : ""}
    ${full && (c.speakers || []).length ? `<button type="button" class="link sm" data-words="${c.id}">${S.words.has(c.id) ? "Hide the words" : "Show the words"}</button>${S.words.has(c.id) ? wordsHtml(c) : ""}` : ""}</li>`;
}
let tickerTop = 0;
function renderTicker() {
  const items = S.radio.filter((c) => !isChatter(c)).slice(0, 12);
  const el = $("#ticker"); const prev = tickerTop;
  el.innerHTML = items.map((c) => radioLine(c)).join("");
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

// ---------------------------------------------------------------- audio
function findCall(id) {
  for (const d of S.detail.values()) { const c = (d.timeline || []).find((x) => x.id === id); if (c) return c; }
  return [...S.radio, ...radioExtra].find((x) => x.id === id);
}
function play(id) {
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

// ---------------------------------------------------------------- maps
const TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
let mini, miniInc, miniAir, big, bigInc, bigAir, bigMe, showAir = true;
const R = CFG.regionBox || {};
const bounds = () => R.bbox_north != null ? [[R.bbox_south, R.bbox_west], [R.bbox_north, R.bbox_east]] : null;
const incIcon = (i, sz = 30) => L.divIcon({ className: "", html: `<span class="mk k-${esc(i.kind)}${i.closed ? " done" : ""}${(SEV[i.severity] || 0) >= 3 && !i.closed ? " sev" : ""}" style="--s:${sz}px">${kindSvg(i.kind)}</span>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
const airIcon = (a) => L.divIcon({ className: "", html: `<span class="amk${a.emergency ? " emg" : ""}${a.interesting ? " int" : ""}"${a.kind === "helicopter" ? "" : ` style="--rot:${a.track || 0}deg"`}>${a.kind === "helicopter" ? I.heli : I.plane}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
function initMini() {
  if (mini || !window.L || getComputedStyle($(".rail")).display === "none") return;
  mini = L.map("minimap", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
  const b = bounds(); b ? mini.fitBounds(b, { padding: [-30, -30] }) : mini.setView([R.default_lat || 26.2, R.default_lng || -98.2], 10);
  L.tileLayer(TILE, { subdomains: "abc", className: "basemap-tiles" }).addTo(mini);
  miniInc = L.layerGroup().addTo(mini); miniAir = L.layerGroup().addTo(mini);
  mini.on("click", () => openMap());
  updateMapIncidents(); updateMapAir();
}
function openMap(focusId) {
  $("#mapsheet").hidden = false; document.body.classList.add("noscroll");
  if (!big) {
    big = L.map("bigmap", { zoomControl: innerWidth >= 760, attributionControl: true });
    const live = S.items.filter(passes).filter((i) => i.lat != null && !i.closed), b = bounds();
    if (live.length > 1) big.fitBounds(L.latLngBounds(live.map((i) => [i.lat, i.lng])).pad(0.15), { maxZoom: 13, paddingTopLeft: [0, 60] });
    else b ? big.fitBounds(b) : big.setView([R.default_lat || 26.2, R.default_lng || -98.2], 11);
    L.tileLayer(TILE, { subdomains: "abc", maxZoom: 19, className: "basemap-tiles", attribution: ATTR }).addTo(big);
    bigAir = L.layerGroup().addTo(big); bigInc = L.layerGroup().addTo(big);
    big.on("click", () => ($("#ms-card").hidden = true));
  }
  setTimeout(() => big.invalidateSize(), 30);
  updateMapIncidents(); updateMapAir(); renderLegend();
  if (S.near) { if (bigMe) bigMe.remove(); bigMe = L.circleMarker(S.near, { radius: 7, color: "#fff", weight: 3, fillColor: "#1d3fbf", fillOpacity: 1 }).addTo(big); }
  if (focusId) { const i = [...S.items, ...S.wrapped].find((x) => x.id === focusId); if (i?.lat != null) { big.setView([i.lat, i.lng], 15); msIncident(i); } }
}
function closeMap() { $("#mapsheet").hidden = true; document.body.classList.remove("noscroll"); }
function renderLegend() {
  const n = S.items.filter(passes).length, a = (S.air?.aircraft || []).length;
  const w = S.f.win === "active" ? S.wrapped.filter(passes).length : 0;
  $("#ms-legend").innerHTML = `<span class="lg">${n} open${w ? ` · ${w} wrapped up` : ""}</span><button type="button" class="lg tog${showAir ? " on" : ""}" data-toggle-air aria-pressed="${showAir}">${I.plane}${a} aircraft</button>`;
}
function updateMapIncidents() {
  const list = [...S.items, ...(S.f.win === "active" ? S.wrapped : [])].filter(passes).filter((i) => i.lat != null);
  if (miniInc) { miniInc.clearLayers(); const live = list.filter((i) => !i.closed); live.forEach((i) => L.marker([i.lat, i.lng], { icon: incIcon(i, 20), interactive: false }).addTo(miniInc));
    if (!mini._fitted && live.length) { mini._fitted = true; mini.fitBounds(L.latLngBounds(live.map((i) => [i.lat, i.lng])).pad(0.25), { maxZoom: 12 }); } }
  if (bigInc && !$("#mapsheet").hidden) {
    bigInc.clearLayers();
    list.sort((a, b) => a.closed - b.closed).reverse().forEach((i) => L.marker([i.lat, i.lng], { icon: incIcon(i, i.closed ? 22 : 32), zIndexOffset: i.closed ? 0 : 500, keyboard: true, title: i.title }).on("click", (e) => { L.DomEvent.stop(e); msIncident(i); }).addTo(bigInc));
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
  c.innerHTML = `<div class="c-eye">${kico(i.kind)}<span>${esc(KIND_LABEL[i.kind])}</span><span class="dot">·</span><time>${esc(i.closed ? "ended " + fmtTime(i.last_at) : ago(i.last_at))}</time></div>
    <h3 class="c-title">${esc(i.title)}</h3><div class="c-place">${esc(placeOf(i))}</div><div class="c-row">${pill(i.closed ? "ended" : i.status)}</div>
    <button type="button" class="pillbtn" data-readstory="${i.id}">Read the story</button>`;
}
function msAir(a) { const c = $("#ms-card"); c.hidden = false; c.innerHTML = airTile(a, true); }

// ---------------------------------------------------------------- panels
let panelKind = null;
function openPanel(kind, title, html) {
  panelKind = kind; $("#panel").hidden = false; document.body.classList.add("noscroll");
  $("#panel-h").textContent = title; $("#panel-body").innerHTML = html || '<div class="loading">Loading…</div>';
  $("#panel .panel-in").scrollTop = 0;
}
function closePanel() { $("#panel").hidden = true; panelKind = null; if ($("#mapsheet").hidden) document.body.classList.remove("noscroll"); }
async function openNamed(name) {
  $("#menu").hidden = true; $("#btn-menu").setAttribute("aria-expanded", "false");
  if (name === "map") return openMap();
  if (name === "radio") { openPanel("radio", "Live radio"); renderRadioPanel(); return; }
  if (name === "codes") {
    openPanel("codes", "Radio codes, explained");
    try { const d = await api("/api/live/codes"); $("#panel-body").innerHTML = `<p class="dim">Codes heard on ${esc(CFG.regionName)} radio lately and what they usually mean. Learned from the traffic itself, so treat them as a guide.</p><dl class="codes big">${(d.items || []).map((c) => `<div><dt>${esc(c.code)}</dt><dd>${esc(c.meaning)}</dd></div>`).join("") || "<p>Not enough traffic yet.</p>"}</dl>`; }
    catch (e) { $("#panel-body").innerHTML = "<p>Couldn't load the codes. Try again in a moment.</p>"; }
    return;
  }
  if (name === "cams") {
    openPanel("cams", "Traffic cameras");
    try { const d = await api("/api/live/cameras"); const bust = Math.floor(Date.now() / 60000);
      $("#panel-body").innerHTML = `<p class="dim">TxDOT camera stills. They refresh about once a minute.</p><div class="cams">${(d.items || []).slice(0, 48).map((c) => `<figure><img loading="lazy" src="${esc(c.img)}&t=${bust}" alt="${esc(c.name)}"><figcaption>${esc(c.name)}${c.dir ? `<small>Looking ${esc(c.dir.toLowerCase())}</small>` : ""}</figcaption></figure>`).join("")}</div>`; }
    catch (e) { $("#panel-body").innerHTML = "<p>Couldn't load cameras.</p>"; }
    return;
  }
  if (name === "about") return openPanel("about", "How this works", `<div class="prose">
    <p><b>JAFO listens to public-safety radio</b> in ${esc(CFG.regionName)} with its own receivers, the same way a scanner does.</p>
    <p>Each transmission is transcribed, then an AI writes it as one plain-English line, notes who's speaking, explains radio codes, and decides which story it belongs to. Stories get a place (rounded to the block), the units working them, and a status: <i>just reported</i>, <i>help on the way</i>, <i>crews on scene</i>, <i>quiet</i>, or <i>wrapped up</i>.</p>
    <p>The briefing at the top is written on your device from those stories, ordered by how serious they are, how many crews are involved, and how recent they are.</p>
    <p><b>In the air</b> comes from aircraft broadcasting their position (ADS-B). We point out helicopters, Border Patrol, medical and military flights, and any emergency codes.</p>
    <p>Names, plates, phone numbers and similar details are hidden automatically. Transcripts are machine-made and can be wrong — <button type="button" class="link" data-open="report">tell us</button> when they are.</p></div>`);
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
  $$("#chips-service [data-svc]").forEach((b) => b.classList.toggle("on", b.dataset.svc === S.f.svc && !(b.dataset.svc === "" && (S.f.kinds.length))));
  $("#chip-near").classList.toggle("on", !!S.near);
  $$("#seg-window [data-win]").forEach((b) => b.classList.toggle("on", b.dataset.win === S.f.win));
  $("#kchips").innerHTML = KINDS.map((k) => `<button type="button" data-kind="${k}" class="${S.f.kinds.includes(k) ? "on" : ""}" aria-pressed="${S.f.kinds.includes(k)}">${kico(k)}${esc(KIND_LABEL[k])}</button>`).join("");
  const more = S.f.win !== "active" || S.f.kinds.length;
  $("#chip-more").textContent = more ? `More · ${[S.f.win !== "active" ? (S.f.win === "7d" ? "week" : "24 h") : "", S.f.kinds.length ? `${S.f.kinds.length} kind${S.f.kinds.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ")}` : "More";
  $("#chip-more").classList.toggle("on", !!more);
  const qn = $("#qnote"); qn.hidden = !S.q; if (S.q) qn.innerHTML = `Showing stories that mention “${esc(S.q)}” <button type="button" class="link sm" data-clearq>Clear</button>`;
}
function setTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("jafo.live.theme", next); } catch (e) {}
}
function nearMe() {
  if (S.near) { S.near = null; syncChips(); loadIncidents(); return; }
  if (!navigator.geolocation) { toast("Location isn't available on this device"); return; }
  toast("Finding you…");
  navigator.geolocation.getCurrentPosition((p) => { S.near = [p.coords.latitude, p.coords.longitude]; syncChips(); loadIncidents(); toast("Showing stories within 5 miles of you"); },
    () => toast("Location was blocked. Allow it in your browser to use Near me."), { timeout: 8000, maximumAge: 300000 });
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-toggle], [data-air], a, li[data-air]"); if (t && t.tagName === "A" && (t.dataset.goto || t.dataset.air)) e.preventDefault();
  if (!t) {
    if (!e.target.closest("#menu, #btn-menu")) $("#menu").hidden = true; return; }
  const ds = t.dataset;
  if (ds.goto) { e.stopPropagation(); if (!$("#mapsheet").hidden) closeMap(); if (panelKind) closePanel(); gotoStory(+ds.goto); return; }
  if (ds.play) { play(+ds.play); return; }
  if (ds.words) { const id = +ds.words; S.words.has(id) ? S.words.delete(id) : S.words.add(id); render(true); if (panelKind === "radio") renderRadioPanel(); return; }
  if (ds.reportInc) { openReport(null, +ds.reportInc); return; }
  if (ds.mapto) { openMap(+ds.mapto); return; }
  if (ds.readstory) { closeMap(); gotoStory(+ds.readstory); return; }
  if (ds.toggleAir !== undefined) { showAir = !showAir; updateMapAir(); renderLegend(); return; }
  if (ds.toggle) { toggleStory(+ds.toggle); return; }
  if (ds.air) {
    const a = (S.air?.aircraft || []).find((x) => x.hex === ds.air); if (!a) return;
    openMap(); if (big && a.lat != null) big.setView([a.lat, a.lng], 13); msAir(a); return;
  }
  if (ds.open) { openNamed(ds.open); return; }
  if (ds.close === "map") { closeMap(); return; }
  if (ds.close === "panel") { closePanel(); return; }
  if (ds.allwrapped !== undefined) { showAllWrapped = true; render(true); return; }
  if (ds.reset !== undefined) { S.f = { svc: "", win: "active", kinds: [] }; S.q = ""; S.near = null; $("#q").value = ""; saveF(); syncChips(); loadIncidents(); return; }
  if (ds.clearq !== undefined) { S.q = ""; $("#q").value = ""; syncChips(); render(true); return; }
  if (ds.svc !== undefined) { S.f.svc = ds.svc; if (ds.svc === "") S.f.kinds = []; saveF(); syncChips(); render(true); prefetchDetails(); return; }
  if (ds.near) { nearMe(); return; }
  if (ds.win) { S.f.win = ds.win; showAllWrapped = false; saveF(); syncChips(); $("#stream").innerHTML = '<div class="loading">Loading…</div>'; S.sig = ""; loadIncidents(); return; }
  if (ds.kind) { const k = ds.kind; S.f.kinds = S.f.kinds.includes(k) ? S.f.kinds.filter((x) => x !== k) : [...S.f.kinds, k]; saveF(); syncChips(); render(true); return; }
  if (ds.radioMore !== undefined) {
    const all = [...S.radio, ...radioExtra]; const oldest = Math.min(...all.map((c) => c.at));
    try { const d = await api("/api/live/radio", { limit: 40, before: oldest, hide_chatter: 1 }); radioExtra = radioExtra.concat(d.items || []); renderRadioPanel(); } catch (err) { toast("Couldn't load earlier calls"); }
    return;
  }
  if (t.id === "chip-more") { const m = $("#more"); m.hidden = !m.hidden; t.setAttribute("aria-expanded", String(!m.hidden)); return; }
  if (t.id === "btn-search") { const f = $("#searchbar"); f.hidden = !f.hidden; t.setAttribute("aria-expanded", String(!f.hidden)); if (!f.hidden) $("#q").focus(); return; }
  if (t.id === "q-clear") { $("#searchbar").hidden = true; return; }
  if (t.id === "btn-map" || t.id === "minimap-open") { openMap(); return; }
  if (t.id === "btn-theme") { setTheme(); return; }
  if (t.id === "btn-menu") { const m = $("#menu"); m.hidden = !m.hidden; t.setAttribute("aria-expanded", String(!m.hidden)); return; }
  if (t.id === "pp") { S.audio.paused ? S.audio.play() : S.audio.pause(); return; }
  if (t.id === "pl-x") { S.audio.pause(); S.playing = null; $("#player").hidden = true; syncPlay(); return; }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (panelKind) closePanel(); else if (!$("#mapsheet").hidden) closeMap(); else $("#menu").hidden = true; }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-toggle][role=button]")) { e.preventDefault(); toggleStory(+e.target.dataset.toggle); }
  if ((e.key === "Enter" || e.key === " ") && e.target.id === "minimap") { e.preventDefault(); openMap(); }
});
let qT;
$("#q").addEventListener("input", (e) => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); syncChips(); render(true); }, 180); });
$("#searchbar").addEventListener("submit", (e) => { e.preventDefault(); $("#searchbar").hidden = true; });

// ---------------------------------------------------------------- boot
window.__brief = { S, openMap, gotoStory, toggleStory, openNamed };
async function boot() {
  syncChips();
  await loadPulse();
  await Promise.all([loadIncidents().catch(() => { $("#stream").innerHTML = '<div class="empty"><p><b>Couldn\'t reach the radio feed.</b> We\'ll keep trying every few seconds.</p></div>'; }), loadRadio(), loadAir(), loadWeather(), loadUnits()]);
  initMini(); presence();
  const m = location.hash.match(/^#story-(\d+)$/); if (m) gotoStory(+m[1]);
  setInterval(() => !document.hidden && loadIncidents().catch(() => {}), 15000);
  setInterval(() => !document.hidden && loadRadio(), 8000);
  setInterval(() => !document.hidden && loadAir(), 10000);
  setInterval(() => !document.hidden && loadPulse(), 60000);
  setInterval(() => !document.hidden && presence(), 30000);
  setInterval(() => !document.hidden && loadWeather(), 600000);
  addEventListener("resize", () => initMini());
}
boot();
})();
