// jafo — command-center HUD.
//
// Three live visual systems that make the main page read like a SIGINT console:
//   1. Audio spectrum + oscilloscope  — WebAudio FFT on the scanner's audio
//   2. Telemetry readouts + traffic graph — from /api/stats, /api/aircraft, /api/calls
//   3. Scrolling intel ticker — from /api/ticker
//
// Loaded after app.js + scanner.js, so it reuses their globals (api, scanner).

// Fraction of the FFT spectrum (from DC up) that carries voice/radio energy.
// We map just this band across the full spectrum/waterfall width so the display
// fills instead of bunching all the content into the leftmost ~quarter.
const CC_VOICE_BAND = 0.42;

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
    // Voice/radio energy lives in the low bins; map just that band (CC_VOICE_BAND
    // of the spectrum) across the full width so the bars actually fill the panel.
    const usable = Math.max(8, Math.floor(ccFreq.length * CC_VOICE_BAND));
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

  // feed the waterfall spectrogram (throttled so it scrolls at a readable rate)
  ccWfFrame++;
  if (ccWfFrame % 2 === 0) ccStepWaterfall(live, t);
}

// ---- Waterfall spectrogram (time scrolls down; color = intensity) ----
let ccWaterfall = null, ccWfCtx = null, ccWfFrame = 0;

function ccFitWaterfall() {
  const cv = ccWaterfall; if (!cv) return;
  // 1:1 backing store (no DPR) so self-scrolling drawImage stays pixel-exact
  cv.width = cv.clientWidth || 1;
  cv.height = cv.clientHeight || 1;
  ccWfCtx = cv.getContext("2d");
}

// Classic SIGINT colormap: black → blue → cyan → green → yellow → red → white
const CC_HEAT_STOPS = [
  [0.0, [2, 4, 12]], [0.14, [8, 22, 86]], [0.34, [18, 120, 165]],
  [0.54, [40, 205, 120]], [0.74, [232, 222, 60]], [0.9, [255, 92, 42]], [1.0, [255, 225, 205]],
];
function ccHeat(v) {
  v = v < 0 ? 0 : (v > 1 ? 1 : v);
  for (let i = 1; i < CC_HEAT_STOPS.length; i++) {
    if (v <= CC_HEAT_STOPS[i][0]) {
      const [a0, c0] = CC_HEAT_STOPS[i - 1], [a1, c1] = CC_HEAT_STOPS[i];
      const f = (v - a0) / ((a1 - a0) || 1);
      return `rgb(${(c0[0] + (c1[0] - c0[0]) * f) | 0},${(c0[1] + (c1[1] - c0[1]) * f) | 0},${(c0[2] + (c1[2] - c0[2]) * f) | 0})`;
    }
  }
  return "rgb(255,225,205)";
}

function ccStepWaterfall(live, t) {
  const cv = ccWaterfall; if (!cv) return;
  if (cv.width !== cv.clientWidth || cv.height !== cv.clientHeight) ccFitWaterfall();
  const ctx = ccWfCtx; if (!ctx) return;
  const w = cv.width, h = cv.height; if (!w || !h) return;
  // scroll everything down by one row
  ctx.drawImage(cv, 0, 0, w, h - 1, 0, 1, w, h - 1);
  // paint the newest row at the top
  for (let x = 0; x < w; x++) {
    let v;
    if (live) {
      const idx = Math.floor((x / w) * ccFreq.length * CC_VOICE_BAND);
      v = ccFreq[idx] / 255;
    } else {
      v = 0.12 + 0.11 * Math.sin(x * 0.06 + t * 2.0) + 0.06 * Math.sin(x * 0.013 - t * 1.3);
    }
    ctx.fillStyle = ccHeat(v);
    ctx.fillRect(x, 0, 1, 1);
  }
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
    // count=0 skips the expensive COUNT(*); 250 rows is plenty for 60m of graph.
    const data = await api("/api/calls?limit=250&only_kept=1&count=0");
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
    ccRefreshUnits();
    ccRefreshPosture();
  } catch (e) { /* keep last frame */ }
}

// ---- Threat posture: severity-weighted incident activity in the last hour ----
function ccRefreshPosture() {
  const el = document.getElementById("cc-posture");
  if (!el) return;
  const now = Math.floor(Date.now() / 1000);
  let score = 0;
  for (const c of ccRecentCalls) {
    if (now - c.start_time > 3600) continue;
    const s = (c.incident_severity || "").toLowerCase();
    if (s === "critical") score += 2;
    else if (s === "high") score += 1;
  }
  let level = "ROUTINE", cls = "";
  if (score >= 14) { level = "CRITICAL"; cls = "critical"; }
  else if (score >= 7) { level = "HIGH"; cls = "high"; }
  else if (score >= 3) { level = "ELEVATED"; cls = "elevated"; }
  el.textContent = level;
  const chip = el.closest(".cc-posture-chip");
  if (chip) chip.className = "cc-posture-chip " + cls;
  const cb = document.getElementById("cc-cb-right");
  if (cb) cb.textContent = level === "ROUTINE" ? "● MONITORING" : `● ${level} ACTIVITY`;
}

