/* jafo wall — "newsroom": the front page that writes itself.
   Lead story = most significant active incident (severity → units → recency),
   rotating every 20 s among the top three; secondary cards; locator map;
   "On the radio" wire; footer with the day's numbers + weather.
   Zero interaction. Polls; keeps last good data on failure. ?demo=1 treats the
   last 24 h of incidents as active. ?theme=dark for the dark sheet. */
(() => {
"use strict";
const CFG = window.NEWSROOM || {};
const SLUG = CFG.slug || "rgv";
const TZ = CFG.tz || undefined;
const Q = new URLSearchParams(location.search);
const DEMO = Q.get("demo") === "1";
const ROT_MS = Math.max(4, +Q.get("rot") || 20) * 1000;   // ?rot=<seconds> to tune rotation
const LEADS_MAX = 3, CARDS_MAX = 4, WIRE_MAX = 16;

// ---------------------------------------------------------------- shared vocabulary (from live.js)
const KIND_ICON = {
  violence: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  traffic: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3.5 16h17M7 19v-3M17 19v-3M7.5 12.5h.01M16.5 12.5h.01"/>',
  medical: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11.5h2l1-2 1.5 4 1-2h1"/>',
  property: '<path d="M4 11 12 4l8 7v9H4v-9z"/><path d="M10 20v-5h4v5"/>',
  suspicious: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
  other: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
};
const KIND_SHORT = { violence: "Violence", traffic: "Traffic", medical: "Medical", property: "Property",
  suspicious: "Suspicious", fire: "Fire", other: "Other" };
const STATUS = { new: "Just in", en_route: "Units on the way", on_scene: "Units on scene", cleared: "Cleared",
  quiet: "Gone quiet", ended: "Ended" };
const UNIT_ST = { dispatched: "dispatched", en_route: "on the way", on_scene: "on scene", transporting: "transporting",
  busy: "busy", available: "available", unknown: "" };
const SEV = { high: 3, medium: 2, low: 1 };
const kindOf = (k) => (KIND_ICON[k] ? k : "other");
const kico = (k, ring) => `<span class="kico k-${kindOf(k)}${ring ? " ring" : ""}"><svg viewBox="0 0 24 24">${KIND_ICON[kindOf(k)]}</svg></span>`;

// ---------------------------------------------------------------- utils
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// privacy markers ⟦•••⟧ become a blurred "hidden" pill — never silently stripped
const rich = (s) => esc(s).replace(/⟦[^⟧]*⟧/g, '<span class="redacted" title="Hidden for privacy">hidden</span>');
const nowS = () => Date.now() / 1000;
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const fmtHour = (ts) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "numeric", timeZone: TZ });
const hourKey = (ts) => new Date(ts * 1000).toLocaleString("en-US", { hour: "numeric", day: "numeric", hourCycle: "h23", timeZone: TZ });
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return "moments";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} d`;
}
const ago = (ts) => { const d = nowS() - ts; return d < 60 ? "just now" : `${fmtDur(d)} ago`; };
const unitsTotal = (u) => Object.values(u || {}).reduce((a, b) => a + (+b || 0), 0);
const place = (it) => [it.location, it.city].filter(Boolean).filter((v, i, a) => i === 0 || !String(a[0]).includes(v)).join(", ");
const stat = (it) => (DEMO && (it.status === "ended" || it.status === "cleared") ? "on_scene" : it.status);
const isEnded = (it) => !DEMO && (it.closed || it.status === "ended");
const rank = (a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0)
  || unitsTotal(b.units) - unitsTotal(a.units)
  || (b.last_at || 0) - (a.last_at || 0);
function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n); const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "") + "…";
}

let failures = 0, lastOk = 0;
async function api(path, params = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set("region", SLUG);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(u, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    const j = await r.json();
    failures = 0; lastOk = Date.now(); setLink();
    return j;
  } catch (e) {
    failures++; setLink();
    throw e;
  } finally { clearTimeout(t); }
}
function setLink() {
  const stale = failures >= 2 || (lastOk && Date.now() - lastOk > 90000);
  $("onair").classList.toggle("stale", !!stale);
  $("onair-t").textContent = stale ? "Reconnecting…" : (DEMO ? "Demo" : "Live");
}

// ---------------------------------------------------------------- state
const S = {
  pulse: null, list24: [], radio: [], wx: null,
  details: new Map(),     // id -> {t, d}
  leads: [], leadIdx: -1, leadId: null, quiet: false,
  rotTimer: null,
};

// ---------------------------------------------------------------- story selection
function pools() {
  let active;
  if (DEMO) active = S.list24.slice();
  else active = (S.pulse?.active || []).slice();
  active.sort(rank);
  const activeIds = new Set(active.map((a) => a.id));
  const earlier = S.list24.filter((i) => !activeIds.has(i.id) && isEnded(i)).sort(rank);
  return { active, earlier };
}
function pickLeads() {
  const { active, earlier } = pools();
  S.quiet = active.length === 0;
  const leads = (S.quiet ? earlier : active).slice(0, LEADS_MAX);
  const leadIds = new Set(leads.map((l) => l.id));
  const rest = (S.quiet ? earlier : active.concat(earlier)).filter((i) => !leadIds.has(i.id));
  return { leads, cards: rest.slice(0, CARDS_MAX), activeCount: active.length };
}

// ---------------------------------------------------------------- lead story
async function detail(id) {
  const c = S.details.get(id);
  if (c && Date.now() - c.t < 15000) return c.d;
  try {
    const d = await api(`/api/live/incidents/${id}`);
    S.details.set(id, { t: Date.now(), d });
    if (S.details.size > 40) S.details.delete(S.details.keys().next().value);
    return d;
  } catch (e) { return c ? c.d : null; }
}

function pullQuote(d) {
  const tl = (d?.timeline || []).slice().sort((a, b) => a.at - b.at);
  for (let i = tl.length - 1; i >= 0; i--) {
    const sp = tl[i].speakers || [];
    for (let j = sp.length - 1; j >= 0; j--) {
      const text = String(sp[j].text || "");
      const bare = text.replace(/⟦[^⟧]*⟧/g, "").replace(/[^A-Za-z]/g, "");
      if (bare.length >= 14) return { text, who: sp[j].who || "Unit", at: tl[i].at, channel: tl[i].channel };
    }
  }
  return null;
}

function unitsLine(d, brief) {
  const list = (d?.units_list || []).filter((u) => u.on_this !== false);
  if (list.length) {
    const shown = list.slice(0, 6).map((u) => {
      const st = UNIT_ST[u.status] || "";
      return `<span class="u">${esc(u.callsign)}${st ? ` <em>${esc(st)}</em>` : ""}</span>`;
    }).join("");
    return shown + (list.length > 6 ? `<span class="u"><em>+${list.length - 6} more</em></span>` : "");
  }
  const u = brief.units || {};
  const parts = [["police", "police"], ["fire", "fire"], ["ems", "EMS"], ["other", "other"]]
    .filter(([k]) => u[k]).map(([k, l]) => `<span class="u">${u[k]} ${l} unit${u[k] > 1 ? "s" : ""}</span>`);
  return parts.length ? parts.join("") : `<span class="u"><em>No units named on the air yet</em></span>`;
}

function leadHTML(brief, d, idx, total) {
  const it = Object.assign({}, brief, d || {});
  const k = kindOf(it.kind);
  const ended = isEnded(it);
  const title = it.title || it.type || "Unnamed incident";
  const hlCls = title.length > 58 ? "xlong" : title.length > 40 ? "long" : "";
  const where = place(it);
  const span = (it.last_at || 0) - (it.first_at || 0);
  const deck = [];
  if (where) deck.push(`<span class="place">${esc(where)}</span>`);
  if (ended) deck.push(`<span class="dot">${esc(fmtTime(it.first_at))}${span > 120 ? ` – ${esc(fmtTime(it.last_at))}` : ""}</span>`);
  else {
    deck.push(`<span class="dot">Since ${esc(fmtTime(it.first_at))}</span>`);
    deck.push(`<span class="dot">Last heard ${esc(ago(it.last_at))}</span>`);
  }
  if (it.calls) deck.push(`<span class="dot">${it.calls} transmission${it.calls > 1 ? "s" : ""}</span>`);
  const q = pullQuote(d);
  const summary = it.summary || (d?.timeline || []).map((t) => t.line).filter(Boolean).slice(-2).join(" ");
  const rot = total > 1
    ? `<span class="rot">Story ${idx + 1} of ${total}<span class="rot-bar" style="--rot:${ROT_MS / 1000}s">${
        Array.from({ length: total }, (_, i) => `<span class="${i < idx ? "done" : i === idx ? "cur" : ""}"></span>`).join("")}</span></span>`
    : "";
  return `
    <div class="kicker">${kico(k)}<span class="kk">${esc(KIND_SHORT[k])}</span><span class="sep"></span>
      ${ended ? `<span class="ended">Ended</span>` : `<span class="st">${esc(STATUS[stat(it)] || stat(it) || "")}</span>`}
      ${it.severity === "high" ? `<span class="sev">Serious</span>` : ""}
      ${rot}</div>
    ${S.quiet ? `<p class="quietnote">No incidents are active on the radio right now. Earlier today:</p>` : ""}
    <h1 class="hl ${hlCls}">${it.sensitive ? `<span class="sens-tag">Sensitive</span> ` : ""}${esc(title)}</h1>
    <div class="deck">${deck.join("")}</div>
    <div class="lp-body k-${k}">
      ${summary ? `<p class="summary">${rich(summary)}</p>` : ""}
      ${q ? `<blockquote class="pull" style="margin:0"><q>${rich(clip(q.text, 150))}</q>
        <span class="who"><b>${esc(q.who)}</b> · ${esc(q.channel || "")} · ${esc(fmtTime(q.at))}</span></blockquote>` : ""}
      <p class="byline"><span class="lbl">${ended ? "Units that responded" : "Responding"}</span>${unitsLine(d, it)}</p>
    </div>`;
}

let leadHtmlCur = "", leadPageId = null;
function showLeadPage(html, id) {
  if (html === leadHtmlCur) return;
  const box = $("lead-pages");
  const cur = box.querySelector(".lp.in");
  if (cur && id != null && id === leadPageId) {
    // same story, fresher facts: patch in place (no crossfade, rotation bar keeps running)
    leadHtmlCur = html;
    const tmp = document.createElement("article"); tmp.innerHTML = html;
    for (const sel of [".kicker .st", ".kicker .ended", ".quietnote", ".hl", ".deck", ".lp-body"]) {
      const a = cur.querySelector(sel), b = tmp.querySelector(sel);
      if (a && b && a.innerHTML !== b.innerHTML) a.innerHTML = b.innerHTML;
    }
    return;
  }
  leadPageId = id;
  const first = !leadHtmlCur;
  leadHtmlCur = html;
  const pg = document.createElement("article");
  pg.className = "lp";
  pg.innerHTML = html;
  box.querySelectorAll(".lp").forEach((o) => { o.classList.remove("in"); o.classList.add("out"); setTimeout(() => o.remove(), 1500); });
  box.appendChild(pg);
  const body = pg.querySelector(".lp-body");
  if (body) $("locator").style.setProperty("--map-top", `${body.offsetTop + 20 * remPx() / 16}px`);
  requestAnimationFrame(() => requestAnimationFrame(() => pg.classList.add("in")));
  if (first) pg.style.transition = "opacity .6s ease";
}
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

async function rotate(advance = true) {
  const { leads, cards, activeCount } = pickLeads();
  S.leads = leads;
  if (!leads.length) {
    showLeadPage(`<div class="kicker"><span class="st">Front page</span></div>
      <h1 class="hl">The radio has been quiet today.</h1>
      <div class="deck"><span class="place">No incidents have been reported in the last 24 hours.</span></div>
      <div class="lp-body"><p class="summary">Stories appear here as dispatch traffic is heard and written up.</p></div>`);
    renderCards([], 0); updateMap(null);
    return;
  }
  let idx = leads.findIndex((l) => l.id === S.leadId);
  if (idx < 0) idx = 0; else if (advance) idx = (idx + 1) % leads.length;
  const brief = leads[idx];
  const d = await detail(brief.id);
  S.leadId = brief.id; S.leadIdx = idx;
  showLeadPage(leadHTML(brief, d, idx, leads.length), brief.id);
  renderCards(cards, activeCount);
  updateMap(Object.assign({}, brief, d || {}));
}
function scheduleRotation() {
  clearTimeout(S.rotTimer);
  S.rotTimer = setTimeout(async () => { try { await rotate(true); } finally { scheduleRotation(); } }, ROT_MS);
}

// ---------------------------------------------------------------- secondary cards
let cardsHtmlCur = "";
function renderCards(cards, activeCount) {
  const anyActive = cards.some((c) => !isEnded(c));
  $("also-head").textContent = anyActive ? "Also developing" : "Earlier today";
  let html = cards.map((c) => {
    const k = kindOf(c.kind), ended = isEnded(c);
    const when = ended ? `Ended · ${fmtTime(c.last_at)}` : `Since ${fmtTime(c.first_at)} · ${ago(c.last_at)}`;
    const where = c.city || c.location;
    return `<div class="card${ended ? " ended" : ""}">
      <div class="ck">${kico(k, ended)}<span>${esc(KIND_SHORT[k])}</span>${ended ? "" : `<span>· ${esc(STATUS[stat(c)] || "")}</span>`}</div>
      <div class="ct">${c.sensitive ? `<span class="sens-tag">Sensitive</span> ` : ""}${esc(c.title || c.type || "Incident")}</div>
      <div class="cm">${where ? `<b>${esc(where)}</b>` : ""}<span>${esc(when)}</span></div></div>`;
  }).join("");
  if (!cards.length) html = `<div class="card empty">No other stories in the last 24 hours.</div>`;
  if (html === cardsHtmlCur) return;
  cardsHtmlCur = html;
  const row = $("also-row");
  row.style.transition = "opacity .6s ease"; row.style.opacity = "0";
  setTimeout(() => { row.innerHTML = html; row.style.opacity = "1"; }, row.innerHTML ? 600 : 0);
}

// ---------------------------------------------------------------- locator map
let map = null, leadMarker = null, dots = null;
const R = CFG.region || {};
function initMap() {
  if (!window.L) return;
  map = L.map("map", { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0.25, fadeAnimation: true });
  // on 4K walls, draw tiles at 2× so street labels stay legible from across the room
  const f = Math.max(1, Math.round(remPx() / 16));
  const scale = f >= 2 ? 2 : 1;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap",
    tileSize: 256 * scale, zoomOffset: -(scale - 1) }).addTo(map);
  map.attributionControl.setPrefix(false);
  dots = L.layerGroup().addTo(map);
  fitRegion(false);
}
function fitRegion(anim) {
  if (!map) return;
  if (R.bbox_south != null) map.fitBounds([[R.bbox_south, R.bbox_west], [R.bbox_north, R.bbox_east]], { animate: anim, duration: 2 });
  else map.setView([R.default_lat || 26.2, R.default_lng || -98.2], 10, { animate: anim });
}
function pinIcon(k, size, lead) {
  const px = size * remPx() / 16;
  return L.divIcon({ className: "", iconSize: [px, px], iconAnchor: [px / 2, px / 2],
    html: `<div class="mpin k-${kindOf(k)}${lead ? " lead" : ""}" style="width:${px}px;height:${px}px;position:relative"><svg viewBox="0 0 24 24">${KIND_ICON[kindOf(k)]}</svg></div>` });
}
function updateDots() {
  if (!map) return;
  dots.clearLayers();
  const { active, earlier } = pools();
  const s = 0.75 * remPx();
  for (const it of active.concat(earlier)) {
    if (it.lat == null || it.id === S.leadId) continue;
    dots.addLayer(L.marker([it.lat, it.lng], { interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", iconSize: [s, s], html: `<div class="mdot k-${kindOf(it.kind)}" style="width:${s}px;height:${s}px"></div>` }) }));
  }
}
let mapLeadKey = "";
function updateMap(it) {
  const cap = $("locator-cap");
  if (!map) { cap.textContent = it ? place(it) : ""; return; }
  updateDots();
  const key = it ? `${it.id}:${it.lat}:${it.lng}` : "none";
  if (key === mapLeadKey) return;
  mapLeadKey = key;
  if (leadMarker) { map.removeLayer(leadMarker); leadMarker = null; }
  if (it && it.lat != null && it.lng != null) {
    leadMarker = L.marker([it.lat, it.lng], { icon: pinIcon(it.kind, 34, !isEnded(it)), interactive: false, keyboard: false }).addTo(map);
    const z = { address: 15, block: 15, intersection: 15, place: 14, street: 14, city: 12 }[it.precision] || 13;
    map.flyTo([it.lat, it.lng], z, { duration: 2.2 });
    const prec = { address: "Exact address", block: "Block-level location", intersection: "Intersection", place: "Landmark location",
      street: "Street-level location", city: "Approximate — city-level only" }[it.precision] || "Approximate location";
    cap.textContent = [prec, it.city].filter(Boolean).join(" · ");
  } else {
    fitRegion(true);
    cap.textContent = it ? "Not pinned — exact spot not given on the air" : "";
  }
}

// ---------------------------------------------------------------- wire
const wireIds = new Set();
async function loadRadio() {
  let j = await api("/api/live/radio", { limit: WIRE_MAX, hide_chatter: 1 });
  if ((j.items || []).length < 5) j = await api("/api/live/radio", { limit: WIRE_MAX });
  S.radio = (j.items || []).slice().sort((a, b) => b.at - a.at).slice(0, WIRE_MAX);
  renderWire();
}
function wireItem(c, isNew) {
  const li = document.createElement("li");
  li.className = "wi" + (isNew ? " new" : "");
  li.dataset.id = c.id;
  const inc = c.incident;
  li.innerHTML = `<div class="wm"><span class="t">${esc(fmtTime(c.at))}</span>${inc ? kico(inc.kind) : ""}<span class="ch">${esc(c.channel || "")}</span></div>
    <p class="wl">${rich(c.line || (c.speakers || []).map((s) => s.text).join(" ") || "")}</p>
    ${inc && inc.title ? `<div class="wi-inc">${inc.sensitive ? `<span class="sens-tag">Sensitive</span> ` : ""}${esc(inc.title)}</div>` : ""}`;
  return li;
}
function renderWire() {
  const ol = $("wire");
  if (!S.radio.length) {
    if (!ol.querySelector(".wire-empty")) ol.innerHTML = `<li class="wire-empty">Waiting for the first transmission of the day.</li>`;
    return;
  }
  ol.querySelector(".wire-empty")?.remove();
  const firstLoad = wireIds.size === 0;
  const fresh = S.radio.filter((c) => !wireIds.has(c.id));
  // insert newest last so it lands on top
  for (const c of fresh.slice().reverse()) {
    wireIds.add(c.id);
    ol.insertBefore(wireItem(c, !firstLoad), ol.firstChild);
  }
  if (firstLoad) { ol.innerHTML = ""; for (const c of S.radio) ol.appendChild(wireItem(c, false)); }
  const keep = new Set(S.radio.map((c) => String(c.id)));
  [...ol.children].forEach((li, i) => { if (i >= WIRE_MAX || !keep.has(li.dataset.id)) { li.remove(); wireIds.delete(+li.dataset.id); } });
  [...ol.children].forEach((li, i) => li.classList.toggle("first", i === 0));
  renderLag();
}
function renderLag() {
  const newest = S.radio[0]?.at;
  const lag = newest ? nowS() - newest : 0;
  $("wire-lag").textContent = newest ? (lag > 600 ? `Latest line ${fmtDur(lag)} ago` : "As it's heard") : "";
}

// ---------------------------------------------------------------- footer
function renderFooter() {
  const p = S.pulse; if (!p) return;
  const h = p.headline || {};
  $("f-today").innerHTML = `<span class="lbl">Incidents · last 24 h</span>
    <span class="val"><span class="num">${h.opened_24h ?? 0}</span><span class="sub">${h.active ?? 0} active now</span></span>`;
  const a = h.calls_1h ?? 0, b = h.calls_prev_1h ?? 0;
  let delta = "";
  if (b > 0) {
    const pct = Math.round((a - b) / b * 100);
    delta = pct === 0 ? "same as the hour before" : `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs hour before`;
  }
  $("f-hour").innerHTML = `<span class="lbl">Radio calls · last hour</span>
    <span class="val"><span class="num">${a.toLocaleString()}</span><span class="delta">${esc(delta)}</span></span>`;
  // group the 10-minute bins by clock hour (region tz)
  const groups = [];
  (p.bins_10min || []).forEach((bin, i) => {
    const t = p.bins_start + i * 600;
    const key = hourKey(t);
    const g = groups[groups.length - 1];
    if (g && g.key === key) g.n += bin.calls; else groups.push({ key, t, n: bin.calls });
  });
  const max = Math.max(1, ...groups.map((g) => g.n));
  const peakI = groups.reduce((bi, g, i) => (g.n > groups[bi].n ? i : bi), 0);
  const peak = groups[peakI];
  const W = 300, H = 54, gap = 2, bw = (W - gap * (groups.length - 1)) / Math.max(1, groups.length);
  const bars = groups.map((g, i) => {
    const bh = Math.max(1.5, (g.n / max) * (H - 2));
    const x = i * (bw + gap), y = H - bh, r = Math.min(3, bw / 2, bh);
    const cls = i === groups.length - 1 ? "cur" : i === peakI ? "peak" : "";
    // rounded top, square baseline
    const d = `M${x},${H}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${H}Z`;
    return `<path d="${d}" class="${cls}"><title>${fmtHour(g.t)}: ${g.n} calls</title></path>`;
  }).join("");
  $("f-busy").innerHTML = `<span class="txt"><span class="lbl">Busiest hour · 24 h</span>
      <span class="val"><span class="num">${peak ? esc(fmtHour(peak.t)) : "—"}</span><span class="sub">${peak ? peak.n.toLocaleString() + " calls" : ""}</span></span></span>
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Radio calls per hour, last 24 hours">${bars}</svg>`;
}
function renderWeather() {
  const w = S.wx; const el = $("f-wx");
  if (!w || !w.now) { el.innerHTML = ""; return; }
  const n = w.now;
  const text = n.text || w.forecast?.[0]?.short || "";
  const wind = n.wind_mph ? `${n.wind_dir || ""} wind ${n.wind_mph} mph` : "Calm";
  const alert = (w.alerts || [])[0];
  el.innerHTML = `<span class="lbl">Weather</span>
    <span class="val"><span class="num">${n.temp != null ? Math.round(n.temp) + "°" : "—"}</span>
    <span class="sub">${alert ? `<span class="alert">${esc(alert.event)}</span>` : esc([text, wind].filter(Boolean).join(" · "))}</span></span>`;
}
function renderWalls() {
  const cur = location.pathname.split("/").pop();
  const links = (CFG.walls || []).map((w) => `<a href="/live/${encodeURIComponent(SLUG)}/wall/${encodeURIComponent(w)}"${w === cur ? ' class="cur"' : ""}>${esc(w)}</a>`).join("");
  $("walls").innerHTML = `<div class="row">${links}<a href="/live/${encodeURIComponent(SLUG)}">live map</a></div>
    <div class="row"><span class="upd" id="upd"></span></div>`;
}

