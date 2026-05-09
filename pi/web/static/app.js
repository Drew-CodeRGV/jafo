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
const STORY_SORT_KEY = "jafo.storySort";
const storyState = {
  raw: [],         // server-returned stories, original order (impact-sorted)
  all: [],         // sorted view used for rendering
  page: 0,         // current page index (0..3 for 16 stories / 4 per page)
  sort: localStorage.getItem(STORY_SORT_KEY) || "impact",  // "impact" | "time"
  rotateTimer: null,
  rotateMs: 20000, // dwell time per page (was 10s — doubled per user request)
};

function applyStorySort() {
  const arr = storyState.raw.slice();
  if (storyState.sort === "time") {
    arr.sort((a, b) =>
      (b.last_call_at || b.created_at || 0) - (a.last_call_at || a.created_at || 0)
    );
  } else {
    // "impact" — server already returns score-sorted, but resort to be safe
    // in case the proxy or future backend changes that.
    arr.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  storyState.all = arr;
}

async function refreshStories() {
  try {
    const data = await api("/api/stories");
    storyState.raw = data.stories || [];
    applyStorySort();
    if (storyState.page * 4 >= storyState.all.length) storyState.page = 0;
    renderStoriesPage(false);
  } catch (e) {
    console.error("stories refresh failed", e);
  }
}

function setStorySort(mode) {
  if (mode !== "impact" && mode !== "time") return;
  if (storyState.sort === mode) return;
  storyState.sort = mode;
  localStorage.setItem(STORY_SORT_KEY, mode);
  document.querySelectorAll("[data-story-sort]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.storySort === mode);
  });
  applyStorySort();
  storyState.page = 0;
  renderStoriesPage(true);
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

// Manual page navigation via arrow buttons next to the pager dots. Same
// behavior as a swipe — wraps around at the ends, resets the rotation
// timer so the user gets the full dwell on the page they jumped to.
function pagePrev() {
  const n = pageCount();
  if (n <= 1) return;
  storyState.page = (storyState.page - 1 + n) % n;
  renderStoriesPage(true);
  startStoriesRotation();
}
function pageNext() {
  const n = pageCount();
  if (n <= 1) return;
  storyState.page = (storyState.page + 1) % n;
  renderStoriesPage(true);
  startStoriesRotation();
}
function attachStoriesArrows() {
  const prev = document.getElementById("stories-prev");
  const next = document.getElementById("stories-next");
  if (prev) prev.addEventListener("click", pagePrev);
  if (next) next.addEventListener("click", pageNext);
}

// Touch/pointer swipe on the stories grid: left = next page, right = prev page.
// Reset the auto-rotate timer on swipe so the user gets the full dwell on
// their chosen page instead of the timer flipping it 1s later.
function attachStoriesSwipe() {
  const root = document.getElementById("stories-cards");
  if (!root) return;
  let startX = 0, startY = 0, tracking = false;
  const SWIPE_MIN_PX = 40;

  root.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  root.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) < SWIPE_MIN_PX) return;        // not enough movement
    if (Math.abs(dy) > Math.abs(dx)) return;        // mostly vertical (page scroll)
    const n = pageCount();
    if (n <= 1) return;
    storyState.page = dx < 0
      ? (storyState.page + 1) % n                   // swipe-left → next
      : (storyState.page - 1 + n) % n;              // swipe-right → prev
    renderStoriesPage(true);
    startStoriesRotation();
  }, { passive: true });
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
      // audio_url (absolute) is set by the edge proxy when stories come from
      // the hub — files live on the hub's filesystem, not this Pi's.
      const src = c.audio_url || `/audio/${escapeHtml(c.opus_path)}`;
      row.innerHTML = `
        <span class="ts">${fmtTime(c.start_time)}</span>
        <audio controls preload="none">
          <source src="${escapeHtml(src)}" type="audio/ogg; codecs=opus">
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
  // Air-traffic + recent-calls overlay layers — all on the single Leaflet
  // map now (the MapLibre 3D pane was removed). Markers indexed for cheap
  // in-place updates between polls.
  aircraftLayer: null,           // L.layerGroup of aircraft markers
  aircraftMarkers: new Map(),    // icao24 → L.marker
  trailLayer:    null,           // L.layerGroup of trail polylines (where they came from)
  trailLines:    new Map(),      // icao24 → L.polyline
  forwardLayer:  null,           // L.layerGroup of projection lines (where they're headed)
  forwardLines:  new Map(),      // icao24 → L.polyline
  airportLayer:  null,           // L.layerGroup of airport markers (persistent)
  airportMarkers: new Map(),     // ICAO → L.marker
  recentCallsLayer:   null,      // L.layerGroup of recent-call ring markers
  recentCallsMarkers: new Map(), // call.id → L.marker
  acPollTimer:    null,
  callsPollTimer: null,
};

// Hardcoded so airports render the moment the 3D map is ready, before any
// /api/aircraft round-trip — and they STAY on screen even if adsb.lol fails
// (which used to wipe airport markers between refreshes). These match the
// RGV_AIRPORTS list in app.py; if you add a region, add it both places.
const RGV_AIRPORTS_JS = [
  { icao: "KMFE", name: "McAllen Intl",       lat: 26.17578, lon: -98.23861 },
  { icao: "KHRL", name: "Valley Intl (HRL)",  lat: 26.22844, lon: -97.65436 },
  { icao: "KBRO", name: "Brownsville/SPI",    lat: 25.90681, lon: -97.42589 },
  { icao: "KEDB", name: "Edinburg Intl",      lat: 26.44167, lon: -98.12083 },
  { icao: "KRWV", name: "Caldwell (Mid-Vly)", lat: 26.17556, lon: -97.97306 },
];

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
  initAirTrafficLayers();
}

// ---- Air traffic + recent calls — overlaid on the main 2D Leaflet map ----
//
// The 3D MapLibre pane was removed (it was CPU-heavy, broken on touch, and
// less impactful than just showing aircraft on the bigger street map).
// We render aircraft as kind-colored arrow icons rotated by track angle,
// per-aircraft trail polylines, airport reference markers, and a
// recent-calls ring overlay — all as Leaflet layer groups so the user
// can toggle each independently if we add controls later.
function initAirTrafficLayers() {
  if (!mapState.map) return;
  mapState.airportLayer      = L.layerGroup().addTo(mapState.map);
  mapState.trailLayer        = L.layerGroup().addTo(mapState.map);
  mapState.forwardLayer      = L.layerGroup().addTo(mapState.map);
  mapState.recentCallsLayer  = L.layerGroup().addTo(mapState.map);
  mapState.aircraftLayer     = L.layerGroup().addTo(mapState.map);  // last so it's on top
  // Seed RGV airports — they don't move, so just place once.
  for (const ap of RGV_AIRPORTS_JS) {
    const m = L.marker([ap.lat, ap.lon], {
      icon: L.divIcon({
        html: `<div class="airport-marker">${_airportSvg()}<div class="airport-label">${ap.icao}</div></div>`,
        className: "", iconSize: [28, 32], iconAnchor: [14, 28],
      }),
      keyboard: false,
    });
    m.bindTooltip(ap.name);
    m.addTo(mapState.airportLayer);
    mapState.airportMarkers.set(ap.icao, m);
  }
  addAirTrafficStatusControl();
  refreshAircraft();
  refreshRecentCalls();
  mapState.acPollTimer    = setInterval(refreshAircraft,    20_000);
  mapState.callsPollTimer = setInterval(refreshRecentCalls, 30_000);
}

// Small status block in the bottom-left of the map: aircraft count + the
// LOCAL/CLOUD source indicator. Replaces the old #map-3d-overlay header.
function addAirTrafficStatusControl() {
  if (!mapState.map) return;
  const Ctl = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd: () => {
      const div = L.DomUtil.create("div", "ac-status-wrap");
      div.innerHTML = `<span class="ac-status-label">Air Traffic</span>
                       <span id="aircraft-count" class="ac-status-count">—</span>
                       <span id="aircraft-source" class="ac-source" title="Data source">…</span>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  new Ctl().addTo(mapState.map);
}