// ---- ZULU + local clocks ----
function ccTickClocks() {
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const z = document.getElementById("cc-zulu"), l = document.getElementById("cc-local");
  if (z) z.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (l) l.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- Cold-boot sequence (client-only theater; skippable) ----
function ccBootSequence() {
  const boot = document.getElementById("cc-boot");
  const out = document.getElementById("cc-boot-text");
  if (!boot || !out) return;
  const lines = [
    { t: "jafo SIGINT ARRAY — cold boot", cls: "hdr" },
    { t: "" },
    { t: "> initializing capture subsystem ........... [OK]" },
    { t: "> SDR lock: Airspy R2 · RTL-SDR ............ [OK]" },
    { t: "> P25 Phase II trunk decoder .............. [OK]" },
    { t: "> Silero VAD · Opus encoder ............... [OK]" },
    { t: "> transcription pipeline (Whisper) ........ [OK]" },
    { t: "> incident enrichment (Claude) ............ [OK]" },
    { t: "> ADS-B receiver · cell observer .......... [OK]" },
    { t: "> link to jafo.live clearing house ........ [OK]" },
    { t: "" },
    { t: "SYSTEMS NOMINAL — DEMONSTRATION MODE", cls: "hdr" },
  ];
  let i = 0, done = false;
  const render = () => {
    out.innerHTML = lines.slice(0, i).map((ln) => {
      const s = ccEsc(ln.t).replace("[OK]", '<span class="ok">[OK]</span>');
      return ln.cls ? `<span class="${ln.cls}">${s}</span>` : s;
    }).join("\n");
  };
  const dismiss = () => {
    if (done) return; done = true;
    boot.classList.add("done");
    setTimeout(() => boot.remove(), 700);
  };
  const timer = setInterval(() => {
    i++; render();
    if (i >= lines.length) { clearInterval(timer); setTimeout(dismiss, 650); }
  }, 150);
  boot.addEventListener("click", () => { clearInterval(timer); dismiss(); });
}

// ---- Active units board: unit IDs seen in the field over the last hour,
//      deduped to their most recent incident (ccRecentCalls is newest-first).
function ccRefreshUnits() {
  const list = document.getElementById("cc-units-list");
  const countEl = document.getElementById("cc-units-count");
  if (!list) return;
  const now = Math.floor(Date.now() / 1000);
  const seen = new Map();
  for (const c of ccRecentCalls) {
    if (now - c.start_time > 60 * 60) continue;        // last hour = "active"
    for (const u of (c.incident_units || [])) {
      const id = (u || "").trim();
      if (!id || seen.has(id)) continue;
      seen.set(id, { type: c.incident_type, city: c.city, sev: c.incident_severity, tag: c.talkgroup_tag });
    }
  }
  const rows = [...seen.entries()];
  if (countEl) countEl.textContent = rows.length ? `${rows.length} in field` : "0";
  if (!rows.length) { list.innerHTML = '<li class="cc-units-empty">no units active</li>'; return; }
  list.innerHTML = "";
  for (const [id, info] of rows.slice(0, 16)) {
    const sev = (info.sev || "").toLowerCase();
    const cls = (sev === "critical" || sev === "high") ? "sev-hi" : (sev === "medium" ? "sev-med" : "");
    const type = (info.type && info.type !== "radio_chatter") ? info.type : (info.tag || "");
    const li = document.createElement("li");
    li.innerHTML = `<span class="cc-unit-id ${cls}">${ccEsc(id)}</span>` +
                   `<span class="cc-unit-type">${ccEsc(type)}</span>` +
                   `<span class="cc-unit-city">${ccEsc(info.city || "")}</span>`;
    list.appendChild(li);
  }
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

// ---- ACARS decode (hover popup turns raw lines into readable data) ----
const ACARS_LABELS = {
  "H1": "Management terminal — position, performance, OOOI or free text",
  "SQ": "Ground-station squitter (station ID, location, VHF frequency)",
  "RA": "Air→ground request / response",
  "RB": "Ground→air response",
  "5Z": "Airline-defined downlink", "20": "Airline-defined downlink",
  "80": "Aircraft downlink (misc)", "83": "Aircraft downlink (misc)",
  "4E": "Airline-defined (often weather / ATIS request)",
  "QQ": "Link management", "Q0": "Link test / no-op",
  "_d": "No message / demand mode", "00": "Emergency",
  "10": "Airline-defined", "11": "Airline-defined", "12": "Airline-defined",
  "13": "Airline-defined", "15": "Network / misc", "16": "Airline-defined",
  "SA": "Media advisory (link establishment)", "C1": "Uplink to cockpit printer",
  "H2": "Management terminal", "B1": "CPDLC / ATC", "B2": "CPDLC / ATC",
  "A6": "ADS-C (automatic position)", "A9": "ATS", "A0": "ATS",
};
const ACARS_AIRLINES = {
  UA: "United", AA: "American", DL: "Delta", WN: "Southwest", B6: "JetBlue",
  NK: "Spirit", F9: "Frontier", AS: "Alaska", HA: "Hawaiian", G4: "Allegiant",
  FX: "FedEx", "5X": "UPS", OO: "SkyWest", MQ: "Envoy", OH: "PSA", YX: "Republic",
  "9E": "Endeavor", AM: "Aeroméxico", Y4: "Volaris", VB: "VivaAerobús",
};
function ccRegCountry(tail) {
  const t = (tail || "").toUpperCase();
  if (/^N/.test(t)) return "🇺🇸 USA";
  if (/^C[-F]/.test(t) || /^C/.test(t)) return "🇨🇦 Canada";
  if (/^XA|^XB|^XC/.test(t)) return "🇲🇽 Mexico";
  if (/^G-/.test(t)) return "🇬🇧 UK";
  if (/^D-/.test(t)) return "🇩🇪 Germany";
  return null;
}
function ccParsePos(text) {
  const m = (text || "").match(/(\d{2})(\d{2}(?:\.\d+)?)([NS])\D{0,4}(\d{3})(\d{2}(?:\.\d+)?)([EW])/);
  if (!m) return null;
  const lat = (+m[1] + (+m[2]) / 60) * (m[3] === "S" ? -1 : 1);
  const lon = (+m[4] + (+m[5]) / 60) * (m[6] === "W" ? -1 : 1);
  return { lat: lat.toFixed(3), lon: lon.toFixed(3) };
}
const CC_LOCAL_ICAO = { KMFE: "McAllen", KBRO: "Brownsville", KHRL: "Harlingen", KEBG: "Edinburg", KPIL: "Port Isabel" };
function ccDecodeSquitter(text) {
  const icao = ((text || "").match(/([A-Z]{4})\d{3}/) || [])[1];
  const pos = ccParsePos(text);
  const fm = (text || "").match(/V(\d{3})(\d{3})/);
  const net = ((text || "").match(/\/([A-Z]+)\s*$/) || [])[1];
  if (!icao && !pos) return null;
  let s = `${net || "VHF"} ground station`;
  if (icao) s += ` <b>${ccEsc(icao)}</b>` + (CC_LOCAL_ICAO[icao] ? ` (${CC_LOCAL_ICAO[icao]})` : "");
  if (pos) s += ` at ${pos.lat}, ${pos.lon}`;
  if (fm) s += ` · ${fm[1]}.${fm[2]} MHz`;
  return s;
}
function ccAcarsDecode(m) {
  const row = (k, v) => `<div class="ap-row"><span class="ap-k">${k}</span><span class="ap-v">${v}</span></div>`;
  const flight = m.flight || "", tail = m.tail || "", label = m.label || "", text = m.text || "";
  const airline = ACARS_AIRLINES[(flight.slice(0, 2) || "").toUpperCase()];
  const country = ccRegCountry(tail);
  let html = "";
  html += row("Aircraft", ccEsc(tail || "—") + (country ? ` · ${country}` : ""));
  if (flight) html += row("Flight", ccEsc(flight) + (airline ? ` · ${ccEsc(airline)}` : ""));
  html += row("Label", `${ccEsc(label)} — ${ccEsc(ACARS_LABELS[label] || "airline / application-defined")}`);
  html += row("Channel", `${m.freq_mhz || "?"} MHz` + (m.mode ? ` · mode ${ccEsc(m.mode)}` : ""));
  if (m.block_id || m.msg_no) html += row("Block / Msg", ccEsc([m.block_id, m.msg_no].filter(Boolean).join(" ")));
  html += row("Received", ccEsc(fmtTime(m.received_at)));
  const notes = [];
  if (label === "SQ") { const sq = ccDecodeSquitter(text); if (sq) notes.push(sq); }
  const pos = ccParsePos(text);
  if (pos && label !== "SQ") notes.push(`Position: <b>${pos.lat}, ${pos.lon}</b>`);
  if (notes.length) html += `<div class="ap-decoded">◉ ${notes.join("<br>◉ ")}</div>`;
  html += `<div class="ap-text"><span class="ap-k">Message</span><pre>${ccEsc(text || "(empty)")}</pre></div>`;
  return html;
}

let ccAcarsMsgs = [];
let ccAcarsGlobeCv = null, ccAcarsRoute = null, ccAcarsGlobeSpin = 0;

function ccBindAcarsClick() {
  const list = document.getElementById("cc-acars-list");
  if (!list || list._acbound) return;
  list._acbound = true;
  list.addEventListener("click", (e) => {
    const r = e.target.closest(".cc-acars-row"); if (!r) return;
    list.querySelectorAll(".cc-acars-row.sel").forEach((x) => x.classList.remove("sel"));
    r.classList.add("sel");
    ccSelectAcars(+r.dataset.idx);
  });
}

function ccSelectAcars(idx) {
  const m = ccAcarsMsgs[idx]; if (!m) return;
  const d = document.getElementById("cc-acars-detail"); if (!d) return;
  ccAcarsRoute = null;
  d.innerHTML =
    `<div class="acd-decode">${ccAcarsDecode(m)}</div>` +
    `<div class="acd-ac" id="acd-ac"><div class="acd-loading">◈ looking up aircraft…</div></div>` +
    `<div class="acd-globe-wrap" id="acd-globe-wrap" style="display:none">` +
    `<div class="acd-route" id="acd-route">—</div><canvas id="cc-acars-globe" class="acd-globe"></canvas></div>`;
  ccAcarsGlobeCv = document.getElementById("cc-acars-globe");
  const reg = m.tail || "", flight = m.flight || "";
  if (!reg && !flight) { document.getElementById("acd-ac").innerHTML = '<div class="acd-none">no tail / flight on this message</div>'; return; }
  const p = new URLSearchParams();
  if (reg) p.set("reg", reg);
  if (flight) p.set("flight", flight);
  // Candidate ICAO airport codes embedded in the message text (4-letter tokens).
  const cand = [...new Set((m.text || "").toUpperCase().match(/\b[A-Z]{4}\b/g) || [])].slice(0, 8);
  if (cand.length) p.set("airports", cand.join(","));
  api(`/api/aircraft-lookup?${p}`).then(ccRenderAircraft).catch(() => {
    const el = document.getElementById("acd-ac"); if (el) el.innerHTML = '<div class="acd-none">lookup failed</div>';
  });
}

// A drawn top-down plane silhouette, always available as a fallback/illustration
// even when no spotter photo exists. Category is inferred from the type string.
function ccPlaneDrawing(info) {
  const t = ((info.type || "") + " " + (info.manufacturer || "") + " " + (info.icao_type || "")).toUpperCase();
  let cat = "AIRCRAFT";
  if (/A380|A3[3-5]0|A300|A310|MD-?11|DC-?10|IL-?96|787|777|767|747/.test(t)) cat = "WIDEBODY";
  else if (/73[0-9]|A31[89]|A32[01]|A220|757|717|727|MD-?[89]0|BAE|RJ85|RJ1/.test(t)) cat = "NARROWBODY";
  else if (/DASH|DHC|ATR|Q4|BEECH|CESSNA|CARAVAN|PC-?12|SF34|SAAB|KING|PILATUS|TBM|TURBOPROP|C\d{2,3}|PA-?\d|CRJ|E1?[79][0-5]|EMB|ERJ/.test(t)) cat = "REGIONAL";
  return `<div class="acd-draw"><svg viewBox="0 0 24 24" class="acd-plane" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg><span class="acd-cat">${ccEsc(cat)}</span></div>`;
}

function ccRenderAircraft(info) {
  const el = document.getElementById("acd-ac"); if (!el) return;
  const logo = info.logo ? `<img class="acd-logo" src="${ccEsc(info.logo)}" alt="" onerror="this.style.display='none'">` : "";
  const op = info.airline_name || info.operator;
  const typ = [info.manufacturer, info.type].filter(Boolean).join(" ");
  const idbits = `<div class="acd-ac-reg">${ccEsc(info.reg || "—")}</div>` +
    (op ? `<div class="acd-ac-op">${ccEsc(op)}</div>` : "") +
    (typ ? `<div class="acd-ac-type">✈ ${ccEsc(typ)}</div>` : "");
  const bits = [`<div class="acd-ac-hdr">${logo}<div class="acd-ac-id">${idbits}</div></div>`];
  // media row: drawn silhouette always, spotter photo alongside when present
  const photo = info.photo
    ? `<a class="acd-photo-wrap" href="${ccEsc(info.photo_link || "#")}" target="_blank" rel="noopener"><img class="acd-photo" src="${ccEsc(info.photo)}" alt="aircraft photo"></a>`
    : "";
  bits.push(`<div class="acd-media${photo ? " has-photo" : ""}">${ccPlaneDrawing(info)}${photo}</div>`);
  el.innerHTML = bits.join("");
  if (info.origin && info.destination && info.origin.lat != null && info.destination.lat != null) {
    ccAcarsRoute = {
      origin: { ...info.origin, lat: +info.origin.lat, lon: +info.origin.lon },
      destination: { ...info.destination, lat: +info.destination.lat, lon: +info.destination.lon },
    };
    const w = document.getElementById("acd-globe-wrap"); if (w) w.style.display = "";
    const rt = document.getElementById("acd-route");
    if (rt) rt.innerHTML = `<b>${ccEsc(info.origin.iata || info.origin.icao || "?")}</b> → <b>${ccEsc(info.destination.iata || info.destination.icao || "?")}</b>` +
      (info.route_source ? ` <span class="acd-rtsrc">(${ccEsc(info.route_source)})</span>` : "");
  }
}

// Great-circle (slerp) interpolation -> [lat,lon] points.
function ccGreatCircle(o, d, n) {
  const R = Math.PI / 180;
  const vec = (la, lo) => [Math.cos(la * R) * Math.cos(lo * R), Math.cos(la * R) * Math.sin(lo * R), Math.sin(la * R)];
  const v1 = vec(o.lat, o.lon), v2 = vec(d.lat, d.lon);
  let dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  dot = Math.max(-1, Math.min(1, dot));
  const om = Math.acos(dot);
  if (om < 1e-6) return [[o.lat, o.lon]];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = Math.sin((1 - t) * om) / Math.sin(om), b = Math.sin(t * om) / Math.sin(om);
    const x = a * v1[0] + b * v2[0], y = a * v1[1] + b * v2[1], z = a * v1[2] + b * v2[2];
    pts.push([Math.asin(z) / R, Math.atan2(y, x) / R]);
  }
  return pts;
}

function ccDrawAcarsGlobe() {
  requestAnimationFrame(ccDrawAcarsGlobe);
  const cv = ccAcarsGlobeCv; if (!cv || !ccAcarsRoute) return;
  const pane = document.getElementById("cc-acars-pane");
  if (!pane || pane.classList.contains("collapsed")) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) ccFitCanvas(cv);
  const ctx = cv.getContext("2d"), w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  const cx = w / 2, cy = h / 2, D2R = Math.PI / 180, minside = Math.min(w, h);
  const o = ccAcarsRoute.origin, d = ccAcarsRoute.destination;
  const arc = ccGreatCircle(o, d, 120);
  const mid = arc[Math.floor(arc.length / 2)];   // route midpoint [lat,lon]
  // central angle between endpoints -> zoom factor
  const vec = (la, lo) => [Math.cos(la * D2R) * Math.cos(lo * D2R), Math.cos(la * D2R) * Math.sin(lo * D2R), Math.sin(la * D2R)];
  const v1 = vec(o.lat, o.lon), v2 = vec(d.lat, d.lon);
  let dotp = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]; dotp = Math.max(-1, Math.min(1, dotp));
  const half = Math.max(Math.acos(dotp) / 2, 0.04);
  let R = (0.40 * minside) / Math.sin(half);      // zoom so the two points frame nicely
  R = Math.max(R, minside / 2 - 8);               // never smaller than a full globe
  R = Math.min(R, minside * 5);                   // cap zoom for very close airports
  // projection centered on the route midpoint, with a gentle wobble for 3D feel
  const latM = mid[0], lonM = mid[1];
  const wob = Math.sin(performance.now() / 1800) * 0.07;
  const tc = Math.cos(-latM * D2R), ts = Math.sin(-latM * D2R);
  const proj = (lat, lon) => {
    const la = lat * D2R, lo = (lon - lonM) * D2R + wob;
    const x = Math.cos(la) * Math.sin(lo), y = Math.sin(la), z = Math.cos(la) * Math.cos(lo);
    return { x: cx + x * R, y: cy - (y * tc - z * ts) * R, vis: (y * ts + z * tc) > 0 };
  };
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(53,227,255,0.13)";
  const grat = (pts) => { ctx.beginPath(); let st = false; for (const [a, b] of pts) { const p = proj(a, b); if (p.vis) { st ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); st = true; } else { if (st) ctx.stroke(); ctx.beginPath(); st = false; } } ctx.stroke(); };
  for (let lat = -80; lat <= 80; lat += 10) grat(Array.from({ length: 73 }, (_, k) => [lat, -180 + k * 5]));
  for (let lon = -180; lon < 180; lon += 10) grat(Array.from({ length: 37 }, (_, k) => [-90 + k * 5, lon]));
  // great-circle route
  ctx.strokeStyle = "#37f5a6"; ctx.lineWidth = 2.5; ctx.shadowBlur = 10; ctx.shadowColor = "#37f5a6";
  ctx.beginPath(); let st = false;
  for (const [lat, lon] of arc) { const p = proj(lat, lon); if (p.vis) { st ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); st = true; } else { if (st) ctx.stroke(); ctx.beginPath(); st = false; } }
  ctx.stroke(); ctx.shadowBlur = 0;
  const pt = (ap, col) => { const p = proj(ap.lat, ap.lon); if (!p.vis) return; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 6.283); ctx.fillStyle = col; ctx.shadowBlur = 12; ctx.shadowColor = col; ctx.fill(); ctx.shadowBlur = 0; ctx.fillStyle = "#eafaff"; ctx.font = "12px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.fillText(ap.iata || ap.icao || "", p.x, p.y - 11); };
  pt(o, "#37f5a6"); pt(d, "#ff4d5e");
}

