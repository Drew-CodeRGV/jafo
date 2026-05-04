// jafo — vanilla JS frontend.
// Single page. Polls for stats every 10s, calls every 15s when "Live" is on.

const state = {
  filters: {
    talkgroup: null,
    talkgroup_tag: null,
    service_tag: null,    // group by service type
    category: null,       // group by city/agency
    incident_type: null,
    severity: null,
    search: "",
  },
  // Sidebar grouping/sorting preferences (persisted in localStorage)
  groupBy: localStorage.getItem("jafo.groupBy") || "service", // service | category | flat
  sort: localStorage.getItem("jafo.sort") || "count",         // count | alpha
  // Which group buckets are expanded (collapsed by default to save space)
  expandedGroups: new Set(JSON.parse(localStorage.getItem("jafo.expanded") || "[]")),
  offset: 0,
  limit: 50,
  total: 0,
  calls: [],
  autoRefresh: true,
  pollTimers: {},
};

function persistGroupingPrefs() {
  localStorage.setItem("jafo.groupBy", state.groupBy);
  localStorage.setItem("jafo.sort", state.sort);
  localStorage.setItem("jafo.expanded", JSON.stringify([...state.expandedGroups]));
}

// ---- API ----
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// ---- Share modal ----
// Format → typical destination:
//   square    → IG feed, FB feed
//   story     → IG Story / Reels (vertical)
//   landscape → Twitter/X, FB link card
const sharePrefs = {
  format: localStorage.getItem("jafo.shareFormat") || "square",
  kind: null,
  id: null,
  title: null,
};

function openSharePopover(_anchorEl, kind, id, title) {
  // Kept the function name so existing call sites work.
  sharePrefs.kind = kind;
  sharePrefs.id = id;
  sharePrefs.title = title || "";

  const modal = document.getElementById("share-modal");
  modal.classList.remove("hidden");

  // Reflect persisted format in the toggle UI
  modal.querySelectorAll(".share-fmt").forEach((b) =>
    b.classList.toggle("active", b.dataset.fmt === sharePrefs.format));

  refreshShareModalAssets();
}

function closeShareModal() {
  const modal = document.getElementById("share-modal");
  modal.classList.add("hidden");
  // Pause and unload preview video so it stops downloading in the background
  const v = document.getElementById("share-video");
  try { v.pause(); v.removeAttribute("src"); v.load(); } catch {}
}

function refreshShareModalAssets() {
  const { kind, id, format } = sharePrefs;
  if (!kind || !id) return;

  const cardUrl  = `/api/share/${kind}/${id}/card.png?format=${format}`;
  const videoUrl = `/api/share/${kind}/${id}/video.mp4?format=${format}`;
  const audioUrl = `/api/share/${kind}/${id}/audio.mp3`;

  // Cache-bust on format toggle so the browser doesn't show stale stretched image
  const bust = Date.now();
  document.getElementById("share-image").src = `${cardUrl}&_=${bust}`;
  const v = document.getElementById("share-video");
  v.src = `${videoUrl}&_=${bust}`;
  v.load();

  const dlImg = document.getElementById("share-dl-image");
  const dlVid = document.getElementById("share-dl-video");
  const dlAud = document.getElementById("share-dl-audio");
  dlImg.href = cardUrl;  dlImg.setAttribute("download", `jafo-${kind}-${id}-${format}.png`);
  dlVid.href = videoUrl; dlVid.setAttribute("download", `jafo-${kind}-${id}-${format}.mp4`);
  dlAud.href = audioUrl; dlAud.setAttribute("download", `jafo-${kind}-${id}.mp3`);
}

function bindShareModal() {
  const modal = document.getElementById("share-modal");
  if (!modal) return;

  modal.querySelector(".story-modal-close")?.addEventListener("click", closeShareModal);
  modal.querySelector(".story-modal-backdrop")?.addEventListener("click", closeShareModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeShareModal();
  });

  modal.querySelectorAll(".share-fmt").forEach((b) => {
    b.addEventListener("click", () => {
      sharePrefs.format = b.dataset.fmt;
      localStorage.setItem("jafo.shareFormat", sharePrefs.format);
      modal.querySelectorAll(".share-fmt").forEach((x) =>
        x.classList.toggle("active", x.dataset.fmt === sharePrefs.format));
      refreshShareModalAssets();
    });
  });

  // Native share — passes both image and audio as files
  const nativeBtn = document.getElementById("share-native-btn");
  if (navigator.share && nativeBtn) {
    nativeBtn.style.display = "block";
    nativeBtn.addEventListener("click", async () => {
      const { kind, id, format, title } = sharePrefs;
      try {
        const files = [];
        const imgRes = await fetch(`/api/share/${kind}/${id}/card.png?format=${format}`);
        if (imgRes.ok) {
          const b = await imgRes.blob();
          files.push(new File([b], `jafo-${kind}-${id}-${format}.png`, { type: "image/png" }));
        }
        const audRes = await fetch(`/api/share/${kind}/${id}/audio.mp3`);
        if (audRes.ok) {
          const b = await audRes.blob();
          files.push(new File([b], `jafo-${kind}-${id}.mp3`, { type: "audio/mpeg" }));
        }
        const supportsFiles = navigator.canShare && navigator.canShare({ files });
        if (supportsFiles && files.length) {
          await navigator.share({ files, title: title || "jafo", text: title || "" });
        }
      } catch (e) { /* canceled */ }
    });
  }
}

// Backwards-compat shim used by the story modal close — it called this name.
function closePopovers() { closeShareModal(); }

