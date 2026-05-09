// Cell-network page — map + dashboard.
//
// Polls /api/cell/quality (dashboard cards + state-change tables) and
// /api/cell/sites (map + sites table) every 15s. No streaming; the
// underlying poller writes once a minute, so any tighter cadence is wasted.
"use strict";

const POLL_MS = 15_000;
const STATE = {
  map: null,
  markers: new Map(),         // site.id → { marker, ringPath }
  asrLayer: null,             // L.layerGroup of FCC ASR towers (only active)
  asrVisible: localStorage.getItem("jafo.asrVisible") !== "0",  // default ON
  myLocation: null,           // {lat, lng, accuracyM} or null until permission granted
  myLocationMarker: null,
  myLocationCircle: null,
  hoverLine: null,            // L.polyline drawn while hovering a tower/cell
  filterOperator: "",
  filterRat: "",
};

function $(s) { return document.querySelector(s); }
function $$(s) { return [...document.querySelectorAll(s)]; }

function fmtAgo(unixSec) {
  if (!unixSec) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60)         return `${s}s ago`;
  if (s < 3600)       return `${Math.floor(s/60)}m ago`;
  if (s < 86400)      return `${Math.floor(s/3600)}h ago`;
  return new Date(unixSec * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtRsrp(dbm) {
  if (dbm == null) return "—";
  return `${dbm} dBm`;
}

// RSRP is the cellular equivalent of "how many bars". Map dBm → quality bin.
//   ≥ -85   excellent
//   -86..-95 good
//   -96..-105 fair
//   -106..-115 poor
//   <  -115  marginal
function rsrpQuality(dbm) {
  if (dbm == null) return { label: "—",         className: "q-unknown" };
  if (dbm >=  -85) return { label: "excellent", className: "q-excellent" };
  if (dbm >=  -95) return { label: "good",      className: "q-good" };
  if (dbm >= -105) return { label: "fair",      className: "q-fair" };
  if (dbm >= -115) return { label: "poor",      className: "q-poor" };
  return                  { label: "marginal", className: "q-marginal" };
}

function operatorColor(op) {
  if (!op) return "#888";
  if (op.startsWith("T-Mobile"))  return "#e20074"; // T-Mobile magenta
  if (op.startsWith("Verizon"))   return "#cd040b"; // VZW red
  if (op.startsWith("AT&T"))      return "#00a8e0"; // AT&T cyan
  if (op.startsWith("US Cellul")) return "#ff8200";
  if (op.includes("Telcel"))      return "#0067ad";
  if (op.includes("Movistar"))    return "#19be21";
  if (op.includes("AT&T MX"))     return "#00a8e0";
  return "#888";
}

// ---------- map ----------
function initMap() {
  STATE.map = L.map("cell-map", {
    zoomControl: true,
    scrollWheelZoom: true,
    minZoom: 8,
    maxZoom: 16,
  }).setView([26.20, -98.05], 10);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(STATE.map);

  STATE.asrLayer = L.layerGroup();
  if (STATE.asrVisible) STATE.asrLayer.addTo(STATE.map);
  loadAsrTowers();
  addAsrToggleControl();
}

// ---------- FCC ASR layer — only towers with linked cells ----------
async function loadAsrTowers() {
  let payload;
  try {
    payload = await fetch("/api/cell/asr").then((r) => r.json());
  } catch (e) {
    console.warn("asr fetch failed", e);
    return;
  }
  STATE.asrLayer.clearLayers();
  for (const t of (payload.towers || [])) {
    if (t.lat == null || t.lng == null) continue;
    const color = operatorColor(t.dominant_operator);
    const sz = Math.min(28, 14 + (t.cell_count || 1) * 2);   // grow with cell count
    const m = L.marker([t.lat, t.lng], {
      icon: L.divIcon({
        html: `<div class="asr-marker" style="--asr-color:${color};--asr-size:${sz}px"></div>`,
        className: "",
        iconSize: [sz, sz],
        iconAnchor: [sz/2, sz - 1],
      }),
      keyboard: false,
    });
    const heightTxt = t.height_m
      ? `${Math.round(t.height_m)} m (${Math.round(t.height_m * 3.28)} ft)`
      : "—";
    const opsTxt = (t.operators || []).join(", ") || "—";
    const distTxt = STATE.myLocation
      ? `${haversineKm(STATE.myLocation.lat, STATE.myLocation.lng, t.lat, t.lng).toFixed(2)} km from you`
      : "";
    m.bindPopup(`
      <div class="cell-popup">
        <div class="popup-head">
          <strong>ASR ${esc(t.asr_number)}</strong>
          <span class="popup-rat">${esc(t.structure_type || "—")} · ${t.cell_count} cells</span>
        </div>
        <div class="popup-row"><span>Owner</span><span>${esc(t.owner || "—")}</span></div>
        <div class="popup-row"><span>Operators</span><span>${esc(opsTxt)}</span></div>
        <div class="popup-row"><span>Height</span><span>${heightTxt}</span></div>
        <div class="popup-row"><span>Max RSRP</span><span>${fmtRsrp(t.max_rsrp_dbm)}</span></div>
        ${distTxt ? `<div class="popup-row"><span>Distance</span><span>${distTxt}</span></div>` : ""}
      </div>
    `);
    // Hover → draw a dotted line from the tower to my current location.
    m.on("mouseover", () => drawHoverLine(t.lat, t.lng, color));
    m.on("mouseout",  clearHoverLine);
    m.addTo(STATE.asrLayer);
  }
  console.log(`asr layer: ${(payload.towers || []).length} active tower(s)`);
}

// ---------- "Where am I?" — browser geolocation ----------
//
// Modern browsers gate getCurrentPosition on a "secure context": HTTPS
// (or localhost literally). It will not fire on http://jafo.local or
// any plain-HTTP LAN IP. We always show the 📍 button so the user has
// somewhere to click, and surface a clear error if the request fails.
function setupMyLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      STATE.myLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: pos.coords.accuracy,
      };
      renderMyLocation();
      flashLocateMessage("Located.", false);
    },
    (err) => {
      console.warn("geolocation:", err.code, err.message);
      const insecure = !window.isSecureContext;
      const msg = insecure
        ? "Geolocation needs HTTPS — open https://jafo.live for this feature."
        : "Geolocation denied. Check browser permissions.";
      flashLocateMessage(msg, true);
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

// Brief in-page banner above the map when geolocation succeeds/fails.
function flashLocateMessage(text, isError) {
  let el = document.getElementById("locate-msg");
  if (!el) {
    el = document.createElement("div");
    el.id = "locate-msg";
    el.className = "locate-msg";
    const map = document.getElementById("cell-map");
    if (map && map.parentNode) map.parentNode.insertBefore(el, map);
  }
  el.textContent = text;
  el.classList.toggle("err", !!isError);
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 6000);
}

