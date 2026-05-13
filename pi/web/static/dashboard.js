// jafo /dashboard — newspaper / briefing view.
// All data comes from existing /api/* endpoints; this file owns rendering
// and the small bit of client-side time/date math for the masthead.

const POLL_STORIES_MS = 60_000;
const POLL_CALLS_MS   = 12_000;
const POLL_AIR_MS     = 10_000;
const POLL_STATS_MS   = 30_000;
const POLL_ANOMALY_MS = 20_000;
const POLL_CLOCK_MS   = 1_000;

const ANOMALY_KEYWORDS = [
  "pursuit", "officer down", "officer needs", "active shooter",
  "shots fired", "shooting", "stabbing", "fatality", "10-33",
  "structure fire", "vehicle fire", "mva with", "rollover",
  "drowning", "missing person", "abduction", "amber alert",
];

const PINNED_SEV = new Set(["critical", "high"]);
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

// Friendly names for ICAO type codes — mirror of the map in app.js so
// the dashboard can render "B738 → Boeing 737-800" without an extra fetch.
const ICAO_TYPE_NAMES = {
  A19N: "A319neo", A20N: "A320neo", A21N: "A321neo",
  A318: "A318", A319: "A319", A320: "A320", A321: "A321",
  A332: "A330-200", A333: "A330-300", A338: "A330-800", A339: "A330-900",
  A359: "A350-900", A35K: "A350-1000", A388: "A380",
  BCS1: "A220-100", BCS3: "A220-300",
  B712: "717", B722: "727", B732: "737-200", B733: "737-300", B734: "737-400",
  B735: "737-500", B736: "737-600", B737: "737-700", B738: "737-800", B739: "737-900",
  B37M: "737 MAX 7", B38M: "737 MAX 8", B39M: "737 MAX 9",
  B752: "757-200", B753: "757-300", B762: "767-200", B763: "767-300", B764: "767-400",
  B772: "777-200", B77L: "777-200LR", B77W: "777-300ER", B77F: "777F",
  B788: "787-8", B789: "787-9", B78X: "787-10",
  B744: "747-400", B748: "747-8", B74F: "747F",
  E135: "ERJ-135", E145: "ERJ-145", E170: "E170", E175: "E175",
  E190: "E190", E195: "E195", E290: "E190-E2", E295: "E195-E2",
  E50P: "Phenom 100", E55P: "Phenom 300",
  CRJ1: "CRJ-100", CRJ2: "CRJ-200", CRJ7: "CRJ-700", CRJ9: "CRJ-900",
  AT43: "ATR 42-300", AT72: "ATR 72-200", AT75: "ATR 72-500", AT76: "ATR 72-600",
  DH8A: "Dash 8-100", DH8B: "Dash 8-200", DH8C: "Dash 8-300", DH8D: "Dash 8-Q400",
  C172: "Cessna 172", C182: "Cessna 182", C208: "Cessna 208 Caravan",
  C25A: "CitationJet CJ2", C25B: "CJ3", C25C: "CJ4", C25M: "Citation M2",
  C510: "Citation Mustang", C525: "CitationJet", C56X: "Citation Excel/XLS",
  C680: "Citation Sovereign", C68A: "Citation Latitude", C750: "Citation X",
  BE20: "King Air 200", B350: "Super King Air 350", B190: "Beech 1900",
  BE40: "Beechjet 400", BE36: "Bonanza A36",
  PA28: "Cherokee/Warrior/Archer", PA31: "Navajo", PA46: "Malibu/Mirage",
  SR20: "Cirrus SR20", SR22: "Cirrus SR22",
  DA40: "Diamond DA40", DA42: "Diamond DA42",
  PC12: "Pilatus PC-12", TBM9: "TBM 900", TBM10: "TBM 940",
  GLF4: "G-IV/G450", GLF5: "G-V/G550", G280: "Gulfstream G280",
  CL30: "Challenger 300", CL35: "Challenger 350", CL60: "Challenger 600",
  GL5T: "Global 5000", GL6T: "Global 6000", GL7T: "Global 7500",
  R44: "Robinson R44", R66: "Robinson R66",
  B06: "Bell 206 JetRanger", B407: "Bell 407", B412: "Bell 412",
  AS50: "AS350 Squirrel", AS65: "AS365 Dauphin",
  EC30: "H130", EC35: "H135", EC45: "H145",
  H60: "UH-60 Black Hawk", H64: "AH-64 Apache",
  F16: "F-16 Falcon", F18: "F/A-18 Hornet", F35: "F-35 Lightning II",
  C130: "C-130 Hercules", C17: "C-17 Globemaster",
};