// ---- Stories strip ----
const storyState = {
  all: [],         // server-returned stories (up to 12)
  page: 0,         // current page index (0..2 for 12 stories / 4 per page)
  rotateTimer: null,
  rotateMs: 10000, // dwell time per page
};

async function refreshStories() {
  try {
    const data = await api("/api/stories");
    storyState.all = data.stories || [];
    if (storyState.page * 4 >= storyState.all.length) storyState.page = 0;
    renderStoriesPage(false);
  } catch (e) {
    console.error("stories refresh failed", e);
  }
}

function pageCount() {
  return Math.max(1, Math.ceil(storyState.all.length / 4));
}

function renderStoriesPage(animate = true) {
  const root = document.getElementById("stories-cards");
  if (!root) return;
  const slice = storyState.all.slice(storyState.page * 4, storyState.page * 4 + 4);

  if (!storyState.all.length) {
    root.innerHTML = `<div class="stories-empty">Stories will appear here once enough enriched calls have been clustered (~5 min after a fresh start).</div>`;
    renderPager();
    return;
  }

  // If animating, fade out current cards first, then swap
  const prev = [...root.children];
  if (animate && prev.length) {
    prev.forEach((el) => el.classList.add("flipping-out"));
    setTimeout(() => paint(), 420);
  } else {
    paint();
  }

  function paint() {
    root.innerHTML = "";
    slice.forEach((s, i) => {
      const card = document.createElement("div");
      const sev = (s.severity || "unknown").toLowerCase();
      card.className = `story-card sev-${sev}` + (animate ? " flipping-in" : "");
      card.style.animationDelay = animate ? `${i * 60}ms` : "";
      card.dataset.id = s.id;
      const ago = fmtAgo(s.last_call_at || s.created_at);
      card.innerHTML = `
        <div class="story-title">${escapeHtml(s.title || "(untitled)")}</div>
        <div class="story-body">${escapeHtml(s.body || "")}</div>
        <div class="story-meta">
          <span><span class="sev-dot"></span>${escapeHtml(s.talkgroup_tag || `tg-${s.talkgroup}`)}</span>
          <span>${ago}</span>
        </div>
      `;
      card.onclick = () => openStoryModal(s.id);
      root.appendChild(card);
    });
    renderPager();
  }
}

function renderPager() {
  const pager = document.getElementById("stories-pager");
  if (!pager) return;
  const n = pageCount();
  if (n <= 1) { pager.innerHTML = ""; return; }
  pager.innerHTML = Array.from({ length: n }, (_, i) =>
    `<span class="dot${i === storyState.page ? " active" : ""}"></span>`
  ).join("");
}

function startStoriesRotation() {
  stopStoriesRotation();
  storyState.rotateTimer = setInterval(() => {
    if (pageCount() <= 1) return;
    storyState.page = (storyState.page + 1) % pageCount();
    renderStoriesPage(true);
  }, storyState.rotateMs);
}
function stopStoriesRotation() {
  if (storyState.rotateTimer) clearInterval(storyState.rotateTimer);
  storyState.rotateTimer = null;
}

async function openStoryModal(id) {
  const modal = document.getElementById("story-modal");
  modal.classList.remove("hidden");
  document.getElementById("story-modal-title").textContent = "Loading…";
  document.getElementById("story-modal-meta").textContent = "";
  document.getElementById("story-modal-body").textContent = "";
  document.getElementById("story-modal-audio").innerHTML = "";

  try {
    const s = await api(`/api/stories/${id}`);
    document.getElementById("story-modal-title").textContent = s.title || "(untitled)";
    const sev = (s.severity || "unknown").toUpperCase();
    const meta = document.getElementById("story-modal-meta");
    meta.innerHTML =
      `${escapeHtml(s.talkgroup_tag || `tg-${s.talkgroup}`)} · severity: ${escapeHtml(sev)} · ${(s.calls || []).length} call${(s.calls || []).length === 1 ? "" : "s"}` +
      ` <button class="share-btn share-btn-inline" title="Share">↗ Share</button>`;
    meta.querySelector(".share-btn").onclick = (e) => {
      e.stopPropagation();
      openSharePopover(e.currentTarget, "story", s.id, s.title || "");
    };
    document.getElementById("story-modal-body").textContent = s.body || "";

    const audioRoot = document.getElementById("story-modal-audio");
    audioRoot.innerHTML = "";
    for (const c of (s.calls || [])) {
      if (!c.audio_available) continue;
      const row = document.createElement("div");
      row.className = "audio-row";
      row.innerHTML = `
        <span class="ts">${fmtTime(c.start_time)}</span>
        <audio controls preload="none">
          <source src="/audio/${escapeHtml(c.opus_path)}" type="audio/ogg; codecs=opus">
        </audio>
      `;
      audioRoot.appendChild(row);
    }
    if (!audioRoot.children.length) {
      audioRoot.innerHTML = '<div style="color:var(--text-faint);font-size:12px">Audio for these calls is no longer on disk (retention).</div>';
    }
  } catch (e) {
    document.getElementById("story-modal-title").textContent = "Failed to load story";
    document.getElementById("story-modal-body").textContent = String(e);
  }
}

function closeStoryModal() {
  const modal = document.getElementById("story-modal");
  modal.classList.add("hidden");
  // Stop any audio playing in the modal
  modal.querySelectorAll("audio").forEach((a) => { try { a.pause(); } catch {} });
}

function bindStoryModal() {
  document.querySelector(".story-modal-close")?.addEventListener("click", closeStoryModal);
  document.querySelector(".story-modal-backdrop")?.addEventListener("click", closeStoryModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("story-modal").classList.contains("hidden")) {
      closeStoryModal();
    }
  });
}

