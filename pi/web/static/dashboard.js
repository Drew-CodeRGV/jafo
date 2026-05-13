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
// User-selected sort: "impact" (default, by score) or "latest" (by last_call_at).
// Persisted to localStorage so it sticks across reloads.
let STORY_SORT = localStorage.getItem("jafo:storySort") || "impact";

function sortStories(stories) {
  const a = (stories || []).slice();
  if (STORY_SORT === "latest") {
    a.sort((x, y) => (y.last_call_at || 0) - (x.last_call_at || 0));
  } else {
    a.sort((x, y) => (y.score || 0) - (x.score || 0)
                  || (y.last_call_at || 0) - (x.last_call_at || 0));
  }
  return a;
}

async function refreshStories() {
  try {
    const d = await api("/api/stories");
    const stories = sortStories(d.stories || []);

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
        <a id="lead-share" class="paper-btn" href="/share/story/${lead.id}" target="_blank" rel="noopener">↗ Share</a>
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
                <a class="story-card-share" href="/share/story/${s.id}" target="_blank" rel="noopener" title="Open shareable page in new tab">↗ Share</a>
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
              <div class="modal-call-audio-wrap">
                <button type="button" class="modal-call-play-btn" data-state="paused">
                  <span class="play-icon">▶</span>
                  <span class="play-label">Listen to this call</span>
                </button>
                <audio preload="metadata" class="modal-call-audio">
                  <source src="${c.audio_url ? escapeHtml(c.audio_url) : `/audio/${escapeHtml(c.opus_path)}`}" type="audio/ogg; codecs=opus">
                </audio>
              </div>` : ""}
          </div>
        `).join("")}
      </div>
    `;
    // Wire each "Listen to this call" button to toggle the sibling
    // <audio> element. We use a custom play button + hidden controls
    // so the label IS the play affordance (it was just text before).
    // Only one call can play at a time across the modal.
    document.querySelectorAll(".modal-call-audio-wrap").forEach(wrap => {
      const btn   = wrap.querySelector(".modal-call-play-btn");
      const audio = wrap.querySelector("audio");
      if (!btn || !audio) return;
      audio.controls = true;  // keep timeline visible after first interaction
      btn.addEventListener("click", () => {
        if (audio.paused) {
          // Pause any other playing audio in the modal
          document.querySelectorAll("#source-modal audio").forEach(a => {
            if (a !== audio && !a.paused) a.pause();
          });
          audio.play().catch(err => console.error("audio play failed:", err));
        } else {
          audio.pause();
        }
      });
      audio.addEventListener("play",  () => {
        btn.dataset.state = "playing";
        btn.querySelector(".play-icon").textContent  = "❚❚";
        btn.querySelector(".play-label").textContent = "Pause";
      });
      audio.addEventListener("pause", () => {
        btn.dataset.state = "paused";
        btn.querySelector(".play-icon").textContent  = "▶";
        btn.querySelector(".play-label").textContent = "Listen to this call";
      });
      audio.addEventListener("ended", () => {
        btn.dataset.state = "paused";
        btn.querySelector(".play-icon").textContent  = "▶";
        btn.querySelector(".play-label").textContent = "Replay this call";
      });
    });
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

// ---- Story category inference + hero illustration ----
// Categories: police, fire, ems, school, transit, air, works, weather, generic.
// Each maps to a flat SVG illustration (newspaper-section style) rendered
// inline — no external deps, scales cleanly, ranks higher than emoji.
function storyCategory(s) {
  const tag = (s.talkgroup_tag || "").toLowerCase();
  const body = (s.body || "").toLowerCase();
  const title = (s.title || "").toLowerCase();
  const blob = `${title} ${body}`;
  if (/\bpd\b|police|sheriff|law|dps|cbp|patrol/.test(tag))      return "police";
  if (/\bfd\b|fire|hazmat/.test(tag))                            return "fire";
  if (/ems|medic|paramed|ambulance|med ?evac/.test(tag))         return "ems";
  if (/isd|school|cisd/.test(tag))                               return "school";
  if (/transport|metro|bus|valley/.test(tag))                    return "transit";
  if (/airport|tower|approach/.test(tag))                        return "air";
  if (/pw|public works|water|util/.test(tag))                    return "works";
  if (/pursuit|chase|suspect|arrest|robbery|burglary|shoot|stab/.test(blob)) return "police";
  if (/structure fire|vehicle fire|brush fire|smoke|flames/.test(blob))      return "fire";
  if (/medical|cpr|injur|cardiac|stroke|overdose|unconscious|hospital/.test(blob)) return "ems";
  if (/aircraft|airplane|helicopter|landing|takeoff/.test(blob))             return "air";
  if (/weather|hurricane|tornado|flood|tropical/.test(blob))                 return "weather";
  return "generic";
}

// Flat newspaper-style SVG illustrations, one per category. Drawn at
// 320x180 (16:9) so they fill the secondary-card hero strip cleanly.
// The Y axis is the sky/background, foreground is the subject silhouette.
// All use the same color palette for visual coherence.
const HERO_SVG = {
  police: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="hp" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a2745"/><stop offset="1" stop-color="#0c1828"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#hp)"/>
    <!-- ground -->
    <rect y="142" width="320" height="38" fill="#0a1018"/>
    <line x1="0" y1="155" x2="320" y2="155" stroke="#1c2840" stroke-width="1"/>
    <!-- patrol car silhouette -->
    <path d="M70 130 L90 110 L130 105 L200 105 L240 115 L260 130 L260 142 L70 142 Z" fill="#202d44"/>
    <rect x="98" y="112" width="38" height="18" fill="#2a3a5a"/>
    <rect x="140" y="112" width="48" height="18" fill="#2a3a5a"/>
    <!-- light bar -->
    <rect x="140" y="98" width="50" height="8" rx="2" fill="#3a4a68"/>
    <rect x="142" y="98" width="22" height="8" fill="#3d6dff"/>
    <rect x="166" y="98" width="22" height="8" fill="#ff3d3d"/>
    <!-- wheels -->
    <circle cx="105" cy="142" r="11" fill="#0a0f18"/><circle cx="105" cy="142" r="5" fill="#1c2840"/>
    <circle cx="225" cy="142" r="11" fill="#0a0f18"/><circle cx="225" cy="142" r="5" fill="#1c2840"/>
    <!-- distant city outline -->
    <path d="M0 142 L20 130 L20 120 L40 120 L40 135 L60 135 L60 125 L80 125 L80 142 Z" fill="#141d30" opacity="0.6"/>
    <path d="M260 142 L280 128 L280 118 L300 118 L300 132 L320 132 L320 142 Z" fill="#141d30" opacity="0.6"/>
  </svg>`,
  fire: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="hf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a1c0c"/><stop offset="0.6" stop-color="#7a3010"/><stop offset="1" stop-color="#2a0d04"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#hf)"/>
    <!-- glow -->
    <circle cx="190" cy="100" r="80" fill="#ff7a2c" opacity="0.35"/>
    <circle cx="190" cy="110" r="50" fill="#ffb030" opacity="0.45"/>
    <!-- flames -->
    <path d="M170 130 Q160 95 175 80 Q185 95 188 75 Q198 92 200 60 Q215 88 215 110 Q215 132 195 138 Q175 138 170 130 Z" fill="#ff4d1a"/>
    <path d="M180 128 Q175 105 188 95 Q195 110 200 90 Q210 110 207 128 Q200 135 188 135 Q180 132 180 128 Z" fill="#ffb830"/>
    <!-- fire truck silhouette -->
    <rect x="40" y="118" width="90" height="24" fill="#a02820"/>
    <rect x="130" y="110" width="50" height="32" fill="#8a1f18"/>
    <rect x="138" y="116" width="34" height="14" fill="#3a0d08"/>
    <rect x="50" y="122" width="74" height="6" fill="#3a0d08"/>
    <line x1="40" y1="115" x2="180" y2="115" stroke="#ffce30" stroke-width="2"/>
    <!-- wheels -->
    <circle cx="60" cy="142" r="10" fill="#0a0606"/><circle cx="60" cy="142" r="5" fill="#241008"/>
    <circle cx="155" cy="142" r="10" fill="#0a0606"/><circle cx="155" cy="142" r="5" fill="#241008"/>
    <rect y="142" width="320" height="38" fill="#1a0a04"/>
  </svg>`,
  ems: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="he" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2a3a"/><stop offset="1" stop-color="#0a1218"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#he)"/>
    <!-- ambulance silhouette -->
    <rect x="60" y="100" width="200" height="42" fill="#f0f3f7" rx="3"/>
    <rect x="60" y="100" width="60" height="42" fill="#dde2e8"/>
    <!-- cross -->
    <rect x="170" y="108" width="40" height="26" fill="#e84c4c"/>
    <rect x="184" y="108" width="12" height="26" fill="#fff"/>
    <rect x="170" y="115" width="40" height="12" fill="#fff"/>
    <!-- windows -->
    <rect x="68" y="106" width="44" height="20" fill="#1a2840" rx="2"/>
    <!-- light bar -->
    <rect x="140" y="92" width="80" height="8" rx="2" fill="#cdd4dc"/>
    <rect x="144" y="92" width="32" height="8" fill="#ff3d3d"/>
    <rect x="184" y="92" width="32" height="8" fill="#3d6dff"/>
    <!-- wheels -->
    <circle cx="100" cy="142" r="12" fill="#0a0f18"/><circle cx="100" cy="142" r="6" fill="#2a3a5a"/>
    <circle cx="225" cy="142" r="12" fill="#0a0f18"/><circle cx="225" cy="142" r="6" fill="#2a3a5a"/>
    <rect y="142" width="320" height="38" fill="#070d14"/>
  </svg>`,
  school: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="hs" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a86f3a"/><stop offset="1" stop-color="#4e2f14"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#hs)"/>
    <!-- ground -->
    <rect y="142" width="320" height="38" fill="#3a2510"/>
    <!-- school building -->
    <rect x="60" y="80" width="200" height="62" fill="#d99c63"/>
    <polygon points="60,80 160,42 260,80" fill="#7a4a20"/>
    <!-- columns -->
    <rect x="120" y="100" width="10" height="42" fill="#f5d4a6"/>
    <rect x="155" y="100" width="10" height="42" fill="#f5d4a6"/>
    <rect x="190" y="100" width="10" height="42" fill="#f5d4a6"/>
    <!-- door -->
    <rect x="148" y="115" width="24" height="27" fill="#2a1808"/>
    <!-- clock circle -->
    <circle cx="160" cy="68" r="8" fill="#fff"/><circle cx="160" cy="68" r="2" fill="#2a1808"/>
    <line x1="160" y1="68" x2="160" y2="62" stroke="#2a1808" stroke-width="1.5"/>
    <line x1="160" y1="68" x2="164" y2="70" stroke="#2a1808" stroke-width="1.5"/>
    <!-- flagpole -->
    <line x1="220" y1="42" x2="220" y2="80" stroke="#1c1208" stroke-width="2"/>
    <polygon points="220,42 220,55 240,49" fill="#e84c4c"/>
  </svg>`,
  transit: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="ht" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a3a4e"/><stop offset="1" stop-color="#0e1822"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#ht)"/>
    <!-- bus -->
    <rect x="50" y="86" width="220" height="56" fill="#d4af37" rx="4"/>
    <rect x="58" y="94" width="50" height="20" fill="#1c2840" rx="2"/>
    <rect x="116" y="94" width="50" height="20" fill="#1c2840" rx="2"/>
    <rect x="174" y="94" width="50" height="20" fill="#1c2840" rx="2"/>
    <rect x="232" y="94" width="32" height="20" fill="#1c2840" rx="2"/>
    <rect x="50" y="120" width="220" height="6" fill="#a88820"/>
    <!-- wheels -->
    <circle cx="90" cy="142" r="14" fill="#0a0f18"/><circle cx="90" cy="142" r="7" fill="#2a3a5a"/>
    <circle cx="232" cy="142" r="14" fill="#0a0f18"/><circle cx="232" cy="142" r="7" fill="#2a3a5a"/>
    <rect y="142" width="320" height="38" fill="#070d14"/>
  </svg>`,
  air: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="ha" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a5a7a"/><stop offset="1" stop-color="#172838"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#ha)"/>
    <!-- clouds -->
    <ellipse cx="40" cy="50" rx="35" ry="10" fill="#e8eef4" opacity="0.6"/>
    <ellipse cx="260" cy="40" rx="40" ry="12" fill="#e8eef4" opacity="0.5"/>
    <ellipse cx="200" cy="120" rx="50" ry="14" fill="#e8eef4" opacity="0.3"/>
    <!-- airplane silhouette -->
    <path d="M50 90 L200 85 L230 70 L240 70 L222 88 L260 92 L270 96 L222 100 L200 116 L194 116 L180 100 L60 105 Z" fill="#f0f3f7"/>
    <path d="M155 85 L165 72 L172 72 L168 86 Z" fill="#dde2e8"/>
    <path d="M155 102 L165 116 L172 116 L168 104 Z" fill="#dde2e8"/>
    <!-- contrail -->
    <line x1="0" y1="92" x2="50" y2="92" stroke="#e8eef4" stroke-width="2" opacity="0.4" stroke-dasharray="4 3"/>
  </svg>`,
  works: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="hw" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#48402c"/><stop offset="1" stop-color="#1c1a14"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#hw)"/>
    <rect y="142" width="320" height="38" fill="#1a1810"/>
    <!-- hardhat -->
    <path d="M120 110 Q120 80 160 80 Q200 80 200 110 L210 110 L210 122 L110 122 L110 110 Z" fill="#e8a830"/>
    <rect x="155" y="80" width="10" height="30" fill="#c08e22"/>
    <rect x="115" y="115" width="90" height="7" fill="#7a5e10"/>
    <!-- cones -->
    <polygon points="60,140 70,108 80,140" fill="#e84c00"/>
    <rect x="58" y="138" width="24" height="6" fill="#a02a00"/>
    <line x1="65" y1="124" x2="76" y2="124" stroke="#f0f0e8" stroke-width="2"/>
    <polygon points="240,140 250,108 260,140" fill="#e84c00"/>
    <rect x="238" y="138" width="24" height="6" fill="#a02a00"/>
    <line x1="244" y1="124" x2="256" y2="124" stroke="#f0f0e8" stroke-width="2"/>
  </svg>`,
  weather: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="hwt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a2030"/><stop offset="1" stop-color="#080c14"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#hwt)"/>
    <!-- storm cloud -->
    <ellipse cx="120" cy="70" rx="50" ry="22" fill="#2a3a4e"/>
    <ellipse cx="180" cy="65" rx="55" ry="25" fill="#3a4a5e"/>
    <ellipse cx="220" cy="75" rx="40" ry="20" fill="#2a3a4e"/>
    <ellipse cx="150" cy="85" rx="80" ry="14" fill="#1a2840"/>
    <!-- lightning -->
    <polygon points="160,95 170,95 162,118 178,118 152,150 160,128 148,128" fill="#fff7a8"/>
    <!-- rain -->
    <line x1="100" y1="100" x2="96" y2="115" stroke="#6e9fc8" stroke-width="2"/>
    <line x1="115" y1="105" x2="111" y2="120" stroke="#6e9fc8" stroke-width="2"/>
    <line x1="200" y1="100" x2="196" y2="115" stroke="#6e9fc8" stroke-width="2"/>
    <line x1="220" y1="105" x2="216" y2="120" stroke="#6e9fc8" stroke-width="2"/>
    <line x1="235" y1="100" x2="231" y2="115" stroke="#6e9fc8" stroke-width="2"/>
  </svg>`,
  generic: `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a3a4e"/><stop offset="1" stop-color="#0e1822"/>
    </linearGradient></defs>
    <rect width="320" height="180" fill="url(#hg)"/>
    <!-- radio tower -->
    <line x1="160" y1="30" x2="120" y2="142" stroke="#aeb9c5" stroke-width="2"/>
    <line x1="160" y1="30" x2="200" y2="142" stroke="#aeb9c5" stroke-width="2"/>
    <line x1="135" y1="100" x2="185" y2="100" stroke="#aeb9c5" stroke-width="1.5"/>
    <line x1="145" y1="75" x2="175" y2="75" stroke="#aeb9c5" stroke-width="1.5"/>
    <line x1="152" y1="55" x2="168" y2="55" stroke="#aeb9c5" stroke-width="1.5"/>
    <circle cx="160" cy="30" r="5" fill="#ff3d3d"/>
    <!-- signal waves -->
    <path d="M140 30 Q160 5 180 30" stroke="#d4af37" stroke-width="1.5" fill="none" opacity="0.6"/>
    <path d="M125 35 Q160 -10 195 35" stroke="#d4af37" stroke-width="1.5" fill="none" opacity="0.4"/>
    <rect y="142" width="320" height="38" fill="#070d14"/>
  </svg>`,
};

function renderStoryHero(s, size) {
  const cat = storyCategory(s);
  const sev = (s.severity || "unknown").toLowerCase();
  const sizeClass = size === "lead" ? "story-hero-lead" : "story-hero-sm";
  const svg = HERO_SVG[cat] || HERO_SVG.generic;
  return `<div class="story-hero ${sizeClass} hero-cat-${cat} hero-sev-${sev}">
    ${svg}
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