const state = {
  sevFilter: "all",
  callsCache: [],
  aircraftCache: [],
};

// ---- API helper ----
async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtAgo(unix) {
  if (!unix) return "—";
  const d = Math.max(0, Math.floor((Date.now() / 1000 - unix)));
  if (d < 60)    return `${d}s ago`;
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
function fmtTime(unix) {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- Masthead clock ----
function tickClock() {
  const now = new Date();
  const date = now.toLocaleDateString([], {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
  const time = now.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", hour12: true,
    timeZoneName: "short",
  });
  document.getElementById("paper-date").textContent = date;
  document.getElementById("paper-time").textContent = time;
}

// ---- Anomaly tape ----
async function refreshAnomaly() {
  try {
    const d = await api("/api/calls?limit=80");
    const tape = document.getElementById("anomaly-tape");
    const icon = document.getElementById("anomaly-icon");
    const text = document.getElementById("anomaly-text");
    const calls = d.calls || [];
    const now = Date.now() / 1000;

    const crit = calls.find(c =>
      (c.incident_severity || "").toLowerCase() === "critical" &&
      (c.start_time || 0) > now - 900);
    if (crit) {
      tape.dataset.state = "alert";
      icon.textContent = "🚨";
      text.textContent = `CRITICAL · ${crit.incident_summary || crit.incident_type || crit.talkgroup_tag}`;
      return;
    }

    for (const c of calls.filter(c => (c.start_time || 0) > now - 1800)) {
      const blob = `${c.transcript || ""} ${c.incident_summary || ""} ${c.incident_type || ""}`.toLowerCase();
      const hit = ANOMALY_KEYWORDS.find(kw => blob.includes(kw));
      if (hit) {
        tape.dataset.state = "watch";
        icon.textContent = "⚠";
        text.textContent = `Watching: "${hit}" on ${c.talkgroup_tag || `tg-${c.talkgroup}`}`;
        return;
      }
    }

    const recent5 = calls.filter(c => (c.start_time || 0) > now - 300).length;
    tape.dataset.state = "quiet";
    icon.textContent = "●";
    text.textContent = recent5
      ? `${recent5} call${recent5 === 1 ? "" : "s"} in the last 5 min · all routine`
      : "Quiet — no recent radio activity";
  } catch (e) {
    console.error("anomaly refresh failed", e);
  }
}

// ---- Lead story + secondary stories grid ----
async function refreshStories() {
  try {
    const d = await api("/api/stories");
    const stories = d.stories || [];

    // Lead
    const titleEl = document.getElementById("lead-title");
    const bodyEl  = document.getElementById("lead-body");
    const tsEl    = document.getElementById("lead-ts");
    const ctaEl   = document.getElementById("lead-actions");
    const btnEl   = document.getElementById("lead-listen");
    if (!stories.length) {
      titleEl.textContent = "All quiet on the RGV beat.";
      bodyEl.textContent  = "No clustered stories in the last few hours. " +
                            "When something noteworthy happens — a pursuit, a structure fire, a medical " +
                            "emergency picked up by the enricher — it will appear here.";
      tsEl.textContent    = "—";
      ctaEl.classList.add("hidden");
    } else {
      const lead = stories[0];
      titleEl.textContent = lead.title || "Activity in progress";
      bodyEl.innerHTML    = highlightTenCodes(escapeHtml(lead.body || ""));
      tsEl.textContent    = `Updated ${fmtAgo(lead.last_call_at || lead.created_at)}`;
      // Inject the hero graphic into the lead block
      const leadEl = document.querySelector(".paper-lead");
      let heroSlot = leadEl.querySelector(".story-hero-slot");
      if (!heroSlot) {
        heroSlot = document.createElement("div");
        heroSlot.className = "story-hero-slot";
        leadEl.insertBefore(heroSlot, leadEl.firstChild);
      }
      heroSlot.innerHTML = renderStoryHero(lead, "lead");
      // Metadata strip: first reported / units / location / duration
      let metaSlot = leadEl.querySelector(".lead-meta-slot");
      if (!metaSlot) {
        metaSlot = document.createElement("div");
        metaSlot.className = "lead-meta-slot";
        // Insert after the headline so it lives above the body paragraph
        const headEl = document.getElementById("lead-title");
        headEl.insertAdjacentElement("afterend", metaSlot);
      }
      if (lead.meta) {
        const m = {
          firstTime: lead.meta.first_time,
          lastTime:  lead.meta.last_time,
          durationSec: lead.meta.duration_sec,
          callCount: lead.meta.call_count,
          units:     lead.meta.units || [],
          address:   lead.meta.address || "",
        };
        metaSlot.innerHTML = renderMetadataStrip(m, { maxUnits: 12 });
      } else {
        metaSlot.innerHTML = "";
      }
      // Wire the action buttons. Both "Listen" + "Source calls (N)"
      // — the modal renders the cluster's full transcripts + audio.
      ctaEl.classList.remove("hidden");
      const sourceN = (lead.related_call_ids || []).length || 1;
      ctaEl.innerHTML = `
        ${lead.primary_call_id ? `<button id="lead-listen" class="paper-btn paper-btn-primary">▶ Listen to source call</button>` : ""}
        <button id="lead-sources" class="paper-btn">Source calls (${sourceN})</button>
      `;
      const listenBtn = document.getElementById("lead-listen");
      if (listenBtn) listenBtn.onclick = () => playPrimaryCall(lead.primary_call_id);
      document.getElementById("lead-sources").onclick = () => openSourceModal(lead.id, lead.title);
    }

    // Secondary stories grid (skip lead)
    const grid = document.getElementById("paper-stories");
    const secondary = stories.slice(1, 7);
    if (!secondary.length) {
      grid.innerHTML = '<div class="paper-empty">More stories will appear as activity builds.</div>';
    } else {
      grid.innerHTML = secondary.map(s => {
        const sev = (s.severity || "unknown").toLowerCase();
        const sourceN = (s.related_call_ids || []).length || 1;
        // Build compact metadata bits for secondary cards (short, no labels)
        const m = s.meta;
        const compactMeta = m ? `
          <div class="story-card-meta">
            <span title="First reported">⏱ ${fmtTime(m.first_time)}</span>
            ${m.duration_sec ? `<span title="Active for">· ${formatDuration(m.duration_sec)}</span>` : ""}
            ${m.units && m.units.length ? `<span title="Responding units">· ${m.units.length} unit${m.units.length === 1 ? "" : "s"}</span>` : ""}
            ${m.address ? `<span class="story-card-meta-addr" title="${escapeHtml(m.address)}">· ${escapeHtml(m.address)}</span>` : ""}
          </div>` : "";
        return `
          <article class="story-card" data-story-id="${s.id}">
            ${renderStoryHero(s, "sm")}
            <div class="story-card-content">
              <span class="story-card-sev ${escapeHtml(sev)}">${escapeHtml(sev)}</span>
              <h4 class="story-card-title">${escapeHtml(s.title || "—")}</h4>
              <p class="story-card-body">${highlightTenCodes(escapeHtml(s.body || ""))}</p>
              ${compactMeta}
              <div class="story-card-footer">
                <span class="story-card-ts">${fmtAgo(s.last_call_at || s.created_at)}</span>
                <button class="story-card-sources" data-story-id="${s.id}">Source calls (${sourceN}) →</button>
              </div>
            </div>
          </article>
        `;
      }).join("");
      grid.querySelectorAll(".story-card-sources").forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const id = +btn.dataset.storyId;
          const story = secondary.find(s => s.id === id);
          openSourceModal(id, story ? story.title : "Source calls");
        };
      });
    }
  } catch (e) {
    console.error("stories refresh failed", e);
  }
}