// ---- Live map (Leaflet) ----
const mapState = {
  map: null,
  seenIds: new Set(),
  primed: false,           // skip animation for the first poll (don't pop the backlog)
  heatLayer: null,
  heatVisible: localStorage.getItem("jafo.heatVisible") !== "0", // default ON
  heatTimer: null,
};

async function refreshHeatmap() {
  if (!mapState.map || typeof L.heatLayer !== "function") return;
  try {
    const data = await api("/api/heatmap");
    if (mapState.heatLayer) {
      mapState.map.removeLayer(mapState.heatLayer);
      mapState.heatLayer = null;
    }
    if (data.points && data.points.length) {
      mapState.heatLayer = L.heatLayer(data.points, {
        radius: 28,
        blur: 22,
        maxZoom: 13,
        // Cool-to-hot: blue → green → yellow → orange → red.
        gradient: { 0.0: "#3a8df0", 0.35: "#4cc06b", 0.6: "#e8d23c", 0.8: "#ec8a3c", 1.0: "#ef4848" },
      });
      if (mapState.heatVisible) mapState.heatLayer.addTo(mapState.map);
    }
    updateHeatToggleLabel(data);
  } catch (e) {
    console.error("heatmap refresh failed", e);
  }
}

function toggleHeatmap() {
  mapState.heatVisible = !mapState.heatVisible;
  localStorage.setItem("jafo.heatVisible", mapState.heatVisible ? "1" : "0");
  if (mapState.heatLayer) {
    if (mapState.heatVisible) mapState.heatLayer.addTo(mapState.map);
    else mapState.map.removeLayer(mapState.heatLayer);
  }
  updateHeatToggleLabel();
}

function updateHeatToggleLabel(data) {
  const btn = document.querySelector(".heat-toggle");
  if (!btn) return;
  btn.classList.toggle("active", mapState.heatVisible);
  btn.textContent = mapState.heatVisible ? "🔥 Heatmap on" : "○ Heatmap off";
  if (data) btn.title = `${data.address_hits} address-precise + ${data.city_hits} city-level points`;
}

function addHeatToggleControl() {
  if (!mapState.map) return;
  const Ctl = L.Control.extend({
    options: { position: "topright" },
    onAdd: () => {
      const div = L.DomUtil.create("div", "leaflet-bar heat-toggle-wrap");
      div.innerHTML = `<button class="heat-toggle ${mapState.heatVisible ? "active" : ""}" type="button">🔥 Heatmap on</button>`;
      L.DomEvent.disableClickPropagation(div);
      div.querySelector(".heat-toggle").addEventListener("click", toggleHeatmap);
      return div;
    },
  });
  new Ctl().addTo(mapState.map);
}

async function initMap() {
  if (mapState.map || typeof L === "undefined") return;
  let cfg = { center: [26.2, -98.0], bounds: [[25.8, -98.9], [26.55, -97.1]] };
  try { cfg = await api("/api/map-config"); } catch (e) { console.warn("map-config failed, using defaults", e); }

  mapState.map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: false,
    minZoom: 8,
    maxZoom: 14,
  });
  mapState.map.fitBounds(cfg.bounds);
  mapState.map.setZoom(mapState.map.getZoom() + 2);
  mapState.map.setMaxBounds(L.latLngBounds(cfg.bounds[0], cfg.bounds[1]).pad(0.5));

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(mapState.map);

  addHeatToggleControl();
}