function _altColor(ft) {
  if (ft > 30000) return "#ec4848";
  if (ft > 15000) return "#ec8a3c";
  if (ft >  5000) return "#e8d23c";
  return "#4cc06b";
}

// Color per aircraft kind — matches what most flight-tracking sites do
// (commercial = warm yellow, military = red, helicopter = green, etc.) so
// the type is readable at a glance without needing the popup.
function _kindColor(kind, emergency) {
  if (emergency) return "#ff2a2a";
  switch (kind) {
    case "military":   return "#ff5b3a";
    case "helicopter": return "#7af07a";
    case "heavy":      return "#ff9b3a";
    case "commercial": return "#ffe87a";
    case "jet":        return "#9be8ff";
    case "uav":        return "#b48cff";
    case "glider":     return "#e8e8e8";
    case "balloon":    return "#ffa8d8";
    case "light":
    default:           return "#5fb7e8";
  }
}

// Aircraft icon SVG. All shapes are authored in a 28×28 grid pointing straight
// up (nose at top, fuselage centered on x=14). The wrapping <g> rotates them
// to match each plane's screen-space track angle (computed at draw-time so
// pitch/bearing are accounted for). Cleaner silhouettes — fewer points,
// pronounced nose, clearly readable wings/tail per kind.
function _aircraftIconShape(kind, fill, stroke) {
  const sw = 0.7;
  switch (kind) {
    case "helicopter":
      // Top-down rotor disk + body + tail boom.
      return `<g>
        <ellipse cx="14" cy="13" rx="12" ry="2.2" fill="${fill}" opacity="0.35" stroke="${stroke}" stroke-width="0.5"/>
        <ellipse cx="14" cy="11.5" rx="3.6" ry="4.5" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
        <rect x="13.3" y="15.5" width="1.4" height="6.5" fill="${fill}" stroke="${stroke}" stroke-width="0.5"/>
        <path d="M11 22.4 L17 22.4 L17 23.4 L11 23.4 Z" fill="${fill}" stroke="${stroke}" stroke-width="0.4"/>
      </g>`;
    case "uav":
      // Dart shape with antenna on top — clearly small and pointy.
      return `<g>
        <path d="M14 3 L19 14 L14 21 L9 14 Z" fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"/>
        <line x1="14" y1="3" x2="14" y2="0.5" stroke="${fill}" stroke-width="1.4" stroke-linecap="round"/>
      </g>`;
    case "glider":
      // Long thin wings, slender fuselage.
      return `<g>
        <path d="M14 3 L14.8 21 L14 18.5 L13.2 21 Z" fill="${fill}" stroke="${stroke}" stroke-width="0.55"/>
        <path d="M0.5 12.4 L27.5 12.4 L27.5 13.6 L14.8 13.6 L14.8 18 L13.2 18 L13.2 13.6 L0.5 13.6 Z"
              fill="${fill}" stroke="${stroke}" stroke-width="0.5" stroke-linejoin="round"/>
      </g>`;
    case "balloon":
      // Hot-air balloon envelope + basket.
      return `<g>
        <path d="M14 1 C20 1 21 9 19.5 13 L8.5 13 C7 9 8 1 14 1 Z"
              fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>
        <line x1="9.5" y1="13" x2="11.5" y2="18" stroke="${stroke}" stroke-width="0.5"/>
        <line x1="18.5" y1="13" x2="16.5" y2="18" stroke="${stroke}" stroke-width="0.5"/>
        <rect x="11" y="18" width="6" height="3.5" rx="0.5" fill="${fill}" stroke="${stroke}" stroke-width="0.5"/>
      </g>`;
    case "military":
      // Sharp delta — pointy nose, swept wings, twin tail fins.
      return `<g>
        <path d="M14 1.5
                 L15.4 13.5
                 L24 18.5 L24 19.6 L15.6 17.5
                 L15.6 21 L17 22.2 L17.4 23.6 L14 22.5
                 L10.6 23.6 L11 22.2 L12.4 21
                 L12.4 17.5 L4 19.6 L4 18.5 L12.6 13.5 Z"
              fill="${fill}" stroke="${stroke}" stroke-width="0.8" stroke-linejoin="round"/>
      </g>`;
    case "heavy":
      // Big jet — broad wings start higher, longer fuselage, distinct horizontal stab.
      return `<g>
        <path d="M14 1
                 L15.5 10
                 L26 14 L26 15.4 L15.5 14
                 L15.5 18.5 L18 20 L18 21 L14 20
                 L10 21 L10 20 L12.5 18.5
                 L12.5 14 L2 15.4 L2 14 L12.5 10 Z"
              fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
      </g>`;
    case "commercial":
      // Standard airliner — symmetric, cleaner geometry than before.
      return `<g>
        <path d="M14 2
                 L15.3 10.5
                 L23.5 13.4 L23.5 14.6 L15.3 13.6
                 L15.3 18 L17.4 19.4 L17.4 20.4 L14 19.6
                 L10.6 20.4 L10.6 19.4 L12.7 18
                 L12.7 13.6 L4.5 14.6 L4.5 13.4 L12.7 10.5 Z"
              fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
      </g>`;
    case "jet":
      // Bizjet / regional — narrower wings.
      return `<g>
        <path d="M14 2.5
                 L15 10.5
                 L21.5 13 L21.5 14 L15 13.5
                 L15 17.5 L16.7 18.7 L16.7 19.6 L14 19
                 L11.3 19.6 L11.3 18.7 L13 17.5
                 L13 13.5 L6.5 14 L6.5 13 L13 10.5 Z"
              fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
      </g>`;
    case "light":
    default:
      // GA / private — small high-wing silhouette, prominent prop nub.
      return `<g>
        <circle cx="14" cy="3.4" r="1.1" fill="${fill}" stroke="${stroke}" stroke-width="0.4"/>
        <path d="M14 4.2
                 L15 11
                 L19.5 13 L19.5 13.9 L15 13.4
                 L15 17.2 L16.4 18.4 L16.4 19.1 L14 18.6
                 L11.6 19.1 L11.6 18.4 L13 17.2
                 L13 13.4 L8.5 13.9 L8.5 13 L13 11 Z"
              fill="${fill}" stroke="${stroke}" stroke-width="0.65" stroke-linejoin="round"/>
      </g>`;
  }
}