// ---- Source-calls modal ----
// Click "Source calls (N)" on any story → fetch /api/stories/{id} and
// render each related call's transcript + audio in a modal overlay.
async function openSourceModal(storyId, title) {
  let modal = document.getElementById("source-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "source-modal";
    modal.className = "source-modal";
    modal.innerHTML = `
      <div class="source-modal-backdrop"></div>
      <div class="source-modal-card" role="dialog" aria-modal="true">
        <button class="source-modal-close" aria-label="Close">×</button>
        <h2 id="source-modal-title">Source calls</h2>
        <div id="source-modal-body" class="source-modal-body">Loading…</div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector(".source-modal-backdrop").onclick = closeSourceModal;
    modal.querySelector(".source-modal-close").onclick    = closeSourceModal;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("open")) closeSourceModal();
    });
  }
  document.getElementById("source-modal-title").textContent = title || "Source calls";
  document.getElementById("source-modal-body").innerHTML    = '<div class="modal-loading">Loading source calls…</div>';
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
  try {
    const d = await api(`/api/stories/${storyId}`);
    const calls = (d.calls || []).filter(c => c.id != null);
    if (!calls.length) {
      document.getElementById("source-modal-body").innerHTML =
        '<div class="modal-empty">This story has no source calls available.</div>';
      return;
    }
    const isPrimary = (cid) => cid === d.primary_call_id;
    const meta = computeClusterMeta(calls);
    document.getElementById("source-modal-body").innerHTML = `
      <div class="modal-meta">
        <span class="modal-meta-tag">${escapeHtml(d.talkgroup_tag || "")}</span>
        <span class="modal-meta-sev sev-${(d.severity || "unknown").toLowerCase()}">${escapeHtml(d.severity || "unknown")}</span>
        <span class="modal-meta-count">${calls.length} source call${calls.length === 1 ? "" : "s"}</span>
      </div>
      <div class="modal-summary">${highlightTenCodes(escapeHtml(d.body || ""))}</div>
      ${renderMetadataStrip(meta, { maxUnits: 20 })}
      <div class="modal-calls">
        ${calls.map(c => `
          <div class="modal-call${isPrimary(c.id) ? " primary" : ""}">
            <div class="modal-call-head">
              ${isPrimary(c.id) ? '<span class="modal-call-badge">PRIMARY</span>' : ""}
              <span class="modal-call-time">${fmtTime(c.start_time)} · ${fmtAgo(c.start_time)}</span>
              <span class="modal-call-tag">${escapeHtml(c.talkgroup_tag || `tg-${c.id}`)}</span>
              ${c.incident_units ? `<span class="modal-call-units">${escapeHtml(Array.isArray(c.incident_units) ? c.incident_units.join(", ") : c.incident_units)}</span>` : ""}
            </div>
            ${c.incident_summary ? `<div class="modal-call-summary">${highlightTenCodes(escapeHtml(c.incident_summary))}</div>` : ""}
            ${c.transcript ? `<div class="modal-call-transcript">${highlightTenCodes(escapeHtml(c.transcript))}</div>` : '<div class="modal-call-pending">no transcript yet</div>'}
            ${c.audio_available && (c.opus_path || c.audio_url) ? `
              <audio controls preload="none">
                <source src="${c.audio_url ? escapeHtml(c.audio_url) : `/audio/${escapeHtml(c.opus_path)}`}" type="audio/ogg; codecs=opus">
              </audio>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  } catch (e) {
    console.error("source modal load failed", e);
    document.getElementById("source-modal-body").innerHTML =
      `<div class="modal-empty">Failed to load source calls: ${escapeHtml(e.message || "")}</div>`;
  }
}

function closeSourceModal() {
  const modal = document.getElementById("source-modal");
  if (!modal) return;
  modal.classList.remove("open");
  document.body.style.overflow = "";
  // Stop any playing audio when we close
  modal.querySelectorAll("audio").forEach(a => { try { a.pause(); } catch (_) {} });
}

async function playPrimaryCall(callId) {
  try {
    const c = await api(`/api/calls/${callId}`);
    if (!c.audio_available || !c.opus_path) return;
    let a = document.getElementById("lead-audio-player");
    if (!a) {
      a = document.createElement("audio");
      a.id = "lead-audio-player";
      a.controls = true;
      a.style.width = "100%";
      a.style.marginTop = "10px";
      document.getElementById("lead-actions").appendChild(a);
    }
    a.src = `/audio/${c.opus_path}`;
    a.play();
  } catch (e) { console.error("play primary failed", e); }
}

// ---- By the Numbers ----
async function refreshStats() {
  try {
    const stats = await api("/api/stats");
    const air   = state.aircraftCache;  // cached from skies refresh
    const num   = document.getElementById("paper-numbers");
    const t = stats.totals || {};
    const r = stats.last_24h || {};
    const b = stats.backlog || {};
    num.innerHTML = `
      <div class="number-tile">
        <div class="num">${(r.kept_24h || 0).toLocaleString()}</div>
        <div class="lbl">Calls today</div>
        <div class="sub">${(t.kept_total || 0).toLocaleString()} all-time</div>
      </div>
      <div class="number-tile">
        <div class="num">${(t.enriched || 0).toLocaleString()}</div>
        <div class="lbl">AI Enriched</div>
        <div class="sub">${b.enrich_pending || 0} pending</div>
      </div>
      <div class="number-tile">
        <div class="num">${air.length}</div>
        <div class="lbl">Aircraft now</div>
        <div class="sub">in RGV airspace</div>
      </div>
      <div class="number-tile">
        <div class="num">${(t.transcribed || 0).toLocaleString()}</div>
        <div class="lbl">Transcribed</div>
        <div class="sub">${b.transcribe_pending || 0} pending</div>
      </div>
    `;
  } catch (_) {}
}

// ---- Local activity ----
async function refreshCalls() {
  try {
    const qs = new URLSearchParams({ limit: "40", only_kept: "1" });
    if (state.sevFilter !== "all") qs.set("severity", state.sevFilter);
    const d = await api(`/api/calls?${qs.toString()}`);
    state.callsCache = d.calls || [];
    renderCalls();
  } catch (e) {
    console.error("calls refresh failed", e);
  }
}

function wireSeverityChips() {
  document.querySelectorAll(".paper-chips .chip[data-sev]").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".paper-chips .chip[data-sev]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.sevFilter = btn.dataset.sev;
      refreshCalls();
    };
  });
}