function popMapMarker(call) {
  if (!mapState.map || call.lat == null || call.lng == null) return;
  const icon = serviceIcon(call.talkgroup_tag, call.service_type, call.incident_type, call.icon) || "📡";

  const div = L.divIcon({
    html: `<div class="map-pulse">${icon}</div>`,
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  const m = L.marker([call.lat, call.lng], { icon: div, interactive: true });

  const popupBits = [];
  if (call.talkgroup_tag) popupBits.push(`<strong>${escapeHtml(call.talkgroup_tag)}</strong>`);
  if (call.city) popupBits.push(escapeHtml(call.city));
  if (call.incident_summary) popupBits.push(escapeHtml(call.incident_summary));
  m.bindPopup(popupBits.join("<br>") || `tg-${call.talkgroup}`);
  m.addTo(mapState.map);

  // Self-remove after the CSS animation finishes (5s + small buffer)
  setTimeout(() => mapState.map.removeLayer(m), 5200);
}

// Marker associated with active audio playback. Stays put while audio plays,
// removes itself when paused/ended/seeked-to-end.
function popPlaybackMarker(call) {
  if (!mapState.map || call.lat == null || call.lng == null) return null;
  const icon = serviceIcon(call.talkgroup_tag, call.service_type, call.incident_type, call.icon) || "📡";
  const div = L.divIcon({
    html: `<div class="map-playing">${icon}</div>`,
    className: "",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
  const m = L.marker([call.lat, call.lng], { icon: div, interactive: true });
  const popupBits = [];
  if (call.talkgroup_tag) popupBits.push(`<strong>${escapeHtml(call.talkgroup_tag)}</strong>`);
  if (call.city) popupBits.push(escapeHtml(call.city));
  if (call.incident_summary) popupBits.push(escapeHtml(call.incident_summary));
  m.bindPopup(popupBits.join("<br>") || `tg-${call.talkgroup}`);
  m.addTo(mapState.map);
  mapState.map.panTo([call.lat, call.lng], { animate: true, duration: 0.4 });
  return m;
}

function feedMapFromCalls(calls) {
  // First load: prime seenIds without popping markers (avoid animating backlog)
  if (!mapState.primed) {
    for (const c of calls) mapState.seenIds.add(c.id);
    mapState.primed = true;
    return;
  }
  // Newest first → animate oldest-first so they appear in chronological order
  const fresh = calls.filter((c) => !mapState.seenIds.has(c.id));
  fresh.reverse();
  for (const c of fresh) {
    mapState.seenIds.add(c.id);
    popMapMarker(c);
  }
  // Keep set bounded
  if (mapState.seenIds.size > 2000) {
    const arr = [...mapState.seenIds].slice(-1000);
    mapState.seenIds = new Set(arr);
  }
}

// ---- Time formatting ----
function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function fmtAgo(ts) {
  if (!ts) return "";
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
function fmtDur(s) {
  if (s == null) return "—";
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`;
}

// Map of icon ID → emoji. Kept in sync with ICON_CHOICES on the server.
const ICON_BY_ID = {
  police: "🚔", fire: "🚒", ems: "🚑", school: "🏫",
  utility: "🔧", water: "💧", power: "⚡", transit: "🚌",
  government: "🏛️", dispatch: "📞", traffic: "🚧", hazmat: "☢️",
  rescue: "🛟", air: "🚁", aviation: "✈️", marine: "⚓",
  hospital: "🏥", construction: "🏗️", k9: "🐕", park: "🌲",
  emergency: "⚠️", weather: "🌪️", radio: "📡",
};

// Inline SVG matching the "AI sparkles" icon convention (one big 4-point star
// + two smaller ones). Tinted via currentColor in CSS.
const AI_STAR_SVG = `<svg class="ai-star" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path fill="currentColor" d="M12 3 13.5 9 19.5 10.5 13.5 12 12 18 10.5 12 4.5 10.5 10.5 9z"/>
  <path fill="currentColor" opacity="0.85" d="M19 4 19.6 6.4 22 7 19.6 7.6 19 10 18.4 7.6 16 7 18.4 6.4z"/>
  <path fill="currentColor" opacity="0.7" d="M5 16 5.5 17.6 7 18 5.5 18.4 5 20 4.5 18.4 3 18 4.5 17.6z"/>
</svg>`;

// Render the icon column on a call card. Optionally wrapped in an external link.
function renderSvcCol(call, icon) {
  const inner = icon ? `<span class="svc-emoji">${icon}</span>` : "";
  if (call.link_url) {
    return `<a class="svc-link" href="${escapeHtml(call.link_url)}"
              target="_blank" rel="noopener noreferrer"
              title="${escapeHtml(call.link_url)}">${inner}</a>`;
  }
  return inner;
}

// ---- Service category resolver ----
// Returns a stable category key (e.g., "police", "fire") used both for icon
// rendering and call-card background tinting.
function serviceCategory(talkgroupTag, csvTag, incidentType, iconOverride) {
  if (iconOverride && ICON_BY_ID[iconOverride]) return iconOverride;

  const csv   = (csvTag       || "").toLowerCase();
  const alpha = (talkgroupTag || "").toLowerCase();
  const inc   = (incidentType || "").toLowerCase();

  // CSV Tag field from RadioReference is most authoritative
  if (/law|corrections|police/.test(csv))       return "police";
  if (/fire/.test(csv))                          return "fire";
  if (/ems|medical/.test(csv))                   return "ems";
  if (/school/.test(csv))                        return "school";
  if (/public.?works|utility/.test(csv))         return "utility";
  if (/transit/.test(csv))                       return "transit";
  if (/\bcity\b|\bcounty\b|municipal/.test(csv)) return "government";

  // Alpha tag keyword fallback
  if (/\bpd\b|police|sheriff|constable|marshal|\bdps\b|swat|jail/.test(alpha)) return "police";
  if (/\bfire\b|\bfd\b|haz.?mat/.test(alpha))                                   return "fire";
  if (/\bems\b|medic|ambulance|paramedic|lonestar/.test(alpha))                 return "ems";
  if (/\bisd\b|school|\bhs\b|\bgms\b|elem|campus/.test(alpha))                  return "school";
  if (/utility|utilities|\bmpu\b|public.?works/.test(alpha))                    return "utility";
  if (/\btransit\b|valley.?metro/.test(alpha))                                  return "transit";

  // Claude incident type as last resort
  if (/fire/.test(inc))                          return "fire";
  if (/medical|ems/.test(inc))                   return "ems";
  if (/traffic stop|arrest|pursuit/.test(inc))   return "police";

  return null;
}

// Backwards-compat thin wrapper: emoji from a category
function serviceIcon(talkgroupTag, csvTag, incidentType, iconOverride) {
  const cat = serviceCategory(talkgroupTag, csvTag, incidentType, iconOverride);
  return cat ? (ICON_BY_ID[cat] || null) : null;
}

// ---- Severity normalization ----
function normSeverity(s) {
  s = (s || "unknown").toLowerCase();
  if (["critical", "high", "medium", "low"].includes(s)) return s;
  return "unknown";
}

// ---- Stats bar ----
async function refreshStats() {
  try {
    const s = await api("/api/stats");
    document.getElementById("stat-totals").innerHTML =
      `<strong>${s.totals.kept_total ?? 0}</strong> kept &nbsp;·&nbsp;
       <strong>${s.totals.transcribed ?? 0}</strong> transcribed &nbsp;·&nbsp;
       <strong>${s.totals.enriched ?? 0}</strong> enriched`;
    document.getElementById("stat-24h").innerHTML =
      `24h: <strong>${s.last_24h.kept_24h ?? 0}</strong> kept`;
    const back = (s.backlog.transcribe_pending ?? 0) + (s.backlog.enrich_pending ?? 0);
    document.getElementById("stat-backlog").innerHTML =
      back === 0
        ? `<strong style="color:var(--good)">●</strong> caught up`
        : `backlog: <strong>${back}</strong>`;

    // CPU temp — color steps: <70 dim, 70-80 warn, 80-90 bad, >90 crit
    const tempEl = document.getElementById("stat-temp");
    if (tempEl) {
      const t = s.cpu_temp_c;
      if (t == null) {
        tempEl.textContent = "";
      } else {
        let color = "var(--text-dim)";
        if (t >= 90) color = "var(--crit)";
        else if (t >= 80) color = "var(--bad)";
        else if (t >= 70) color = "var(--warn)";
        tempEl.innerHTML = `cpu: <strong style="color:${color}">${t.toFixed(1)}°C</strong>`;
      }
    }
  } catch (e) {
    console.error("Stats refresh failed:", e);
  }
}

// ---- Talkgroup grouping sidebar ----
async function refreshTalkgroups() {
  try {
    const data = await api(
      `/api/talkgroup-groups?group_by=${encodeURIComponent(state.groupBy)}&sort=${encodeURIComponent(state.sort)}`
    );
    const root = document.getElementById("talkgroup-groups");
    root.innerHTML = "";

    if (!data.groups.length || data.groups.every((g) => !g.talkgroups.length)) {
      root.innerHTML = '<div class="empty-tg">No talkgroup activity yet.</div>';
      return;
    }

    // For "flat" mode: render a single flat list, no group headers.
    if (state.groupBy === "flat") {
      const ul = document.createElement("ul");
      ul.className = "filter-list";
      const tgs = data.groups[0]?.talkgroups || [];
      // Cap to keep the sidebar manageable
      for (const tg of tgs.slice(0, 50)) {
        ul.appendChild(renderTalkgroupItem(tg));
      }
      root.appendChild(ul);
      return;
    }

    // Grouped mode: render expandable sections.
    for (const group of data.groups) {
      if (!group.talkgroups.length) continue;
      const isExpanded = state.expandedGroups.has(group.key);
      const section = document.createElement("div");
      section.className = "tg-group" + (isExpanded ? " expanded" : "");

      const header = document.createElement("button");
      header.className = "tg-group-header";
      const gIcon = serviceIcon(null, group.name, null);
      const gIconPart = gIcon ? `${gIcon} ` : "";
      header.innerHTML = `
        <span class="caret">${isExpanded ? "▾" : "▸"}</span>
        <span class="tg-group-name">${gIconPart}${escapeHtml(group.name)}</span>
        <span class="count">${group.total}</span>
      `;
      header.onclick = () => {
        if (state.expandedGroups.has(group.key)) {
          state.expandedGroups.delete(group.key);
        } else {
          state.expandedGroups.add(group.key);
        }
        persistGroupingPrefs();
        refreshTalkgroups();
      };
      section.appendChild(header);

      // "Filter by this whole group" pseudo-row
      const filterAll = document.createElement("button");
      filterAll.className = "tg-group-filter-all";
      const groupKey = state.groupBy === "service" ? "service_tag" : "category";
      const isActive = state.filters[groupKey] === group.name;
      if (isActive) filterAll.classList.add("active");
      filterAll.textContent = isActive
        ? `× Filtering: ${group.name}`
        : `Filter all ${group.name}`;
      filterAll.onclick = (e) => {
        e.stopPropagation();
        if (state.filters[groupKey] === group.name) {
          state.filters[groupKey] = null;
        } else {
          // Mutually exclusive: clear the other group filter and any single-tg filter
          state.filters.service_tag = null;
          state.filters.category = null;
          state.filters.talkgroup = null;
          state.filters.talkgroup_tag = null;
          state.filters[groupKey] = group.name;
        }
        refreshTalkgroups();
        resetAndLoad();
      };
      // Always show the "filter all" button when group is expanded
      if (isExpanded) section.appendChild(filterAll);

      if (isExpanded) {
        const ul = document.createElement("ul");
        ul.className = "filter-list nested";
        for (const tg of group.talkgroups) {
          ul.appendChild(renderTalkgroupItem(tg));
        }
        section.appendChild(ul);
      }

      root.appendChild(section);
    }
  } catch (e) {
    console.error("Talkgroup refresh failed:", e);
  }
}

function renderTalkgroupItem(tg) {
  const li = document.createElement("li");
  li.dataset.tg = tg.talkgroup;
  li.dataset.tag = tg.talkgroup_tag || "";
  const label = tg.talkgroup_tag || `tg-${tg.talkgroup}`;
  // Show description as a tooltip if available
  const tooltip = tg.description && tg.description !== label ? tg.description : "";
  li.title = tooltip;
  // Encrypted indicator from CSV mode "DE"
  const enc = (tg.mode || "").toUpperCase().includes("E");
  const icon = serviceIcon(tg.talkgroup_tag, tg.tag, null);
  const iconPart = icon ? `${icon} ` : "";
  li.innerHTML = `
    <span>${iconPart}${escapeHtml(label)}${enc ? '<span class="enc-tag" title="Encrypted">🔒</span>' : ""}</span>
    <span class="count">${tg.n}</span>
  `;
  if (state.filters.talkgroup === tg.talkgroup) li.classList.add("active");
  li.onclick = () => {
    if (state.filters.talkgroup === tg.talkgroup) {
      state.filters.talkgroup = null;
      state.filters.talkgroup_tag = null;
    } else {
      // Single-tg filter is mutually exclusive with group-level filters
      state.filters.service_tag = null;
      state.filters.category = null;
      state.filters.talkgroup = tg.talkgroup;
      state.filters.talkgroup_tag = tg.talkgroup_tag;
    }
    refreshTalkgroups();
    resetAndLoad();
  };
  return li;
}

async function refreshIncidentTypes() {
  try {
    const data = await api("/api/incident-types");
    const ul = document.getElementById("incident-type-list");
    ul.innerHTML = "";
    const filtered = data.incident_types.filter(
      (t) => t.incident_type && t.incident_type !== "radio_chatter"
    );
    if (!filtered.length) {
      ul.innerHTML = '<li style="color:var(--text-faint)">No incidents yet</li>';
      return;
    }
    for (const t of filtered.slice(0, 25)) {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(t.incident_type)}</span><span class="count">${t.n}</span>`;
      if (state.filters.incident_type === t.incident_type) li.classList.add("active");
      li.onclick = () => {
        state.filters.incident_type =
          state.filters.incident_type === t.incident_type ? null : t.incident_type;
        refreshIncidentTypes();
        resetAndLoad();
      };
      ul.appendChild(li);
    }
  } catch (e) {
    console.error("Incident type refresh failed:", e);
  }
}

function bindSeverityList() {
  document.querySelectorAll("#severity-list li").forEach((li) => {
    li.onclick = () => {
      const sev = li.dataset.sev;
      state.filters.severity = state.filters.severity === sev ? null : sev;
      document.querySelectorAll("#severity-list li").forEach((x) => x.classList.remove("active"));
      if (state.filters.severity)
        document
          .querySelector(`#severity-list li[data-sev="${state.filters.severity}"]`)
          .classList.add("active");
      resetAndLoad();
    };
  });
}

// ---- Group/sort toggles ----
function bindGroupingToggles() {
  document.querySelectorAll(".seg-toggle [data-group]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.group === state.groupBy);
    btn.onclick = () => {
      if (state.groupBy === btn.dataset.group) return;
      state.groupBy = btn.dataset.group;
      persistGroupingPrefs();
      document.querySelectorAll("[data-group]").forEach((b) =>
        b.classList.toggle("active", b.dataset.group === state.groupBy)
      );
      refreshTalkgroups();
    };
  });
  document.querySelectorAll(".seg-toggle [data-sort]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sort === state.sort);
    btn.onclick = () => {
      if (state.sort === btn.dataset.sort) return;
      state.sort = btn.dataset.sort;
      persistGroupingPrefs();
      document.querySelectorAll("[data-sort]").forEach((b) =>
        b.classList.toggle("active", b.dataset.sort === state.sort)
      );
      refreshTalkgroups();
    };
  });
}

// ---- Active filter chips ----
function renderActiveFilters() {
  const bar = document.getElementById("active-filters");
  bar.innerHTML = "";
  const f = state.filters;
  const chips = [];
  if (f.talkgroup_tag || f.talkgroup) {
    chips.push({ label: f.talkgroup_tag || `tg-${f.talkgroup}`, key: "talkgroup" });
  }
  if (f.service_tag) chips.push({ label: `service: ${f.service_tag}`, key: "service_tag" });
  if (f.category) chips.push({ label: `city: ${f.category}`, key: "category" });
  if (f.incident_type) chips.push({ label: f.incident_type, key: "incident_type" });
  if (f.severity) chips.push({ label: `severity: ${f.severity}`, key: "severity" });
  if (f.search) chips.push({ label: `"${f.search}"`, key: "search" });

  for (const c of chips) {
    const span = document.createElement("span");
    span.className = "active-filter-chip";
    span.textContent = c.label;
    span.onclick = () => {
      if (c.key === "talkgroup") {
        f.talkgroup = null;
        f.talkgroup_tag = null;
      } else if (c.key === "search") {
        f.search = "";
        document.getElementById("search").value = "";
      } else {
        f[c.key] = null;
      }
      refreshTalkgroups();
      refreshIncidentTypes();
      bindSeverityList();
      resetAndLoad();
    };
    bar.appendChild(span);
  }
}

// ---- Calls list ----
function buildCallsURL() {
  const f = state.filters;
  if (f.search) {
    const params = new URLSearchParams({ q: f.search, limit: state.limit });
    return `/api/search?${params}`;
  }
  const p = new URLSearchParams({
    limit: state.limit,
    offset: state.offset,
    only_kept: "1",
  });
  if (f.talkgroup) p.set("talkgroup", f.talkgroup);
  if (f.service_tag) p.set("service_tag", f.service_tag);
  if (f.category) p.set("category", f.category);
  if (f.incident_type) p.set("incident_type", f.incident_type);
  if (f.severity) p.set("severity", f.severity);
  return `/api/calls?${p}`;
}

async function loadCalls(append = false) {
  const loading = document.getElementById("loading");
  loading.classList.remove("hidden");
  try {
    const url = buildCallsURL();
    const data = await api(url);
    const items = data.calls || [];
    if (append) {
      state.calls = state.calls.concat(items);
    } else {
      state.calls = items;
      // Map only animates the unfiltered live feed
      const unfiltered = !state.filters.search
        && !state.filters.talkgroup
        && !state.filters.service_tag
        && !state.filters.category
        && !state.filters.incident_type
        && !state.filters.severity;
      if (unfiltered) feedMapFromCalls(items);
    }
    state.total = data.total ?? items.length;
    renderCalls();
    document
      .getElementById("load-more")
      .classList.toggle("hidden", state.calls.length >= state.total || state.filters.search);
  } catch (e) {
    console.error("Call load failed:", e);
  } finally {
    loading.classList.add("hidden");
  }
}

function resetAndLoad() {
  state.offset = 0;
  state.calls = [];
  renderActiveFilters();
  loadCalls(false);
}

function renderCalls() {
  const root = document.getElementById("results");
  if (!state.calls.length) {
    root.innerHTML = '<div class="empty-state">No calls match the current filters.</div>';
    return;
  }
  root.innerHTML = "";
  for (const c of state.calls) {
    root.appendChild(renderCall(c));
  }
}

function renderCall(c) {
  const div = document.createElement("div");
  div.className = "call";
  div.dataset.id = c.id;

  const sev = normSeverity(c.incident_severity);
  div.style.borderLeft = `3px solid var(--${sevColor(sev)})`;

  const cat = serviceCategory(c.talkgroup_tag, c.service_type, c.incident_type, c.icon);
  if (cat) div.classList.add(`cat-${cat}`);
  const svcIcon = cat ? ICON_BY_ID[cat] : null;

  const headerBits = [];
  if (c.talkgroup_tag) {
    headerBits.push(`<span class="tag">${escapeHtml(c.talkgroup_tag)}</span>`);
  }
  if (c.incident_type && c.incident_type !== "radio_chatter") {
    headerBits.push(`<span class="type">${escapeHtml(c.incident_type)}</span>`);
  }
  if (c.incident_units && c.incident_units.length) {
    headerBits.push(
      `<span class="units">units: ${c.incident_units.map(escapeHtml).join(", ")}</span>`
    );
  }

  const summary = c.incident_summary
    ? `<div class="summary">${escapeHtml(c.incident_summary)}</div>`
    : "";
  const transcript = c.transcript
    ? `<div class="transcript">${highlight(c.transcript, state.filters.search)}</div>`
    : c.audio_available
    ? '<div class="pending">Awaiting transcription…</div>'
    : "";
  const location = c.incident_location
    ? `<div class="location">${escapeHtml(c.incident_location)}</div>`
    : "";

  // Enhance button: visible if we have audio and the transcript isn't already
  // from the premium model. Replaces with "Enhanced ✓" once Groq has run.
  const isEnhanced = (c.transcript_model || "").startsWith("whisper-large-v3-turbo");
  const enhanceBtn = c.audio_available
    ? (isEnhanced
        ? `<span class="enhance-badge" title="Already enhanced via ${escapeHtml(c.transcript_model || "")}">${AI_STAR_SVG}<span>Enhanced</span></span>`
        : `<button class="enhance-btn" title="Re-run this call's audio through Groq Whisper-Large for higher-quality transcription">${AI_STAR_SVG}<span>Enhance Call</span></button>`)
    : "";

  const audioEl = c.audio_available
    ? `<div class="audio-row">
         <audio controls preload="none" class="audio-inline">
           <source src="/audio/${escapeHtml(c.opus_path)}" type="audio/ogg; codecs=opus">
         </audio>
         ${enhanceBtn}
         <button class="share-btn" title="Share">↗</button>
       </div>`
    : `<div class="audio-row">
         <span class="pending">no audio</span>
         <button class="share-btn" title="Share">↗</button>
       </div>`;

  div.innerHTML = `
    <div class="when">
      <div>${fmtTime(c.start_time)}</div>
      <div>${fmtDate(c.start_time)}</div>
      <div class="ago">${fmtAgo(c.start_time)}</div>
    </div>
    <div class="svc-col">${renderSvcCol(c, svcIcon)}</div>
    <div class="body">
      <div class="header-line">${headerBits.join("")}</div>
      ${summary}
      ${transcript}
      ${location}
    </div>
    <div class="meta-right">
      <span class="duration">${fmtDur(c.duration_sec)}</span>
      ${audioEl}
    </div>
  `;

  // When this call's audio plays, drop a marker on the map at the call's
  // location and pan to it. Remove the marker when audio pauses/ends.
  const audioNode = div.querySelector("audio");
  if (audioNode) {
    let marker = null;
    const drop = () => {
      if (marker) return;
      marker = popPlaybackMarker(c);
    };
    const lift = () => {
      if (marker && mapState.map) mapState.map.removeLayer(marker);
      marker = null;
    };
    audioNode.addEventListener("play",  drop);
    audioNode.addEventListener("pause", lift);
    audioNode.addEventListener("ended", lift);
  }

  // Share popover
  const shareBtn = div.querySelector(".share-btn");
  if (shareBtn) {
    shareBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const title = c.incident_summary || c.talkgroup_tag || `Call #${c.id}`;
      openSharePopover(shareBtn, "call", c.id, title);
    });
  }

  // Enhance Call — POST to /api/calls/<id>/enhance, swap transcript on success
  const enhanceBtn = div.querySelector(".enhance-btn");
  if (enhanceBtn) {
    enhanceBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      enhanceBtn.disabled = true;
      enhanceBtn.classList.add("enhancing");
      const labelEl = enhanceBtn.querySelector("span");
      const origLabel = labelEl ? labelEl.textContent : "";
      if (labelEl) labelEl.textContent = "Enhancing…";
      try {
        const r = await fetch(`/api/calls/${c.id}/enhance`, { method: "POST" });
        const payload = await r.json();
        if (!r.ok || payload.error) {
          throw new Error(payload.error || `HTTP ${r.status}`);
        }
        // Swap in the enhanced transcript and replace the button with a badge
        const tEl = div.querySelector(".transcript");
        if (tEl) {
          tEl.classList.add("transcript-enhanced");
          tEl.innerHTML = highlight(payload.transcript, state.filters.search);
        } else if (payload.transcript) {
          // No prior transcript element — insert one now
          const body = div.querySelector(".body");
          const newT = document.createElement("div");
          newT.className = "transcript transcript-enhanced";
          newT.innerHTML = highlight(payload.transcript, state.filters.search);
          body.appendChild(newT);
        }
        const newBadge = document.createElement("span");
        newBadge.className = "enhance-badge";
        newBadge.title = `Enhanced via ${payload.transcript_model}`;
        newBadge.innerHTML = `${AI_STAR_SVG}<span>Enhanced</span>`;
        enhanceBtn.replaceWith(newBadge);
      } catch (err) {
        if (labelEl) labelEl.textContent = origLabel;
        enhanceBtn.disabled = false;
        enhanceBtn.classList.remove("enhancing");
        enhanceBtn.classList.add("enhance-failed");
        enhanceBtn.title = `Enhance failed: ${err.message}`;
        setTimeout(() => enhanceBtn.classList.remove("enhance-failed"), 3000);
        console.error("enhance failed", err);
      }
    });
  }

  return div;
}