// =====================================================================
// Sort toggle (Impact vs Latest news)
// =====================================================================
(function wireSortToggle() {
  const btns = document.querySelectorAll(".paper-sort-btn");
  if (!btns.length) return;
  btns.forEach(b => {
    if (b.dataset.sort === STORY_SORT) b.classList.add("active");
    else b.classList.remove("active");
    b.addEventListener("click", () => {
      STORY_SORT = b.dataset.sort;
      localStorage.setItem("jafo:storySort", STORY_SORT);
      btns.forEach(x => x.classList.toggle("active", x.dataset.sort === STORY_SORT));
      refreshStories();
    });
  });
})();

// =====================================================================
// CNN-style ticker — latest news, most viewed, most active talkgroups
// =====================================================================
const TICKER_SPEEDS = [30, 45, 60, 90, 120, 180, 240];   // seconds, faster → slower
let tickerSpeedIdx = (() => {
  const stored = parseInt(localStorage.getItem("jafo:tickerSpeed") || "", 10);
  const i = TICKER_SPEEDS.indexOf(stored);
  return i >= 0 ? i : 3;  // default 90s
})();

function applyTickerSpeed() {
  const dur = TICKER_SPEEDS[tickerSpeedIdx];
  document.documentElement.style.setProperty("--ticker-duration", dur + "s");
  localStorage.setItem("jafo:tickerSpeed", String(dur));
}

