// jafo — command-center HUD.
//
// Three live visual systems that make the main page read like a SIGINT console:
//   1. Audio spectrum + oscilloscope  — WebAudio FFT on the scanner's audio
//   2. Telemetry readouts + traffic graph — from /api/stats, /api/aircraft, /api/calls
//   3. Scrolling intel ticker — from /api/ticker
//
// Loaded after app.js + scanner.js, so it reuses their globals (api, scanner).

// ============================================================
// Agency patch — generated SVG "shield" for the transmitting agency
// ============================================================
const CC_CAT_COLOR = {
  police:'#3b82f6', fire:'#ef4444', ems:'#f97316', school:'#eab308',
  utility:'#d29922', water:'#38bdf8', power:'#f5d020', transit:'#22c55e',
  government:'#94a3b8', dispatch:'#a78bfa', traffic:'#fb923c', hazmat:'#d4e020',
  rescue:'#ff8c3c', air:'#b46adc', aviation:'#b46adc', marine:'#3cb4b4',
  hospital:'#ff82aa', construction:'#dc8c3c', k9:'#a0785a', park:'#3fb950',
  emergency:'#ffb000', weather:'#60a5fa', radio:'#35e3ff',
};
function ccHash(s) { let h=0; s=String(s||''); for (let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return Math.abs(h); }
function ccAgencyInitials(tag) {
  if (!tag) return '??';
  const upper = (tag.match(/[A-Z0-9]/g) || []).join('');
  if (upper.length >= 2 && upper.length <= 4) return upper;
  const words = tag.replace(/[^A-Za-z0-9]/g,' ').split(/\s+/).filter(Boolean);
  return (words.slice(0,3).map(w=>w[0].toUpperCase()).join('') || tag.slice(0,2).toUpperCase());
}
function ccAgencyPatch(tag, category, size) {
  size = size || 36;
  const col = CC_CAT_COLOR[category] || '#35e3ff';
  const ini = ccAgencyInitials(tag);
  const id = 'ap' + (ccHash(tag) % 100000);
  const fs = ini.length >= 4 ? 11 : (ini.length === 3 ? 14 : 16);
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" role="img" aria-label="${ccEsc(tag)}">
    <defs><radialGradient id="${id}" cx="50%" cy="36%" r="72%">
      <stop offset="0%" stop-color="#102230"/><stop offset="100%" stop-color="#050b11"/>
    </radialGradient></defs>
    <circle cx="24" cy="24" r="22" fill="url(#${id})" stroke="${col}" stroke-width="2.5"/>
    <circle cx="24" cy="24" r="17.5" fill="none" stroke="${col}" stroke-width="1" opacity="0.45"/>
    <text x="24" y="25" text-anchor="middle" dominant-baseline="central"
      font-family="ui-monospace, Menlo, monospace" font-weight="700"
      font-size="${fs}" letter-spacing="0.5" fill="${col}">${ccEsc(ini)}</text>
  </svg>`;
}

// ============================================================
// Canvas helpers (crisp on HiDPI, resize-aware)
// ============================================================
function ccFitCanvas(cv) {
  if (!cv) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ============================================================
// 1. Audio spectrum analyser + oscilloscope
// ============================================================
let ccAudioCtx = null, ccAnalyser = null, ccSrc = null, ccFreq = null, ccTime = null;
let ccSpec = null, ccSpecCtx = null;

function ccEnsureAudioGraph() {
  if (ccAnalyser) return;
  const el = document.getElementById("scanner-audio");
  if (!el) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ccAudioCtx = new AC();
    ccSrc = ccAudioCtx.createMediaElementSource(el);
    ccAnalyser = ccAudioCtx.createAnalyser();
    ccAnalyser.fftSize = 256;
    ccAnalyser.smoothingTimeConstant = 0.82;
    ccSrc.connect(ccAnalyser);
    ccAnalyser.connect(ccAudioCtx.destination);
    ccFreq = new Uint8Array(ccAnalyser.frequencyBinCount);
    ccTime = new Uint8Array(ccAnalyser.fftSize);
  } catch (e) {
    // createMediaElementSource throws if already wired — safe to ignore.
  }
}

function ccResumeAudio() {
  if (ccAudioCtx && ccAudioCtx.state === "suspended") ccAudioCtx.resume();
}

function ccScannerPlaying() {
  return typeof scanner !== "undefined" && scanner.audio &&
         !scanner.audio.paused && !scanner.audio.ended && scanner.audio.currentTime > 0;
}

function ccDrawSpectrum() {
  requestAnimationFrame(ccDrawSpectrum);
  const cv = ccSpec; if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) {
    ccSpecCtx = ccFitCanvas(cv);
  }
  const ctx = ccSpecCtx; if (!ctx) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const t = performance.now() / 1000;

  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = "rgba(53,227,255,0.10)";
  ctx.lineWidth = 1;
  for (let gy = 0; gy <= 4; gy++) {
    const y = (h / 4) * gy + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const live = ccAnalyser && ccScannerPlaying();
  const statusEl = document.getElementById("cc-spectrum-status");
  if (statusEl) statusEl.textContent = live ? "◉ RECEIVING" : "STANDBY";
  if (statusEl) statusEl.style.color = live ? "#37f5a6" : "";

  // ---- bars ---- (adaptive: more bars on a wider canvas)
  const BARS = Math.max(48, Math.min(96, Math.floor(w / 8)));
  let mag = new Array(BARS);
  if (live) {
    ccAnalyser.getByteFrequencyData(ccFreq);
    // use the lower ~half of bins (where voice energy lives), map to BARS
    const usable = Math.floor(ccFreq.length * 0.8);
    for (let i = 0; i < BARS; i++) {
      const idx = Math.floor((i / BARS) * usable);
      mag[i] = ccFreq[idx] / 255;
    }
  } else {
    // idle "standby" sweep — animated noise so the console always looks alive
    for (let i = 0; i < BARS; i++) {
      const base = 0.18 + 0.14 * Math.sin(i * 0.35 + t * 1.6);
      const ripple = 0.10 * Math.sin(i * 0.9 - t * 3.0);
      const shimmer = 0.05 * Math.sin(i * 2.1 + t * 5.0);
      mag[i] = Math.max(0.04, base + ripple + shimmer);
    }
  }

  const bw = w / BARS;
  ctx.shadowBlur = live ? 10 : 5;
  for (let i = 0; i < BARS; i++) {
    const bh = Math.max(1, mag[i] * (h - 6));
    const x = i * bw;
    const y = h - bh;
    const hue = live ? 165 - mag[i] * 110 : 190;   // green→cyan with level
    const col = live ? `hsl(${hue}, 100%, ${45 + mag[i] * 20}%)` : "rgba(53,227,255,0.5)";
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.fillRect(x + 0.5, y, Math.max(1, bw - 1.5), bh);
  }
  ctx.shadowBlur = 0;

  // ---- oscilloscope overlay ----
  ctx.beginPath();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = live ? "rgba(255,255,255,0.75)" : "rgba(53,227,255,0.35)";
  ctx.shadowBlur = 8;
  ctx.shadowColor = live ? "#9fffe0" : "rgba(53,227,255,0.4)";
  if (live) {
    ccAnalyser.getByteTimeDomainData(ccTime);
    const step = ccTime.length / w;
    for (let x = 0; x < w; x++) {
      const v = ccTime[Math.floor(x * step)] / 128 - 1;   // -1..1
      const y = h / 2 + v * (h / 2 - 4);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  } else {
    for (let x = 0; x < w; x++) {
      const v = Math.sin(x * 0.045 + t * 2.2) * 0.25 + Math.sin(x * 0.012 - t) * 0.08;
      const y = h / 2 + v * (h / 2 - 4);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ============================================================
// 2. Telemetry readouts + traffic graph
// ============================================================
const CC_METRICS = [
  { key: "calls24",  label: "Calls / 24h", cls: "cyan" },
  { key: "callshr",  label: "Calls / hr",  cls: "" },
  { key: "active",   label: "Active ch",   cls: "" },
  { key: "aircraft", label: "Aircraft",    cls: "cyan" },
  { key: "total",    label: "Total int",   cls: "" },
  { key: "backlog",  label: "Queue",       cls: "amber" },
];
const ccVals = {};        // displayed (animated) values
const ccTargets = {};     // target values
const ccHist = {};        // rolling history per metric → sparkline

function ccBuildMetrics() {
  const root = document.getElementById("cc-metrics");
  if (!root) return;
  root.innerHTML = CC_METRICS.map((m) => `
    <div class="cc-metric">
      <div class="cc-metric-label">${m.label}</div>
      <div class="cc-metric-val ${m.cls}" id="cc-m-${m.key}">—</div>
      <canvas class="cc-metric-spark" id="cc-spark-${m.key}"></canvas>
    </div>`).join("");
  CC_METRICS.forEach((m) => { ccVals[m.key] = 0; ccTargets[m.key] = 0; ccHist[m.key] = []; });
}

function ccSetMetric(key, value) {
  if (value == null || isNaN(value)) return;
  ccTargets[key] = value;
  const h = ccHist[key];
  h.push(value);
  if (h.length > 48) h.shift();
}

function ccFmtNum(n) {
  n = Math.round(n);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 10000)   return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString();
}

function ccAnimateMetrics() {
  requestAnimationFrame(ccAnimateMetrics);
  for (const m of CC_METRICS) {
    const cur = ccVals[m.key], tgt = ccTargets[m.key];
    if (cur !== tgt) {
      const next = cur + (tgt - cur) * 0.18;
      ccVals[m.key] = Math.abs(tgt - next) < 0.5 ? tgt : next;
      const el = document.getElementById(`cc-m-${m.key}`);
      if (el) el.textContent = ccFmtNum(ccVals[m.key]);
    }
    ccDrawSpark(m.key);
  }
}

function ccDrawSpark(key) {
  const cv = document.getElementById(`cc-spark-${key}`);
  if (!cv) return;
  if (cv.width !== cv.clientWidth * (window.devicePixelRatio || 1)) ccFitCanvas(cv);
  const ctx = cv.getContext("2d");
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const data = ccHist[key];
  if (!data || data.length < 2) return;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const span = max - min || 1;
  ctx.beginPath();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = "rgba(55,245,166,0.8)";
  ctx.shadowBlur = 5; ctx.shadowColor = "rgba(55,245,166,0.6)";
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 2) - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ---- traffic graph: calls/min over the last 60 minutes ----
let ccTrafficCv = null;

function ccDrawTraffic(buckets) {
  const cv = ccTrafficCv; if (!cv) return;
  const ctx = ccFitCanvas(cv);
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);
  // baseline grid
  ctx.strokeStyle = "rgba(53,227,255,0.08)";
  ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
  const max = Math.max(...buckets, 1);
  const n = buckets.length;
  const bw = w / n;
  ctx.shadowBlur = 6;
  for (let i = 0; i < n; i++) {
    const bh = (buckets[i] / max) * (h - 3);
    const x = i * bw;
    const recent = i >= n - 5;
    const col = recent ? "#37f5a6" : "rgba(53,227,255,0.55)";
    ctx.fillStyle = col; ctx.shadowColor = col;
    ctx.fillRect(x + 0.5, h - bh, Math.max(1, bw - 1), bh);
  }
  ctx.shadowBlur = 0;
}

async function ccRefreshTraffic() {
  try {
    const data = await api("/api/calls?limit=500&only_kept=1");
    const calls = data.calls || [];
    ccRecentCalls = calls;                 // shared with the radar scope
    const now = Math.floor(Date.now() / 1000);
    const MIN = 60;
    const buckets = new Array(MIN).fill(0);
    const seenTg = new Set();
    let lastHour = 0;
    for (const c of calls) {
      const age = now - c.start_time;        // seconds ago
      if (age < 3600) { lastHour++; if (c.talkgroup != null) seenTg.add(c.talkgroup); }
      const minAgo = Math.floor(age / 60);
      if (minAgo >= 0 && minAgo < MIN) buckets[MIN - 1 - minAgo]++;
    }
    ccDrawTraffic(buckets);
    ccSetMetric("callshr", lastHour);
    ccSetMetric("active", seenTg.size);
  } catch (e) { /* keep last frame */ }
}

async function ccRefreshStats() {
  try {
    const s = await api("/api/stats");
    ccSetMetric("calls24", s.last_24h ? s.last_24h.kept_24h : 0);
    ccSetMetric("total", s.totals ? s.totals.kept_total : 0);
    const bl = s.backlog ? (s.backlog.transcribe_pending || 0) + (s.backlog.enrich_pending || 0) : 0;
    ccSetMetric("backlog", bl);
  } catch (e) { /* ignore */ }
}

async function ccRefreshAircraft() {
  try {
    const a = await api("/api/aircraft");
    ccSetMetric("aircraft", a && typeof a.count === "number" ? a.count : 0);
  } catch (e) { /* ignore */ }
}

// ============================================================
// 2b. Tactical radar scope — plots recent calls by bearing/distance from the
//     node center, with range rings and a rotating sweep. Toggled via the
//     "◎ Radar" view chip; the loop idles (no draw) while the pane is hidden.
// ============================================================
let ccRecentCalls = [];
let ccRadarCv = null, ccRadarCenter = null, ccRadarRange = [0.4, 0.9];

async function ccRefreshRadarConfig() {
  try {
    const m = await api("/api/map-config");
    if (m && m.center) ccRadarCenter = m.center;
    if (m && m.bounds) {
      ccRadarRange = [
        Math.max(0.05, (m.bounds[1][0] - m.bounds[0][0]) / 2),
        Math.max(0.05, (m.bounds[1][1] - m.bounds[0][1]) / 2),
      ];
    }
  } catch (e) { /* defaults are fine */ }
}

function ccSevColor(sev) {
  sev = (sev || "").toLowerCase();
  if (sev === "critical" || sev === "high") return "#ff4d5e";
  if (sev === "medium") return "#ffb000";
  return "#35e3ff";
}

function ccDrawRadar() {
  requestAnimationFrame(ccDrawRadar);
  const cv = ccRadarCv; if (!cv) return;
  const pane = document.getElementById("cc-radar-pane");
  if (!pane || pane.classList.contains("collapsed")) return;   // idle while hidden
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) {
    ccFitCanvas(cv);
  }
  const ctx = cv.getContext("2d");
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 14;
  const t = performance.now() / 1000;
  const sweep = (t * 0.7) % (Math.PI * 2);   // radians, clockwise

  ctx.clearRect(0, 0, w, h);

  // range rings + cross-hairs
  ctx.strokeStyle = "rgba(55,245,166,0.22)";
  ctx.lineWidth = 1;
  for (let k = 1; k <= 4; k++) {
    ctx.beginPath(); ctx.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  // cardinal labels
  ctx.fillStyle = "rgba(55,245,166,0.5)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - R + 8); ctx.fillText("S", cx, cy + R - 8);
  ctx.fillText("E", cx + R - 8, cy); ctx.fillText("W", cx - R + 8, cy);

  // sweep trail (fan of fading lines behind the leading edge)
  for (let i = 0; i < 28; i++) {
    const a = sweep - i * 0.045;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.strokeStyle = `rgba(55,245,166,${0.33 * (1 - i / 28)})`;
    ctx.lineWidth = i === 0 ? 2 : 1;
    ctx.stroke();
  }

  // blips
  const now = Math.floor(Date.now() / 1000);
  const [rangeLat, rangeLng] = ccRadarRange;
  const center = ccRadarCenter || [26.2, -98.0];
  const calls = ccRecentCalls.slice(0, 160);
  ctx.textAlign = "left";
  for (const c of calls) {
    if (c.lat == null || c.lng == null) continue;
    const jx = ((ccHash("x" + c.id) % 1000) / 1000 - 0.5) * 0.14;
    const jy = ((ccHash("y" + c.id) % 1000) / 1000 - 0.5) * 0.14;
    let nx = (c.lng - center[1]) / rangeLng + jx;
    let ny = -(c.lat - center[0]) / rangeLat + jy;
    let rr = Math.hypot(nx, ny);
    if (rr > 1) { nx /= rr; ny /= rr; rr = 1; }
    const px = cx + nx * R, py = cy + ny * R;
    const ageMin = (now - c.start_time) / 60;
    const freshness = Math.max(0, 1 - ageMin / 60);          // fade over an hour
    // brighten as the sweep passes this bearing
    let ba = Math.atan2(ny, nx); if (ba < 0) ba += Math.PI * 2;
    let d = Math.abs(((sweep - ba) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2));
    const ping = d < 0.5 ? (1 - d / 0.5) : 0;
    const alpha = Math.min(1, 0.25 + freshness * 0.55 + ping * 0.8);
    const col = ccSevColor(c.incident_severity);
    const rad = 2.5 + freshness * 2 + ping * 3;
    ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.globalAlpha = alpha;
    ctx.shadowBlur = 8 + ping * 10; ctx.shadowColor = col;
    ctx.fill();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  // center node
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#eafff6"; ctx.shadowBlur = 10; ctx.shadowColor = "#37f5a6"; ctx.fill();
  ctx.shadowBlur = 0;
}

// ============================================================
// 3. Intel ticker
// ============================================================
async function ccRefreshTicker() {
  const track = document.getElementById("cc-ticker-track");
  if (!track) return;
  try {
    const d = await api("/api/ticker");
    const items = [];
    for (const tg of (d.active_talkgroups || [])) {
      items.push(`<span class="cc-ticker-item"><b>${ccEsc(tg.label)}</b><span class="sub">${ccEsc(tg.sub || "")}</span></span>`);
    }
    for (const l of (d.latest || [])) {
      const label = l.label || l.title || l.talkgroup_tag || "";
      const sub = l.sub || l.incident_summary || "";
      if (label) items.push(`<span class="cc-ticker-item"><b>${ccEsc(label)}</b><span class="sub">${ccEsc(sub)}</span></span>`);
    }
    if (!items.length) items.push(`<span class="cc-ticker-item"><b>MONITORING</b><span class="sub">awaiting traffic…</span></span>`);
    const sep = `<span class="cc-ticker-sep">◆</span>`;
    const seq = items.join(sep);
    // duplicate for a seamless -50% scroll loop
    track.innerHTML = seq + sep + seq + sep;
  } catch (e) { /* keep last */ }
}

function ccEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// Scanner-state header mirror
// ============================================================
const CC_STATE_TEXT = {
  idle: "IDLE", loading: "ACQUIRING", playing: "◉ LIVE",
  waiting: "LISTENING", paused: "PAUSED", gated: "LOCKED",
};
function ccMirrorScannerState() {
  const bar = document.getElementById("scanner-bar");
  const out = document.getElementById("cc-scanner-state");
  if (!bar || !out) return;
  const st = bar.dataset.state || "idle";
  out.textContent = CC_STATE_TEXT[st] || st.toUpperCase();
  out.style.color = (st === "playing") ? "#37f5a6" : "";
}

// ============================================================
// Boot
// ============================================================
function ccInit() {
  ccSpec = document.getElementById("cc-spectrum");
  ccTrafficCv = document.getElementById("cc-traffic");
  ccRadarCv = document.getElementById("cc-radar");
  if (ccSpec) ccSpecCtx = ccFitCanvas(ccSpec);

  // Build audio graph + resume on the first user gesture (play click, etc.)
  document.addEventListener("click", () => { ccEnsureAudioGraph(); ccResumeAudio(); }, true);

  window.addEventListener("resize", () => {
    if (ccSpec) ccSpecCtx = ccFitCanvas(ccSpec);
  });

  ccBuildMetrics();

  // kick visuals
  requestAnimationFrame(ccDrawSpectrum);
  requestAnimationFrame(ccAnimateMetrics);
  requestAnimationFrame(ccDrawRadar);
  setInterval(ccMirrorScannerState, 300);

  // data pumps
  ccRefreshRadarConfig();
  ccRefreshStats();    setInterval(ccRefreshStats, 12000);
  ccRefreshTraffic();  setInterval(ccRefreshTraffic, 20000);
  ccRefreshAircraft(); setInterval(ccRefreshAircraft, 15000);
  ccRefreshTicker();   setInterval(ccRefreshTicker, 60000);
}

ccInit();