function sevColor(sev) {
  return ({
    critical: "crit",
    high: "bad",
    medium: "warn",
    low: "good",
    unknown: "text-faint",
  })[sev] || "text-faint";
}

// ---- Helpers ----
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function highlight(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
  return safe.replace(re, "<mark>$1</mark>");
}

// ---- Search ----
let searchTimer;
function bindSearch() {
  const input = document.getElementById("search");
  input.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = e.target.value.trim();
      resetAndLoad();
    }, 300);
  });
}

// ---- Mobile sidebar drawer ----
function bindMobileMenu() {
  const btn = document.getElementById("menu-btn");
  const backdrop = document.getElementById("sidebar-backdrop");
  const close = () => document.body.classList.remove("sidebar-open");

  btn?.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-open");
  });
  backdrop?.addEventListener("click", close);

  // Close after picking a filter from the sidebar (mobile UX)
  document.querySelector(".sidebar")?.addEventListener("click", (e) => {
    if (window.innerWidth > 760) return;
    // Close on talkgroup / incident / severity / clear-filter clicks
    const t = e.target.closest("li, .clear-btn, .tg-group-filter-all");
    if (t) close();
  });

  // Reset state when resizing back to desktop
  window.addEventListener("resize", () => {
    if (window.innerWidth > 760) close();
  });
}