// Builds the entire marker SVG: icon at top (sky), dashed line down to a
// small shadow dot at the bottom (ground). Marker anchor is "bottom", so
// the bottom of this SVG lines up with the aircraft's actual lat/lon and
// the icon floats `altPx` pixels above it. Only the icon glyph rotates
// to flight track — the connector and shadow stay vertical/horizontal.
// 2D Leaflet aircraft icon — kind-colored shape rotated by compass track.
// 38px (was 30) for visibility on OSM tiles. Background-disc behind the
// shape gives high contrast against any tile color.
function _aircraftSvg(kind, trackDeg, emergency) {
  const fill = _kindColor(kind, emergency);
  const stroke = "rgba(0,0,0,0.95)";
  const ICON = 38;
  const NATIVE = 28;
  const SCALE = ICON / NATIVE;
  const cx = ICON / 2;
  const rot = (trackDeg != null && Number.isFinite(trackDeg)) ? trackDeg : 0;
  // Disc backplate punches through busy map tiles. Disc fades out at the
  // edges so the icon doesn't look like it has a hard ring around it.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 ${ICON} ${ICON}">
    <defs>
      <radialGradient id="ac-bg-${kind}" cx="50%" cy="50%" r="55%">
        <stop offset="0%"   stop-color="rgba(0,0,0,0.55)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cx}" r="${cx-1}" fill="url(#ac-bg-${kind})"/>
    <g transform="rotate(${rot.toFixed(1)} ${cx} ${cx}) scale(${SCALE})">
      ${_aircraftIconShape(kind, fill, stroke)}
    </g>
  </svg>`;
}

// Project a point N minutes ahead given current position + track + speed.
// Uses flat-earth approximation — fine for the 5–10 nm vector we draw at
// typical RGV ground speeds. Returns null when track or speed is unknown.
function _projectForward(lat, lon, trackDeg, speedKt, minutesAhead) {
  if (lat == null || lon == null) return null;
  if (trackDeg == null || !Number.isFinite(trackDeg)) return null;
  if (speedKt == null || speedKt <= 0) return null;
  const distNm = speedKt * (minutesAhead / 60);
  if (distNm < 0.1) return null;
  const rad = trackDeg * Math.PI / 180;
  const dLat = (distNm * Math.cos(rad)) / 60.0;
  const dLon = (distNm * Math.sin(rad)) /
               (60.0 * Math.cos(lat * Math.PI / 180));
  return [lat + dLat, lon + dLon];
}

function _airportSvg() {
  // Bright triangle on a dark plate — reads on imagery + against the sky.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="10" fill="rgba(0,18,30,0.85)" stroke="rgba(255,232,122,0.8)" stroke-width="1"/>
    <polygon points="11,4 18,17 11,14 4,17" fill="#ffe87a" stroke="rgba(0,0,0,0.85)" stroke-width="0.6"/>
  </svg>`;
}