// ---- ACARS message feed (only polls while the panel is open) ----
async function ccRefreshAcars() {
  const pane = document.getElementById("cc-acars-pane");
  if (!pane || pane.classList.contains("collapsed")) return;
  const list = document.getElementById("cc-acars-list");
  const status = document.getElementById("cc-acars-status");
  let d;
  try { d = await api("/api/acars"); } catch (e) { return; }
  if (status) status.textContent = d.active ? "◉ RECEIVING" : (d.count ? `${d.count} msgs` : "mode off");
  const msgs = d.messages || [];
  if (!msgs.length || !list) return;   // keep the "flip to ACARS mode" hint
  ccAcarsMsgs = msgs;
  // Group by flight (fall back to tail) — newest group first.
  const order = [], groups = new Map();
  msgs.forEach((m, i) => {
    const key = m.flight || m.tail || "—";
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(i);
  });
  list.innerHTML = order.map((key) => {
    const idxs = groups.get(key), first = ccAcarsMsgs[idxs[0]];
    const airline = ACARS_AIRLINES[(first.flight || "").slice(0, 2).toUpperCase()];
    const sub = (first.tail && first.flight) ? first.tail : "";
    const rows = idxs.map((i) => {
      const m = ccAcarsMsgs[i], txt = (m.text || "").replace(/\s+/g, " ").trim();
      return `<div class="cc-acars-row" data-idx="${i}" title="click to decode + look up">` +
             `<span class="cc-acars-time">${ccEsc(fmtTime(m.received_at))}</span>` +
             `<span class="cc-acars-lbl">${ccEsc(m.label || "")}</span>` +
             `<span class="cc-acars-txt">${ccEsc(txt.slice(0, 80))}</span></div>`;
    }).join("");
    return `<div class="acg"><div class="acg-hdr">✈ <b>${ccEsc(key)}</b>` +
           `${airline ? ` · ${ccEsc(airline)}` : ""}${sub ? ` · ${ccEsc(sub)}` : ""}` +
           `<span class="acg-n">${idxs.length}</span></div>${rows}</div>`;
  }).join("");
  ccBindAcarsClick();
}