// ---- Misc bindings ----
function bindClearFilters() {
  document.getElementById("clear-filters").onclick = () => {
    state.filters = {
      talkgroup: null, talkgroup_tag: null,
      service_tag: null, category: null,
      incident_type: null, severity: null, search: "",
    };
    document.getElementById("search").value = "";
    document.querySelectorAll(".filter-list li.active").forEach((li) => li.classList.remove("active"));
    refreshTalkgroups();
    resetAndLoad();
  };
}
function bindLoadMore() {
  document.getElementById("load-more").onclick = () => {
    state.offset += state.limit;
    loadCalls(true);
  };
}
function bindAutoRefresh() {
  const cb = document.getElementById("auto-refresh");
  cb.checked = state.autoRefresh;
  cb.onchange = () => {
    state.autoRefresh = cb.checked;
    if (state.autoRefresh) startPolling();
    else stopPolling();
  };
}

// ---- Polling ----
function startPolling() {
  stopPolling();
  state.pollTimers.stats = setInterval(refreshStats, 10000);
  state.pollTimers.calls = setInterval(() => {
    if (state.offset === 0 && !state.filters.search) {
      // Don't wipe the DOM while audio is playing — that kills the active element.
      const anyPlaying = [...document.querySelectorAll("audio")].some(a => !a.paused);
      if (!anyPlaying) loadCalls(false);
    }
  }, 15000);
  state.pollTimers.sidebar = setInterval(() => {
    refreshTalkgroups();
    refreshIncidentTypes();
  }, 60000);
  // Stories refresh from server every 2 min (server itself recomputes every 5 min)
  state.pollTimers.stories = setInterval(() => {
    const wasOnPage0 = storyState.page === 0;
    refreshStories().then(() => {
      // Don't yank the page out from under the user mid-rotation
      if (wasOnPage0) renderStoriesPage(false);
    });
  }, 120000);
  // Heatmap recomputes every 90s; geocoding cache fills in between passes
  state.pollTimers.heat = setInterval(refreshHeatmap, 90000);
}
function stopPolling() {
  Object.values(state.pollTimers).forEach(clearInterval);
  state.pollTimers = {};
}

