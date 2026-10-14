// jafo — OSINT exposure demo (frontend). Loads ONLY when the edge operator
// has opted in (server gates with JAFO_OSINT_DEMO). See services/osint.py.
//
// Opens a modal for the name(s) heard on a call, queries /api/osint (which runs
// a sandboxed user-scanner lookup in the background), and renders any public
// profile matches — explicitly framed as unverified, possibly-wrong guesses.

// Generic cyan head-and-neck silhouette — used when no avatar / no match.
const OSINT_SILHOUETTE = `
<svg viewBox="0 0 80 92" class="osint-silhouette" aria-hidden="true">
  <circle cx="40" cy="26" r="17" fill="none" stroke="#35e3ff" stroke-width="2.4"/>
  <path d="M10 88 C10 64 26 54 40 54 C54 54 70 64 70 88" fill="none" stroke="#35e3ff" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

let _osintTimers = [];

function _osintEsc(s) {
  return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function _osintClearTimers() { _osintTimers.forEach(clearTimeout); _osintTimers = []; }

function openOsint(names, call) {
  const modal = document.getElementById("osint-modal");
  if (!modal) return;
  names = (names || []).filter(Boolean);
  const title = document.getElementById("osint-title");
  if (title) title.textContent = names.length ? names.join("  ·  ") : "No names detected";
  const body = document.getElementById("osint-body");
  body.innerHTML = "";
  _osintClearTimers();

  for (const name of names) {
    const sec = document.createElement("div");
    sec.className = "osint-person";
    sec.innerHTML = `
      <div class="osint-person-hdr">
        <span class="osint-subj">${OSINT_SILHOUETTE}<span>${_osintEsc(name)}</span></span>
        <span class="osint-status" data-status>◈ scanning…</span>
      </div>
      <div class="osint-matches" data-matches>
        <div class="osint-loading">querying open sources across public platforms…</div>
      </div>`;
    body.appendChild(sec);
    _pollOsint(name, sec, 0);
  }
  modal.classList.remove("hidden");
}
window.openOsint = openOsint;

async function _pollOsint(name, sec, tries) {
  let data;
  try {
    data = await (await fetch(`/api/osint?name=${encodeURIComponent(name)}`)).json();
  } catch (e) {
    _renderOsint(sec, { status: "error", matches: [], error: "request failed" });
    return;
  }
  if (data.status === "pending" && tries < 40) {
    _osintTimers.push(setTimeout(() => _pollOsint(name, sec, tries + 1), 2500));
    return;
  }
  _renderOsint(sec, data);
}

function _renderOsint(sec, data) {
  const statusEl = sec.querySelector("[data-status]");
  const wrap = sec.querySelector("[data-matches]");
  const matches = data.matches || [];
  const cands = (data.candidates || []).join(", ");

  if (data.status === "invalid") {
    if (statusEl) statusEl.textContent = "not a scannable name";
    wrap.innerHTML = `<div class="osint-none">${OSINT_SILHOUETTE}<p>Not treated as a civilian name.</p></div>`;
    return;
  }
  if (statusEl) {
    statusEl.textContent = matches.length ? `${matches.length} possible match${matches.length>1?"es":""}` : "no matches";
    statusEl.classList.toggle("hit", matches.length > 0);
  }

  if (!matches.length) {
    wrap.innerHTML = `
      <div class="osint-none">
        ${OSINT_SILHOUETTE}
        <p>No public profile matched the guessed handles${cands ? ` <span class="osint-cands">(${_osintEsc(cands)})</span>` : ""}.</p>
        <p class="osint-note">Absence of a match proves nothing — the real person may use a different handle.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `<div class="osint-grid">` + matches.map((m) => {
    const av = m.avatar
      ? `<img class="osint-avatar" src="${_osintEsc(m.avatar)}" alt="" referrerpolicy="no-referrer"
             onerror="this.outerHTML='<span class=&quot;osint-avatar-fallback&quot;>'+document.getElementById('osint-sil-tpl').innerHTML+'</span>'">`
      : `<span class="osint-avatar-fallback">${OSINT_SILHOUETTE}</span>`;
    return `
      <a class="osint-match" href="${_osintEsc(m.url)}" target="_blank" rel="noopener noreferrer">
        ${av}
        <span class="osint-match-meta">
          <span class="osint-platform">${_osintEsc(m.platform || "?")}</span>
          <span class="osint-handle">@${_osintEsc(m.handle || "")}</span>
        </span>
      </a>`;
  }).join("") + `</div>
    <p class="osint-note">${matches.length} candidate profile(s) — <strong>unverified</strong>, possibly a different person. Candidates tried: ${_osintEsc(cands)}.</p>`;
}

// Recent-names rail (beside the map): last few names heard, one-click lookup.
function refreshOsintRail() {
  const list = document.getElementById("osint-rail-list");
  if (!list || typeof state === "undefined") return;
  const seen = new Set();
  const rows = [];
  for (const c of (state.calls || [])) {
    for (const name of (c.persons || [])) {
      const k = (name || "").toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      rows.push({ name, call: c });
      if (rows.length >= 6) break;
    }
    if (rows.length >= 6) break;
  }
  if (!rows.length) {
    list.innerHTML = '<li class="osint-rail-empty">no names heard yet…</li>';
    return;
  }
  list.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "osint-rail-item";
    li.innerHTML =
      `<span class="osint-rail-name">${OSINT_SILHOUETTE}<span>${_osintEsc(r.name)}</span></span>` +
      `<span class="osint-rail-src">${_osintEsc(r.call.talkgroup_tag || "")}</span>`;
    li.addEventListener("click", () => openOsint([r.name], r.call));
    list.appendChild(li);
  }
}
window.refreshOsintRail = refreshOsintRail;

function _osintClose() {
  const modal = document.getElementById("osint-modal");
  if (modal) modal.classList.add("hidden");
  _osintClearTimers();
}

function _osintBind() {
  const modal = document.getElementById("osint-modal");
  if (!modal) return;
  modal.querySelectorAll("[data-osint-close]").forEach((el) => el.addEventListener("click", _osintClose));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) _osintClose();
  });
  // Hidden template so the <img onerror> handler can swap in a silhouette.
  const tpl = document.createElement("div");
  tpl.id = "osint-sil-tpl"; tpl.style.display = "none"; tpl.innerHTML = OSINT_SILHOUETTE;
  document.body.appendChild(tpl);

  // Manual lookup — type any name (great for live demos with a volunteer).
  const manual = document.getElementById("osint-rail-manual");
  if (manual) {
    manual.addEventListener("click", () => {
      const name = (prompt("Run the OSINT exposure demo on this name:") || "").trim();
      if (name) openOsint([name], null);
    });
  }
}
_osintBind();
