// jafo — talkgroup editor.
// Loads /api/talkgroups/all, renders an editable table.
// Saves per-row via PUT /api/talkgroups/<id>.

const tgState = {
  rows: [],          // server data (last loaded)
  cities: [],        // dropdown source
  iconChoices: [],   // [{id, emoji, label}, ...]
  filter: "",
  onlyActive: false,
  onlyOverridden: false,
  dirty: new Map(),  // talkgroup -> {field: value}
};

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function load() {
  setStatus("Loading…");
  try {
    const data = await api("/api/talkgroups/all");
    tgState.rows = data.talkgroups || [];
    tgState.cities = data.available_cities || [];
    tgState.iconChoices = data.icon_choices || [];
    tgState.dirty.clear();
    render();
    setStatus(`${tgState.rows.length} talkgroups`);
  } catch (e) {
    setStatus(`Load failed: ${e.message}`);
  }
}

function setStatus(msg) {
  document.getElementById("tg-status").textContent = msg;
}

function render() {
  const tbody = document.getElementById("tg-tbody");
  tbody.innerHTML = "";

  const filtered = applyFilter(tgState.rows);
  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="12" class="tg-empty">No talkgroups match.</td>`;
    tbody.appendChild(tr);
    return;
  }

  const cityOptions =
    `<option value=""></option>` +
    tgState.cities.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  const iconOptionsFor = (selectedId) =>
    `<option value="">— auto —</option>` +
    tgState.iconChoices.map((i) =>
      `<option value="${escapeHtml(i.id)}"${i.id === selectedId ? " selected" : ""}>${i.emoji} ${escapeHtml(i.label)}</option>`
    ).join("");

  for (const r of filtered) {
    const tr = document.createElement("tr");
    tr.dataset.tg = r.talkgroup;
    if (tgState.dirty.has(r.talkgroup)) tr.classList.add("dirty");

    tr.innerHTML = `
      <td class="num id-cell">${r.talkgroup}</td>
      <td><input data-field="name" value="${escapeHtml(r.name || "")}"
          placeholder="${escapeHtml(r.csv_alpha_tag || "")}"></td>
      <td>
        <input data-field="city" list="city-list-${r.talkgroup}"
               value="${escapeHtml(r.city || "")}"
               placeholder="${escapeHtml(r.csv_category || "")}">
        <datalist id="city-list-${r.talkgroup}">${cityOptions}</datalist>
      </td>
      <td><input data-field="service_type" value="${escapeHtml(r.service_type || "")}"
          placeholder="${escapeHtml(r.csv_tag || "")}"></td>
      <td><select data-field="icon" class="icon-select">${iconOptionsFor(r.icon || "")}</select></td>
      <td><input data-field="link_url" type="url" class="url-input"
          value="${escapeHtml(r.link_url || "")}" placeholder="https://…"></td>
      <td class="num"><input data-field="lat" type="number" step="0.0001"
          value="${r.lat ?? ""}" placeholder="auto"></td>
      <td class="num"><input data-field="lng" type="number" step="0.0001"
          value="${r.lng ?? ""}" placeholder="auto"></td>
      <td><input data-field="notes" value="${escapeHtml(r.notes || "")}"></td>
      <td class="num">${r.calls_7d || ""}</td>
      <td><span class="source ${r.is_overridden ? "ov" : ""}">${r.is_overridden ? "edited" : "csv"}</span></td>
      <td>
        <button class="save-btn">Save</button>
        ${r.is_overridden ? '<button class="reset-btn" title="Clear override and revert to CSV">Reset</button>' : ""}
      </td>
    `;
    bindRow(tr, r);
    tbody.appendChild(tr);
  }
}

function applyFilter(rows) {
  let out = rows;
  if (tgState.onlyActive) out = out.filter((r) => r.calls_7d > 0);
  if (tgState.onlyOverridden) out = out.filter((r) => r.is_overridden);
  if (tgState.filter) {
    const q = tgState.filter.toLowerCase();
    out = out.filter((r) =>
      String(r.talkgroup).includes(q) ||
      (r.name || "").toLowerCase().includes(q) ||
      (r.city || "").toLowerCase().includes(q) ||
      (r.service_type || "").toLowerCase().includes(q) ||
      (r.notes || "").toLowerCase().includes(q)
    );
  }
  return out;
}

function bindRow(tr, r) {
  const tg = r.talkgroup;
  const onChange = (el) => {
    const field = el.dataset.field;
    const original = r[field] ?? "";
    const current = el.value;
    const dirty = tgState.dirty.get(tg) || {};
    if (String(current) === String(original)) {
      delete dirty[field];
    } else {
      dirty[field] = current;
    }
    if (Object.keys(dirty).length === 0) {
      tgState.dirty.delete(tg);
      tr.classList.remove("dirty");
      tr.querySelector(".save-btn")?.classList.remove("dirty");
    } else {
      tgState.dirty.set(tg, dirty);
      tr.classList.add("dirty");
      tr.querySelector(".save-btn")?.classList.add("dirty");
    }
  };
  tr.querySelectorAll("input[data-field]").forEach((inp) => {
    inp.addEventListener("input", () => onChange(inp));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") tr.querySelector(".save-btn")?.click();
    });
  });
  tr.querySelectorAll("select[data-field]").forEach((sel) => {
    sel.addEventListener("change", () => {
      onChange(sel);
      // Discrete picks save instantly — no need to hit the button
      saveRow(tr, r);
    });
  });
  tr.querySelector(".save-btn").onclick = () => saveRow(tr, r);
  tr.querySelector(".reset-btn")?.addEventListener("click", () => resetRow(tr, r));
}

async function saveRow(tr, r) {
  // Build the full payload (server stores the merged set of overrides)
  const payload = {
    name:         tr.querySelector('[data-field="name"]').value.trim(),
    city:         tr.querySelector('[data-field="city"]').value.trim(),
    service_type: tr.querySelector('[data-field="service_type"]').value.trim(),
    icon:         tr.querySelector('[data-field="icon"]').value,
    link_url:     tr.querySelector('[data-field="link_url"]').value.trim(),
    lat:          tr.querySelector('[data-field="lat"]').value,
    lng:          tr.querySelector('[data-field="lng"]').value,
    notes:        tr.querySelector('[data-field="notes"]').value.trim(),
  };

  // Drop fields that match the CSV defaults (so we don't store noise)
  if (payload.name === r.csv_alpha_tag) payload.name = "";
  if (payload.city === r.csv_category) payload.city = "";
  if (payload.service_type === r.csv_tag) payload.service_type = "";

  setStatus(`Saving tg-${r.talkgroup}…`);
  try {
    await api(`/api/talkgroups/${r.talkgroup}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setStatus(`Saved tg-${r.talkgroup}`);
    await load();
  } catch (e) {
    setStatus(`Save failed: ${e.message}`);
  }
}

async function resetRow(tr, r) {
  if (!confirm(`Clear all overrides for tg-${r.talkgroup}?`)) return;
  setStatus(`Resetting tg-${r.talkgroup}…`);
  try {
    await api(`/api/talkgroups/${r.talkgroup}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await load();
  } catch (e) {
    setStatus(`Reset failed: ${e.message}`);
  }
}

function bindToolbar() {
  const search = document.getElementById("tg-search");
  let t;
  search.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      tgState.filter = search.value.trim();
      render();
    }, 200);
  });
  document.getElementById("tg-only-active").addEventListener("change", (e) => {
    tgState.onlyActive = e.target.checked;
    render();
  });
  document.getElementById("tg-only-overridden").addEventListener("change", (e) => {
    tgState.onlyOverridden = e.target.checked;
    render();
  });
}

bindToolbar();
load();