// ---- Cloud banner (edge-only — server gates on JAFO_HUB_URL) ----
function maybeShowCloudBanner() {
  const link = window.JAFO_HUB_LINK;
  const banner = document.getElementById("cloud-banner");
  if (!link || !banner) return;
  if (localStorage.getItem("jafo.cloudBannerDismissed") === "1") return;
  banner.classList.remove("hidden");
}

function bindCloudBanner() {
  const banner = document.getElementById("cloud-banner");
  if (!banner) return;
  banner.querySelectorAll('[data-action="dismiss"]').forEach((el) => {
    el.addEventListener("click", () => {
      banner.classList.add("hidden");
      localStorage.setItem("jafo.cloudBannerDismissed", "1");
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !banner.classList.contains("hidden")) {
      banner.classList.add("hidden");
      localStorage.setItem("jafo.cloudBannerDismissed", "1");
    }
  });
}

// ---- Boot ----
async function boot() {
  bindCloudBanner();
  maybeShowCloudBanner();
  bindSearch();
  bindClearFilters();
  bindLoadMore();
  bindAutoRefresh();
  bindSeverityList();
  bindGroupingToggles();
  bindStoryModal();
  bindShareModal();
  bindMobileMenu();
  await initMap();
  await Promise.all([refreshStats(), refreshTalkgroups(), refreshIncidentTypes(), refreshStories(), refreshHeatmap()]);
  await loadCalls(false);
  startPolling();
  startStoriesRotation();
}
boot();
