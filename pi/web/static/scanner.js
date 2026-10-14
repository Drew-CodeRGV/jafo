// jafo — "Listen Live" scanner.
//
// Plays a channel's decoded calls back-to-back in chronological order and keeps
// playing new calls live as they arrive. Single channel by default; add more
// channels for a combined scan (like a real scanner across several talkgroups).
//
// Loaded AFTER app.js, so it reuses app.js globals directly:
//   api(), escapeHtml(), fmtDur(), fmtAgo(), serviceIcon(),
//   popPlaybackMarker(), mapState  (all declared at app.js top level)
//
// No backend changes: everything rides on /api/calls (talkgroup / talkgroups /
// since filters) and /api/talkgroup-groups (channel picker source).

const SCANNER_BACKFILL = 6;        // recent calls to prime the queue with
const SCANNER_POLL_MS   = 5000;    // how often to look for new traffic
const SCANNER_LS_KEY    = "jafo.scanner.channels";

const scanner = {
  channels: [],            // [{talkgroup, tag}]
  queue: [],               // calls waiting to play (chronological)
  seen: new Set(),         // call ids queued-or-played (dedupe)
  current: null,           // call currently playing
  marker: null,            // leaflet marker for the current call
  lastSince: 0,            // max start_time seen → next poll's `since`
  pollTimer: null,
  paused: false,
  started: false,          // user has pressed play at least once this session
  audio: null,
  groupsCache: null,       // cached /api/talkgroup-groups payload
};

// ---- DOM handles (populated in scannerInit) ----
let SB = {};

function scannerInit() {
  SB = {
    bar:      document.getElementById("scanner-bar"),
    toggle:   document.getElementById("scanner-toggle"),
    skip:     document.getElementById("scanner-skip"),
    stop:     document.getElementById("scanner-stop"),
    vol:      document.getElementById("scanner-vol"),
    chips:    document.getElementById("scanner-channels"),
    nowText:  document.getElementById("scanner-now-text"),
    nowLabel: document.getElementById("scanner-now-label"),
    audio:    document.getElementById("scanner-audio"),
    picker:   document.getElementById("channel-picker"),
    pickerList:   document.getElementById("channel-picker-list"),
    pickerSearch: document.getElementById("channel-picker-search"),
  };
  if (!SB.bar) return;          // template not present → nothing to do
  scanner.audio = SB.audio;

  SB.toggle.addEventListener("click", scannerTogglePlay);
  SB.skip.addEventListener("click", scannerSkip);
  SB.stop.addEventListener("click", scannerStop);
  if (SB.vol) {
    const savedVol = parseFloat(localStorage.getItem("jafo.scanner.vol") || "1");
    SB.vol.value = isNaN(savedVol) ? 1 : savedVol;
    scanner.audio.volume = SB.vol.value;
    SB.vol.addEventListener("input", () => {
      scanner.audio.volume = SB.vol.value;
      localStorage.setItem("jafo.scanner.vol", SB.vol.value);
    });
  }

  scanner.audio.addEventListener("ended", () => { if (!scanner.paused) scannerPlayNext(); });
  scanner.audio.addEventListener("error", () => { if (!scanner.paused) scannerPlayNext(); });

  // "+ add channel" / chip clicks (delegated)
  SB.chips.addEventListener("click", (e) => {
    const add = e.target.closest(".scanner-add");
    if (add) { openChannelPicker(); return; }
    const rm = e.target.closest(".scanner-chip-rm");
    if (rm) {
      const tg = parseInt(rm.closest(".scanner-chip").dataset.tg, 10);
      removeChannel(tg);
    }
  });

  // Channel picker popover
  if (SB.pickerSearch) {
    SB.pickerSearch.addEventListener("input", () => renderChannelPicker(SB.pickerSearch.value));
  }
  document.addEventListener("click", (e) => {
    if (!SB.picker || SB.picker.classList.contains("hidden")) return;
    if (SB.picker.contains(e.target) || e.target.closest(".scanner-add")) return;
    closeChannelPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && SB.picker && !SB.picker.classList.contains("hidden")) {
      closeChannelPicker();
    }
  });

  // Restore previously-chosen channels (chips only — don't auto-blast audio).
  try {
    const saved = JSON.parse(localStorage.getItem(SCANNER_LS_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) {
      scanner.channels = saved.filter((c) => c && c.talkgroup);
    }
  } catch { /* ignore */ }
  renderChannelChips();
  renderNowPlaying(null);

  bindViewToggles();
  bindRail();
}