// Recent-call popup HTML — used by the Leaflet ring markers.
function _recentCallPopupHtml(c) {
  const sumTxt  = c.incident_summary ? `<div class="ac-pop-summary">${escapeHtml(c.incident_summary)}</div>` : "";
  const typeTxt = c.incident_type && c.incident_type !== "radio_chatter"
    ? `<div class="ac-pop-row"><span class="ac-pop-key">Type</span><span>${escapeHtml(c.incident_type)}</span></div>` : "";
  const sevTxt  = c.incident_severity && c.incident_severity !== "unknown"
    ? `<div class="ac-pop-row"><span class="ac-pop-key">Severity</span><span class="sev sev-${c.incident_severity}">${c.incident_severity}</span></div>` : "";
  const locTxt  = c.incident_location
    ? `<div class="ac-pop-row"><span class="ac-pop-key">Location</span><span>${escapeHtml(c.incident_location)}${c.precise ? "" : " <em>(approx.)</em>"}</span></div>` : "";
  return `<div class="ac-pop">
    <div class="ac-pop-head">
      <strong>${escapeHtml(c.talkgroup_tag || ("tg-" + c.talkgroup))}</strong>
      <span class="ac-pop-time">${fmtTime(c.start_time)}</span>
    </div>
    ${typeTxt}${sevTxt}${locTxt}${sumTxt}
    <div class="ac-pop-actions">
      <a href="#" data-call-id="${c.id}" class="ac-pop-link">Open in timeline ↓</a>
    </div>
  </div>`;
}

// SVG for a recent-call ring marker. Color = service kind (fire/law/ems).
function _callKindColor(kind) {
  return ({ fire: "#ef4848", law: "#3a8df0", ems: "#4cc06b" })[kind] || "#cccccc";
}