function renderMyLocation() {
  if (!STATE.myLocation || !STATE.map) return;
  const { lat, lng, accuracyM } = STATE.myLocation;
  if (STATE.myLocationMarker) STATE.myLocationMarker.remove();
  if (STATE.myLocationCircle) STATE.myLocationCircle.remove();
  STATE.myLocationCircle = L.circle([lat, lng], {
    radius: Math.max(20, accuracyM || 50),
    color: "#3a8df0", weight: 1, fillColor: "#3a8df0", fillOpacity: 0.12,
  }).addTo(STATE.map);
  STATE.myLocationMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: '<div class="my-location"></div>',
      className: "", iconSize: [16, 16], iconAnchor: [8, 8],
    }),
    keyboard: false, interactive: false,
  }).addTo(STATE.map);
}

// Idempotent — only ever creates one button regardless of how many times
// it's called. Earlier version recursively added a new button on every
// geolocation error, which stacked up rapidly on insecure contexts.
let _locateButtonAdded = false;
function addLocateButton() {
  if (_locateButtonAdded) return;
  _locateButtonAdded = true;
  const Ctl = L.Control.extend({
    options: { position: "topright" },
    onAdd: () => {
      const div = L.DomUtil.create("div", "leaflet-bar locate-wrap");
      div.innerHTML = `<button class="locate-btn" type="button" title="Use my location">📍</button>`;
      L.DomEvent.disableClickPropagation(div);
      div.querySelector(".locate-btn").addEventListener("click", setupMyLocation);
      return div;
    },
  });
  new Ctl().addTo(STATE.map);
}