function renderTicker(data) {
  const track = document.getElementById("ticker-track");
  if (!track) return;

  const sections = [
    { label: "Latest News",          items: data.latest            || [] },
    { label: "Most Viewed",          items: data.most_viewed       || [] },
    { label: "Most Active Talkgroups", items: data.active_talkgroups || [] },
  ].filter(s => s.items.length > 0);

  if (!sections.length) {
    track.innerHTML = '<span class="ticker-item">Scanning RGV traffic…</span>';
    return;
  }

  const renderSection = (s) => {
    let html = `<span class="ticker-section-label">${escapeHtml(s.label)}</span>`;
    s.items.forEach((it, i) => {
      const sub = it.sub ? `<span class="ticker-item-sub">· ${escapeHtml(it.sub)}</span>` : "";
      html += `<a class="ticker-item" href="${escapeHtml(it.url || "#")}" target="_blank" rel="noopener">${escapeHtml(it.label || "")}${sub}</a>`;
      if (i < s.items.length - 1) html += '<span class="ticker-sep">•</span>';
    });
    return html;
  };

  // Render the full set TWICE so the keyframes animation can translate
  // -50% and produce a seamless loop.
  const oneRun = sections.map(s =>
    renderSection(s) + '<span class="ticker-sep" style="margin:0 16px">★</span>'
  ).join("");
  track.innerHTML = oneRun + oneRun;
}

async function refreshTicker() {
  try {
    const r = await fetch("/api/ticker", { cache: "no-store" });
    if (!r.ok) return;
    renderTicker(await r.json());
  } catch (e) {
    console.warn("ticker refresh failed", e);
  }
}

(function wireSpeedControl() {
  applyTickerSpeed();
  const up   = document.querySelector(".ticker-speed-up");
  const down = document.querySelector(".ticker-speed-down");
  if (!up || !down) return;
  up.addEventListener("click",   () => { tickerSpeedIdx = Math.max(0, tickerSpeedIdx - 1); applyTickerSpeed(); });
  down.addEventListener("click", () => { tickerSpeedIdx = Math.min(TICKER_SPEEDS.length - 1, tickerSpeedIdx + 1); applyTickerSpeed(); });
})();

// Initial + periodic refresh of the ticker (every 60s — cheap query)
refreshTicker();
setInterval(refreshTicker, 60_000);