// ----------------------------------------------------------------------
// Aircraft — pulled every 20s from /api/aircraft. Each plane gets a
// kind-colored arrow rotated by track + a faint trail polyline behind it.
// Updates the LOCAL/CLOUD source indicator + visible-count stat.
// ----------------------------------------------------------------------
async function refreshAircraft() {
  if (!mapState.map || !mapState.aircraftLayer) return;
  let payload;
  try {
    const url = "/api/aircraft" + (window.JAFO_REGION_SLUG
      ? "?region=" + encodeURIComponent(window.JAFO_REGION_SLUG)
      : "?region=rgv");
    payload = await fetch(url).then((r) => r.json());
  } catch (e) {
    console.warn("aircraft fetch failed", e);
    return;
  }
  const list = payload.aircraft || [];
  const seen = new Set();

  for (const a of list) {
    if (a.lat == null || a.lon == null) continue;
    seen.add(a.icao24);

    const color = _kindColor(a.kind, a.emergency);

    // Trail (where they came from) — beefier than before so it actually
    // reads on the OSM background. Same kind color as the icon, slightly
    // dimmed for cloud-only aircraft so verified trails dominate.
    const trail = (a.trail || []).map(([lon, lat]) => [lat, lon]);
    let line = mapState.trailLines.get(a.icao24);
    const trailOpacity = (a.source === "cloud") ? 0.45 : 0.85;
    if (trail.length >= 2) {
      if (!line) {
        line = L.polyline(trail, {
          color, weight: 3, opacity: trailOpacity, lineCap: "round", lineJoin: "round",
        }).addTo(mapState.trailLayer);
        mapState.trailLines.set(a.icao24, line);
      } else {
        line.setLatLngs(trail);
        line.setStyle({ color, opacity: trailOpacity });
      }
    } else if (line) {
      line.remove();
      mapState.trailLines.delete(a.icao24);
    }

    // Forward projection (where they're headed) — if an airport event is
    // attached (DEP/ARR detection), aim straight at that airport. Otherwise
    // extrapolate ~6 minutes ahead based on track + ground speed. Dashed,
    // same color as the trail, so it reads as "future intent" not "past
    // path".
    let forward = null;
    const ev = a.airport_event;
    if (ev && ev.icao) {
      const ap = RGV_AIRPORTS_JS.find((x) => x.icao === ev.icao);
      if (ap) forward = [ap.lat, ap.lon];
    }
    if (!forward) {
      forward = _projectForward(a.lat, a.lon, a.track_deg, a.velocity_kt, 6);
    }
    let fline = mapState.forwardLines.get(a.icao24);
    if (forward) {
      const fwdLatLngs = [[a.lat, a.lon], forward];
      if (!fline) {
        fline = L.polyline(fwdLatLngs, {
          color, weight: 2.5, opacity: 0.7,
          dashArray: "6, 6", lineCap: "round",
        }).addTo(mapState.forwardLayer);
        mapState.forwardLines.set(a.icao24, fline);
      } else {
        fline.setLatLngs(fwdLatLngs);
        fline.setStyle({ color });
      }
    } else if (fline) {
      fline.remove();
      mapState.forwardLines.delete(a.icao24);
    }

    // Aircraft marker. Bumped from 30→38 px for visibility on the OSM map,
    // and the per-source class drives styling (verified planes pop with
    // a glow, cloud-only planes still readable but slightly dimmer).
    const html = _aircraftSvg(a.kind, a.track_deg, a.emergency);
    const srcCls = `ac-src-${a.source || "cloud"}`;
    const icon = L.divIcon({
      html,
      className: `ac-leaflet ${srcCls}` + (a.emergency ? " ac-emergency" : ""),
      iconSize: [38, 38], iconAnchor: [19, 19],
    });
    let m = mapState.aircraftMarkers.get(a.icao24);
    if (!m) {
      m = L.marker([a.lat, a.lon], { icon, keyboard: false });
      m.bindPopup(_aircraftPopupHtml(a), { offset: [0, -10], maxWidth: 280 });
      m.addTo(mapState.aircraftLayer);
      mapState.aircraftMarkers.set(a.icao24, m);
    } else {
      m.setLatLng([a.lat, a.lon]);
      m.setIcon(icon);
      m.setPopupContent(_aircraftPopupHtml(a));
    }
  }

  // Drop aircraft + trails + forward lines not in this payload
  for (const [icao, m] of mapState.aircraftMarkers) {
    if (!seen.has(icao)) { m.remove(); mapState.aircraftMarkers.delete(icao); }
  }
  for (const [icao, line] of mapState.trailLines) {
    if (!seen.has(icao)) { line.remove(); mapState.trailLines.delete(icao); }
  }
  for (const [icao, line] of mapState.forwardLines) {
    if (!seen.has(icao)) { line.remove(); mapState.forwardLines.delete(icao); }
  }

  // Status block in the bottom-left corner
  const counter = document.getElementById("aircraft-count");
  if (counter) counter.textContent = list.length;
  // Three-state source indicator: BOTH (merged), LOCAL only, CLOUD only.
  const badge = document.getElementById("aircraft-source");
  if (badge) {
    const src = payload.data_source || "";
    let label, cls, title;
    if (src === "merged") {
      const v = list.filter((a) => a.source === "verified").length;
      const c = list.filter((a) => a.source === "cloud").length;
      label = "BOTH";
      cls = "merged";
      title = `Merged feed: ${v} verified by local antenna, ${c} cloud-only (still shown for full coverage)`;
    } else if (src === "readsb-local") {
      label = "LOCAL";
      cls = "local";
      title = "Local readsb only — adsb.lol cloud unreachable this poll";
    } else {
      label = "CLOUD";
      cls = "cloud";
      title = "Cloud (adsb.lol) only — local readsb offline or no fix yet";
    }
    badge.textContent = label;
    badge.classList.remove("local", "cloud", "merged");
    badge.classList.add(cls);
    badge.title = title;
  }

  renderAirStrip(list);
  renderAircraftTypes(list);
}