// ---- view-toggle chips (map / air traffic / stories) ----
// Feed-first: these panels start collapsed and the user opts them in. State is
// persisted so a reload keeps the user's chosen layout.
const VIEW_PANELS = {
  radar:   "#cc-radar-pane",
  link:    "#cc-link-pane",
  acars:   "#cc-acars-pane",
  map:     ".map-pane",
  air:     "#air-strip",
  stories: "#stories-strip",
};

function bindViewToggles() {
  const bar = document.getElementById("view-toggle");
  if (!bar) return;
  bar.querySelectorAll(".view-chip").forEach((chip) => {
    const key = chip.dataset.view;
    const open = localStorage.getItem(`jafo.view.${key}`) === "open";
    setViewPanel(key, open, chip);
    chip.addEventListener("click", () => {
      const nowOpen = chip.classList.toggle("active");
      setViewPanel(key, nowOpen, chip);
      localStorage.setItem(`jafo.view.${key}`, nowOpen ? "open" : "closed");
    });
  });
}

function setViewPanel(key, open, chip) {
  const el = document.querySelector(VIEW_PANELS[key]);
  if (!el) return;
  el.classList.toggle("collapsed", !open);
  if (chip) chip.classList.toggle("active", open);
  // Leaflet mis-measures a container that was display:none at init; nudge it.
  if (key === "map" && open && typeof mapState !== "undefined" && mapState.map) {
    setTimeout(() => mapState.map.invalidateSize(), 60);
  }
}

// ---- slim rail → opens the filter drawer ----
function bindRail() {
  document.querySelectorAll(".rail .rail-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.body.classList.add("sidebar-open");
      if (btn.dataset.rail === "search") {
        const s = document.getElementById("search");
        if (s) setTimeout(() => s.focus(), 50);
      }
    });
  });
}

// ---- channel selection ----
function persistChannels() {
  localStorage.setItem(SCANNER_LS_KEY, JSON.stringify(scanner.channels));
}

function channelFilterParams() {
  const ids = scanner.channels.map((c) => c.talkgroup);
  const p = new URLSearchParams({ only_kept: "1" });
  if (ids.length === 1) p.set("talkgroup", ids[0]);
  else if (ids.length > 1) p.set("talkgroups", ids.join(","));
  return p;
}

function channelLabel(c) {
  const icon = serviceIcon(c.tag, c.service, null);
  return (icon ? icon + " " : "") + (c.tag || `tg-${c.talkgroup}`);
}

function addChannel(tg, tag, service) {
  if (scanner.channels.some((c) => c.talkgroup === tg)) return;
  scanner.channels.push({ talkgroup: tg, tag, service });
  persistChannels();
  renderChannelChips();
  if (scanner.started) restartQueueForChannels();
  else scannerStart();          // first pick → start listening immediately
}

function removeChannel(tg) {
  scanner.channels = scanner.channels.filter((c) => c.talkgroup !== tg);
  persistChannels();
  renderChannelChips();
  if (!scanner.channels.length) { scannerStop(); return; }
  if (scanner.started) restartQueueForChannels();
}

function renderChannelChips() {
  if (!SB.chips) return;
  const chips = scanner.channels.map((c) => `
    <span class="scanner-chip" data-tg="${c.talkgroup}">
      <span class="scanner-chip-label">${escapeHtml(channelLabel(c))}</span>
      <button class="scanner-chip-rm" title="Remove channel" aria-label="Remove channel">×</button>
    </span>`).join("");
  const addLabel = scanner.channels.length ? "＋ Add" : "＋ Channel";
  SB.chips.innerHTML = chips + `<button class="scanner-add" type="button">${addLabel}</button>`;
}

// ---- channel picker popover ----
async function openChannelPicker() {
  if (!SB.picker) return;
  SB.picker.classList.remove("hidden");
  if (SB.pickerSearch) { SB.pickerSearch.value = ""; SB.pickerSearch.focus(); }
  if (!scanner.groupsCache) {
    SB.pickerList.innerHTML = '<div class="channel-picker-empty">Loading channels…</div>';
    try {
      scanner.groupsCache = await api("/api/talkgroup-groups?group_by=service&sort=count");
    } catch (e) {
      SB.pickerList.innerHTML = '<div class="channel-picker-empty">Could not load channels.</div>';
      return;
    }
  }
  renderChannelPicker("");
}

function closeChannelPicker() {
  if (SB.picker) SB.picker.classList.add("hidden");
}

