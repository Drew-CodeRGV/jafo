/* JAFO wall display: "pulse" — ambient city pulse.
 *
 * A 24-hour radial clock of radio traffic, an abstract light-field map of
 * incidents, and the latest transmission set large. Zero interaction; polls
 * /api/live/pulse (15 s) and /api/live/radio?since= (5 s).
 *
 * ?demo=1 treats the last 24 h of incidents as active and replays recent radio
 * (plus those incidents' own timelines) as if it were arriving live.
 */
(() => {
  "use strict";
  const CFG = window.PULSE_CFG || {};
  const SLUG = CFG.slug || "rgv";
  const TZ = CFG.tz || undefined;
  const DEMO = new URLSearchParams(location.search).get("demo") === "1";
  const W = 1920, H = 1080;            // design stage
  const MAP = { w: 1000, h: 500, pad: 40 };
  const RING = { size: 880, c: 440, base: 286, len: 96, glyph: 232, label: 270 };

  // ------------------------------------------------------------ design tokens
  const COL = {
    sodium: [227, 168, 87], bone: [221, 226, 234], mist: [141, 151, 167], haze: [86, 96, 114],
    lattice: [120, 136, 162], night: "#05070b",
  };
  const KIND_RGB = {
    violence: [235, 98, 99], fire: [235, 98, 99], medical: [0, 168, 136],
    traffic: [51, 140, 237], property: [51, 140, 237], suspicious: [51, 140, 237], other: [138, 147, 160],
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const kindRgb = (k) => KIND_RGB[k] || KIND_RGB.other;

  // Same glyphs as live.js (KIND_ICON)
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
  const KIND_SHORT = { violence: "Danger", traffic: "Traffic", medical: "Medical", property: "Property",
    suspicious: "Suspicious", fire: "Fire", other: "Other" };
  const STATUS_LABEL = { new: "New", en_route: "Units on the way", on_scene: "Units on scene",
    cleared: "Cleared", quiet: "Quiet", ended: "Ended" };
  const kindSvg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
  const glyph = (k) => `<span class="glyph k-${esc(k || "other")}">${kindSvg(k)}</span>`;
  // Canvas versions of the glyphs (circles become arc paths)
  const GLYPH_PATH = {};
  for (const [k, svg] of Object.entries(KIND_ICON)) {
    let d = "";
    svg.replace(/<path d="([^"]+)"/g, (_, p) => (d += p + " "));
    svg.replace(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g, (_, cx, cy, r) => {
      cx = +cx; cy = +cy; r = +r;
      d += `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0 `;
    });
    GLYPH_PATH[k] = new Path2D(d);
  }

  // ------------------------------------------------------------ helpers
  const $ = (s) => document.querySelector(s);
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const nowSec = () => Date.now() / 1000;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (p) => 1 - Math.pow(1 - p, 3);

  const fmtHM = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const fmtDate = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric" });
  const fmtParts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric",
    month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const hm = (ts) => fmtHM.format(new Date(ts * 1000));
  let _off = { at: -1e12, v: 0 };
  function tzOffset(ts) {                       // seconds to add to UTC to get region wall time
    if (Math.abs(ts - _off.at) < 600) return _off.v;
    const p = {};
    for (const x of fmtParts.formatToParts(new Date(ts * 1000))) p[x.type] = +x.value;
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) / 1000;
    _off = { at: ts, v: Math.round((wall - Math.floor(ts)) / 60) * 60 };
    return _off.v;
  }
  const secOfDay = (ts) => (((ts + tzOffset(ts)) % 86400) + 86400) % 86400;
  const angleOf = (ts) => (secOfDay(ts) / 86400) * Math.PI * 2 - Math.PI / 2;   // midnight at 12 o'clock
  function ago(ts) {
    const s = Math.max(0, nowSec() - ts);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    const h = s / 3600;
    return h < 10 ? `${Math.round(h * 10) / 10} h ago`.replace(".0 ", " ") : `${Math.round(h)} h ago`;
  }

  async function api(path, q = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`/api/live/${path}?` + new URLSearchParams({ region: SLUG, ...q }), { cache: "no-store", signal: ctl.signal });
      if (!r.ok) throw new Error(`${path} ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------ state
  const S = {
    pulse: null, inc24: [], inc7d: [], cityPos: {}, incById: new Map(),
    radioLast: 0, seen: new Set(), queue: [], lineAt: 0,
    focus: null, focusAt: 0, focusIdx: -1,
    ripples: [], sparks: [], fails: {}, sound: false,
    ringDirty: true, fieldDirty: true, demoPool: [], demoIdx: 0,
  };
  const activeList = () => {
    if (DEMO) return S.inc24.slice().sort((a, b) => b.last_at - a.last_at);
    return (S.pulse?.active || []).slice().sort((a, b) => b.last_at - a.last_at);
  };

  // ------------------------------------------------------------ stage fit
  const stage = $("#stage"), drift = $("#drift");
  const mapCv = $("#map-cv"), ringCv = $("#ring-cv");
  const mapCtx = mapCv.getContext("2d"), ringCtx = ringCv.getContext("2d");
  let PX = 1;                                     // device pixels per stage px
  const field = document.createElement("canvas"), ringLayer = document.createElement("canvas");
  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    stage.style.left = `${(innerWidth - W * s) / 2}px`;
    stage.style.top = `${(innerHeight - H * s) / 2}px`;
    stage.style.transform = `scale(${s})`;
    PX = s * (window.devicePixelRatio || 1);
    const mw = MAP.w + MAP.pad * 2, mh = MAP.h + MAP.pad * 2;
    for (const [cv, w, h] of [[mapCv, mw, mh], [field, mw, mh], [ringCv, RING.size, RING.size], [ringLayer, RING.size, RING.size]]) {
      cv.width = Math.round(w * PX); cv.height = Math.round(h * PX);
    }
    S.ringDirty = S.fieldDirty = true;
  }
  addEventListener("resize", fit);

  // ------------------------------------------------------------ projection
  let proj = null, projKey = "";
  // Fit to where incidents actually happen (robust 3-97% extent, padded),
  // clamped to the region bbox, so the light field fills its frame.
  function setProjection(r, items) {
    if (!r || r.bbox_north == null) return;
    let n = r.bbox_north, s = r.bbox_south, e = r.bbox_east, w = r.bbox_west;
    const pts = (items || []).filter((i) => i.lat != null && i.lng != null && i.lat <= n && i.lat >= s && i.lng >= w && i.lng <= e);
    if (pts.length >= 6) {
      const la = pts.map((i) => i.lat).sort((a, b) => a - b), lo = pts.map((i) => i.lng).sort((a, b) => a - b);
      const q = (arr, f) => arr[Math.round((arr.length - 1) * f)];
      let s2 = q(la, 0.03), n2 = q(la, 0.97), w2 = q(lo, 0.03), e2 = q(lo, 0.97);
      const pl = Math.max(0.08, (n2 - s2) * 0.16), pg = Math.max(0.12, (e2 - w2) * 0.12);
      s = Math.max(s, s2 - pl); n = Math.min(n, n2 + pl); w = Math.max(w, w2 - pg); e = Math.min(e, e2 + pg);
    }
    const key = [n, s, e, w].map((v) => v.toFixed(3)).join();
    if (key === projKey) return;
    projKey = key;
    const mid = ((n + s) / 2) * Math.PI / 180;
    const k = Math.cos(mid);
    const lonSpan = (e - w) * k, latSpan = n - s;
    const sc = Math.min(MAP.w / lonSpan, MAP.h / latSpan);
    const ox = (MAP.w - lonSpan * sc) / 2, oy = (MAP.h - latSpan * sc) / 2;
    proj = (lat, lng) => [MAP.pad + ox + (lng - w) * k * sc, MAP.pad + oy + (n - lat) * sc];
    proj.inside = (lat, lng) => lat <= r.bbox_north && lat >= r.bbox_south && lng >= r.bbox_west && lng <= r.bbox_east;
    proj.inView = (p) => p[0] > 4 && p[0] < MAP.w + MAP.pad * 2 - 4 && p[1] > 4 && p[1] < MAP.h + MAP.pad * 2 - 4;
    S.fieldDirty = true;
  }
  setProjection(CFG.region);
  function posOf(inc) {
    if (!proj || !inc) return null;
    let p = null;
    if (inc.lat != null && inc.lng != null && proj.inside(inc.lat, inc.lng)) p = proj(inc.lat, inc.lng);
    else { const c = inc.city && S.cityPos[inc.city.toLowerCase()]; if (c) p = proj(c.lat, c.lng); }
    return p && proj.inView(p) ? p : null;
  }

  // ------------------------------------------------------------ light field (offscreen, rebuilt when data changes)
  function buildField() {
    S.fieldDirty = false;
    const g = field.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, field.width, field.height);
    g.setTransform(PX, 0, 0, PX, 0, 0);
    if (!proj) return;
    const pts = [];
    for (const i of S.inc7d.concat(S.inc24)) if (i.lat != null && proj.inside(i.lat, i.lng)) pts.push(proj(i.lat, i.lng));
    const step = 13, sig2 = 2 * 24 * 24;
    const cols = Math.floor(MAP.w / step), rows = Math.floor(MAP.h / step);
    const vals = new Float32Array((cols + 1) * (rows + 1));
    let max = 0.0001;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const x = MAP.pad + c * step, y = MAP.pad + r * step;
      let v = 0;
      for (const p of pts) {
        const dx = p[0] - x, dy = p[1] - y, d2 = dx * dx + dy * dy;
        if (d2 < 9 * sig2) v += Math.exp(-d2 / sig2);
      }
      vals[r * (cols + 1) + c] = v; if (v > max) max = v;
    }
    const norm = Math.max(max, 3);
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const x = MAP.pad + c * step, y = MAP.pad + r * step;
      // soft vignette so the field has no hard rectangle edge
      const ex = (c / cols - 0.5) * 2, ey = (r / rows - 0.5) * 2;
      const edge = clamp(1.25 - Math.sqrt(ex * ex * 0.8 + ey * ey * 0.9), 0, 1);
      const v = Math.pow(clamp(vals[r * (cols + 1) + c] / norm, 0, 1), 0.6);
      if (edge <= 0.01 && v < 0.05) continue;
      if (v > 0.04) {
        g.fillStyle = rgba(COL.sodium, (0.08 + 0.5 * v) * Math.max(edge, 0.5));
        g.beginPath(); g.arc(x, y, 1.0 + 1.5 * v, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = rgba(COL.lattice, 0.10 * edge);
        g.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
      }
    }
    // place names, derived from where incidents happened
    const labels = Object.entries(S.cityPos).filter(([, c]) => c.n >= 3).sort((a, b) => b[1].n - a[1].n);
    const placed = [];
    g.font = "400 14px 'Hanken Grotesk', 'Helvetica Neue', Arial, sans-serif";
    try { g.letterSpacing = "3px"; } catch (_) { /* older engines */ }
    g.textAlign = "center"; g.textBaseline = "middle";
    for (const [, c] of labels) {
      if (!proj.inside(c.lat, c.lng)) continue;
      const [x, y] = proj(c.lat, c.lng);
      if (!proj.inView([x, y + 20])) continue;
      if (placed.some(([px, py]) => Math.abs(px - x) < 130 && Math.abs(py - (y + 20)) < 28)) continue;
      placed.push([x, y + 20]);
      g.fillStyle = rgba(COL.mist, 0.42);
      g.fillText(c.name.toUpperCase(), x, y + 20);
      if (placed.length >= 12) break;
    }
  }
  function rebuildCities() {
    setProjection(S.pulse?.region || CFG.region, S.inc7d.concat(S.inc24));
    const acc = {};
    for (const i of S.inc7d.concat(S.inc24)) {
      if (!i.city || i.lat == null || !proj || !proj.inside(i.lat, i.lng)) continue;
      const key = i.city.toLowerCase();
      const a = (acc[key] ||= { name: i.city, lat: 0, lng: 0, n: 0 });
      a.lat += i.lat; a.lng += i.lng; a.n++;
    }
    for (const a of Object.values(acc)) { a.lat /= a.n; a.lng /= a.n; }
    S.cityPos = acc;
    S.fieldDirty = true;
  }

  // ------------------------------------------------------------ ring layer (offscreen)
  function drawGlyphDot(g, x, y, kind, r, alpha, filled) {
    const c = kindRgb(kind);
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = filled ? rgba(c, 0.22 * alpha) : COL.night; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = rgba(c, 0.95 * alpha); g.stroke();
    const s = (r * 1.3) / 24;
    g.save(); g.translate(x - 12 * s, y - 12 * s); g.scale(s, s);
    g.lineWidth = 1.6 / s * 0.9; g.lineCap = "round"; g.lineJoin = "round";
    g.strokeStyle = rgba(c, alpha); g.stroke(GLYPH_PATH[kind] || GLYPH_PATH.other);
    g.restore();
  }
  let ringDots = [];
  function buildRing() {
    S.ringDirty = false;
    const g = ringLayer.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ringLayer.width, ringLayer.height);
    g.setTransform(PX, 0, 0, PX, 0, 0);
    const C = RING.c, P = S.pulse;
    // scaffolding: hairline base circle + hour ticks + four labels
    g.strokeStyle = rgba(COL.lattice, 0.16); g.lineWidth = 1;
    g.beginPath(); g.arc(C, C, RING.base - 6, 0, Math.PI * 2); g.stroke();
    for (let h = 0; h < 24; h++) {
      const a = (h / 24) * Math.PI * 2 - Math.PI / 2, major = h % 6 === 0;
      const r1 = RING.base - 6, r2 = r1 - (major ? 10 : 5);
      g.strokeStyle = rgba(COL.lattice, major ? 0.4 : 0.22);
      g.beginPath(); g.moveTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); g.lineTo(C + Math.cos(a) * r2, C + Math.sin(a) * r2); g.stroke();
    }
    g.font = "400 13px 'Fragment Mono', Menlo, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    try { g.letterSpacing = "1.5px"; } catch (_) { /* ignore */ }
    g.fillStyle = rgba(COL.mist, 0.75);
    [["MIDNIGHT", 0, "center"], ["NOON", 12, "center"]].forEach(([t, h, al]) => {
      const a = (h / 24) * Math.PI * 2 - Math.PI / 2, r = h % 12 ? 394 : RING.label - 6;
      g.textAlign = h % 12 ? (h === 6 ? "left" : "right") : al;
      g.fillText(t, C + Math.cos(a) * r, C + Math.sin(a) * r);
    });
    g.textAlign = "center";
    if (!P) return;
    const bins = P.bins_10min || [];
    const maxCalls = Math.max(10, ...bins.map((b) => b.calls));
    const ref = maxCalls >= 100 ? Math.floor(maxCalls / 50) * 50 : maxCalls >= 40 ? Math.floor(maxCalls / 20) * 20 : Math.floor(maxCalls / 10) * 10;
    const scale = RING.len / maxCalls;
    // reference circle at a round value
    if (ref > 0) {
      const rr = RING.base + ref * scale;
      g.setLineDash([1, 6]); g.strokeStyle = rgba(COL.lattice, 0.28);
      g.beginPath(); g.arc(C, C, rr, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      S.refLabel = { r: rr, text: `${ref} calls / 10 min` };
    }
    const nowBin = Math.floor((P.now - P.bins_start) / 600);
    const binA = (Math.PI * 2) / 144;
    for (let i = 0; i < bins.length; i++) {
      const t = P.bins_start + i * 600 + 300;
      const a = angleOf(t);
      const age = clamp((nowBin - i) / 143, 0, 1);
      const n = bins[i].calls;
      g.save(); g.translate(C, C); g.rotate(a);
      const wBar = Math.min(9, RING.base * binA - 3);
      if (n > 0) {
        const len = Math.max(3, n * scale);
        g.fillStyle = rgba(COL.sodium, 0.95 - 0.62 * age);
        g.beginPath(); g.roundRect(RING.base, -wBar / 2, len, wBar, [0, 4, 4, 0]); g.fill();
      } else {
        g.fillStyle = rgba(COL.lattice, 0.14);
        g.fillRect(RING.base, -1, 3, 2);
      }
      g.restore();
    }
    // incident openings as glyph dots, stacked inward when they collide
    const act = new Set(activeList().map((i) => i.id));
    const list = S.inc24.filter((i) => i.first_at >= P.bins_start).sort((a, b) => a.first_at - b.first_at);
    const slots = [[], []];
    ringDots = [];
    for (const inc of list) {
      const a = angleOf(inc.first_at);
      let k = 0;
      while (k < 2 && slots[k].some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * (RING.glyph - k * 22) < 23)) k++;
      if (k >= 2) continue;
      slots[k].push(a);
      const r = RING.glyph - k * 22;
      const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
      ringDots.push({ id: inc.id, x, y, kind: inc.kind });
      drawGlyphDot(g, x, y, inc.kind, 10, act.has(inc.id) ? 1 : 0.62, act.has(inc.id));
    }
  }

  // ------------------------------------------------------------ per-frame drawing
  let lastFrame = 0;
  function frame(tms) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (tms - lastFrame < 15) return;        // cap ~60fps on high-refresh panels
    lastFrame = tms;
    const t = tms / 1000;
    if (S.fieldDirty) buildField();
    if (S.ringDirty) buildRing();
    drawMap(t);
    drawRing(t);
  }

  function drawMap(t) {
    const g = mapCtx;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, mapCv.width, mapCv.height);
    g.drawImage(field, 0, 0);
    g.setTransform(PX, 0, 0, PX, 0, 0);
    const act = activeList(), actIds = new Set(act.map((i) => i.id));
    // embers: the day's earlier incidents
    if (!DEMO) for (const i of S.inc24) {
      if (actIds.has(i.id)) continue;
      const p = posOf(i); if (!p) continue;
      g.fillStyle = rgba(kindRgb(i.kind), 0.5);
      g.beginPath(); g.arc(p[0], p[1], 3, 0, Math.PI * 2); g.fill();
    }
    // active incidents: glow, breathe with traffic
    const unmapped = [];
    for (const i of act) {
      const p = posOf(i);
      if (!p) { unmapped.push(i); continue; }
      const c = kindRgb(i.kind);
      const phase = (i.id % 17) * 0.37;
      const breathe = 1 + 0.14 * Math.sin((t / 6.5) * Math.PI * 2 + phase);
      const recent = clamp(1 - (nowSec() - i.last_at) / 3600, 0.25, 1);
      const r = (12 + 7 * Math.sqrt(i.calls || 1)) * breathe;
      const grd = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 2.2);
      grd.addColorStop(0, rgba(c, 0.42 * recent + 0.1));
      grd.addColorStop(0.35, rgba(c, 0.14 * recent + 0.04));
      grd.addColorStop(1, rgba(c, 0));
      g.fillStyle = grd; g.beginPath(); g.arc(p[0], p[1], r * 2.2, 0, Math.PI * 2); g.fill();
    }
    for (const i of act) {
      const p = posOf(i); if (!p) continue;
      g.fillStyle = rgba(kindRgb(i.kind), 0.95);
      g.beginPath(); g.arc(p[0], p[1], 3.6, 0, Math.PI * 2); g.fill();
      g.fillStyle = rgba(COL.bone, 0.85);
      g.beginPath(); g.arc(p[0], p[1], 1.4, 0, Math.PI * 2); g.fill();
    }
    // ripples: one per new call tied to an incident
    S.ripples = S.ripples.filter((rp) => t - rp.t0 < 4.5);
    for (const rp of S.ripples) {
      const p = (t - rp.t0) / 4.5, e = ease(p);
      g.strokeStyle = rgba(rp.c, 0.7 * (1 - p) * (1 - p)); g.lineWidth = 1.6 - p;
      g.beginPath(); g.arc(rp.x, rp.y, 6 + e * 130, 0, Math.PI * 2); g.stroke();
      if (p > 0.18) {
        const p2 = (p - 0.18) / 0.82;
        g.strokeStyle = rgba(rp.c, 0.35 * (1 - p2) * (1 - p2)); g.lineWidth = 1;
        g.beginPath(); g.arc(rp.x, rp.y, 6 + ease(p2) * 90, 0, Math.PI * 2); g.stroke();
      }
    }
    // unmapped active incidents along the lower edge
    if (unmapped.length) {
      const y = MAP.pad + MAP.h + 20;
      let x = MAP.pad + MAP.w - 8;
      g.font = "400 13px 'Fragment Mono', Menlo, monospace"; g.textAlign = "right"; g.textBaseline = "middle";
      try { g.letterSpacing = "1.5px"; } catch (_) { /* ignore */ }
      for (const i of unmapped.slice(0, 12)) {
        const c = kindRgb(i.kind);
        const b = 0.6 + 0.4 * Math.sin(t / 3 + i.id);
        g.fillStyle = rgba(c, 0.25 * b); g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
        g.fillStyle = rgba(c, 0.95); g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
        i._ux = x; i._uy = y;
        x -= 26;
      }
      g.fillStyle = rgba(COL.mist, 0.5);
      g.fillText("NOT YET MAPPED", x - 6, y + 1);
    }
    // focus reticle + leader line
    const f = S.focus;
    if (f) {
      const fade = clamp((t - f.t0) / 1.6, 0, 1) * (f.leaving ? clamp(1 - (t - f.leaving) / 1.2, 0, 1) : 1);
      const p = posOf(f.inc) || (f.inc._ux != null ? [f.inc._ux, f.inc._uy] : null);
      if (p && fade > 0) {
        const c = kindRgb(f.inc.kind);
        const rr = 22 + 2 * Math.sin(t * 1.1);
        g.strokeStyle = rgba(COL.bone, 0.7 * fade); g.lineWidth = 1.2;
        for (let q = 0; q < 4; q++) {
          const a0 = t * 0.25 + q * Math.PI / 2;
          g.beginPath(); g.arc(p[0], p[1], rr, a0 + 0.25, a0 + Math.PI / 2 - 0.25); g.stroke();
        }
        g.strokeStyle = rgba(c, 0.45 * fade);
        g.beginPath(); g.arc(p[0], p[1], rr + 9, 0, Math.PI * 2); g.stroke();
        if (f.anchor) {
          const [ax, ay] = f.anchor;
          const dx = ax - p[0], dy = ay - p[1], d = Math.hypot(dx, dy);
          if (d > rr + 16) {
            const sx = p[0] + (dx / d) * (rr + 12), sy = p[1] + (dy / d) * (rr + 12);
            const grd = g.createLinearGradient(sx, sy, ax, ay);
            grd.addColorStop(0, rgba(COL.bone, 0.55 * fade)); grd.addColorStop(1, rgba(COL.bone, 0.08 * fade));
            g.strokeStyle = grd; g.lineWidth = 1;
            g.beginPath(); g.moveTo(sx, sy); g.lineTo(ax, ay); g.stroke();
          }
        }
      }
    }
  }

  function drawRing(t) {
    const g = ringCtx, C = RING.c, P = S.pulse;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ringCv.width, ringCv.height);
    // the whole dial breathes very slightly with the last 30 minutes of traffic
    let rate = 0.5;
    if (P) {
      const b = P.bins_10min || [], recent = b.slice(-3).reduce((s, x) => s + x.calls, 0) / 3;
      const max = Math.max(10, ...b.map((x) => x.calls));
      rate = clamp(recent / max, 0, 1);
    }
    const breath = 0.88 + 0.12 * (0.5 + 0.5 * Math.sin((t / (9 - 4 * rate)) * Math.PI * 2));
    g.globalAlpha = breath;
    g.drawImage(ringLayer, 0, 0);
    g.globalAlpha = 1;
    g.setTransform(PX, 0, 0, PX, 0, 0);
    if (S.refLabel) {
      g.font = "400 12px 'Fragment Mono', Menlo, monospace"; g.textAlign = "left"; g.textBaseline = "middle";
      g.fillStyle = rgba(COL.mist, 0.55);
      const a = -Math.PI / 2 + 0.16;
      g.save(); g.translate(C + Math.cos(a) * (S.refLabel.r + 2), C + Math.sin(a) * (S.refLabel.r + 2)); g.rotate(a + Math.PI / 2);
      g.fillText(S.refLabel.text, 2, -8); g.restore();
    }
    // the now hand
    const now = nowSec(), a = angleOf(now);
    const trail = 0.42;
    try {
      const cg = g.createConicGradient(a - trail, C, C);
      cg.addColorStop(0, rgba(COL.sodium, 0)); cg.addColorStop(trail / (Math.PI * 2), rgba(COL.sodium, 0.13 + 0.08 * rate));
      cg.addColorStop(Math.min(1, trail / (Math.PI * 2) + 0.0001), rgba(COL.sodium, 0)); cg.addColorStop(1, rgba(COL.sodium, 0));
      g.fillStyle = cg;
      g.beginPath(); g.arc(C, C, RING.base + RING.len + 8, a - trail, a); g.arc(C, C, RING.glyph + 16, a, a - trail, true); g.closePath(); g.fill();
    } catch (_) { /* conic gradients unsupported: skip trail */ }
    const r0 = RING.glyph + 16, r1 = RING.base + RING.len + 14;
    const hg = g.createLinearGradient(C + Math.cos(a) * r0, C + Math.sin(a) * r0, C + Math.cos(a) * r1, C + Math.sin(a) * r1);
    hg.addColorStop(0, rgba(COL.sodium, 0)); hg.addColorStop(1, rgba(COL.sodium, 0.95));
    g.strokeStyle = hg; g.lineWidth = 2; g.lineCap = "round";
    g.beginPath(); g.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0); g.lineTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); g.stroke();
    const tx = C + Math.cos(a) * r1, ty = C + Math.sin(a) * r1;
    g.fillStyle = rgba(COL.sodium, 0.95); g.beginPath(); g.arc(tx, ty, 3.2, 0, Math.PI * 2); g.fill();
    // sparks at the tip: one per transmission shown
    S.sparks = S.sparks.filter((s) => t - s.t0 < 3);
    for (const s of S.sparks) {
      const p = (t - s.t0) / 3;
      g.strokeStyle = rgba(s.c, 0.8 * (1 - p) * (1 - p)); g.lineWidth = 1.4;
      g.beginPath(); g.arc(tx, ty, 4 + ease(p) * 34, 0, Math.PI * 2); g.stroke();
    }
    // focused incident's dot on the ring
    const f = S.focus;
    if (f) {
      const d = ringDots.find((x) => x.id === f.inc.id);
      if (d) {
        const fade = clamp((t - f.t0) / 1.6, 0, 1) * (f.leaving ? clamp(1 - (t - f.leaving) / 1.2, 0, 1) : 1);
        g.strokeStyle = rgba(COL.bone, 0.75 * fade); g.lineWidth = 1.2;
        g.beginPath(); g.arc(d.x, d.y, 15 + 1.5 * Math.sin(t * 1.3), 0, Math.PI * 2); g.stroke();
      }
    }
  }

  // ------------------------------------------------------------ voice lines
  const linesEl = $("#lines");
  function lineHtml(text, animate) {
    const parts = String(text || "").split(/(⟦[^⟧]*⟧)/);
    let i = 0, out = "";
    const delay = () => (animate ? ` style="animation-delay:${Math.min(i++ * 85, 2600)}ms"` : ` style="animation-duration:0s"`);
    for (const part of parts) {
      if (!part) continue;
      if (/^⟦[^⟧]*⟧$/.test(part)) { out += `<span class="w"${delay()}><span class="redacted">hidden</span></span> `; continue; }
      for (const w of part.split(/\s+/)) if (w) out += `<span class="w"${delay()}>${esc(w)}</span> `;
    }
    return out;
  }
  function metaHtml(it) {
    const inc = it.incident && it.incident.title ? it.incident : null;
    return `${it.channel ? `<span class="ch">${esc(it.channel)}</span><span class="dot"></span>` : ""}`
      + `<span class="when" data-at="${it.at}">${esc(hm(it.at))} · ${esc(ago(it.at))}</span>`
      + (inc ? `<span class="dot"></span><span class="inc">${glyph(inc.kind)}<span class="tt">${esc(inc.title)}</span></span>` : "");
  }
  function showLine(it, animate = true) {
    const quiet = linesEl.querySelector(".quiet-note"); if (quiet) quiet.remove();
    for (const el of linesEl.querySelectorAll(".line:not(.past)")) el.classList.add("past");
    const el = document.createElement("div");
    el.className = "line" + (animate ? " new" : "");
    el.innerHTML = `<div class="text">${lineHtml(it.line, animate)}</div><div class="meta">${metaHtml(it)}</div>`;
    linesEl.appendChild(el);
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("new")));
    const all = linesEl.querySelectorAll(".line");
    for (let i = 0; i < all.length - 4; i++) {
      const old = all[i];
      old.style.opacity = "0";
      setTimeout(() => old.remove(), 2500);
    }
    if (!animate) return;
    S.lineAt = nowSec();
    const t = performance.now() / 1000;
    const incId = it.incident_id || it.incident?.id;
    const inc = incId != null ? (S.incById.get(incId) || it.incident) : null;
    S.sparks.push({ t0: t, c: inc ? kindRgb(inc.kind) : COL.sodium });
    if (inc) {
      const full = activeList().find((x) => x.id === inc.id) || S.incById.get(inc.id);
      const p = full && posOf(full);
      if (p) S.ripples.push({ x: p[0], y: p[1], c: kindRgb(full.kind), t0: t });
    }
    if (S.sound && CFG.audio && it.audio) {
      try { const a = new Audio(it.audio); a.volume = 0.7; a.play().catch(() => {}); } catch (_) { /* ignore */ }
    }
  }
  function pumpQueue() {
    if (!S.queue.length) return;
    // when far behind, skip unattached chatter and keep only the freshest few
    if (S.queue.length > 3) S.queue = S.queue.filter((x, i) => x.incident_id || x.type !== "Radio Chatter" || i === S.queue.length - 1);
    if (S.queue.length > 5) S.queue = S.queue.slice(-5);
    const dwell = S.queue.length > 2 ? 5 : 7.5;
    if (nowSec() - S.lineAt < dwell) return;
    showLine(S.queue.shift(), true);
  }
  function refreshAgo() {
    for (const el of linesEl.querySelectorAll(".when[data-at]")) {
      const at = +el.dataset.at; el.textContent = `${hm(at)} · ${ago(at)}`;
    }
  }

  // ------------------------------------------------------------ focus caption
  const capEl = $("#caption");
  function focusPool() {
    const act = activeList();
    if (act.length) return { list: act.slice(0, 12), earlier: false };
    return { list: S.inc24.slice().sort((a, b) => b.last_at - a.last_at).slice(0, 6), earlier: true };
  }
  function nextFocus() {
    const { list, earlier } = focusPool();
    if (!list.length) { hideCaption(); return; }
    // mapped incidents first in the rotation, but every one gets its turn
    S.focusIdx = (S.focusIdx + 1) % list.length;
    const inc = list[S.focusIdx];
    const t = performance.now() / 1000;
    if (S.focus) S.focus.leaving = t;
    capEl.classList.remove("on");
    setTimeout(() => placeCaption(inc, earlier), S.focus ? 1300 : 0);
  }
  function hideCaption() {
    if (S.focus) S.focus.leaving = performance.now() / 1000;
    capEl.classList.remove("on");
  }
  function unitText(u) {
    if (!u) return "";
    const n = (u.police || 0) + (u.fire || 0) + (u.ems || 0) + (u.other || 0);
    return n ? `${n} unit${n === 1 ? "" : "s"}` : "";
  }
  function placeCaption(inc, earlier) {
    const st = STATUS_LABEL[inc.status] || "";
    const when = earlier
      ? `${inc.status === "ended" ? "ended" : "last heard"} ${ago(inc.last_at)}`
      : `opened ${hm(inc.first_at)}`;
    const where = [inc.location, inc.city].filter(Boolean).join(", ") || "Location not given";
    const bits = [earlier && inc.status === "ended" ? "" : `<span class="st">${esc(st)}</span>`, `<span class="${earlier && inc.status === "ended" ? "st" : ""}">${esc(earlier && inc.status === "ended" ? when[0].toUpperCase() + when.slice(1) : when)}</span>`, inc.calls ? `${inc.calls} call${inc.calls === 1 ? "" : "s"}` : "", unitText(inc.units)].filter(Boolean);
    capEl.innerHTML = `<div class="eyebrow">${glyph(inc.kind)}<span>${esc(earlier ? "Earlier today" : KIND_SHORT[inc.kind] || "Incident")}</span></div>`
      + `<h2><span class="t">${esc(inc.title || "Untitled incident")}</span></h2>`
      + `<div class="where"><span class="t">${esc(where)}</span><br><span class="t">${bits.join(" · ")}</span></div>`;
    const p = posOf(inc) || (inc._ux != null ? [inc._ux, inc._uy] : null);
    // put the caption in the quadrant away from the point
    const px = p ? p[0] - MAP.pad : 200, py = p ? p[1] - MAP.pad : 400;
    const right = px < MAP.w * 0.5;
    capEl.classList.toggle("r", right);
    const h = capEl.offsetHeight, w = capEl.offsetWidth;
    const top = py < MAP.h * 0.5 ? MAP.h - h : 0;
    const left = right ? MAP.w - w : 0;
    capEl.style.left = `${left}px`; capEl.style.top = `${top}px`;
    // anchor the leader at the nearest edge of the text itself (right-aligned text is ragged)
    const sc = capEl.getBoundingClientRect().width / w || 1, box = capEl.getBoundingClientRect();
    let edge = right ? w : 0;
    for (const el of capEl.querySelectorAll(".eyebrow, h2 .t, .where .t")) {
      for (const rc of el.getClientRects()) {
        const x0 = (rc.left - box.left) / sc, x1 = (rc.right - box.left) / sc;
        edge = right ? Math.min(edge, x0) : Math.max(edge, x1);
      }
    }
    const ax = MAP.pad + left + (right ? edge - 22 : edge + 22);
    const ay = MAP.pad + top + h * 0.5;
    S.focus = { inc, t0: performance.now() / 1000, anchor: posOf(inc) ? [ax, ay] : null, leaving: 0 };
    requestAnimationFrame(() => capEl.classList.add("on"));
    S.ringDirty = true;
  }

  // ------------------------------------------------------------ text panels
  function renderTally() {
    const P = S.pulse; if (!P) return;
    const h = P.headline || {};
    const act = activeList();
    const cur = h.calls_1h ?? 0, prev = h.calls_prev_1h ?? 0;
    const trend = cur > prev ? `up from ${prev}` : cur < prev ? `down from ${prev}` : "the same as the hour before";
    const open = DEMO ? act.length : h.active ?? act.length;
    $("#sentence").innerHTML = `<b>${cur}</b> transmissions in the last hour, ${esc(trend)}.<br>`
      + `<b>${open}</b> incident${open === 1 ? "" : "s"} open, <b>${h.units_out ?? 0}</b> unit${h.units_out === 1 ? "" : "s"} out.`;
    const byKind = {};
    for (const i of act) byKind[i.kind || "other"] = (byKind[i.kind || "other"] || 0) + 1;
    const order = ["violence", "fire", "medical", "traffic", "property", "suspicious", "other"];
    const kinds = order.filter((k) => byKind[k]);
    $("#kinds").innerHTML = kinds.length
      ? kinds.map((k) => `<span title="${esc(KIND_LABEL[k])}">${glyph(k)}<b>${byKind[k]}</b>${kinds.length > 4 ? "" : " " + esc(KIND_SHORT[k])}</span>`).join("")
      : `<span>${h.opened_24h ?? 0} incidents opened in the last 24 hours</span>`;
  }
  function renderClock() {
    const d = new Date();
    const parts = fmtHM.formatToParts(d);
    const time = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
    const dp = (parts.find((p) => p.type === "dayPeriod") || {}).value || "";
    $("#clock").innerHTML = `${esc(time)}<small>${esc(dp)}</small>`;
    $("#date").textContent = fmtDate.format(d);
  }
  function renderWeather(w) {
    if (!w || !w.now) return;
    const n = w.now, text = n.text || (w.forecast && w.forecast[0] && w.forecast[0].short) || "";
    const wind = n.wind_mph ? ` · wind ${n.wind_dir || ""} ${n.wind_mph} mph` : n.wind_dir ? " · calm" : "";
    const al = (w.alerts || [])[0];
    $("#wx").innerHTML = `<b>${esc(n.temp ?? "–")}°</b> ${esc(text)}${esc(wind)}`
      + (al ? `<span class="alert">${esc(al.event || al.headline || al.title || "Weather alert")}</span>` : "");
  }
  function setConn() {
    const bad = Object.values(S.fails).some((n) => n >= 2);
    $("#conn").hidden = !bad;
  }
  function ok(k) { S.fails[k] = 0; setConn(); }
  function fail(k, e) { S.fails[k] = (S.fails[k] || 0) + 1; setConn(); console.warn("pulse wall:", k, e && e.message); }

  // ------------------------------------------------------------ polling
  function indexIncidents() {
    S.incById = new Map();
    for (const i of S.inc7d) S.incById.set(i.id, i);
    for (const i of S.inc24) S.incById.set(i.id, i);
    for (const i of S.pulse?.active || []) S.incById.set(i.id, i);
  }
  async function pollPulse() {
    try {
      const p = await api("pulse");
      S.pulse = p;
      if (p.region && !proj) setProjection(p.region);
      indexIncidents();
      S.ringDirty = true;
      renderTally();
      const lag = p.pipeline && p.pipeline.lag_sec;
      const lagEl = $("#lag");
      lagEl.hidden = !(lag > 600);
      if (lag > 600) lagEl.textContent = `Catching up · transcripts ${lag >= 5400 ? `${Math.round(lag / 1800) / 2} h` : `${Math.round(lag / 60)} min`} behind`;
      if (!S.focus && activeList().length) nextFocus();
      ok("pulse");
    } catch (e) { fail("pulse", e); }
  }
  async function pollInc24() {
    try {
      const d = await api("incidents", { window: "24h" });
      S.inc24 = d.items || [];
      indexIncidents(); rebuildCities();
      S.ringDirty = true;
      renderTally();
      ok("inc");
    } catch (e) { fail("inc", e); }
  }
  async function pollInc7d() {
    try {
      const d = await api("incidents", { window: "7d", limit: 1000 });
      S.inc7d = d.items || [];
      indexIncidents(); rebuildCities();
    } catch (e) { console.warn("pulse wall: 7d", e && e.message); }
  }
  async function pollWeather() {
    try { renderWeather(await api("weather")); } catch (e) { /* weather is decorative */ }
  }
  const usable = (it) => it && it.line && String(it.line).trim().length > 3;
  async function initRadio() {
    try {
      const d = await api("radio", { limit: 12 });
      const items = (d.items || []).filter(usable).sort((a, b) => a.at - b.at);
      for (const it of d.items || []) S.seen.add(it.id);
      S.radioLast = Math.max(0, ...(d.items || []).map((x) => x.at));
      const tail = items.slice(-4);
      if (!tail.length) linesEl.innerHTML = `<div class="quiet-note">The radio is quiet.</div>`;
      tail.slice(0, -1).forEach((it) => showLine(it, false));
      if (tail.length) showLine(tail[tail.length - 1], true);
      ok("radio");
    } catch (e) { fail("radio", e); setTimeout(initRadio, 8000); return false; }
    return true;
  }
  async function pollRadio() {
    if (!S.radioLast) return;
    try {
      const d = await api("radio", { since: S.radioLast, limit: 50 });
      const fresh = (d.items || []).filter((x) => !S.seen.has(x.id)).sort((a, b) => a.at - b.at);
      for (const it of fresh) {
        S.seen.add(it.id);
        S.radioLast = Math.max(S.radioLast, it.at);
        if (usable(it)) S.queue.push(it);
      }
      if (S.seen.size > 5000) S.seen = new Set([...S.seen].slice(-1000));
      ok("radio");
    } catch (e) { fail("radio", e); }
  }

  // demo: replay recent radio + incident timelines as if live
  async function buildDemoPool() {
    const pool = [];
    try {
      const d = await api("radio", { limit: 60 });
      for (const it of d.items || []) if (usable(it)) pool.push(it);
    } catch (_) { /* fine */ }
    const picks = S.inc24.filter((i) => posOf(i)).slice(0, 10);
    const details = await Promise.all(picks.map((i) => api(`incidents/${i.id}`).catch(() => null)));
    for (const det of details) {
      if (!det) continue;
      for (const ev of det.timeline || []) {
        if (!usable(ev)) continue;
        pool.push({ ...ev, incident_id: det.id, incident: { id: det.id, title: det.title, kind: det.kind } });
      }
    }
    const byId = new Map(); for (const p of pool) byId.set(p.id ?? `${p.at}-${p.line}`, p);
    S.demoPool = [...byId.values()].sort((a, b) => a.at - b.at);
    // interleave so incident-linked lines come up often
    const linked = S.demoPool.filter((x) => x.incident_id), loose = S.demoPool.filter((x) => !x.incident_id);
    const mix = [];
    while (linked.length || loose.length) { if (linked.length) mix.push(linked.shift()); if (loose.length) mix.push(loose.shift()); }
    S.demoPool = mix;
  }
  function demoTick() {
    if (!S.demoPool.length) return;
    S.queue.push(S.demoPool[S.demoIdx % S.demoPool.length]);
    S.demoIdx++;
  }

  // ------------------------------------------------------------ ambient bits
  function driftTick() {
    const t = Date.now() / 1000;
    const x = 11 * Math.sin(t / 1013), y = 7 * Math.sin(t / 1381 + 1.3);
    drift.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
  }
  let mouseT = 0;
  addEventListener("mousemove", () => {
    document.body.classList.add("mouse");
    clearTimeout(mouseT); mouseT = setTimeout(() => document.body.classList.remove("mouse"), 3500);
  });
  const sndBtn = $("#sound");
  if (sndBtn) sndBtn.addEventListener("click", () => {
    S.sound = !S.sound;
    sndBtn.textContent = S.sound ? "Sound on" : "Sound off";
    sndBtn.classList.toggle("on", S.sound);
  });
  // reload every 6 h, but only when the server answers (never strand the wall on an error page)
  function scheduleReload(ms) {
    setTimeout(async () => {
      try { await api("pulse"); location.reload(); } catch (_) { scheduleReload(5 * 60 * 1000); }
    }, ms);
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    if (DEMO) $("#demo-tag").hidden = false;
    fit(); renderClock(); driftTick();
    requestAnimationFrame(frame);
    setInterval(renderClock, 1000);
    setInterval(driftTick, 1000);
    setInterval(refreshAgo, 30000);
    setInterval(pumpQueue, 500);
    setInterval(nextFocus, 15000);
    await Promise.all([pollPulse(), pollInc24(), pollWeather()]);
    pollInc7d();
    setInterval(pollPulse, 15000);
    setInterval(pollInc24, 60000);
    setInterval(pollInc7d, 30 * 60 * 1000);
    setInterval(pollWeather, 10 * 60 * 1000);
    if (!S.focus) nextFocus();
    if (DEMO) {
      await buildDemoPool();
      if (!S.demoPool.length) await initRadio();
      demoTick(); S.lineAt = 0;
      setInterval(demoTick, 6500);
    } else {
      await initRadio();
      setInterval(pollRadio, 5000);
    }
    scheduleReload(6 * 3600 * 1000);
  }
  boot();
})();