// ---------------------------------------------------------------- clock
function tick() {
  const d = new Date();
  $("clock").textContent = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  $("dateline").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: TZ })
    + (DEMO ? " · demo edition" : "");
  const u = $("upd");
  if (u) u.textContent = lastOk ? `Updated ${fmtDur((Date.now() - lastOk) / 1000) === "moments" ? Math.round((Date.now() - lastOk) / 1000) + " s" : fmtDur((Date.now() - lastOk) / 1000)} ago` : "Connecting…";
  setLink();
}

// ---------------------------------------------------------------- polling
async function loadPulse() { S.pulse = await api("/api/live/pulse"); renderFooter(); }
async function loadList() { const j = await api("/api/live/incidents", { window: "24h" }); S.list24 = j.items || []; }
async function loadWx() { try { S.wx = await api("/api/live/weather"); } catch (e) { /* keep last */ } renderWeather(); }
function every(ms, fn) { const run = async () => { try { await fn(); } catch (e) { /* keep last good data */ } setTimeout(run, ms); }; setTimeout(run, ms); }

async function boot() {
  renderWalls(); tick(); setInterval(tick, 1000);
  initMap();
  await Promise.allSettled([loadPulse(), loadList(), loadRadio(), loadWx()]);
  await rotate(false).catch(() => {});
  scheduleRotation();
  every(15000, async () => { await loadPulse(); await rotate(false); });   // refresh lead in place
  every(10000, loadRadio);
  every(60000, loadList);
  every(10 * 60000, loadWx);
  setInterval(renderLag, 30000);
  setTimeout(() => location.reload(), 6 * 3600 * 1000);
  window.addEventListener("resize", () => map && map.invalidateSize());
}
boot();
})();