// ----------------------------------------------------------------------
// Air-strip: horizontal list of currently-visible aircraft (between the
// map and the stories strip). Each card shows callsign / type / altitude
// + an airline logo for commercial flights, click pans the map to the
// aircraft and opens its popup.
// ----------------------------------------------------------------------
function renderAirStrip(list) {
  const wrap  = document.getElementById("air-strip-cards");
  const count = document.getElementById("air-strip-count");
  const empty = document.querySelector(".air-strip-empty");
  if (!wrap || !count) return;

  // Sort: emergency first, then military, then helicopters/UAVs (interesting),
  // then commercial/heavy/jet, then light/glider/balloon. Within each tier,
  // by callsign alpha so the order is stable across polls.
  const sortKey = (a) => {
    if (a.emergency) return 0;
    if (a.kind === "military")             return 1;
    if (a.kind === "helicopter" || a.kind === "uav") return 2;
    if (a.kind === "heavy" || a.kind === "commercial" || a.kind === "jet") return 3;
    return 4;
  };
  const sorted = [...list].sort((a, b) => {
    const k = sortKey(a) - sortKey(b);
    if (k !== 0) return k;
    return (a.callsign || a.icao24 || "").localeCompare(b.callsign || b.icao24 || "");
  });

  count.textContent = list.length ? `· ${list.length}` : "";
  if (empty) empty.style.display = list.length ? "none" : "";

  wrap.innerHTML = sorted.map((a) => {
    const cs       = (a.callsign || a.icao24 || "—").trim();
    const kindCls  = a.kind || "light";
    const kindLbl  = ({
      light: "Light/GA", commercial: "Comm", heavy: "Heavy", jet: "Jet",
      military: "MIL", helicopter: "Heli", uav: "UAV",
      glider: "Glider", balloon: "Balloon",
    })[a.kind] || "Aircraft";
    const altTxt   = a.altitude_ft != null
      ? `${(a.altitude_ft >= 1000) ? (a.altitude_ft / 1000).toFixed(1) + "k" : a.altitude_ft} ft`
      : "—";
    const ktTxt    = a.velocity_kt != null ? `${a.velocity_kt} kt` : "";
    const isAirline = ["commercial", "heavy", "jet"].includes(a.kind);
    const logoHtml  = (isAirline && a.airline_iata)
      ? `<img class="ac-card-logo"
              src="https://images.kiwi.com/airlines/64/${a.airline_iata}.png"
              alt="${escapeHtml(a.airline_icao || a.airline_iata)}"
              loading="lazy" onerror="this.style.display='none'"/>`
      : "";
    const emergCls = a.emergency ? " ac-card-emerg" : "";
    const evTxt = a.airport_event
      ? `<span class="ac-card-event ${a.airport_event.type.toLowerCase()}">${a.airport_event.type} ${a.airport_event.icao}</span>`
      : "";
    return `<button class="ac-card kind-${kindCls}${emergCls}" data-icao="${a.icao24 || ""}"
                    data-lat="${a.lat ?? ""}" data-lon="${a.lon ?? ""}"
                    title="Click to focus on map">
      ${logoHtml}
      <div class="ac-card-body">
        <div class="ac-card-head">
          <span class="ac-card-cs">${escapeHtml(cs)}</span>
          <span class="ac-card-kind">${kindLbl}</span>
        </div>
        <div class="ac-card-meta">
          <span class="ac-card-alt">${altTxt}</span>
          ${ktTxt ? `<span class="ac-card-kt">${ktTxt}</span>` : ""}
          ${evTxt}
        </div>
      </div>
    </button>`;
  }).join("");

  // Click → focus aircraft on map
  for (const btn of wrap.querySelectorAll(".ac-card")) {
    btn.addEventListener("click", () => {
      const icao = btn.dataset.icao;
      const lat  = parseFloat(btn.dataset.lat);
      const lon  = parseFloat(btn.dataset.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon) && mapState.map) {
        mapState.map.setView([lat, lon], 11, { animate: true });
        const m = mapState.aircraftMarkers.get(icao);
        if (m && m.openPopup) m.openPopup();
      }
    });
  }
}

// ----------------------------------------------------------------------
// Sidebar "Aircraft seen" panel — a compact rollup by kind with the
// most-interesting tier (emergency / military) at the top, color-coded.
// ----------------------------------------------------------------------
function renderAircraftTypes(list) {
  const ul     = document.getElementById("ac-types-list");
  const total  = document.getElementById("ac-types-count");
  if (!ul || !total) return;

  total.textContent = list.length;
  if (!list.length) {
    ul.innerHTML = '<li class="ac-types-empty">no aircraft</li>';
    return;
  }

  // Bucket: emergency stays its own bucket, then per-kind counts.
  const bucket = new Map();
  let emerg = 0;
  for (const a of list) {
    if (a.emergency) { emerg++; continue; }
    const k = a.kind || "light";
    bucket.set(k, (bucket.get(k) || 0) + 1);
  }

  const KIND_ORDER = [
    ["military",  "Military",   true],
    ["helicopter","Helicopter", true],
    ["uav",       "UAV/Drone",  true],
    ["heavy",     "Heavy",      false],
    ["commercial","Commercial", false],
    ["jet",       "Jet",        false],
    ["light",     "Light/GA",   false],
    ["glider",    "Glider",     false],
    ["balloon",   "Balloon",    false],
  ];
  const rows = [];
  if (emerg > 0) {
    rows.push({ key: "emergency", label: "EMERGENCY", n: emerg, anomaly: true });
  }
  for (const [k, lbl, anomaly] of KIND_ORDER) {
    const n = bucket.get(k) || 0;
    if (n > 0) rows.push({ key: k, label: lbl, n, anomaly });
  }

  ul.innerHTML = rows.map((r) => `
    <li class="ac-type-row${r.anomaly ? " anomaly" : ""} kind-${r.key}">
      <span class="ac-type-dot" aria-hidden="true"></span>
      <span class="ac-type-label">${escapeHtml(r.label)}</span>
      <span class="ac-type-count">${r.n}</span>
    </li>`).join("");
}