// ============================================================
// 4. AI Analyst situation assessment (typewriter SITREP strip)
// ============================================================
let ccAnalystText = "";
let ccAnalystTyper = null;

async function ccRefreshAnalyst() {
  const textEl = document.getElementById("cc-sitrep-text");
  const metaEl = document.getElementById("cc-sitrep-meta");
  if (!textEl) return;
  try {
    const d = await api("/api/analyst");
    // Strip any stray markdown / header and collapse to a single line for the strip.
    const txt = (d.assessment || "")
      .replace(/\*\*/g, "").replace(/`/g, "")
      .replace(/^\s*situation assessment[:\s-]*/i, "")
      .replace(/\s+/g, " ").trim();
    if (metaEl) {
      const win = d.window_min >= 120 ? `${Math.round(d.window_min / 60)}h` : `${d.window_min || 30}m`;
      metaEl.textContent = d.incident_count != null
        ? `${d.incident_count} incidents · ${win}${d.cached ? " · cached" : ""}` : "";
    }
    if (txt && txt !== ccAnalystText) {
      ccAnalystText = txt;
      ccTypewrite(textEl, txt);
    } else if (!txt && !ccAnalystText) {
      textEl.textContent = "assessment unavailable (no AI key on this node)";
    }
  } catch (e) { /* keep last */ }
}

function ccTypewrite(el, text) {
  if (ccAnalystTyper) clearInterval(ccAnalystTyper);
  let i = 0;
  ccAnalystTyper = setInterval(() => {
    i++;
    el.innerHTML = ccEsc(text.slice(0, i)) + (i < text.length ? '<span class="cursor">▋</span>' : "");
    if (i >= text.length) clearInterval(ccAnalystTyper);
  }, 14);
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
// 5. Link-analysis graph — units <-> talkgroups, force-directed
// ============================================================
let ccLinkCv = null, ccLinkNodes = new Map(), ccLinkEdges = [], ccLinkBuilt = 0;

function ccBuildLink() {
  const now = Math.floor(Date.now() / 1000);
  const tgCount = new Map(), pairs = [];
  for (const c of ccRecentCalls) {
    if (now - c.start_time > 3600) continue;
    const tg = c.talkgroup_tag; if (!tg) continue;
    tgCount.set(tg, (tgCount.get(tg) || 0) + 1);
    for (const u of (c.incident_units || [])) {
      const unit = (u || "").trim();
      if (unit) pairs.push([unit, tg, c.incident_severity]);
    }
  }
  const topTg = [...tgCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22).map((e) => e[0]);
  const topSet = new Set(topTg);
  const W = ccLinkCv ? ccLinkCv.clientWidth || 600 : 600;
  const H = ccLinkCv ? ccLinkCv.clientHeight || 400 : 400;
  const next = new Map();
  const ensure = (id, type, label, w, sev) => {
    const ex = ccLinkNodes.get(id);
    if (ex) { ex.w = w; ex.label = label; if (sev) ex.sev = sev; next.set(id, ex); return ex; }
    const n = { id, type, label, w, sev, x: W / 2 + (Math.random() - 0.5) * W * 0.6,
                y: H / 2 + (Math.random() - 0.5) * H * 0.6, vx: 0, vy: 0 };
    next.set(id, n); return n;
  };
  for (const tg of topTg) ensure("tg:" + tg, "tg", tg, tgCount.get(tg));
  const edgeKeys = new Set(), edges = [];
  for (const [unit, tg, sev] of pairs) {
    if (!topSet.has(tg)) continue;
    const uid = "u:" + unit;
    ensure(uid, "unit", unit, 1, sev);
    const ek = uid + "|tg:" + tg;
    if (!edgeKeys.has(ek)) { edgeKeys.add(ek); edges.push({ a: uid, b: "tg:" + tg }); }
    if (next.size > 90) break;
  }
  ccLinkNodes = next;
  ccLinkEdges = edges.filter((e) => next.has(e.a) && next.has(e.b));
}

function ccDrawLink() {
  requestAnimationFrame(ccDrawLink);
  const cv = ccLinkCv; if (!cv) return;
  const pane = document.getElementById("cc-link-pane");
  if (!pane || pane.classList.contains("collapsed")) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(cv.clientWidth * dpr) || cv.height !== Math.round(cv.clientHeight * dpr)) ccFitCanvas(cv);
  const ctx = cv.getContext("2d");
  const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
  if (performance.now() - ccLinkBuilt > 8000) { ccBuildLink(); ccLinkBuilt = performance.now(); }

  const nodes = [...ccLinkNodes.values()];
  const cx = w / 2, cy = h / 2;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    a.vx += (cx - a.x) * 0.0009; a.vy += (cy - a.y) * 0.0009;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
      const rep = 1400 / d2, fx = (dx / d) * rep, fy = (dy / d) * rep;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
  }
  for (const e of ccLinkEdges) {
    const a = ccLinkNodes.get(e.a), b = ccLinkNodes.get(e.b); if (!a || !b) continue;
    let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const f = (d - 72) * 0.0022, fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const n of nodes) {
    n.vx *= 0.86; n.vy *= 0.86; n.x += n.vx; n.y += n.vy;
    n.x = Math.max(16, Math.min(w - 16, n.x)); n.y = Math.max(24, Math.min(h - 14, n.y));
  }

  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(53,227,255,0.16)";
  for (const e of ccLinkEdges) {
    const a = ccLinkNodes.get(e.a), b = ccLinkNodes.get(e.b); if (!a || !b) continue;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.textAlign = "center";
  for (const n of nodes) {
    const isTg = n.type === "tg";
    const r = isTg ? Math.min(17, 6 + Math.sqrt(n.w) * 2) : 4;
    const col = isTg ? "#35e3ff" : ccSevColor(n.sev);
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.283);
    ctx.fillStyle = col; ctx.shadowBlur = 8; ctx.shadowColor = col; ctx.fill(); ctx.shadowBlur = 0;
    if (isTg) {
      ctx.fillStyle = "#cfeefb"; ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(String(n.label).slice(0, 16), n.x, n.y - r - 4);
    }
  }
}

// ============================================================
// 6. Boot wireframe globe (canvas, during the cold-boot overlay)
// ============================================================
function ccBootGlobe() {
  const cv = document.getElementById("cc-boot-globe");
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = 190 * dpr; cv.height = 190 * dpr;
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
  const R = 82, cx = 95, cy = 95;
  let ang = 0;
  const frame = () => {
    if (!document.getElementById("cc-boot")) return;   // boot dismissed → stop
    ang += 0.02;
    ctx.clearRect(0, 0, 190, 190);
    ctx.lineWidth = 1; ctx.shadowBlur = 8; ctx.shadowColor = "#35e3ff";
    ctx.strokeStyle = "rgba(53,227,255,0.55)";
    // outline
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.stroke();
    // latitude rings
    for (let lat = -60; lat <= 60; lat += 30) {
      const lr = lat * Math.PI / 180;
      ctx.beginPath();
      ctx.ellipse(cx, cy - R * Math.sin(lr), R * Math.cos(lr), R * Math.cos(lr) * 0.32, 0, 0, 6.283);
      ctx.stroke();
    }
    // rotating meridians
    ctx.strokeStyle = "rgba(53,227,255,0.35)";
    for (let k = 0; k < 6; k++) {
      const phase = ang + k * Math.PI / 6;
      const sx = Math.abs(R * Math.sin(phase));
      ctx.beginPath(); ctx.ellipse(cx, cy, sx, R, 0, 0, 6.283); ctx.stroke();
    }
    // a bright "lock" blip (RGV)
    const bl = ang * 1.5;
    ctx.fillStyle = "#37f5a6"; ctx.shadowColor = "#37f5a6";
    ctx.beginPath(); ctx.arc(cx + R * 0.5 * Math.cos(bl), cy + R * 0.3 * Math.sin(bl), 2.5, 0, 6.283); ctx.fill();
    ctx.shadowBlur = 0;
    requestAnimationFrame(frame);
  };
  frame();
}

// ============================================================
// 7. THE WALL — fullscreen rotating ops display
// ============================================================
const CC_WALL_VIEWS = ["radar", "map", "link", "stories"];
let ccWallTimer = null, ccWallIdx = 0, ccWallPrev = null;

function ccWallShow() {
  const view = CC_WALL_VIEWS[ccWallIdx % CC_WALL_VIEWS.length];
  ccWallIdx++;
  if (typeof setViewPanel === "function" && typeof VIEW_PANELS !== "undefined") {
    for (const v of Object.keys(VIEW_PANELS)) setViewPanel(v, v === view, null);
  }
  const stage = document.getElementById("cc-wall-stage");
  if (stage) stage.innerHTML = `THE WALL · now showing <b>${view.toUpperCase()}</b> · auto-rotating · press ESC to exit`;
}

function ccWallEnter() {
  // remember current panel states to restore on exit
  ccWallPrev = {};
  if (typeof VIEW_PANELS !== "undefined") {
    for (const [v, sel] of Object.entries(VIEW_PANELS)) {
      const el = document.querySelector(sel);
      ccWallPrev[v] = el ? !el.classList.contains("collapsed") : false;
    }
  }
  document.body.classList.add("wall-mode");
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  ccWallIdx = 0; ccWallShow();
  ccWallTimer = setInterval(ccWallShow, 12000);
}

function ccWallExit() {
  if (!document.body.classList.contains("wall-mode")) return;
  document.body.classList.remove("wall-mode");
  clearInterval(ccWallTimer); ccWallTimer = null;
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  if (ccWallPrev && typeof setViewPanel === "function") {
    for (const [v, open] of Object.entries(ccWallPrev)) setViewPanel(v, open, null);
  }
}

function ccWallToggle() {
  document.body.classList.contains("wall-mode") ? ccWallExit() : ccWallEnter();
}

function ccBindWall() {
  const btn = document.getElementById("cc-wall-btn");
  if (btn) btn.addEventListener("click", ccWallToggle);
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (/^(input|textarea|select)$/i.test(tag)) return;
    if (e.key === "w" || e.key === "W") ccWallToggle();
    else if (e.key === "Escape" && document.body.classList.contains("wall-mode")) ccWallExit();
  });
  // If the user leaves fullscreen by any means, drop out of wall mode too.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) ccWallExit();
  });
}

// ============================================================
// Boot
// ============================================================
function ccInit() {
  ccSpec = document.getElementById("cc-spectrum");
  ccTrafficCv = document.getElementById("cc-traffic");
  ccRadarCv = document.getElementById("cc-radar");
  ccWaterfall = document.getElementById("cc-waterfall");
  ccLinkCv = document.getElementById("cc-link");
  if (ccSpec) ccSpecCtx = ccFitCanvas(ccSpec);
  if (ccWaterfall) ccFitWaterfall();

  // Build audio graph + resume on the first user gesture (play click, etc.)
  document.addEventListener("click", () => { ccEnsureAudioGraph(); ccResumeAudio(); }, true);

  window.addEventListener("resize", () => {
    if (ccSpec) ccSpecCtx = ccFitCanvas(ccSpec);
    if (ccWaterfall) ccFitWaterfall();
  });

  ccBuildMetrics();
  ccBindAcarsClick();
  ccBootSequence();
  ccBootGlobe();
  ccTickClocks();
  setInterval(ccTickClocks, 1000);
  ccBindWall();

  // kick visuals
  requestAnimationFrame(ccDrawSpectrum);
  requestAnimationFrame(ccAnimateMetrics);
  requestAnimationFrame(ccDrawRadar);
  requestAnimationFrame(ccDrawLink);
  requestAnimationFrame(ccDrawAcarsGlobe);
  setInterval(ccMirrorScannerState, 300);

  // data pumps — intervals kept gentle so the dashboard doesn't hammer the
  // single-SQLite pipeline (the Pi shares one DB across capture+enrich+web).
  ccRefreshRadarConfig();
  ccRefreshStats();    setInterval(ccRefreshStats, 30000);
  ccRefreshTraffic();  setInterval(ccRefreshTraffic, 60000);
  ccRefreshAircraft(); setInterval(ccRefreshAircraft, 30000);
  ccRefreshTicker();   setInterval(ccRefreshTicker, 90000);
  ccRefreshAnalyst();  setInterval(ccRefreshAnalyst, 90000);
  setInterval(ccRefreshAcars, 10000);
}

ccInit();
