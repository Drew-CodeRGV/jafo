/* jafo — "river" wall display. Time is the axis: every incident is a bar from its first call to
   its last, aircraft fly in lanes above, every radio transmission is a dot below, and the now-line
   advances smoothly to the right. Zero-interaction; polls the live APIs.
   ?hours=3|6|12 sets the rolling window (default 6). ?sensitive=show is honoured server-side. */
(() => {
"use strict";
const CFG = window.JAFO_WALL || {};
const REGION = CFG.region || "rgv";
const TZ = CFG.tz || undefined;
const qs = new URLSearchParams(location.search);
const HOURS = [3, 6, 12].includes(+qs.get("hours")) ? +qs.get("hours") : 6;
const SPAN = HOURS * 3600;
const PAD = 0.06;        // share of the window kept as "future" to the right of now
const MIN_FUTURE = 0.012; // when now gets this close to the right edge, slide the river left
const SHIFT = 0.045;     // ...by this share of the window
const FOCUS_MS = 10000;

// ---------------------------------------------------------------- glyphs (shared with /live and the other walls)
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
const SVC_ICON = {
  police: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3z"/>',
  fire: KIND_ICON.fire,
  ems: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/>',
  other: KIND_ICON.other,
};
const SVC_ROWS = ["police", "fire", "ems", "other"];
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
  left: '<path d="M6 12h12"/>',
  unknown: '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
};
const ST_LABEL = { new: "New", en_route: "En route", on_scene: "On scene", cleared: "Cleared", quiet: "Quiet", ended: "Ended",
  dispatched: "Dispatched", transporting: "Transporting", busy: "Busy", available: "Available", left: "Left", unknown: "Heard" };
const INC_ST_ORDER = ["new", "en_route", "on_scene", "quiet", "cleared", "ended"];
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const AIR_ICON = {
  heli: '<path d="M3 5.5h18M12 5.5v3"/><path d="M6.5 13c0-2.6 2.5-4.5 5.5-4.5s5.5 1.9 5.5 4.5-2.5 3.5-5.5 3.5-5.5-.9-5.5-3.5z"/><path d="M17.3 12.2H22M22 10v4.4M8.5 20h7M10 16.4 9.3 20M14 16.4l.7 3.6"/>',
  plane: '<path d="M12 2.8c.8 0 1.2.9 1.2 2v5l7.3 4.3v1.8l-7.3-2.2v4.5l2.2 1.7v1.6L12 20.6l-3.4 1v-1.6l2.2-1.7v-4.5l-7.3 2.2v-1.8l7.3-4.3v-5c0-1.1.4-2 1.2-2z"/>',
};
const ROLE_LABEL = { border: "Border Patrol", medical: "Medical", police: "Police", military: "Military", news: "News" };
const AKIND_LABEL = { helicopter: "Helicopter", military: "Military", light: "Light aircraft", commercial: "Airliner" };

const svg = (p, cls = "g") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
const kindSvg = (k) => svg(KIND_ICON[k] || KIND_ICON.other, "g kg");
const airSvg = (kind) => `<svg viewBox="0 0 24 24" class="ag${kind === "helicopter" ? "" : " fillg"}" aria-hidden="true">${kind === "helicopter" ? AIR_ICON.heli : AIR_ICON.plane}</svg>`;
const stMark = (s) => `<span class="st st-${esc(s)}">${svg(ST_ICON[s] || ST_ICON.unknown)}${esc(ST_LABEL[s] || s)}</span>`;
const sensTag = (it) => (it && it.sensitive ? `<span class="sens-tag">Sensitive</span>` : "");
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
// Privacy markers ⟦•••⟧ become a "hidden" pill — never stripped silently.
const rich = (t) => esc(t).replace(/⟦[^⟧]*⟧/g, '<span class="hid" title="Hidden for privacy">hidden</span>');
const plainLen = (t) => String(t || "").replace(/⟦[^⟧]*⟧/g, "hidden");
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
const num = (n) => (n == null ? "–" : Number(n).toLocaleString());

// ---------------------------------------------------------------- time (always the region's clock)
let clockSkew = 0;   // server now - local now
const now = () => Date.now() / 1000 + clockSkew;
const tf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const fmtTime = (ts) => tf.format(new Date(ts * 1000)).replace(/\s?([AP])M$/, (m, a) => ` ${a.toLowerCase()}m`);
function fmtRange(a, b) {   // "8:44–11:48 pm" when both share a meridiem
  const A = fmtTime(a), B = fmtTime(b);
  const ma = A.slice(-2), mb = B.slice(-2);
  return `${ma === mb ? A.slice(0, -3) : A}–${B}`;
}
function fmtAge(s) {
  s = Math.max(0, s);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h < 24 ? `${h}h ${String(m).padStart(2, "0")}m` : `${Math.floor(h / 24)}d`;
}
const tzOffset = (() => { // seconds to add to UTC for region wall time (tick alignment)
  const d = new Date(); d.setMilliseconds(0);
  const l = new Date(d.toLocaleString("en-US", { timeZone: TZ })), u = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((l - u) / 1000);
})();
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });

// ---------------------------------------------------------------- state
const S = {
  inc: new Map(), radio: new Map(), radioNewest: 0,
  airHist: [], airLive: [], airCounts: null, pulse: null,
  lastOk: 0, failing: false, t0: 0, shifting: false, live: [], focusId: null, focusIdx: -1,
  hidden: 0, railIds: [],
};
const OPEN = (i) => !i.closed && !["cleared", "ended"].includes(i.status);
const endOf = (i) => (OPEN(i) ? Math.max(i.last_at, now()) : i.last_at);