const AI_STAR_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
  <path fill="currentColor" d="M12 3 13.5 9 19.5 10.5 13.5 12 12 18 10.5 12 4.5 10.5 10.5 9z"/>
</svg>`;

// ---- Ten-codes — common across TX public-safety (varies slightly by
// agency, this is the McAllen-area canonical set). Used to underline
// codes in transcripts and show their meaning on hover. ----
const TEN_CODES = {
  "10-1":  "Receiving poorly",
  "10-2":  "Receiving well",
  "10-3":  "Stop transmitting",
  "10-4":  "OK / acknowledged",
  "10-5":  "Relay message",
  "10-6":  "Busy",
  "10-7":  "Out of service",
  "10-8":  "In service",
  "10-9":  "Repeat",
  "10-10": "Off duty",
  "10-12": "Standby / visitors present",
  "10-13": "Weather / road conditions",
  "10-15": "Prisoner in custody",
  "10-16": "Pick up prisoner",
  "10-18": "Urgent",
  "10-19": "Return to station",
  "10-20": "Location?",
  "10-21": "Call by phone",
  "10-22": "Disregard",
  "10-23": "Stand by",
  "10-24": "Assignment complete",
  "10-25": "Report in person",
  "10-26": "Detaining suspect",
  "10-27": "Driver's license check",
  "10-28": "Vehicle registration check",
  "10-29": "Check for wanted / warrants",
  "10-31": "Crime in progress",
  "10-32": "Person with gun",
  "10-33": "EMERGENCY — officer needs help",
  "10-35": "Major crime alert",
  "10-36": "Correct time?",
  "10-37": "Suspicious vehicle",
  "10-38": "Stopping suspicious vehicle",
  "10-39": "Urgent — lights & siren",
  "10-40": "Silent run — no lights/siren",
  "10-43": "Information",
  "10-45": "Animal carcass",
  "10-46": "Assist motorist",
  "10-49": "Traffic light out",
  "10-50": "Accident / MVA",
  "10-51": "Wrecker needed",
  "10-52": "Ambulance needed",
  "10-53": "Road blocked",
  "10-54": "Livestock on highway",
  "10-55": "Intoxicated driver",
  "10-57": "Hit and run",
  "10-58": "Direct traffic",
  "10-59": "Convoy / escort",
  "10-66": "Message cancellation",
  "10-70": "Fire alarm",
  "10-71": "Advise nature of fire",
  "10-72": "Report progress on fire",
  "10-73": "Smoke report",
  "10-74": "Negative",
  "10-76": "En route",
  "10-77": "ETA?",
  "10-78": "Need assistance",
  "10-79": "Notify coroner",
  "10-80": "Chase in progress",
  "10-85": "Delayed",
  "10-89": "Bomb threat",
  "10-90": "Bank alarm",
  "10-91": "Pick up subject",
  "10-95": "Subject in custody",
  "10-96": "Mental health subject",
  "10-97": "Arrived at scene",
  "10-98": "Escaped prisoner",
  "10-99": "Officer down / wanted-and-armed",
};

// Wrap every "10-XX" token in escaped text with an <abbr> tag that shows
// the meaning on hover. Operates on already-html-escaped strings — call
// AFTER escapeHtml(), never before.
function highlightTenCodes(escapedHtml) {
  return escapedHtml.replace(/\b(10-\d{1,3})\b/g, (_, code) => {
    const meaning = TEN_CODES[code];
    if (meaning) {
      return `<abbr class="ten-code" title="${escapeHtml(meaning)}">${code}</abbr>`;
    }
    return `<abbr class="ten-code ten-code-unknown" title="ten-code (unknown)">${code}</abbr>`;
  });
}

// ---- Cluster metadata ----
// Computes structured facts from a story's source calls. Returns an
// object with formatted strings ready for display.
function computeClusterMeta(calls) {
  if (!calls || !calls.length) return null;
  const sorted = [...calls].sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
  const first = sorted[0];
  const last  = sorted[sorted.length - 1];

  // Duration = last call's start - first call's start + last call's duration
  const lastEnd = (last.start_time || 0) + (last.duration_sec || 0);
  const durSec = Math.max(0, lastEnd - (first.start_time || 0));

  // Units: union of incident_units across calls
  const unitSet = new Set();
  for (const c of sorted) {
    if (c.incident_units) {
      const u = Array.isArray(c.incident_units)
        ? c.incident_units
        : String(c.incident_units).split(",");
      u.forEach(x => { const t = String(x).trim(); if (t) unitSet.add(t); });
    }
  }
  const units = [...unitSet].sort();

  // Address: prefer the primary call's incident_location, fall back to
  // the most-specific one across the cluster.
  const locs = sorted.map(c => (c.incident_location || "").trim()).filter(Boolean);
  const address = locs.sort((a, b) => b.length - a.length)[0] || "";

  return {
    firstTime: first.start_time,
    lastTime:  last.start_time,
    durationSec: Math.round(durSec),
    callCount: sorted.length,
    units, address,
  };
}

function formatDuration(sec) {
  if (!sec || sec < 1) return "—";
  if (sec < 60)  return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderMetadataStrip(meta, opts = {}) {
  if (!meta) return "";
  const bits = [];
  bits.push(`<span class="meta-bit"><b>First reported:</b> ${fmtTime(meta.firstTime)}</span>`);
  bits.push(`<span class="meta-bit"><b>Last activity:</b> ${fmtTime(meta.lastTime)}</span>`);
  bits.push(`<span class="meta-bit"><b>Duration:</b> ${formatDuration(meta.durationSec)}</span>`);
  bits.push(`<span class="meta-bit"><b>Calls:</b> ${meta.callCount}</span>`);
  if (meta.units.length) {
    const list = meta.units.slice(0, opts.maxUnits || 8).map(escapeHtml).join(", ");
    const more = meta.units.length > (opts.maxUnits || 8) ? ` +${meta.units.length - (opts.maxUnits || 8)}` : "";
    bits.push(`<span class="meta-bit"><b>Units:</b> ${list}${more}</span>`);
  }
  if (meta.address) {
    bits.push(`<span class="meta-bit meta-bit-address"><b>Location:</b> ${escapeHtml(meta.address)}</span>`);
  }
  return `<div class="meta-strip">${bits.join("")}</div>`;
}

// ---- Story category inference ----
// Returns {emoji, key} where key is used for color/CSS class. Inspects the
// talkgroup tag, severity, and body keywords. Most-specific match wins.
function storyCategory(s) {
  const tag = (s.talkgroup_tag || "").toLowerCase();
  const body = (s.body || "").toLowerCase();
  const title = (s.title || "").toLowerCase();
  const blob = `${title} ${body}`;
  // Tag-first (most reliable signal)
  if (/\bpd\b|police|sheriff|law|dps|cbp|patrol/.test(tag))     return { key: "police", emoji: "🚓" };
  if (/\bfd\b|fire|hazmat/.test(tag))                            return { key: "fire",   emoji: "🚒" };
  if (/ems|medic|paramed|ambulance|med ?evac/.test(tag))         return { key: "ems",    emoji: "🚑" };
  if (/isd|school|cisd/.test(tag))                               return { key: "school", emoji: "🏫" };
  if (/transport|metro|bus|valley/.test(tag))                    return { key: "transit", emoji: "🚌" };
  if (/airport|tower|approach/.test(tag))                        return { key: "air",    emoji: "✈" };
  if (/pw|public works|water|util/.test(tag))                    return { key: "works",  emoji: "🔧" };
  // Body keyword fallback
  if (/pursuit|chase|suspect|arrest|robbery|burglary|shoot|stab/.test(blob)) return { key: "police", emoji: "🚓" };
  if (/structure fire|vehicle fire|brush fire|smoke|flames/.test(blob))      return { key: "fire",   emoji: "🚒" };
  if (/medical|cpr|injur|cardiac|stroke|overdose|unconscious|hospital/.test(blob)) return { key: "ems", emoji: "🚑" };
  if (/aircraft|airplane|helicopter|landing|takeoff/.test(blob))             return { key: "air",    emoji: "✈" };
  if (/weather|hurricane|tornado|flood|tropical/.test(blob))                 return { key: "weather", emoji: "🌪" };
  return { key: "generic", emoji: "📡" };
}

function renderStoryHero(s, size) {
  const cat = storyCategory(s);
  const sev = (s.severity || "unknown").toLowerCase();
  const sizeClass = size === "lead" ? "story-hero-lead" : "story-hero-sm";
  return `<div class="story-hero ${sizeClass} hero-cat-${cat.key} hero-sev-${sev}">
    <span class="story-hero-icon">${cat.emoji}</span>
  </div>`;
}

function renderCallCard(c) {
  const sev = (c.incident_severity || "unknown").toLowerCase();
  const tag = c.talkgroup_tag || `tg-${c.talkgroup}`;
  const incType = c.incident_type && c.incident_type !== "radio_chatter" ? c.incident_type : "";
  const ai = c.enriched_at
    ? `<span class="paper-call-ai" title="AI-enriched">${AI_STAR_SVG}</span>` : "";
  const sevBadge = PINNED_SEV.has(sev)
    ? `<span class="paper-call-sev ${sev}">${sev}</span>` : "";
  const summary = c.incident_summary
    ? `<span class="summary">${escapeHtml(c.incident_summary)}</span> ` : "";
  const transcript = c.transcript
    ? highlightTenCodes(escapeHtml(c.transcript))
    : (c.audio_available ? '<span class="pending">Awaiting transcription…</span>' : "");
  const audio = c.audio_available && c.opus_path
    ? `<audio controls preload="none"><source src="/audio/${escapeHtml(c.opus_path)}" type="audio/ogg; codecs=opus"></audio>`
    : "";
  return `
    <div class="paper-call sev-${sev}">
      <div class="paper-call-time">
        ${fmtTime(c.start_time)}
        <span class="ago">${fmtAgo(c.start_time)}</span>
      </div>
      <div class="paper-call-body">
        <div class="paper-call-meta">
          ${ai}
          <span class="paper-call-tag">${escapeHtml(tag)}</span>
          ${incType ? `<span class="paper-call-type">${escapeHtml(incType)}</span>` : ""}
          ${sevBadge}
        </div>
        <p class="paper-call-text">${summary}${transcript}</p>
        ${audio}
      </div>
    </div>
  `;
}

function renderCalls() {
  const calls = state.callsCache;
  const pinned = calls.filter(c => PINNED_SEV.has((c.incident_severity || "").toLowerCase()));
  const recent = calls.filter(c => !PINNED_SEV.has((c.incident_severity || "").toLowerCase()));

  pinned.sort((a, b) => {
    const sa = SEVERITY_RANK[(a.incident_severity || "unknown").toLowerCase()] ?? 0;
    const sb = SEVERITY_RANK[(b.incident_severity || "unknown").toLowerCase()] ?? 0;
    if (sa !== sb) return sb - sa;
    return (b.start_time || 0) - (a.start_time || 0);
  });
  recent.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));

  const pinnedEl = document.getElementById("paper-pinned");
  const recentEl = document.getElementById("paper-recent");
  const recentH  = document.getElementById("paper-recent-h");

  pinnedEl.innerHTML = pinned.length
    ? pinned.slice(0, 12).map(renderCallCard).join("")
    : "";
  recentEl.innerHTML = recent.length
    ? recent.slice(0, 30).map(renderCallCard).join("")
    : '<div class="paper-empty">No recent calls match your filter.</div>';

  // Show "Other recent" header only when there's pinned content above
  if (pinned.length && recent.length) recentH.classList.remove("hidden");
  else recentH.classList.add("hidden");

  // Tab title hint
  const critN = pinned.filter(c => (c.incident_severity || "").toLowerCase() === "critical").length;
  document.title = critN > 0 ? `🚨 ${critN} critical — jafo` : "jafo — RGV Briefing";
}

// ---- Skies ----
function aircraftKindEmoji(kind, emerg) {
  if (emerg) return "🚨";
  if (kind === "helicopter") return "🚁";
  if (kind === "military")   return "🪖";
  if (kind === "uav")        return "🛸";
  if (kind === "heavy")      return "✈️";
  return "✈";
}

async function refreshAircraft() {
  try {
    const d = await api("/api/aircraft?region=rgv");
    state.aircraftCache = (d.aircraft || []).filter(a => a.lat != null && a.lon != null);
    renderSkies();
  } catch (e) {
    console.error("aircraft refresh failed", e);
  }
}

function renderSkies() {
  const list = state.aircraftCache;
  const root = document.getElementById("paper-skies");
  const countEl = document.getElementById("paper-skies-count");
  countEl.textContent = `${list.length} aircraft`;

  if (!list.length) {
    root.innerHTML = '<div class="paper-empty">No aircraft currently in RGV airspace.</div>';
    return;
  }

  // Order: emergency first, then by altitude desc (more interesting overhead)
  const sorted = [...list].sort((a, b) => {
    if (a.emergency && !b.emergency) return -1;
    if (!a.emergency && b.emergency) return 1;
    return (b.altitude_ft || 0) - (a.altitude_ft || 0);
  });

  root.innerHTML = sorted.slice(0, 30).map(a => {
    const code = (a.type_code || "").toUpperCase();
    const friendly = ICAO_TYPE_NAMES[code];
    const name = a.callsign || a.registration || a.icao24 || "—";
    const typeBit = code
      ? (friendly
        ? `<span class="type-code">${escapeHtml(code)} · ${escapeHtml(friendly)}</span>`
        : `<span class="type-code">${escapeHtml(code)}</span>`)
      : "";
    const altFt = a.altitude_ft ? `${Math.round(a.altitude_ft / 100) * 100}ft` : "—";
    const spd   = a.velocity_kt ? `${Math.round(a.velocity_kt)}kt` : "";
    let status  = "";
    if (a.emergency) status = "EMERGENCY";
    else if (a.airport_event && a.airport_event.kind) status = a.airport_event.kind.toUpperCase();
    return `
      <div class="paper-sky-row${a.emergency ? " emerg" : ""}">
        <span class="paper-sky-kind">${aircraftKindEmoji(a.kind, a.emergency)}</span>
        <span class="paper-sky-name">${escapeHtml(name)} ${typeBit}</span>
        <span class="paper-sky-alt">${altFt}</span>
        <span class="paper-sky-spd">${spd}</span>
        <span class="paper-sky-status">${status}</span>
      </div>
    `;
  }).join("");
}

// ---- Boot ----
function startPolling() {
  setInterval(refreshStories,  POLL_STORIES_MS);
  setInterval(refreshCalls,    POLL_CALLS_MS);
  setInterval(refreshAircraft, POLL_AIR_MS);
  setInterval(refreshStats,    POLL_STATS_MS);
  setInterval(refreshAnomaly,  POLL_ANOMALY_MS);
  setInterval(tickClock,       POLL_CLOCK_MS);
}

document.addEventListener("DOMContentLoaded", async () => {
  tickClock();
  wireSeverityChips();
  await Promise.all([
    refreshStories(),
    refreshAnomaly(),
    refreshCalls(),
    refreshAircraft(),
  ]);
  await refreshStats(); // depends on aircraftCache
  startPolling();
});