function renderChannelPicker(query) {
  if (!SB.pickerList || !scanner.groupsCache) return;
  const q = (query || "").trim().toLowerCase();
  const chosen = new Set(scanner.channels.map((c) => c.talkgroup));
  const groups = scanner.groupsCache.groups || [];
  let html = "";
  for (const g of groups) {
    const members = (g.talkgroups || []).filter((tg) => {
      if (!q) return true;
      const label = (tg.talkgroup_tag || "").toLowerCase();
      return label.includes(q) || (g.name || "").toLowerCase().includes(q);
    });
    if (!members.length) continue;
    html += `<div class="channel-picker-group">${escapeHtml(g.name)}</div>`;
    for (const tg of members) {
      const icon = serviceIcon(tg.talkgroup_tag, tg.tag, null);
      const iconPart = icon ? icon + " " : "";
      const label = tg.talkgroup_tag || `tg-${tg.talkgroup}`;
      const on = chosen.has(tg.talkgroup);
      html += `
        <button class="channel-picker-item${on ? " on" : ""}"
                data-tg="${tg.talkgroup}"
                data-tag="${escapeHtml(label)}"
                data-service="${escapeHtml(tg.tag || "")}">
          <span>${iconPart}${escapeHtml(label)}</span>
          <span class="channel-picker-count">${on ? "✓" : tg.n}</span>
        </button>`;
    }
  }
  SB.pickerList.innerHTML = html || '<div class="channel-picker-empty">No channels match.</div>';
  SB.pickerList.querySelectorAll(".channel-picker-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tg = parseInt(btn.dataset.tg, 10);
      if (scanner.channels.some((c) => c.talkgroup === tg)) {
        removeChannel(tg);
      } else {
        addChannel(tg, btn.dataset.tag, btn.dataset.service);
      }
      renderChannelPicker(SB.pickerSearch ? SB.pickerSearch.value : "");
    });
  });
}

// ---- playback engine ----
async function scannerStart() {
  if (!scanner.channels.length) { openChannelPicker(); return; }
  scanner.started = true;
  scanner.paused = false;
  scanner.queue = [];
  scanner.seen.clear();
  SB.bar.dataset.state = "loading";
  SB.toggle.textContent = "⏸";
  await scannerBackfill();
  scannerStartPoll();
  scannerPlayNext();
}

async function restartQueueForChannels() {
  scanner.queue = [];
  scanner.seen.clear();
  scanner.lastSince = 0;
  await scannerBackfill();
  if (!scanner.current || scanner.audio.ended || scanner.audio.paused) scannerPlayNext();
}

async function scannerBackfill() {
  const p = channelFilterParams();
  p.set("limit", SCANNER_BACKFILL);
  let calls = [];
  try {
    const data = await api(`/api/calls?${p}`);
    calls = data.calls || [];
  } catch (e) {
    renderNowPlaying(null, "Could not reach the server.");
    return;
  }
  // Self-gate: audio is owner-only. If the server returned calls but none are
  // playable for this session, say so instead of showing a dead player.
  const playable = calls.filter((c) => c.audio_available && c.opus_path);
  if (calls.length && !playable.length) {
    SB.bar.dataset.state = "gated";
    renderNowPlaying(null, "Live audio plays on the local jafo node (or sign in as admin).");
    return;
  }
  // newest-first → chronological
  playable.reverse();
  for (const c of playable) scannerEnqueue(c);
}

function scannerEnqueue(c) {
  if (scanner.seen.has(c.id)) return;
  scanner.seen.add(c.id);
  scanner.queue.push(c);
  if (c.start_time > scanner.lastSince) scanner.lastSince = c.start_time;
}

function scannerStartPoll() {
  scannerStopPoll();
  scanner.pollTimer = setInterval(scannerPoll, SCANNER_POLL_MS);
}
function scannerStopPoll() {
  if (scanner.pollTimer) clearInterval(scanner.pollTimer);
  scanner.pollTimer = null;
}

async function scannerPoll() {
  if (!scanner.channels.length) return;
  const p = channelFilterParams();
  p.set("since", scanner.lastSince || 0);
  p.set("limit", "50");
  let calls = [];
  try {
    const data = await api(`/api/calls?${p}`);
    calls = data.calls || [];
  } catch { return; }
  const fresh = calls
    .filter((c) => c.audio_available && c.opus_path && !scanner.seen.has(c.id))
    .sort((a, b) => a.start_time - b.start_time);
  for (const c of fresh) scannerEnqueue(c);
  // If we were idle (waiting for traffic), kick playback back to life.
  if (fresh.length && !scanner.paused &&
      (!scanner.current || scanner.audio.ended || scanner.audio.paused)) {
    scannerPlayNext();
  }
}