// Aircraft popup card — same fields as before, just rendered inside
// Leaflet's L.popup instead of a MapLibre popup.
function _aircraftPopupHtml(a) {
  const cs    = (a.callsign || a.icao24 || "").trim();
  const reg   = a.registration ? ` · ${escapeHtml(a.registration)}` : "";
  const tcode = a.type_code ? ` ${escapeHtml(a.type_code)}` : "";
  const altTxt = a.altitude_ft ? `${a.altitude_ft.toLocaleString()} ft` : "ground";
  const ktTxt  = a.velocity_kt ? `${a.velocity_kt} kt` : "—";
  const trkTxt = a.track_deg != null ? `${Math.round(a.track_deg)}°` : "—";
  const vrTxt  = a.vertical_rate_fpm
    ? `${a.vertical_rate_fpm > 0 ? "↑" : "↓"} ${Math.abs(a.vertical_rate_fpm).toLocaleString()} fpm`
    : "level";
  const kindLbl = ({
    light: "Light/GA", commercial: "Commercial", heavy: "Heavy", jet: "Jet",
    military: "MILITARY", helicopter: "Helicopter", uav: "UAV",
    glider: "Glider", balloon: "Balloon",
  })[a.kind] || "Aircraft";
  const evTxt = a.airport_event
    ? `<div class="ac-pop-event ${a.airport_event.type.toLowerCase()}">
         <strong>${a.airport_event.type}</strong> ${a.airport_event.icao} · ${a.airport_event.distance_nm} nm
       </div>` : "";
  const emergTxt = a.emergency
    ? `<div class="ac-pop-event arr" style="background:#ff2a2a;color:#fff">⚠ EMERGENCY · squawk ${a.squawk}</div>` : "";
  const isAirlineKind = ["commercial", "heavy", "jet"].includes(a.kind);
  const logoHtml = (isAirlineKind && a.airline_iata)
    ? `<div class="ac-pop-logo-wrap">
         <img class="ac-pop-logo"
              src="https://images.kiwi.com/airlines/128/${a.airline_iata}.png"
              alt="${escapeHtml(a.airline_icao || a.airline_iata)}" loading="lazy"
              onerror="this.parentElement.style.display='none'"/>
       </div>` : "";
  const srcLabel = ({
    verified: "✓ Local + Cloud",
    local:    "📡 Local only",
    cloud:    "☁ Cloud only",
  })[a.source || "cloud"] || "—";
  const srcCls = `ac-src-${a.source || "cloud"}`;

  return `<div class="ac-pop">
    <div class="ac-pop-head">
      <strong>${escapeHtml(cs || "—")}</strong>
      <span class="ac-pop-time">${escapeHtml(kindLbl)}</span>
    </div>
    ${logoHtml}
    <div class="ac-pop-row"><span class="ac-pop-key">Type</span><span>${escapeHtml(a.description || "")}${tcode}${reg}</span></div>
    <div class="ac-pop-row"><span class="ac-pop-key">Altitude</span><span>${altTxt}</span></div>
    <div class="ac-pop-row"><span class="ac-pop-key">Speed/Track</span><span>${ktTxt} · ${trkTxt}</span></div>
    <div class="ac-pop-row"><span class="ac-pop-key">VR</span><span>${vrTxt}</span></div>
    <div class="ac-pop-row"><span class="ac-pop-key">Source</span><span class="${srcCls}">${srcLabel}</span></div>
    ${evTxt}${emergTxt}
  </div>`;
}

