/* jafo wall — "grid" situation board. Zero interaction, polls the live APIs,
   keeps the last good data on failure. ?theme=dark|light|auto, ?demo=1 treats the
   last 24 hours of incidents as if they were active (for showing the board off). */
(function () {
  "use strict";

  const CFG = JSON.parse(document.getElementById("wall-cfg").textContent);
  const Q = new URLSearchParams(location.search);
  const DEMO = Q.get("demo") === "1";
  const SLUG = CFG.slug;
  const TZ = CFG.tz || undefined;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ vocab (shared with live.js)
  const KIND_ICON = {
    violence: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
    traffic: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3.5 16h17M7 19v-3M17 19v-3M7.5 12.5h.01M16.5 12.5h.01"/>',
    medical: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M9.5 11.5h2l1-2 1.5 4 1-2h1"/>',
    property: '<path d="M4 11 12 4l8 7v9H4v-9z"/><path d="M10 20v-5h4v5"/>',
    suspicious: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
    fire: '<path d="M12 21c-4 0-6.5-2.6-6.5-6.2 0-3.6 3-5.6 3.6-9.3 2.2 1.4 3.2 3.4 3.3 5.3 1-.8 1.6-2 1.8-3.3 2.3 1.9 4.3 4.6 4.3 7.5C18.5 18.4 16 21 12 21z"/>',
    other: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  };
  const KIND_LABEL = {
    violence: "Violence and danger", traffic: "Traffic", medical: "Medical and welfare",
    property: "Property and alarms", suspicious: "Suspicious and disputes", fire: "Fire", other: "Other calls",
  };
  const KIND_WORD = {   // for the plain-English sentence
    violence: ["violence or danger", "violence or danger"], traffic: ["traffic", "traffic"], medical: ["medical", "medical"],
    property: ["property or alarm", "property or alarm"], suspicious: ["suspicious or dispute", "suspicious or dispute"],
    fire: ["fire", "fire"], other: ["other", "other"],
  };
  const KINDS = ["violence", "fire", "medical", "traffic", "property", "suspicious", "other"];
  const kindSvg = (k) => `<svg viewBox="0 0 24 24">${KIND_ICON[k] || KIND_ICON.other}</svg>`;
  const kico = (k) => `<span class="kico k-${esc(k || "other")}">${kindSvg(k)}</span>`;

  const STATUS = {
    new: { label: "New", ico: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>' },
    en_route: { label: "Units on the way", short: "On the way", ico: '<path d="M4 12h14M13 6l6 6-6 6"/>' },
    on_scene: { label: "Units on scene", short: "On scene", ico: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>' },
    quiet: { label: "Quiet", ico: '<path d="M9 7v10M15 7v10"/>' },
    cleared: { label: "Cleared", ico: '<path d="M5 12.5 10 17 19 7.5"/>' },
    ended: { label: "Cleared", ico: '<path d="M5 12.5 10 17 19 7.5"/>' },
  };
  const PIPE = ["new", "en_route", "on_scene", "quiet", "cleared"];
  const PIPE_LABEL = { new: "New", en_route: "On the way", on_scene: "On scene", quiet: "Quiet", cleared: "Cleared" };
  const chip = (s) => {
    const d = STATUS[s] || STATUS.quiet;
    return `<span class="chip s-${esc(s)}"><svg viewBox="0 0 24 24">${d.ico}</svg>${esc(d.short || d.label)}</span>`;
  };

  const SERVICES = [["police", "Police"], ["fire", "Fire"], ["ems", "EMS"]];
  const USTATES = [["on_scene", "On scene"], ["en_route", "On the way"], ["busy", "Busy"], ["available", "Available"]];
  const ugroup = (s) => (s === "dispatched" || s === "en_route") ? "en_route"
    : (s === "transporting" || s === "busy") ? "busy" : (s === "on_scene" || s === "available") ? s : null;

  // ------------------------------------------------------------ helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const txt = (s) => esc(s).replace(/⟦[^⟧]*⟧/g, '<span class="redacted" title="Hidden for privacy">hidden</span>');
  const fmtN = (n) => Math.round(n).toLocaleString("en-US");
  const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : (many || one + "s")}`;
  const tf = (o) => new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: TZ }, o));
  const fTime = tf({ hour: "numeric", minute: "2-digit" });
  const fDate = tf({ weekday: "long", month: "long", day: "numeric" });
  const fHour = tf({ hour: "numeric" });
  const fHourNum = tf({ hour: "numeric", hourCycle: "h23" });
  const clockParts = (d) => fTime.format(d).replace(/\s?(AM|PM)$/, (m, p) => ` ${p}`);
  const hourLabel = (t) => fHour.format(new Date(t * 1000)).replace(" ", " ");
  const localHour = (t) => parseInt(fHourNum.format(new Date(t * 1000)), 10) % 24;
  function age(sec) {
    sec = Math.max(0, sec);
    if (sec < 90) return "just now";
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return sec < 6 * 3600 && m >= 5 ? `${h} h ${m} min` : `${h} h`;
  }
  const hash = (n) => ((Number(n) * 2654435761) >>> 0);
  const nowS = () => Date.now() / 1000;
  const u = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--u")) || Math.min(innerWidth / 100, innerHeight / 56.25);

  // animated numbers; a change washes its tile briefly
  function setNum(el, v, opts) {
    if (!el) return;
    v = Number(v) || 0;
    const prev = el._v;
    el._v = v;
    if (prev === undefined) { el.textContent = fmtN(v); return; }
    if (prev === v) return;
    flash(el.closest(".tile"));
    const t0 = performance.now(), dur = 900;
    cancelAnimationFrame(el._raf);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmtN(prev + (v - prev) * e);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }
  function flash(tile) {
    if (!tile || !booted) return;
    tile.classList.add("flash");
    clearTimeout(tile._ft);
    tile._ft = setTimeout(() => tile.classList.remove("flash"), 1400);
  }
  function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; return true; } return false; }

  async function getJSON(path, params) {
    const p = new URLSearchParams(Object.assign({ region: SLUG }, params || {}));
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(`${path}?${p}`, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(`${path} ${r.status}`);
      return await r.json();
    } finally { clearTimeout(to); }
  }

  // ------------------------------------------------------------ state
  const S = { pulse: null, day: null, weather: null, units: null, lastOk: 0, failing: false };
  let booted = false;

  // ------------------------------------------------------------ static skeleton
  function buildKinds() {
    const html = KINDS.map((k) => `
      <div class="tile kt k-${k}" id="kt-${k}">
        <div class="kt-head">${kico(k)}<div class="kt-label">${esc(KIND_LABEL[k])}</div></div>
        <div class="kt-body">
          <div class="kt-count"><span class="kt-num" id="ktn-${k}">0</span><span class="kt-sub">active</span></div>
          <div class="kt-spark">
            <div class="kt-day"><b id="ktd-${k}">0</b> in 24 h</div>
            <svg id="kts-${k}" aria-hidden="true"></svg>
            <div class="kt-now"><span>24 h ago</span><span>now</span></div>
          </div>
        </div>
      </div>`).join("") + `
      <div class="tile wx" id="wx">
        <div class="kt-head"><span class="wx-ico" id="wx-ico"></span><div class="kt-label" id="wx-text">Weather</div></div>
        <div class="wx-main">
          <span class="wx-temp" id="wx-temp">–</span>
          <div class="wx-side" id="wx-side"></div>
        </div>
      </div>`;
    $("kinds").innerHTML = html;

    $("pipe").innerHTML = PIPE.map((s) => `
      <div class="stage s-${s}" id="st-${s}">
        <div class="stage-top"><span class="stage-ico"><svg viewBox="0 0 24 24">${STATUS[s].ico}</svg></span><span class="stage-num" id="stn-${s}">0</span></div>
        <div class="stage-label">${esc(PIPE_LABEL[s])}</div>
      </div>`).join("");

    $("units").innerHTML = SERVICES.map(([k, name]) => `
      <div class="urow" id="ur-${k}">
        <div class="urow-name">${name}</div>
        <div class="ubar" id="ub-${k}"></div>
        <div class="urow-total"><b id="ut-${k}">0</b> out</div>
      </div>`).join("");
    $("units-legend").innerHTML = USTATES.map(([k, l]) =>
      `<span class="lg"><span class="sw" style="background:var(--u-${k})"></span>${l}</span>`).join("");

    const walls = (CFG.walls || []).map((w) =>
      `<a href="/live/${encodeURIComponent(SLUG)}/wall/${encodeURIComponent(w)}${location.search}" class="${w === "grid" ? "on" : ""}">${esc(w)}</a>`).join("");
    $("walls").innerHTML = walls + `<a href="/live/${encodeURIComponent(SLUG)}">live map</a>`;
    if (DEMO) $("demo-pill").hidden = false;
  }

  // ------------------------------------------------------------ derive the view model
  function derive() {
    const p = S.pulse;
    const now = nowS();
    let active = (p.active || []).slice();
    let byStatus = Object.assign({}, p.active_by_status || {});
    let unitsBy = p.units_by_service_status || {};
    let unitsOut = (p.headline || {}).units_out || 0;
    const dayItems = (S.day && S.day.items) || [];
    let cleared = dayItems.filter((i) => i.status === "cleared" || i.status === "ended").length;

    if (DEMO && dayItems.length) {
      // the last 24 h as if it were happening now; closed ones get a stable fake live status
      const fake = ["new", "en_route", "on_scene", "on_scene", "quiet", "cleared"];
      const all = dayItems.map((i) => {
        let st = i.status;
        if (st === "ended" || st === "cleared") st = fake[hash(i.id) % fake.length];
        return Object.assign({}, i, { status: st });
      });
      active = all.filter((i) => i.status !== "cleared");
      cleared = all.length - active.length;
      byStatus = {};
      active.forEach((i) => { byStatus[i.status] = (byStatus[i.status] || 0) + 1; });
      if (S.units && S.units.items) {
        const fakeU = ["on_scene", "on_scene", "en_route", "busy", "available", "available"];
        unitsBy = {};
        S.units.items.forEach((x) => {
          const st = ugroup(x.status) || fakeU[hash(x.id) % fakeU.length];
          const svc = x.service || "other";
          (unitsBy[svc] = unitsBy[svc] || {})[st] = ((unitsBy[svc] || {})[st] || 0) + 1;
        });
        unitsOut = 0;
        Object.values(unitsBy).forEach((m) => { unitsOut += (m.on_scene || 0) + (m.en_route || 0) + (m.busy || 0); });
      }
    }
    const byKind = {};
    active.forEach((i) => { const k = KIND_LABEL[i.kind] ? i.kind : "other"; byKind[k] = (byKind[k] || 0) + 1; });
    const opened = p.opened_24h || {};
    const sev = { high: 0, medium: 1, low: 2 };
    const ranked = active.slice().sort((a, b) => {
      const sa = a.status === "quiet" ? 1 : 0, sb = b.status === "quiet" ? 1 : 0;
      if (sa !== sb) return sa - sb;
      const va = sev[a.severity] ?? 1.5, vb = sev[b.severity] ?? 1.5;
      if (va !== vb) return va - vb;
      return (b.last_at || 0) - (a.last_at || 0);
    });
    const unitsOnIncidents = active.reduce((n, i) => n + Object.values(i.units || {}).reduce((a, b) => a + (b || 0), 0), 0);
    return { now, active, ranked, byKind, byStatus, unitsBy, unitsOut: Math.max(unitsOut, unitsOnIncidents), cleared, opened, dayItems };
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!S.pulse) return;
    const v = derive();
    renderNow(v);
    renderKinds(v);
    renderPipe(v);
    renderUnits(v);
    renderList(v);
    renderMap(v);
    renderVolume();
    booted = true;
  }

  function sentence(v) {
    const p = S.pulse, h = p.headline || {};
    const n = v.active.length;
    const parts = [];
    const c1 = h.calls_1h || 0, c0 = h.calls_prev_1h || 0;
    let pace = "";
    if (c1 + c0 > 0) {
      const r = c0 ? c1 / c0 : 2;
      pace = r > 1.15 ? "Radio is <b>busier</b> than the hour before." : r < 0.85 ? "Radio is <b>quieter</b> than the hour before." : "Radio is about as busy as the hour before.";
    }
    if (!n) {
      const tot = Object.values(v.opened).reduce((a, b) => a + b, 0);
      parts.push(tot ? `${plural(tot, "incident")} came and went in the last 24 hours.` : "Nothing needs attention right now.");
      if (pace) parts.push(pace);
      return parts.join(" ");
    }
    const kinds = Object.entries(v.byKind).sort((a, b) => b[1] - a[1]);
    const top = kinds.slice(0, 3).map(([k, c]) => `${c} ${KIND_WORD[k][0]}`);
    const rest = kinds.slice(3).reduce((a, [, c]) => a + c, 0);
    if (rest) top.push(`${rest} other`);
    parts.push(`<b>${plural(n, "active incident")}</b> — ${listJoin(top)}.`);
    const hi = v.active.filter((i) => i.severity === "high").length;
    if (hi) parts.push(`${hi === 1 ? "One is" : fmtN(hi) + " are"} high priority.`);
    parts.push(v.unitsOut ? `<b>${plural(v.unitsOut, "unit")}</b> out.` : "No units reported out.");
    if (pace) parts.push(pace);
    return parts.join(" ");
  }
  const listJoin = (a) => a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

  function renderNow(v) {
    const p = S.pulse, h = p.headline || {};
    const n = v.active.length;
    $("now-quiet").hidden = n > 0;
    $("now-num").parentElement.hidden = n === 0;
    setNum($("now-num"), n);
    $("now-unit").textContent = n === 1 ? "active incident" : "active incidents";
    setHTML($("now-sentence"), sentence(v));
    setNum($("f-units"), v.unitsOut);
    setNum($("f-calls"), h.calls_1h || 0);
    setNum($("f-opened"), DEMO ? v.dayItems.length : (h.opened_24h || 0));
    const lag = (p.pipeline || {}).lag_sec || 0;
    $("lag").hidden = lag <= 600;
    if (lag > 600) $("lag").textContent = `Catching up · transcripts ${lag >= 5400 ? (Math.round(lag / 1800) / 2) + " h" : Math.round(lag / 60) + " min"} behind`;
    const lc = p.last_call;
    if (lc && lc.start_time) {
      const ago = nowS() - lc.start_time;
      const when = ago > 1800 ? `${age(ago)} ago` : fTime.format(new Date(lc.start_time * 1000));
      setHTML($("now-last"), `Last processed call <b>${esc(when)}</b> · ${esc(lc.talkgroup_tag || "")}${lc.call_line ? ` — “${txt(lc.call_line)}”` : ""}`);
    } else setHTML($("now-last"), "");
  }

  function renderKinds(v) {
    const hourly = S.pulse.incidents_by_hour || [];
    const curH = 23;
    KINDS.forEach((k) => {
      const n = v.byKind[k] || 0;
      const tile = $("kt-" + k);
      tile.classList.toggle("zero", n === 0);
      setNum($("ktn-" + k), n);
      const day = DEMO ? v.dayItems.filter((i) => (i.kind || "other") === k).length : (v.opened[k] || 0);
      setNum($("ktd-" + k), day);
      spark($("kts-" + k), hourly.map((hh) => hh[k] || 0), curH);
    });
  }

  // 24 tiny columns, de-emphasis gray; the current hour wears the kind color
  function spark(svg, vals, cur) {
    if (!svg) return;
    const W = Math.max(40, svg.clientWidth || svg.parentElement.clientWidth), H = Math.max(16, svg.clientHeight || 40);
    const n = vals.length || 24, slot = W / n, bw = Math.max(2, Math.min(24, slot - 2));
    const max = Math.max(1, ...vals);
    let out = `<line x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}" stroke="var(--hair)" stroke-width="1"/>`;
    vals.forEach((x, i) => {
      const xx = i * slot + (slot - bw) / 2;
      const isCur = i === cur;
      const fill = isCur ? "var(--kc)" : "var(--spark)";
      if (!x) {
        out += `<rect x="${xx.toFixed(1)}" y="${H - 2}" width="${bw.toFixed(1)}" height="2" rx="1" fill="${isCur ? "var(--kc)" : "var(--hair)"}"/>`;
        return;
      }
      const bh = Math.max(4, (x / max) * (H - 2));
      out += `<path d="${colPath(xx, H, bw, bh, Math.min(4, bw / 2))}" fill="${fill}"/>`;
    });
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    setHTML(svg, out);
  }
  // column with rounded data end, square at the baseline
  function colPath(x, base, w, h, r) {
    r = Math.min(r, h, w / 2);
    const y = base - h;
    return `M${x.toFixed(1)},${base}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + r).toFixed(1)}V${base}Z`;
  }

  function renderPipe(v) {
    PIPE.forEach((s) => {
      const n = s === "cleared" ? v.cleared : (v.byStatus[s] || 0);
      $("st-" + s).classList.toggle("zero", n === 0);
      setNum($("stn-" + s), n);
    });
  }

  function renderUnits(v) {
    const by = v.unitsBy || {};
    let any = false, heard = 0;
    const tot = SERVICES.map(([k]) => {
      const m = by[k] || {};
      const g = { on_scene: 0, en_route: 0, busy: 0, available: 0 };
      Object.entries(m).forEach(([st, n]) => { const gg = ugroup(st); if (gg) g[gg] += n; else heard += n; });
      return [k, g];
    });
    const maxRow = Math.max(1, ...tot.map(([, g]) => g.on_scene + g.en_route + g.busy + g.available));
    tot.forEach(([k, g]) => {
      const sum = g.on_scene + g.en_route + g.busy + g.available;
      if (sum) any = true;
      setNum($("ut-" + k), g.on_scene + g.en_route + g.busy);
      // bars share one scale (longest row = full width) so services compare honestly
      const segs = USTATES.filter(([s]) => g[s] > 0).map(([s, l]) => {
        const w = g[s] / maxRow;
        const label = (w * ($("ub-" + k).clientWidth || 300)) > u() * 1.6 ? g[s] : "";
        return `<div class="useg" title="${l}: ${g[s]}" style="flex:${w} 1 0;background:var(--u-${s});color:var(--u-ink-${s})">${label}</div>`;
      });
      const rest = 1 - sum / maxRow;
      if (rest > 0.001) segs.push(`<div class="useg track" style="flex:${rest} 1 0">${sum ? "" : "none heard"}</div>`);
      setHTML($("ub-" + k), segs.join(""));
    });
    const scope = DEMO ? "demo · all units heard" : "last 4 hours";
    $("units-note").textContent = any ? scope + (heard ? ` · +${heard} status unknown` : "") : (heard ? `${heard} heard, status unknown` : "none heard in 4 hours");
  }

  function renderList(v) {
    const max = 7;
    let rows = [], title, note = "";
    const activeIds = new Set(v.active.map((i) => i.id));
    const past = v.dayItems.filter((i) => !activeIds.has(i.id) && (i.status === "ended" || i.status === "cleared" || DEMO))
      .sort((a, b) => (b.last_at || 0) - (a.last_at || 0)).slice(0, max);
    const pastRows = past.map((i) => row(Object.assign({}, i, { status: "cleared" }), v.now, true));
    if (v.ranked.length) {
      title = "Top active";
      rows = v.ranked.slice(0, max).map((i) => row(i, v.now, false));
      if (rows.length < max && pastRows.length) rows.push(`<li class="row-sep">Earlier today</li>`, ...pastRows.slice(0, max - rows.length));
    } else {
      title = "Earlier today";
      note = past.length ? "nothing active · most recent first" : "";
      rows = pastRows.length ? pastRows : [`<li class="empty-list">No incidents in the last 24 hours.</li>`];
    }
    $("list-title").textContent = title;
    const html = rows.join("");
    const box = $("rows");
    const before = new Set([...box.querySelectorAll("[data-id]")].map((e) => e.dataset.id));
    if (setHTML(box, html) && booted) {
      box.querySelectorAll("[data-id]").forEach((e) => { if (!before.has(e.dataset.id) && !e.classList.contains("dim")) e.classList.add("fresh-row"); });
    }
    // show only the rows that fit whole; the note says how many more there are
    let shown = 0;
    const lim = box.clientHeight + 1;
    const items = [...box.children];
    items.forEach((e) => { e.hidden = false; });
    items.forEach((e) => {
      const fits = e.offsetTop - box.offsetTop + e.offsetHeight <= lim;
      e.hidden = !fits;
      if (fits && e.classList.contains("row") && !e.classList.contains("dim")) shown++;
    });
    const sep = box.querySelector(".row-sep");
    if (sep && (!sep.nextElementSibling || sep.nextElementSibling.hidden)) sep.hidden = true;
    if (v.ranked.length) note = v.ranked.length > shown ? `${v.ranked.length - shown} more active` : "most urgent first";
    $("list-note").textContent = note;
  }
  function row(i, now, dim) {
    const k = KIND_LABEL[i.kind] ? i.kind : "other";
    const units = Object.values(i.units || {}).reduce((a, b) => a + (b || 0), 0);
    const place = [i.location, i.city && !(i.location || "").includes(i.city) ? i.city : null].filter(Boolean).join(", ");
    const meta = [place ? txt(place) : `<span style="color:var(--ink-3)">place not given</span>`,
      units ? plural(units, "unit") : null].filter(Boolean).join('<span class="sep">·</span>');
    const ago = dim ? `${age(now - (i.last_at || now))} ago` : age(now - (i.first_at || now));
    const hi = !dim && i.severity === "high" ? '<span class="hi-pill">High</span>' : "";
    return `<li class="row${dim ? " dim" : ""}" data-id="${esc(i.id)}">
      ${kico(k)}
      <div class="row-main"><div class="row-title">${hi}${txt(i.title || KIND_LABEL[k])}</div><div class="row-meta">${meta}</div></div>
      <div class="row-right">${chip(i.status)}<span class="row-age">${esc(ago)}</span></div>
    </li>`;
  }

  // ------------------------------------------------------------ map
  let map = null, layer = null;
  function initMap() {
    if (!window.L || map) return;
    const r = CFG.region || {};
    map = L.map("map", {
      zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, touchZoom: false, tap: false, zoomSnap: 0.25, fadeAnimation: false,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    fitMap();
    layer = L.layerGroup().addTo(map);
    map.attributionControl.setPrefix(false);
    void r;
  }
  function fitMap() {
    if (!map) return;
    const r = CFG.region || {};
    if (r.bbox_north != null) map.fitBounds([[r.bbox_south, r.bbox_west], [r.bbox_north, r.bbox_east]], { padding: [8, 8] });
    else map.setView([r.default_lat || 26.2, r.default_lng || -98.2], 10);
  }
  function renderMap(v) {
    if (!map) initMap();
    if (!map) { $("map-note").textContent = "map unavailable"; return; }
    const pts = v.active.filter((i) => i.lat != null && i.lng != null);
    const past = v.active.length ? [] : v.dayItems.filter((i) => i.lat != null && i.lng != null);
    const key = JSON.stringify([pts.map((i) => [i.id, i.kind, i.status]), past.map((i) => i.id), Math.round(u())]);
    if (key !== map._key) {
      map._key = key;
      layer.clearLayers();
      const s = Math.round(u() * 1.5);
      past.forEach((i) => layer.addLayer(L.marker([i.lat, i.lng], {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: "", html: `<div class="pin past"></div>`, iconSize: [s * 0.5, s * 0.5] }),
      })));
      pts.forEach((i) => {
        const k = KIND_LABEL[i.kind] ? i.kind : "other";
        const live = i.status === "new" || i.status === "en_route";
        layer.addLayer(L.marker([i.lat, i.lng], {
          interactive: false, keyboard: false, zIndexOffset: live ? 500 : 0,
          icon: L.divIcon({ className: "", html: `<div class="pin k-${k}${live ? " pulse" : ""}" style="position:relative">${kindSvg(k)}</div>`, iconSize: [s, s] }),
        }));
      });
    }
    const unplaced = v.active.length - pts.length;
    $("map-note").textContent = v.active.length
      ? `${plural(pts.length, "incident")} mapped${unplaced ? ` · ${unplaced} without a place` : ""}`
      : `nothing active · gray = earlier today (${past.length})`;
  }

  // ------------------------------------------------------------ 24h call volume
  function busiestHour() {
    const p = S.pulse;
    if (!p || !p.bins_10min) return null;
    const bins = p.bins_10min, start = p.bins_start;
    let best = null;
    for (let i = 0; i + 6 <= bins.length; i++) {
      const t = start + i * 600;
      if (localMinuteZero(t) === false) continue;
      const calls = bins.slice(i, i + 6).reduce((a, b) => a + b.calls, 0);
      if (!best || calls > best.calls) best = { i, calls, t };
    }
    if (!best) return null;
    best.label = `${hourLabel(best.t)}–${hourLabel(best.t + 3600)}`;
    return best;
  }
  // bins start at an arbitrary second; treat the bin containing the top of the hour as the hour's start
  function localMinuteZero(t) {
    const m = (Math.floor(t / 60) % 60 + 60) % 60;   // US zones are whole-hour offsets
    return m < 10;
  }

  function renderVolume() {
    const p = S.pulse, box = $("vol-chart");
    const bins = p.bins_10min || [], start = p.bins_start || (nowS() - 86400);
    const W = Math.max(200, box.clientWidth), H = Math.max(60, box.clientHeight);
    const U = u();
    const fs = Math.round(U * 0.95), axisH = Math.round(fs * 1.6), topPad = Math.round(fs * 1.7), labW = Math.round(U * 3.4);
    const plotW = W - labW, plotH = H - axisH - topPad, base = topPad + plotH;
    const n = bins.length || 144, slot = plotW / n, bw = Math.max(1, Math.min(24, slot - 2));
    const max = Math.max(1, ...bins.map((b) => b.calls));
    const nice = niceCeil(max);
    const y = (vv) => base - (vv / nice) * plotH;
    const peak = busiestHour();
    let s = "";
    // one recessive gridline at the nice max, labelled on the left
    s += `<line x1="${labW}" x2="${W}" y1="${y(nice).toFixed(1)}" y2="${y(nice).toFixed(1)}" stroke="var(--hair)" stroke-width="1"/>`;
    const mid = plotH > fs * 3.2;
    if (mid) s += `<line x1="${labW}" x2="${W}" y1="${y(nice / 2).toFixed(1)}" y2="${y(nice / 2).toFixed(1)}" stroke="var(--hair)" stroke-width="1"/>`;
    s += `<text class="ax" x="${labW - U * 0.5}" y="${y(nice) + fs * 0.35}" text-anchor="end" font-size="${fs}" style="font-variant-numeric:tabular-nums">${fmtN(nice)}</text>`;
    if (mid) s += `<text class="ax" x="${labW - U * 0.5}" y="${y(nice / 2) + fs * 0.35}" text-anchor="end" font-size="${fs}" style="font-variant-numeric:tabular-nums">${fmtN(nice / 2)}</text>`;
    s += `<text class="ax" x="${labW - U * 0.5}" y="${base + fs * 0.35}" text-anchor="end" font-size="${fs}">0</text>`;
    bins.forEach((b, i) => {
      if (!b.calls) return;
      const x = labW + i * slot + (slot - bw) / 2;
      const lastHour = i >= n - 6;
      const inPeak = peak && i >= peak.i && i < peak.i + 6;
      const fill = lastHour ? "var(--ink)" : inPeak ? "var(--ink-2)" : "var(--spark)";
      s += `<path d="${colPath(x, base, bw, Math.max(2, base - y(b.calls)), 4)}" fill="${fill}"/>`;
    });
    s += `<line x1="${labW}" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}" stroke="var(--base)" stroke-width="1"/>`;
    // hour ticks every 3 h (local)
    const firstHour = Math.ceil(start / 3600) * 3600;
    for (let t = firstHour; t < start + 86400; t += 3600) {
      if (localHour(t) % 3) continue;
      const x = labW + ((t - start) / 600) * slot;
      if (x > W - U * 4) continue;
      s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${base}" y2="${base + U * 0.35}" stroke="var(--base)"/>`;
      s += `<text class="ax" x="${x.toFixed(1)}" y="${base + axisH - fs * 0.25}" text-anchor="middle" font-size="${fs}">${esc(hourLabel(t))}</text>`;
    }
    // now marker at the right end
    const nx = W - 1;
    s += `<line x1="${nx}" x2="${nx}" y1="${topPad - fs * 0.2}" y2="${base + U * 0.35}" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>`;
    s += `<text class="ax-strong" x="${nx}" y="${base + axisH - fs * 0.25}" text-anchor="end" font-size="${fs}">now</text>`;
    // busiest hour annotation
    if (peak && peak.calls) {
      const x0 = labW + peak.i * slot, x1 = x0 + 6 * slot;
      const pk = Math.max(...bins.slice(peak.i, peak.i + 6).map((b) => b.calls));
      const ly = y(pk) - fs * 0.45;
      const cx = (x0 + x1) / 2;
      const anchor = cx < labW + U * 8 ? "start" : cx > W - U * 10 ? "end" : "middle";
      const tx = anchor === "start" ? x0 : anchor === "end" ? x1 : cx;
      s += `<line x1="${x0.toFixed(1)}" x2="${x1.toFixed(1)}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="var(--ink-2)" stroke-width="2" stroke-linecap="round"/>`;
      s += `<text class="ax-strong" x="${tx.toFixed(1)}" y="${(ly - fs * 0.4).toFixed(1)}" text-anchor="${anchor}" font-size="${fs}">Busiest · ${fmtN(peak.calls)}</text>`;
    }
    let svg = box.querySelector("svg");
    if (!svg) { box.innerHTML = '<svg aria-hidden="true"></svg>'; svg = box.querySelector("svg"); }
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    setHTML(svg, s);
    const total = bins.reduce((a, b) => a + b.calls, 0);
    const h = p.headline || {};
    $("vol-note").innerHTML = `<b style="color:var(--ink);font-weight:650">${fmtN(total)}</b> calls${peak && peak.calls ? ` · busiest ${esc(peak.label)} (${fmtN(peak.calls)})` : ""} · this hour <b style="color:var(--ink);font-weight:650">${fmtN(h.calls_1h || 0)}</b>`;
  }
  function niceCeil(v) {
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 5 ? 5 : 10) * e;
  }

  // ------------------------------------------------------------ weather
  const WX = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.3A3.4 3.4 0 0 0 7 18z"/>',
    rain: '<path d="M7 15h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.3A3.4 3.4 0 0 0 7 15z"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/>',
    storm: '<path d="M7 14h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.3A3.4 3.4 0 0 0 7 14z"/><path d="M12.5 15.5 10.5 19h3l-2 3"/>',
    fog: '<path d="M4 9h16M4 13h16M6 17h12"/>',
    wind: '<path d="M3 9h12a3 3 0 1 0-3-3M3 15h16a3 3 0 1 1-3 3"/>',
  };
  function wxIcon(text, isDay) {
    const t = (text || "").toLowerCase();
    if (/thunder|storm/.test(t)) return WX.storm;
    if (/rain|shower|drizzle/.test(t)) return WX.rain;
    if (/fog|haze|mist|smoke/.test(t)) return WX.fog;
    if (/wind|breez/.test(t)) return WX.wind;
    if (/cloud|overcast/.test(t) && !/partly sunny|mostly sunny/.test(t)) return WX.cloud;
    return isDay === false ? WX.moon : WX.sun;
  }
  const isWarning = (a) => /warning/i.test(a.event || "") || /extreme|severe/i.test(a.severity || "");
  function renderWeather() {
    const w = S.weather;
    if (!w) return;
    const now = w.now || {}, fc = w.forecast || [];
    const text = now.text || (fc[0] && fc[0].short) || "";
    const isDay = (() => { const h = localHour(nowS()); return h >= 7 && h < 19; })();
    $("wx-ico").innerHTML = `<svg viewBox="0 0 24 24">${wxIcon(text, isDay)}</svg>`;
    $("wx-temp").textContent = now.temp != null ? `${Math.round(now.temp)}°` : "–";
    const alerts = w.alerts || [];
    const warn = alerts.filter(isWarning);
    const adv = alerts.filter((a) => !isWarning(a));
    $("wx-text").textContent = text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : "Weather";
    const side = [];
    if (warn.length || adv.length) {
      const a = (warn[0] || adv[0]);
      const kindWord = ((a.event || "").match(/warning|watch|advisory|statement/i) || ["Alert"])[0];
      side.push(`<span class="wx-alert">⚠ ${esc(warn.length ? kindWord : a.event)}${alerts.length > 1 ? ` +${alerts.length - 1}` : ""}</span>`);
    } else if (now.feels != null && now.temp != null && Math.abs(now.feels - now.temp) >= 3) {
      side.push(`<span>feels <b>${Math.round(now.feels)}°</b></span>`);
    } else if (now.wind_mph != null) {
      side.push(`<span>${now.wind_mph ? `wind <b>${esc(now.wind_dir || "")} ${Math.round(now.wind_mph)}</b> mph` : "wind calm"}</span>`);
    }
    fc.slice(0, 2).forEach((f) => side.push(`<span>${esc(f.name)} <b>${f.temp != null ? Math.round(f.temp) + "°" : "–"}</b></span>`));
    setHTML($("wx-side"), side.slice(0, 3).join(""));
    $("wx").classList.toggle("alerting", warn.length > 0);
    const b = $("banner");
    if (warn.length) {
      const a = warn[0];
      $("banner-event").textContent = a.event || "Weather warning";
      $("banner-headline").textContent = a.headline || "";
      $("banner-more").textContent = warn.length > 1 ? `+${warn.length - 1} more warning${warn.length > 2 ? "s" : ""}` : "National Weather Service";
      if (b.hidden) { b.hidden = false; $("board").classList.add("warn"); requestAnimationFrame(render); }
    } else if (!b.hidden) { b.hidden = true; $("board").classList.remove("warn"); requestAnimationFrame(render); }
  }

  // ------------------------------------------------------------ clock + freshness
  function tick() {
    const d = new Date();
    $("clock-time").textContent = clockParts(d);
    $("clock-date").textContent = fDate.format(d);
    const ft = $("fresh-text"), fr = $("fresh");
    if (!S.lastOk) { ft.textContent = "Connecting…"; fr.classList.add("stale"); return; }
    const ago = Math.round((Date.now() - S.lastOk) / 1000);
    ft.textContent = ago < 5 ? "Updated just now" : ago < 90 ? `Updated ${ago}s ago` : `Updated ${Math.round(ago / 60)} min ago`;
    fr.classList.toggle("stale", ago > 60);
    $("conn").hidden = !S.failing;
  }

  // ------------------------------------------------------------ polling
  async function poll(name, fn, every) {
    try {
      S[name] = await fn();
      if (name === "pulse") { S.lastOk = Date.now(); S.failing = false; }
      if (name === "weather") renderWeather(); else render();
    } catch (e) {
      if (name === "pulse") S.failing = true;
      console.warn("[wall] " + name + " failed, keeping last data:", e && e.message);
    } finally {
      const wait = name === "pulse" && S.failing ? 8000 : every;
      setTimeout(() => poll(name, fn, every), wait);
    }
  }

  // burn-in care: emphasis slowly walks across the tiles
  function rotateSpot() {
    const tiles = [...document.querySelectorAll(".tile")];
    let i = 0;
    setInterval(() => {
      tiles.forEach((t) => t.classList.remove("spot"));
      tiles[i++ % tiles.length].classList.add("spot");
    }, 20000);
  }

  window.wallGrid = { S, render, renderWeather };   // for screenshot tests

  function start() {
    buildKinds();
    tick();
    setInterval(tick, 1000);
    initMap();
    poll("pulse", () => getJSON("/api/live/pulse"), 15000);
    poll("day", () => getJSON("/api/live/incidents", { window: "24h", limit: 300 }), 30000);
    poll("weather", () => getJSON("/api/live/weather"), 5 * 60000);
    if (DEMO) poll("units", () => getJSON("/api/live/units", { scope: "all" }), 30000);
    let rz;
    addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (map) { map.invalidateSize(); fitMap(); } render(); }, 200); });
    rotateSpot();
    setTimeout(() => location.reload(), 6 * 3600 * 1000);
  }
  start();
})();