// ---------- Hover line from tower/cell to my location ----------
function drawHoverLine(lat, lng, color) {
  clearHoverLine();
  if (!STATE.myLocation) return;
  STATE.hoverLine = L.polyline(
    [[STATE.myLocation.lat, STATE.myLocation.lng], [lat, lng]],
    { color: color || "#ffe87a", weight: 2, dashArray: "6, 6", opacity: 0.85 }
  ).addTo(STATE.map);
}
function clearHoverLine() {
  if (STATE.hoverLine) {
    STATE.hoverLine.remove();
    STATE.hoverLine = null;
  }
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function addAsrToggleControl() {
  const Ctl = L.Control.extend({
    options: { position: "topright" },
    onAdd: () => {
      const div = L.DomUtil.create("div", "leaflet-bar asr-toggle-wrap");
      div.innerHTML = `<button class="asr-toggle ${STATE.asrVisible ? "active" : ""}" type="button">▲ FCC towers ${STATE.asrVisible ? "on" : "off"}</button>`;
      L.DomEvent.disableClickPropagation(div);
      div.querySelector(".asr-toggle").addEventListener("click", toggleAsr);
      return div;
    },
  });
  new Ctl().addTo(STATE.map);
}

function toggleAsr() {
  STATE.asrVisible = !STATE.asrVisible;
  localStorage.setItem("jafo.asrVisible", STATE.asrVisible ? "1" : "0");
  if (STATE.asrVisible) STATE.asrLayer.addTo(STATE.map);
  else                  STATE.map.removeLayer(STATE.asrLayer);
  const btn = document.querySelector(".asr-toggle");
  if (btn) {
    btn.classList.toggle("active", STATE.asrVisible);
    btn.textContent = `▲ FCC towers ${STATE.asrVisible ? "on" : "off"}`;
  }
}

function placeOrUpdateMarker(site) {
  if (site.lat == null || site.lng == null) return;
  const color = operatorColor(site.operator);
  const q = rsrpQuality(site.last_rsrp_dbm);

  const existing = STATE.markers.get(site.id);
  if (existing) {
    existing.marker.setLatLng([site.lat, site.lng]);
    existing.marker.setStyle({ color, fillColor: color });
    existing.marker.bindPopup(popupHtml(site));
    return;
  }
  const m = L.circleMarker([site.lat, site.lng], {
    radius: 7,
    weight: 2,
    color: color,
    fillColor: color,
    fillOpacity: 0.65,
    className: `cell-marker ${q.className}`,
  });
  m.bindPopup(popupHtml(site));
  // Same hover-line pattern as ASR towers — draws a dotted path from
  // the cell's location to your position so you see the receive geometry.
  m.on("mouseover", () => drawHoverLine(site.lat, site.lng, color));
  m.on("mouseout",  clearHoverLine);
  m.addTo(STATE.map);
  STATE.markers.set(site.id, { marker: m });
}

function popupHtml(site) {
  return `
    <div class="cell-popup">
      <div class="popup-head">
        <strong>${esc(site.operator || "Unknown operator")}</strong>
        <span class="popup-rat">${esc(site.rat || "")} ${esc(site.band || "")}</span>
      </div>
      <div class="popup-row"><span>PCI</span><span>${site.pci ?? "—"}</span></div>
      <div class="popup-row"><span>Cell ID</span><span>${esc(site.cell_id || "—")}</span></div>
      <div class="popup-row"><span>EARFCN</span><span>${site.earfcn ?? "—"}</span></div>
      <div class="popup-row"><span>Last RSRP</span><span>${fmtRsrp(site.last_rsrp_dbm)}</span></div>
      <div class="popup-row"><span>Last seen</span><span>${fmtAgo(site.last_seen_at)}</span></div>
      <div class="popup-row"><span>Obs count</span><span>${site.obs_count ?? 0}</span></div>
    </div>
  `;
}

function dropMissingMarkers(visibleIds) {
  for (const [id, entry] of STATE.markers) {
    if (!visibleIds.has(id)) {
      entry.marker.remove();
      STATE.markers.delete(id);
    }
  }
}

// ---------- KPI cards ----------
function renderDashboard(q) {
  const $serving = $("#kpi-serving");
  if (q.serving) {
    const s = q.serving;
    $serving.querySelector(".kpi-value").textContent =
      `${s.operator || "Unknown"} ${s.band || ""}`.trim();
    $serving.querySelector(".kpi-sub").textContent =
      `PCI ${s.pci ?? "?"} · ${fmtRsrp(s.rsrp_dbm)} · SINR ${s.sinr_db ?? "?"} dB`;
  } else {
    $serving.querySelector(".kpi-value").textContent = "—";
    $serving.querySelector(".kpi-sub").textContent = "no observations yet";
  }

  const c = q.counts || {};
  $("#kpi-visible .kpi-value").textContent     = c.sites_1h ?? "—";
  $("#kpi-visible .kpi-baseline").textContent  = c.sites_24h ?? "—";
  $("#kpi-operators .kpi-value").textContent   = (q.operators || []).length;
  $("#kpi-stale .kpi-value").textContent       = (q.stale_sites || []).length;
  $("#kpi-new .kpi-value").textContent         = (q.new_sites   || []).length;

  // Per-operator table
  const ops = q.operators || [];
  $("#op-table tbody").innerHTML = ops.map((o) => {
    const dbm = o.avg_rsrp != null ? Math.round(o.avg_rsrp) : null;
    const ql  = rsrpQuality(dbm);
    return `<tr>
      <td><span class="op-dot" style="background:${operatorColor(o.operator)}"></span>${esc(o.operator || "—")}</td>
      <td>${o.n}</td>
      <td>${fmtRsrp(dbm)}</td>
      <td><span class="quality ${ql.className}">${ql.label}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="4" class="empty">No operator data yet.</td></tr>`;

  // Stale + new
  $("#stale-table tbody").innerHTML = (q.stale_sites || []).map((s) => `
    <tr>
      <td>${esc(s.operator || "—")}</td>
      <td>${esc(cellLabel(s))}</td>
      <td>${fmtAgo(s.last_seen_at)}</td>
    </tr>`).join("") || `<tr><td colspan="3" class="empty">None.</td></tr>`;
  $("#new-table tbody").innerHTML = (q.new_sites || []).map((s) => `
    <tr>
      <td>${esc(s.operator || "—")}</td>
      <td>${esc(cellLabel(s))}</td>
      <td>${fmtAgo(s.first_seen_at)}</td>
    </tr>`).join("") || `<tr><td colspan="3" class="empty">None.</td></tr>`;

  // Populate operator filter
  const sel = $("#filter-operator");
  const have = new Set([...sel.options].map((o) => o.value));
  for (const o of ops) {
    if (o.operator && !have.has(o.operator)) {
      const opt = document.createElement("option");
      opt.value = o.operator;
      opt.textContent = o.operator;
      sel.appendChild(opt);
    }
  }
}

function cellLabel(s) {
  if (s.cell_id) return `${s.rat || ""} ${s.band || ""} cell ${s.cell_id}`;
  return `${s.rat || ""} ${s.band || ""} PCI ${s.pci} EARFCN ${s.earfcn}`;
}

// ---------- Sites table + map plot ----------
function renderSites(payload) {
  const sites = payload.sites || [];
  const filtered = sites.filter((s) => {
    if (STATE.filterOperator && s.operator !== STATE.filterOperator) return false;
    if (STATE.filterRat && s.rat !== STATE.filterRat) return false;
    return true;
  });

  // Map markers — only sites with known geolocation
  const visible = new Set();
  for (const s of filtered) {
    if (s.lat != null && s.lng != null) {
      visible.add(s.id);
      placeOrUpdateMarker(s);
    }
  }
  dropMissingMarkers(visible);

  // Table
  const tbody = $("#sites-table tbody");
  if (!filtered.length) {
    tbody.innerHTML = "";
    $("#sites-empty").hidden = sites.length > 0;
    return;
  }
  $("#sites-empty").hidden = true;
  tbody.innerHTML = filtered.map((s) => {
    const ql = rsrpQuality(s.last_rsrp_dbm);
    return `<tr data-site-id="${s.id}">
      <td><span class="op-dot" style="background:${operatorColor(s.operator)}"></span>${esc(s.operator || "—")}</td>
      <td>${esc(s.rat || "—")}</td>
      <td>${esc(s.band || "—")}</td>
      <td>${s.pci ?? "—"}</td>
      <td>${esc(s.cell_id || "—")}</td>
      <td>${s.earfcn ?? "—"}</td>
      <td><span class="quality ${ql.className}">${fmtRsrp(s.last_rsrp_dbm)}</span></td>
      <td>${fmtAgo(s.first_seen_at)}</td>
      <td>${fmtAgo(s.last_seen_at)}</td>
      <td>${s.obs_count ?? 0}</td>
    </tr>`;
  }).join("");

  // Click row → focus that site on the map (if it has coords)
  for (const tr of tbody.querySelectorAll("tr")) {
    tr.addEventListener("click", () => {
      const id = Number(tr.dataset.siteId);
      const m = STATE.markers.get(id);
      if (m && m.marker) {
        STATE.map.setView(m.marker.getLatLng(), 14);
        m.marker.openPopup();
      }
    });
  }
}

// ---------- escape ----------
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- poll loop ----------
async function tick() {
  try {
    const [q, sites] = await Promise.all([
      fetch("/api/cell/quality").then((r) => r.json()),
      fetch("/api/cell/sites?hours=24").then((r) => r.json()),
    ]);
    renderDashboard(q);
    renderSites(sites);
  } catch (e) {
    console.warn("cell tick failed", e);
  }
}

// ---------- init ----------
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  // Always show the 📍 button so the user can request geolocation on demand.
  // We try once at load too, but on http://jafo.local the request silently
  // fails (non-secure context) and the button is the user's only path.
  addLocateButton();
  setupMyLocation();
  $("#filter-operator").addEventListener("change", (e) => {
    STATE.filterOperator = e.target.value;
    tick();
  });
  $("#filter-rat").addEventListener("change", (e) => {
    STATE.filterRat = e.target.value;
    tick();
  });
  tick();
  setInterval(tick, POLL_MS);
});