function scannerPlayNext() {
  if (scanner.paused) return;
  scannerLiftMarker();
  const next = scanner.queue.shift();
  if (!next) {
    scanner.current = null;
    SB.bar.dataset.state = "waiting";
    SB.toggle.textContent = "⏸";
    const names = scanner.channels.map(channelLabel).join(", ") || "channel";
    renderNowPlaying(null, `Listening… waiting for traffic on ${names}`);
    return;
  }
  scanner.current = next;
  SB.bar.dataset.state = "playing";
  SB.toggle.textContent = "⏸";
  scanner.audio.src = `/audio/${next.opus_path}`;
  const play = scanner.audio.play();
  if (play && play.catch) play.catch(() => {/* autoplay gesture lost — user can hit play */});
  renderNowPlaying(next);
  // mapState is an app.js top-level const (shared global scope), not a window
  // property — reference it directly, guarded by typeof in case app.js failed.
  if (typeof mapState !== "undefined" && mapState.map) scanner.marker = popPlaybackMarker(next);
}

function scannerLiftMarker() {
  if (scanner.marker && typeof mapState !== "undefined" && mapState.map) {
    mapState.map.removeLayer(scanner.marker);
  }
  scanner.marker = null;
}

function scannerTogglePlay() {
  if (!scanner.channels.length) { openChannelPicker(); return; }
  if (!scanner.started) { scannerStart(); return; }
  if (scanner.paused) {
    scanner.paused = false;
    SB.toggle.textContent = "⏸";
    if (scanner.current && scanner.audio.paused && !scanner.audio.ended) {
      scanner.audio.play().catch(() => {});
      SB.bar.dataset.state = "playing";
    } else {
      scannerPlayNext();
    }
  } else {
    scanner.paused = true;
    scanner.audio.pause();
    SB.toggle.textContent = "▶";
    SB.bar.dataset.state = "paused";
  }
}

function scannerSkip() {
  if (!scanner.started) return;
  scanner.paused = false;
  scanner.audio.pause();
  scannerPlayNext();
  if (!scanner.current) scannerPoll();   // queue was empty → look for more now
}

function scannerStop() {
  scanner.started = false;
  scanner.paused = false;
  scannerStopPoll();
  scanner.audio.pause();
  scanner.audio.removeAttribute("src");
  scanner.audio.load();
  scanner.queue = [];
  scanner.seen.clear();
  scanner.current = null;
  scanner.lastSince = 0;
  scannerLiftMarker();
  SB.bar.dataset.state = "idle";
  SB.toggle.textContent = "▶";
  renderNowPlaying(null);
}

function renderNowPlaying(call, overrideMsg) {
  if (!SB.nowText) return;
  if (overrideMsg) {
    if (SB.nowLabel) SB.nowLabel.textContent = "Listen Live";
    SB.nowText.textContent = overrideMsg;
    return;
  }
  if (!call) {
    if (SB.nowLabel) SB.nowLabel.textContent = "Listen Live";
    SB.nowText.textContent = scanner.channels.length
      ? "Press play to start the live scanner…"
      : "Pick a channel to start the live scanner…";
    return;
  }
  const tag = call.talkgroup_tag || `tg-${call.talkgroup}`;
  const icon = serviceIcon(call.talkgroup_tag, call.service_type, call.incident_type, call.icon);
  // Agency patch of who's transmitting (generated SVG; falls back to the emoji).
  const patch = (typeof ccAgencyPatch === "function")
    ? `<span class="scanner-now-patch">${ccAgencyPatch(tag, serviceCategory(call.talkgroup_tag, call.service_type, call.incident_type, call.icon), 26)}</span>`
    : (icon ? icon + " " : "");
  if (SB.nowLabel) SB.nowLabel.innerHTML =
    `${patch}<strong>${escapeHtml(tag)}</strong> <span class="scanner-ago">${escapeHtml(fmtAgo(call.start_time))}</span>`;
  const body = call.incident_summary || call.transcript || "(transcribing…)";
  SB.nowText.textContent = body;
}

// scanner.js loads after app.js (which calls boot() at parse time), so the DOM
// is already present. Initialise immediately.
scannerInit();