async function getJSON(path, params = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set("region", REGION);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    // plain same-origin fetch: the Referer (this /wall/ URL) tells the server to soften sensitive incidents
    const r = await fetch(u, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- text measurement (for label fitting)
const mctx = document.createElement("canvas").getContext("2d");
function tw(text, px, weight = 600, mono = false) {
  mctx.font = `${weight} ${px}px ${mono ? '"JetBrains Mono", monospace' : '"Barlow Semi Condensed", "Arial Narrow", sans-serif'}`;
  return mctx.measureText(text).width;
}

// ---------------------------------------------------------------- geometry
const cv = $("canvas"), slide = $("slide");
let W = 0;
const X = (t) => ((t - S.t0) / SPAN) * W;
function anchor() { S.t0 = now() - SPAN * (1 - PAD); }
function tickStep() {
  if (SPAN <= 3 * 3600) return [900, 1800];
  if (SPAN <= 6 * 3600) return [1800, 3600];
  return [3600, 2 * 3600];
}
function pack(items, gap, maxLanes = Infinity) {
  // items: {s, e} px extents; first-fit into lanes (interval lists). Returns lane count; sets it.lane (-1 = no room).
  const lanes = [];
  for (const it of items) {
    let L = lanes.findIndex((iv) => iv.every(([s, e]) => it.e + gap <= s || it.s >= e + gap));
    if (L < 0) {
      if (lanes.length >= maxLanes) { it.lane = -1; continue; }
      L = lanes.length; lanes.push([]);
    }
    lanes[L].push([it.s, it.e]); it.lane = L;
  }
  return lanes.length;
}

// ---------------------------------------------------------------- render: axis + grid
function renderAxis() {
  const [minor, major] = tickStep();
  const t1 = S.t0 + SPAN * 1.2;
  let ax = "", gr = "";
  const nx = X(now());
  for (let t = Math.ceil((S.t0 + tzOffset) / minor) * minor - tzOffset; t <= t1; t += minor) {
    const x = X(t), isMaj = (t + tzOffset) % major === 0, isDay = (t + tzOffset) % 86400 === 0;
    gr += `<i class="${isMaj ? "maj" : ""}" style="left:${x.toFixed(1)}px"></i>`;
    if (x < 3 * rem() || x > W - 3 * rem() || (x > nx - 14 * rem() && x < nx + 3 * rem())) continue;   // keep clear of the now tag
    ax += `<span class="${isDay ? "day" : isMaj ? "" : "min"}" style="left:${x.toFixed(1)}px">${isDay ? esc(dayFmt.format(new Date(t * 1000))) : esc(fmtTime(t))}</span>`;
  }
  gr += `<div class="future" style="left:${nx.toFixed(1)}px" id="future"></div>`;
  gr += gapBands();
  $("grid").innerHTML = gr;
  $("axis").innerHTML = ax;
}

// ---------------------------------------------------------------- honest gaps in what was heard
// A stretch of >= 25 min with no heard calls in the pulse bins is labelled "Nothing heard a–b".
// We don't guess at why.
let GAPS = [];
function computeGaps() {
  // Runs of >= 3 empty 10-minute bins (heard calls, transcribed or not), clipped to the window.
  GAPS = [];
  const bins = S.pulse?.bins_10min, b0 = S.pulse?.bins_start;
  if (!bins || !b0) return;
  const tNow = now();
  let run = null;
  const flush = () => { if (run && run[1] - run[0] >= 25 * 60 && run[1] > S.t0) GAPS.push([Math.max(run[0], S.t0), run[1]]); run = null; };
  bins.forEach((bn, k) => {
    const s0 = b0 + k * 600, e0 = Math.min(s0 + 600, tNow);
    if (k === bins.length - 1) { flush(); return; }   // the current bin is still filling
    if (!(bn.calls > 0)) run = run ? [run[0], e0] : [s0, e0]; else flush();
  });
  flush();
}
function gapBands() {
  return GAPS.map(([a, b]) => `<div class="gapband" style="left:${X(a).toFixed(1)}px;width:${(X(b) - X(a)).toFixed(1)}px"></div>`).join("");
}
function renderGaps() {
  const r = rem();
  $("gaps").innerHTML = GAPS.map(([a, b]) => {
    const w = X(b) - X(a);
    if (w < 3 * r) return "";
    const txt = w > 26 * r ? `Nothing heard ${fmtRange(a, b)}` : w > 9 * r ? "Nothing heard" : "–";
    return `<div class="gap" style="left:${X(a).toFixed(1)}px;width:${w.toFixed(1)}px"><span>${esc(txt)}</span></div>`;
  }).join("");
}

// ---------------------------------------------------------------- aircraft
function airName(a) { return `${a.callsign || a.reg || a.hex || ""}`.trim(); }
function airSub(a) {
  return [ROLE_LABEL[a.role], a.operator && !ROLE_LABEL[a.role] ? a.operator : null, a.role ? null : AKIND_LABEL[a.kind]]
    .filter(Boolean).join(" · ").slice(0, 34);
}
function incTitle(id) {
  const i = S.inc.get(id);
  return i ? (i.title || "an incident") : null;   // titles come from the (softened) incident feed, never air.py
}
// Aircraft tracks: persisted history (split where the track goes silent) + live positions for the tail.
function airTracks() {
  const tNow = now(), out = new Map();
  for (const a of S.airHist) {
    const pts = (a.points || []).map((p) => p[3]).filter(Boolean).sort((x, y) => x - y);
    if (!pts.length) pts.push(a.first_at, a.last_at);
    const dts = []; for (let k = 1; k < pts.length; k++) dts.push(pts[k] - pts[k - 1]);
    const med = dts.length ? dts.slice().sort((x, y) => x - y)[Math.floor(dts.length / 2)] : 0;
    const brk = Math.max(15 * 60, med * 4);
    const segs = []; let s = pts[0], p = pts[0];
    for (const t of pts.slice(1)) { if (t - p > brk) { segs.push([s, p]); s = t; } p = t; }
    segs.push([s, Math.max(p, a.last_at || p)]);
    out.set(a.hex, { hex: a.hex, a: { ...a }, segs, near: new Set(a.near_incidents || []), circled: !!a.circled, live: false, circNow: false });
  }
  for (const a of S.airLive) {
    if (!a.interesting) continue;
    const seen = tNow - (a.seen_sec || 0);
    if (tNow - seen > 180) continue;
    let h = out.get(a.hex);
    const first = (a.trail && a.trail[0] && a.trail[0][3]) || seen;
    if (!h) { h = { hex: a.hex, a: {}, segs: [], near: new Set(), circled: false }; out.set(a.hex, h); }
    h.a = { ...h.a, ...a };
    const last = h.segs[h.segs.length - 1];
    if (last && seen - last[1] < 15 * 60) last[1] = Math.max(last[1], seen);
    else h.segs.push([Math.min(first, seen), seen]);
    h.live = true; h.circNow = !!a.circling; h.circled = h.circled || !!a.circling;
    if (a.near_incident && a.near_incident.id) h.near.add(a.near_incident.id);
  }
  return [...out.values()];
}
function renderAir(tracks) {
  const r = rem(), tNow = now(), AH = 3.2 * r;
  const items = [];
  for (const h of tracks) {
    for (let k = 0; k < h.segs.length; k++) {
      const [s, e] = h.segs[k];
      const lastSeg = k === h.segs.length - 1;
      const live = h.live && lastSeg;
      if (e < S.t0 - 60) continue;
      const a = X(s), b = Math.max(X(live ? tNow : e), a + 0.6 * r);
      const nearT = [...h.near].map(incTitle).filter(Boolean)[0];
      const sub = airSub(h.a);
      const badge = live && h.circNow ? "Circling now" : h.circled && lastSeg ? "Circled" : "";
      const lw = (lastSeg || b - a > 30 * r) ? 2.6 * r + tw(airName(h.a), 1.7 * r) + (sub ? tw(sub, 1.5 * r, 400) + 0.6 * r : 0)
        + (badge ? tw(badge.toUpperCase(), 1.3 * r, 700) + 2.2 * r : 0) + (nearT ? Math.min(tw(`over ${nearT}`, 1.5 * r, 400), 26 * r) + 0.6 * r : 0) + 1.2 * r : 0;
      const ls = Math.max(a, 0.4 * r);
      let s0 = ls, labelLeft = ls;
      const nx = X(tNow);
      if (lw && ls + lw > nx - 0.5 * r) { labelLeft = Math.max(0.4 * r, Math.min(ls, nx - lw - 1.2 * r)); s0 = labelLeft; }
      items.push({ h, live, a, b, lw, labelLeft, badge, nearT, sub, s: Math.min(s0, a), e: Math.max(b, labelLeft + lw),
        pri: (live && h.circNow ? 0 : live ? 1 : h.a.kind === "helicopter" ? 2 : 3) });
    }
  }
  items.sort((x, y) => x.pri - y.pri || x.a - y.a);
  const nL = pack(items, 1.2 * r, 4);
  const lanes = Math.max(1, nL);
  document.documentElement.style.setProperty("--air-h", `${(lanes * AH + 0.8 * r) / r}rem`);
  const shown = items.filter((x) => x.lane >= 0);
  $("laneAir").innerHTML = shown.map((x) => {
    const a = x.h.a, top = x.lane * AH + 0.4 * r;
    const cls = `abar${a.kind === "helicopter" ? " heli" : ""}${x.live ? " live" : ""}${x.live && x.h.circNow ? " circ" : ""}`;
    const lab = x.lw ? `<span class="alab" style="left:${(x.labelLeft - x.a).toFixed(1)}px">${airSvg(a.kind)}<b>${esc(airName(a))}</b>${x.sub ? `<em>${esc(x.sub)}</em>` : ""}${x.badge ? `<span class="badge">${esc(x.badge)}</span>` : ""}${x.nearT ? `<em>over ${esc(x.nearT.length > 40 ? x.nearT.slice(0, 39) + "…" : x.nearT)}</em>` : ""}</span>` : "";
    return `<div class="${cls}" data-hex="${esc(x.h.hex)}" ${x.live ? `data-live="1" data-a="${x.a.toFixed(1)}"` : ""} style="left:${x.a.toFixed(1)}px;width:${(x.b - x.a).toFixed(1)}px;top:${top.toFixed(1)}px"><i class="trk"></i>${lab}</div>`;
  }).join("") || `<div class="lane-empty sm">${S.airHist.length || S.airLive.length ? "No notable aircraft in this window" : "No notable aircraft logged in this window yet"}${S.airCounts?.total ? ` · ${S.airCounts.total} routine overhead now` : ""}</div>`;
  $("glAir").style.minHeight = "";
}

// ---------------------------------------------------------------- incidents
function phases(i) {
  // Stage times from the incident list: reported → en route → on scene (transport counts) → clearing.
  const st = [["en_route", i.en_route_at], ["on_scene", i.on_scene_at || i.transport_at], ["cleared", i.cleared_at]]
    .filter(([, t]) => t).map(([s, t]) => [s, Math.max(i.first_at, Math.min(t, i.last_at))]).sort((p, q) => p[1] - q[1]);
  if (!st.length) {
    const s = { new: "new", en_route: "en_route" }[i.status] || "on_scene";
    return [{ s, a: i.first_at, b: i.last_at }];
  }
  const marks = [["new", i.first_at], ...st], out = [];
  marks.forEach(([s, t], k) => {
    const b = k + 1 < marks.length ? marks[k + 1][1] : i.last_at;
    if (b > t || k === marks.length - 1) out.push({ s, a: t, b: Math.max(t, b) });
  });
  return out;
}
function incPriority(i) {
  return (OPEN(i) ? 0 : 10) + (SEV_RANK[i.severity] ?? 4);
}
function renderIncidents(airByInc) {
  const r = rem(), tNow = now(), nx = X(tNow);
  const lane = $("laneInc"), H = lane.clientHeight;
  const vis = [...S.inc.values()].filter((i) => endOf(i) >= S.t0 - 60 && i.first_at <= tNow + 60);
  const items = vis.map((i) => {
    const open = OPEN(i), a = X(i.first_at), solidB = Math.max(X(i.last_at), a + 1.0 * r);
    const b = open ? Math.max(nx, solidB) : solidB;
    const air = airByInc.get(i.id) || [];
    const meta = [i.city, open ? ST_LABEL[i.status] : null].filter(Boolean).join(" · ");
    const title = plainLen(i.title || i.type || "Incident");
    const lwFull = 1.9 * r + 0.8 * r + tw(title, 2 * r) + (i.sensitive ? tw("SENSITIVE", 1.2 * r, 700) + 2.2 * r : 0)
      + (meta ? tw(meta, 1.6 * r, 400) + 0.8 * r : 0) + (air.length ? tw(air[0].name, 1.5 * r, 400) + 3 * r : 0) + 1.2 * r;
    return { i, open, a, b, solidB, lwFull, meta, air, title };
  });
  // Layout for each item: label inside the bar if it fits, else after it, else before it, else truncated.
  const place = (x, compact) => {
    const pad = 0.9 * r, start = Math.max(x.a, 0) + pad, room = (x.open ? nx - 0.6 * r : x.solidB) - start;
    x.lw = x.lwFull;
    if (room >= x.lwFull) { x.lab = "in"; x.lx = start; }
    else if (compact && !x.open) { x.lab = null; }
    else if (!x.open && x.solidB + 0.8 * r + x.lwFull <= nx - 0.8 * r) { x.lab = "after"; x.lx = x.solidB + 0.8 * r; }
    else if (x.a - x.lwFull - 0.8 * r >= 0.4 * r) { x.lab = "before"; x.lx = x.a - x.lwFull - 0.8 * r; }
    else { x.lab = x.open ? "in" : "after"; x.lx = x.open ? start : x.solidB + 0.8 * r; x.lw = Math.max(Math.min(x.lwFull, nx - 0.8 * r - x.lx), 0); if (x.lw < 12 * r) { x.lab = x.open ? "in" : null; x.lw = x.open ? Math.max(x.lw, 12 * r) : 0; } }
    x.s = Math.min(x.a, x.lab ? x.lx : x.a); x.e = Math.max(x.b, x.lab ? x.lx + x.lw : x.b);
  };
  const LHmin = 4.6 * r, LHmax = 6.6 * r;
  const maxLanes = Math.max(1, Math.floor((H - 1.2 * r) / LHmin));
  items.forEach((x) => place(x, false));
  let ordered = items.slice().sort((p, q) => p.i.first_at - q.i.first_at);
  let nL = pack(ordered, 1.6 * r);
  if (nL > maxLanes) {
    // Too busy for every label: open and severe first, then most recent. Each gets its label where
    // there is room in some lane; otherwise it is drawn bare (a label inside the bar still fits).
    ordered = items.slice().sort((p, q) => incPriority(p.i) - incPriority(q.i) || q.i.last_at - p.i.last_at);
    const lanes = [], gap = 1.2 * r;
    const free = (s, e) => lanes.findIndex((iv) => iv.every(([p, q]) => e + gap <= p || s >= q + gap));
    for (const x of ordered) {
      let L = -1;
      for (const compact of [false, true]) {
        place(x, compact);
        L = free(x.s, x.e);
        if (L < 0 && lanes.length < maxLanes) { L = lanes.length; lanes.push([]); }
        if (L >= 0) break;
      }
      x.lane = L;
      if (L >= 0) lanes[L].push([x.s, x.e]);
    }
    nL = lanes.length;
  }
  const LH = Math.max(LHmin, Math.min(LHmax, (H - 1.2 * r) / Math.max(nL, 1)));
  const bh = Math.round(LH * 0.6);
  S.hidden = items.filter((x) => x.lane < 0).length;
  S.live = [];
  const html = items.filter((x) => x.lane >= 0).map((x) => {
    const i = x.i, k = esc(i.kind || "other"), top = x.lane * LH + 0.8 * r + (LH - bh) / 2;
    const bodyW = x.solidB - x.a;
    const segs = phases(i).map((p, n, arr) => {
      const L = X(p.a) - x.a, Wd = n === arr.length - 1 ? bodyW - L : Math.max(X(p.b) - X(p.a), 0.2 * r);
      return `<i class="seg s-${p.s}" style="left:${L.toFixed(1)}px;width:${Math.max(Wd, 0.2 * r).toFixed(1)}px"></i>`;
    }).join("");
    const ticks = []; let lastT = -99;
    for (const t of i.call_times || []) { const tx = X(t) - x.a; if (tx - lastT >= 0.4 * r && tx <= bodyW) { ticks.push(`<i class="tick" style="left:${tx.toFixed(1)}px"></i>`); lastT = tx; } }
    const tail = x.open ? `<i class="tail" data-tail style="left:${bodyW.toFixed(1)}px;width:${Math.max(0, nx - x.solidB).toFixed(1)}px"></i><i class="pulse" data-pulse style="left:${(Math.max(nx, x.solidB) - x.a).toFixed(1)}px"></i>` : `<i class="cap" style="left:${(bodyW - 2).toFixed(1)}px"></i>`;
    if (x.open) S.live.push({ id: i.id, a: x.a, solidB: x.solidB });
    let lab = "";
    if (x.lab) {
      const ab = x.air.slice(0, 1).map((h) => `<span class="ab">${airSvg(h.kind)}${esc(h.name)}${h.circ ? " circling" : ""}</span>`).join("");
      lab = `<span class="blab ${x.lab}" style="left:${(x.lx - x.a).toFixed(1)}px;max-width:${Math.max(x.lw, 4 * r).toFixed(1)}px">${kindSvg(i.kind)}${sensTag(i)}<b>${rich(i.title || i.type || "Incident")}</b>${x.meta ? `<em>${esc(x.meta)}</em>` : ""}${ab}</span>`;
    }
    return `<div class="bar k-${k}${x.open ? " open" : " done"}${i.status === "quiet" ? " quiet" : ""}${i.severity === "high" || i.severity === "critical" ? " hi" : ""}${S.focusId === i.id ? " focus" : ""}" data-id="${i.id}" style="left:${x.a.toFixed(1)}px;top:${top.toFixed(1)}px;width:${bodyW.toFixed(1)}px;--bh:${bh}px">
      <div class="body" style="width:${bodyW.toFixed(1)}px">${segs}${ticks.join("")}</div>${tail}${lab}</div>`;
  }).join("");
  lane.innerHTML = html || `<div class="lane-empty">${S.lastOk ? `No incidents in the last ${HOURS} hours.` : "Listening…"}</div>`;
  const mn = $("moreNote");
  mn.hidden = !S.hidden;
  if (S.hidden) mn.textContent = `+ ${S.hidden} more ended incident${S.hidden > 1 ? "s" : ""} not drawn`;
}

// ---------------------------------------------------------------- radio
function renderRadio() {
  const c = $("radioCv"), box = $("laneRadio"), r = rem();
  const H = box.clientHeight, Wc = Math.ceil(W * (1 + PAD) + 2), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(Wc * dpr); c.height = Math.round(H * dpr); c.style.width = Wc + "px"; c.style.height = H + "px";
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, Wc, H);
  const css = getComputedStyle(document.documentElement);
  const col = (k) => css.getPropertyValue(`--k-${k}`).trim();
  const rowH = 2.2 * r, top = 0.8 * r + 1.4 * r + 0.6 * r;   // aligned with the gutter labels
  g.strokeStyle = "rgba(150,180,210,0.08)"; g.lineWidth = 1;
  SVC_ROWS.forEach((_, k) => { const y = Math.round(top + k * rowH + rowH / 2) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(Wc, y); g.stroke(); });
  // heard-call histogram (pulse 10-minute bins: everything received, transcribed or not)
  const bins = S.pulse?.bins_10min, b0 = S.pulse?.bins_start, hb = 2.6 * r, by = H - 0.4 * r;
  if (bins && b0) {
    const mx = Math.max(10, ...bins.map((b) => b.calls || 0)), bw = X(b0 + 600) - X(b0);
    g.fillStyle = "rgba(121,180,242,0.22)";
    bins.forEach((b, k) => {
      const x = X(b0 + k * 600); if (x + bw < 0 || !b.calls) return;
      const h = Math.max(1, (b.calls / mx) * hb); g.fillRect(x + 1, by - h, Math.max(1, bw - 2), h);
    });
  }
  const tNow = now(), dr = Math.max(2, 0.42 * r);
  const pts = [];
  const seen = new Set();   // "incident|second" already drawn from the recent radio page
  for (const cl of S.radio.values()) {
    if (cl.at < S.t0 - 60 || cl.at > tNow + 5) continue;
    const row = Math.max(0, SVC_ROWS.indexOf(cl.service || "other"));
    if (cl.incident_id) seen.add(`${cl.incident_id}|${cl.at}`);
    pts.push({ x: X(cl.at), y: top + row * rowH + rowH / 2, k: cl.incident_id && S.inc.get(cl.incident_id)?.kind, chat: cl.chat });
  }
  // older linked calls come from each incident's call_times (row = the incident's service)
  for (const i of S.inc.values()) {
    const row = Math.max(0, SVC_ROWS.indexOf(i.service || "other"));
    for (const t of i.call_times || []) {
      if (t < S.t0 - 60 || t > tNow + 5 || seen.has(`${i.id}|${t}`)) continue;
      pts.push({ x: X(t), y: top + row * rowH + rowH / 2, k: i.kind, chat: false });
    }
  }
  pts.sort((a, b) => (a.k ? 1 : 0) - (b.k ? 1 : 0));
  for (const p of pts) {
    g.beginPath(); g.arc(p.x, p.y, p.chat ? dr * 0.6 : dr, 0, 7);
    if (p.k) { g.globalAlpha = 0.95; g.fillStyle = col(p.k) || "#8a929e"; g.fill(); }
    else if (p.chat) { g.globalAlpha = 0.5; g.strokeStyle = "#93a0ae"; g.lineWidth = 1; g.stroke(); }
    else { g.globalAlpha = 0.45; g.fillStyle = "#93a0ae"; g.fill(); }
  }
  g.globalAlpha = 1;
  renderGaps();
}

// ---------------------------------------------------------------- header
function renderHeads(tracks) {
  const p = S.pulse || {}, h = p.headline || {};
  const open = [...S.inc.values()].filter(OPEN);
  const by = {}; for (const i of open) by[i.status] = (by[i.status] || 0) + 1;
  const mix = INC_ST_ORDER.filter((s) => by[s]).slice(0, 3).map((s) => `<span>${svg(ST_ICON[s])}${by[s]} ${esc(ST_LABEL[s].toLowerCase())}</span>`).join("");
  const inWin = [...S.inc.values()].filter((i) => i.first_at >= now() - SPAN).length;
  const d = h.calls_1h != null && h.calls_prev_1h != null ? h.calls_1h - h.calls_prev_1h : null;
  const liveAir = tracks.filter((t) => t.live);
  const circ = liveAir.filter((t) => t.circNow);
  const lag = p.pipeline?.lag_sec;
  $("heads").innerHTML = `
    <div class="hd"><div class="n">${num(open.length)}<small>open</small></div><div class="mix">${mix || "<span>nothing open right now</span>"}</div></div>
    <div class="hd"><div class="n">${num(h.calls_1h)}${d != null ? `<small class="${d > 0 ? "up" : "dn"}">${d > 0 ? "▲" : d < 0 ? "▼" : "■"} ${num(Math.abs(d))}</small>` : ""}</div><div class="l">Calls · last hour</div></div>
    <div class="hd"><div class="n">${num(h.units_out)}</div><div class="l">Units out</div></div>
    <div class="hd"><div class="n">${num(inWin)}</div><div class="l">Incidents · last ${HOURS} h</div></div>
    <div class="hd${circ.length ? " circ" : ""}"><div class="n">${circ.length ? `${circ.length}<small>circling now</small>` : `${liveAir.length}<small>notable</small>`}</div><div class="l">Aircraft up now</div></div>
    ${lag > 600 ? `<div class="hd lagbox"><div class="n">${fmtAge(lag)} behind</div><div class="l">Transcripts catching up</div></div>` : ""}`;
}

// ---------------------------------------------------------------- rail
function railOrder() {
  return [...S.inc.values()].filter(OPEN).sort((a, b) =>
    (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4)
    || INC_ST_ORDER.indexOf(a.status) - INC_ST_ORDER.indexOf(b.status)
    || (b.last_at || 0) - (a.last_at || 0));
}
function card(i) {
  const t = now();
  const loc = [i.location, i.city].filter(Boolean).join(" · ");
  const ll = i.last_line;
  const units = (i.unit_list || []).filter((u) => u.status !== "left");
  const unitHtml = units.length
    ? units.slice(0, 8).map((u) => `<span class="upill">${svg(ST_ICON[u.status] || ST_ICON.unknown)}${esc(u.callsign)}</span>`).join("")
    : (i.responders || []).map((x) => `<span class="upill">${x.n > 1 ? `${x.n} × ` : ""}${esc(x.label)}</span>`).join("");
  return `<div class="card k-${esc(i.kind || "other")}${S.focusId === i.id ? " focus" : ""}" data-id="${i.id}">
    <div class="c-h">${kindSvg(i.kind)}<div class="c-t">${sensTag(i)}${rich(i.title || i.type || "Incident")}</div></div>
    <div class="c-m">${stMark(i.status)}<span class="loc">${rich(loc || "Location not given")}</span><span class="age">${fmtTime(i.first_at)} · ${fmtAge(t - i.first_at)}</span></div>
    ${ll && ll.text ? `<div class="c-line"><time>${fmtTime(ll.at)}</time>${rich(ll.text)}</div>` : ""}
    ${unitHtml ? `<div class="c-u">${unitHtml}</div>` : ""}</div>`;
}
function renderRail(tracks) {
  const list = railOrder();
  const el = $("oList");
  $("oCount").textContent = list.length ? `${list.length}` : "";
  if (!list.length) {
    el.innerHTML = `<div class="empty">${S.lastOk ? "No open incidents. New ones appear on the river as soon as dispatch puts them on the air." : "Listening…"}</div>`;
    S.railIds = [];
  } else {
    // keep the focused incident on the board: start the list at it when it would fall below the fold
    el.innerHTML = list.map(card).join("");
    const cards = [...el.children];
    let hidden = 0;
    while (el.scrollHeight > el.clientHeight + 1 && cards.length > 1) { cards.pop().remove(); hidden++; }
    if (hidden) {
      const more = document.createElement("div");
      more.className = "o-more"; el.appendChild(more);
      while (el.scrollHeight > el.clientHeight + 1 && cards.length > 1) { cards.pop().remove(); hidden++; }
      more.textContent = `+ ${hidden} more open on the river`;
    }
    S.railIds = cards.map((c) => +c.dataset.id);
  }
  // in the air now
  const live = tracks.filter((t) => t.live).sort((a, b) => (b.circNow ? 1 : 0) - (a.circNow ? 1 : 0) || (b.a.kind === "helicopter" ? 1 : 0) - (a.a.kind === "helicopter" ? 1 : 0));
  $("aCount").textContent = S.airCounts ? `${S.airCounts.airborne ?? S.airCounts.total} up` : "";
  $("aList").innerHTML = live.slice(0, 3).map((h) => {
    const a = h.a, near = [...h.near].map(incTitle).filter(Boolean)[0];
    return `<div class="arow${h.circNow ? " circ" : ""}">${airSvg(a.kind)}<b>${esc(airName(a))}</b><em>${esc([airSub(a), a.alt_ft > 0 ? `${Number(a.alt_ft).toLocaleString()} ft` : null, near ? `over ${near}` : null].filter(Boolean).join(" · "))}</em>${h.circNow ? `<span class="badge">Circling now</span>` : ""}</div>`;
  }).join("") || `<div class="empty">${S.airCounts?.total ? `Nothing notable overhead · ${S.airCounts.total} routine aircraft` : "Nothing notable overhead."}</div>`;
}
function renderLegend() {
  const k = (cls, label) => `<span class="${cls}"><i class="kc"></i>${label}</span>`;
  $("legend").innerHTML = k("k-violence", "Danger · fire") + k("k-medical", "Medical") + k("k-traffic", "Traffic · property") + k("k-other", "Other")
    + `<span><i class="l-new"></i>Reported</span><span><i class="l-en"></i>Units en route</span><span><i class="l-on"></i>On scene</span><span><i class="l-tail"></i>Still open</span>`;
}

// ---------------------------------------------------------------- focus cycle (gentle highlight, no interaction)
function cycleFocus() {
  const ids = S.railIds;
  if (!ids.length) { S.focusId = null; } else { S.focusIdx = (S.focusIdx + 1) % ids.length; S.focusId = ids[S.focusIdx]; }
  for (const e of document.querySelectorAll(".bar.focus, .card.focus")) e.classList.remove("focus");
  if (S.focusId != null) for (const e of document.querySelectorAll(`[data-id="${S.focusId}"]`)) e.classList.add("focus");
}

// ---------------------------------------------------------------- render all
function render() {
  W = cv.clientWidth;
  if (!W) return;
  slide.style.width = `${W}px`;
  computeGaps();
  const tracks = airTracks();
  renderAxis();
  renderAir(tracks);
  const airByInc = new Map();
  for (const h of tracks) for (const id of h.near) {
    (airByInc.get(id) || airByInc.set(id, []).get(id)).push({ name: airName(h.a), kind: h.a.kind, circ: h.live && h.circNow });
  }
  renderHeads(tracks);
  renderRail(tracks);
  renderIncidents(airByInc);   // after rail + air (lane heights settle first)
  renderRadio();
  placeNow(true);
}
let _rt = 0; function scheduleRender() { clearTimeout(_rt); _rt = setTimeout(render, 150); }

// ---------------------------------------------------------------- now-line: advances every second; river slides when it nears the edge
function placeNow(instant) {
  const nl = $("nowline"), tNow = now(), nx = X(tNow);
  if (instant) { nl.style.transition = "none"; requestAnimationFrame(() => requestAnimationFrame(() => (nl.style.transition = ""))); }
  nl.style.left = `${nx.toFixed(1)}px`;
  $("nowL").textContent = `now ${fmtTime(tNow)}`;
  const fut = document.getElementById("future"); if (fut) fut.style.left = `${nx.toFixed(1)}px`;
  for (const e of document.querySelectorAll(".bar.open")) {
    const L = S.live.find((x) => x.id === +e.dataset.id); if (!L) continue;
    const tl = e.querySelector("[data-tail]"), pu = e.querySelector("[data-pulse]");
    if (tl) tl.style.width = `${Math.max(0, nx - L.solidB).toFixed(1)}px`;
    if (pu) pu.style.left = `${(Math.max(nx, L.solidB) - L.a).toFixed(1)}px`;
  }
  for (const e of document.querySelectorAll('.abar[data-live="1"]')) e.style.width = `${Math.max(nx - parseFloat(e.dataset.a), 6).toFixed(1)}px`;
}
function maybeShift() {
  if (S.shifting || !W) return;
  if (S.t0 + SPAN - now() > SPAN * MIN_FUTURE) return;
  S.shifting = true;
  const dx = SHIFT * SPAN, px = (dx / SPAN) * W;
  slide.classList.add("shift");
  slide.style.transform = `translateX(${(-px).toFixed(1)}px)`;
  setTimeout(() => {
    slide.classList.remove("shift");
    S.t0 += dx;
    slide.style.transform = "";
    render();
    S.shifting = false;
  }, 1900);
}

// ---------------------------------------------------------------- clock / status
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", timeZoneName: "short" });
const clkFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
function tick() {
  const d = new Date(now() * 1000);
  const parts = Object.fromEntries(clkFmt.formatToParts(d).map((p) => [p.type, p.value]));
  $("cTime").innerHTML = `${parts.hour}:${parts.minute}<small>:${parts.second} ${esc((parts.dayPeriod || "").toLowerCase())}</small>`;
  $("cDate").textContent = dateFmt.format(d);
  const stale = S.lastOk && Date.now() - S.lastOk > 60000;
  const bad = S.failing || stale || !S.lastOk;
  $("conn").classList.toggle("bad", bad && !!S.lastOk);
  $("connT").textContent = !S.lastOk ? "Connecting" : bad ? "Reconnecting" : "Live";
  $("updated").textContent = S.lastOk ? `updated ${fmtAge((Date.now() - S.lastOk) / 1000)} ago` : "";
  const lag = S.pulse?.pipeline?.lag_sec;
  $("lag").hidden = !(lag > 600);
  if (lag > 600) $("lag").innerHTML = `${svg('<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>')}Catching up · transcripts ${fmtAge(lag)} behind radio`;
  if (W) { placeNow(false); maybeShift(); }
}
function renderWalls() {
  const keep = qs.get("sensitive") ? `?sensitive=${encodeURIComponent(qs.get("sensitive"))}` : "";
  $("walls").innerHTML = (CFG.walls || []).map((w) => `<a class="${w === CFG.wall ? "on" : ""}" href="/live/${encodeURIComponent(REGION)}/wall/${encodeURIComponent(w)}${keep}">${esc(w)}</a>`).join("")
    + `<a href="/live/${encodeURIComponent(REGION)}">live map</a>`;
}

// ---------------------------------------------------------------- polling
async function pollIncidents() {
  try {
    const win = `${HOURS}h`;
    const [w, a] = await Promise.all([getJSON("/api/live/incidents", { window: win }), getJSON("/api/live/incidents", { window: "active" })]);
    if (w.now) clockSkew = w.now - Date.now() / 1000;
    const m = new Map();
    for (const i of [...(w.items || []), ...(a.items || [])]) m.set(i.id, i);
    S.inc = m;
    S.lastOk = Date.now(); S.failing = false;
    render();
  } catch (e) { S.failing = true; }
}
async function pollPulse() {
  try { S.pulse = await getJSON("/api/live/pulse"); scheduleRender(); } catch (e) { /* keep last good */ }
}
function addCall(c) {
  S.radio.set(c.id, { at: c.at, service: c.service, incident_id: c.incident_id || (c.incident && c.incident.id) || null,
    chat: /chatter/i.test(c.type || "") || /^brief, unclear/i.test(c.line || "") });
  if (c.at > S.radioNewest) S.radioNewest = c.at;
}
async function pollRadio() {
  // One small recent page per poll for unlinked dots; never pages back through history.
  try {
    const since = S.radioNewest ? S.radioNewest - 120 : Math.floor(now()) - 900;
    const d = await getJSON("/api/live/radio", { since, limit: 100 });
    for (const c of d.items || []) addCall(c);
    const cut = S.t0 - 600;
    for (const [id, c] of S.radio) if (c.at < cut) S.radio.delete(id);
    scheduleRender();
  } catch (e) { /* retried next poll */ }
}
async function pollAir() {
  try {
    const d = await getJSON("/api/live/air");
    S.airLive = d.aircraft || []; S.airCounts = d.counts || null;
    scheduleRender();
  } catch (e) { /* keep last good */ }
}
async function pollAirHistory() {
  try {
    const until = Math.floor(now()), since = Math.floor(S.t0 - 600);
    const d = await getJSON("/api/live/air/history", { since, until, interesting: 1 });
    S.airHist = d.aircraft || [];
    scheduleRender();
  } catch (e) { /* history is optional; lanes fall back to live */ }
}
// Reload every 6 h to pick up code changes, only when the server answers, so a network blip
// never leaves the wall on a browser error page.
function scheduleReload() {
  setTimeout(async function tryReload() {
    try { const r = await fetch(location.href, { method: "HEAD", cache: "no-store" }); if (r.ok) return location.reload(); } catch (e) {}
    setTimeout(tryReload, 60000);
  }, 6 * 3600 * 1000);
}

function boot() {
  anchor();
  renderWalls(); renderLegend();
  setInterval(tick, 1000); tick();
  render();
  (async () => {
    await pollIncidents();
    pollPulse(); pollAir(); pollAirHistory(); pollRadio();
  })();
  setInterval(pollIncidents, 20000);
  setInterval(pollPulse, 15000);
  setInterval(pollAir, 15000);
  setInterval(pollAirHistory, 60000);
  setInterval(pollRadio, 10000);
  setInterval(cycleFocus, FOCUS_MS);
  setInterval(() => { if (!S.shifting) render(); }, 60000);   // ages, labels, gaps
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => scheduleRender());
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(render, 250); });
  let mouseT = 0;
  window.addEventListener("mousemove", () => {
    document.body.classList.add("mouse");
    clearTimeout(mouseT); mouseT = setTimeout(() => document.body.classList.remove("mouse"), 3500);
  });
  scheduleReload();
}
boot();
})();