// ----------------------------------------------------------------------
// Recent-calls overlay — every call from the last 15 min as a kind-colored
// ring on the map. Refreshed every 30s; older calls fade out.
// ----------------------------------------------------------------------
async function refreshRecentCalls() {
  if (!mapState.map || !mapState.recentCallsLayer) return;
  let payload;
  try {
    payload = await fetch("/api/recent-calls-geo?minutes=15").then((r) => r.json());
  } catch (e) {
    console.warn("recent-calls fetch failed", e);
    return;
  }
  const calls = payload.calls || [];
  const now   = payload.now || (Date.now() / 1000);
  const seen  = new Set();

  for (const c of calls) {
    if (c.lat == null || c.lng == null) continue;
    seen.add(c.id);

    const ageMin  = Math.max(0, (now - c.start_time) / 60);
    const opacity = Math.max(0.25, 1 - ageMin / 16);
    const color   = _callKindColor(c.kind);

    // Per-id jitter so stacked-at-centroid calls fan out a little (~13m at 26°N)
    const jLat = (((c.id * 97) % 100) - 50) * 0.00012;
    const jLng = (((c.id * 31) % 100) - 50) * 0.00012;

    let m = mapState.recentCallsMarkers.get(c.id);
    if (!m) {
      m = L.circleMarker([c.lat + jLat, c.lng + jLng], {
        radius: 6, color, fillColor: color, fillOpacity: 0.7 * opacity,
        weight: 2, opacity, className: `recent-call-marker kind-${c.kind || "other"}`,
      });
      m.bindPopup(_recentCallPopupHtml(c), { offset: [0, -6] });
      m.on("popupopen", () => {
        const a = m.getPopup().getElement().querySelector(".ac-pop-link");
        if (a) a.addEventListener("click", (ev) => {
          ev.preventDefault();
          const row = document.querySelector(`.call[data-id="${c.id}"]`);
          if (row) {
            row.scrollIntoView({ behavior: "smooth", block: "center" });
            row.classList.add("flash");
            setTimeout(() => row.classList.remove("flash"), 1800);
          }
        });
      });
      m.addTo(mapState.recentCallsLayer);
      mapState.recentCallsMarkers.set(c.id, m);
    } else {
      m.setStyle({ opacity, fillOpacity: 0.7 * opacity });
    }
  }

  for (const [id, m] of mapState.recentCallsMarkers) {
    if (!seen.has(id)) { m.remove(); mapState.recentCallsMarkers.delete(id); }
  }
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

  // Stories sort toggle (Impact / Recent)
  document.querySelectorAll("[data-story-sort]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.storySort === storyState.sort);
    btn.onclick = () => setStorySort(btn.dataset.storySort);
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

  // Enhance button: hub-only. On the edge (jafo.local) the user always sees
  // the local faster-whisper transcript with no premium upsell — keeps the
  // edge $0/month for the user. On the hub we show the button (or the
  // "Enhanced" badge once Groq has been run).
  const isEnhanced = (c.transcript_model || "").startsWith("whisper-large-v3-turbo");
  const enhanceBtn = (window.JAFO_IS_HUB && c.audio_available)
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

  // Enhance Call — POST to /api/calls/<id>/enhance, swap transcript on success.
  // (renamed to enhanceBtnEl to avoid shadowing the enhanceBtn HTML string above)
  const enhanceBtnEl = div.querySelector(".enhance-btn");
  if (enhanceBtnEl) {
    enhanceBtnEl.addEventListener("click", async (e) => {
      e.stopPropagation();
      enhanceBtnEl.disabled = true;
      enhanceBtnEl.classList.add("enhancing");
      const labelEl = enhanceBtnEl.querySelector("span");
      const origLabel = labelEl ? labelEl.textContent : "";
      if (labelEl) labelEl.textContent = "Enhancing…";
      try {
        const r = await fetch(`/api/calls/${c.id}/enhance`, { method: "POST" });
        const payload = await r.json();
        if (!r.ok || payload.error) {
          throw new Error(payload.error || `HTTP ${r.status}`);
        }
        const tEl = div.querySelector(".transcript");
        if (tEl) {
          tEl.classList.add("transcript-enhanced");
          tEl.innerHTML = highlight(payload.transcript, state.filters.search);
        } else if (payload.transcript) {
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
        enhanceBtnEl.replaceWith(newBadge);
      } catch (err) {
        if (labelEl) labelEl.textContent = origLabel;
        enhanceBtnEl.disabled = false;
        enhanceBtnEl.classList.remove("enhancing");
        enhanceBtnEl.classList.add("enhance-failed");
        enhanceBtnEl.title = `Enhance failed: ${err.message}`;
        setTimeout(() => enhanceBtnEl.classList.remove("enhance-failed"), 3000);
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

// ---- Cell-network glance widget (sidebar) ----
//
// Fetches /api/cell/quality and renders one row per active operator with a
// colored chip and a quality summary. Cheap (server-side aggregation), so
// refresh every 60s. Quietly hides itself if no observations exist yet
// (cloud hub before edge sync wires up, freshly-installed Pi, etc.).
async function refreshCellGlance() {
  const ul = document.getElementById("cell-glance");
  if (!ul) return;
  let data;
  try {
    data = await api("/api/cell/quality");
  } catch (e) {
    return;
  }
  const ops = (data && data.operators) || [];
  if (!ops.length) {
    ul.innerHTML = '<li class="cell-glance-empty">no observations yet</li>';
    return;
  }
  ul.innerHTML = ops.map((o) => {
    const dbm = o.avg_rsrp != null ? Math.round(o.avg_rsrp) : null;
    const q   = _glanceQuality(dbm);
    return `<li>
      <span class="op-dot" style="background:${_glanceOpColor(o.operator)}"></span>
      <span class="op-name">${escapeHtml(o.operator || "Unknown")}</span>
      <span class="op-meta">${o.n} · <span class="op-q ${q.cls}">${q.label}</span></span>
    </li>`;
  }).join("");
}

function _glanceOpColor(op) {
  if (!op) return "#888";
  if (op.startsWith("T-Mobile"))  return "#e20074";
  if (op.startsWith("Verizon"))   return "#cd040b";
  if (op.startsWith("AT&T"))      return "#00a8e0";
  if (op.startsWith("FirstNet"))  return "#3a8df0";
  if (op.startsWith("US Cellul")) return "#ff8200";
  if (op.includes("Telcel"))      return "#0067ad";
  if (op.includes("Movistar"))    return "#19be21";
  return "#888";
}
function _glanceQuality(dbm) {
  if (dbm == null) return { label: "—",     cls: "q-unknown" };
  if (dbm >=  -85) return { label: "great", cls: "q-excellent" };
  if (dbm >=  -95) return { label: "good",  cls: "q-good" };
  if (dbm >= -105) return { label: "fair",  cls: "q-fair" };
  if (dbm >= -115) return { label: "poor",  cls: "q-poor" };
  return                  { label: "weak",  cls: "q-marginal" };
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
  // Cell-glance widget — refresh every 60s. Live observations only update
  // when cellmon polls the modem, so a tighter cadence is wasted.
  refreshCellGlance();
  state.pollTimers.cellGlance = setInterval(refreshCellGlance, 60000);
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
  attachStoriesSwipe();
  attachStoriesArrows();
}

boot();
