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
      header.innerHTML = `
        <span class="caret">${isExpanded ? "▾" : "▸"}</span>
        <span class="tg-group-name">${escapeHtml(group.name)}</span>
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
  li.innerHTML = `
    <span>${escapeHtml(label)}${enc ? '<span class="enc-tag" title="Encrypted">🔒</span>' : ""}</span>
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

  // Native audio element with proper preload + type. preload="metadata" lets
  // the browser fetch enough of the file to know the duration up front, which
  // is what was preventing playback from running to the end before.
  const audioEl = c.audio_available
    ? `<audio controls preload="metadata" class="audio-inline">
         <source src="/audio/${escapeHtml(c.opus_path)}" type="audio/ogg; codecs=opus">
         Your browser doesn't support inline audio.
       </audio>`
    : '<span class="pending">no audio</span>';

  div.innerHTML = `
    <div class="when">
      <div>${fmtTime(c.start_time)}</div>
      <div>${fmtDate(c.start_time)}</div>
      <div class="ago">${fmtAgo(c.start_time)}</div>
    </div>
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
      loadCalls(false);
    }
  }, 15000);
  state.pollTimers.sidebar = setInterval(() => {
    refreshTalkgroups();
    refreshIncidentTypes();
  }, 60000);
}
function stopPolling() {
  Object.values(state.pollTimers).forEach(clearInterval);
  state.pollTimers = {};
}

// ---- Boot ----
async function boot() {
  bindSearch();
  bindClearFilters();
  bindLoadMore();
  bindAutoRefresh();
  bindSeverityList();
  bindGroupingToggles();
  await Promise.all([refreshStats(), refreshTalkgroups(), refreshIncidentTypes()]);
  await loadCalls(false);
  startPolling();
}
boot();
