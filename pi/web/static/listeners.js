/* "N watching" → a map of where people are watching from, by city.
   Click any #watching element (or [data-listeners]) on the Briefing, map or Console.
   Data: GET /api/live/presence/map?region=…  (city centroids + counts only).        */
(function () {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const region = () => (window.JAFO_LIVE && (window.JAFO_LIVE.region?.slug || window.JAFO_LIVE.region)) || "rgv";
  let box = null, map = null, layer = null, timer = null, fitted = false;

  const css = `
  .lw-back{position:fixed;inset:0;z-index:3000;background:rgba(10,14,20,.45);display:grid;place-items:center;padding:16px}
  .lw{--b:#fff;--t:#141a24;--t2:#4a5464;--t3:#7a8494;--r:#e3e7ee;--a:#1d4fd8;background:var(--b);color:var(--t);width:min(720px,100%);max-height:calc(100dvh - 32px);
      border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;font:400 15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .lw{--b:#161c25;--t:#eef2f8;--t2:#c3cad6;--t3:#8c95a4;--r:#263040;--a:#7ea2ff}}
  :root[data-theme="dark"] .lw{--b:#161c25;--t:#eef2f8;--t2:#c3cad6;--t3:#8c95a4;--r:#263040;--a:#7ea2ff}
  .lw-h{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 10px}
  .lw-h h2{margin:0;font:750 20px/1.25 system-ui,sans-serif;flex:1}
  .lw-h p{margin:2px 0 0;color:var(--t3);font-size:13.5px}
  .lw-x{border:0;background:transparent;color:var(--t2);font-size:24px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px}
  .lw-map{height:min(46vh,360px);min-height:220px;border-top:1px solid var(--r);border-bottom:1px solid var(--r);isolation:isolate;z-index:0}
  .lw-list{overflow:auto;padding:6px 18px 4px;margin:0;list-style:none}
  .lw-list li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--r)}
  .lw-list li:last-child{border-bottom:0}
  .lw-list b{font-variant-numeric:tabular-nums}
  .lw-f{padding:8px 18px 14px;color:var(--t3);font-size:12px}
  .lw-tiles{filter:saturate(.55) brightness(1.02)}
  .lw-tiles.dark{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9) saturate(.5)}
  .lw-dot{background:rgba(29,79,216,.85);border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.35);color:#fff;
      display:grid;place-items:center;font:700 12px system-ui,sans-serif}`;

  function ensureStyle() {
    if (document.getElementById("lw-style")) return;
    const s = document.createElement("style"); s.id = "lw-style"; s.textContent = css; document.head.appendChild(s);
  }

  async function load() {
    let d;
    try { d = await (await fetch(`/api/live/presence/map?region=${encodeURIComponent(region())}`, { cache: "no-store" })).json(); }
    catch (e) { box.querySelector(".lw-h p").textContent = "Couldn't load listeners right now."; return; }
    const n = d.watching || 1, places = d.places || [];
    box.querySelector(".lw-h h2").textContent = `${n} ${n === 1 ? "person" : "people"} watching now`;
    box.querySelector(".lw-h p").textContent = places.length
      ? `From ${places.length} ${places.length === 1 ? "place" : "places"}${d.unknown ? `, plus ${d.unknown} we couldn't place` : ""}. Updated every 20 seconds.`
      : "We couldn't place anyone yet.";
    box.querySelector(".lw-list").innerHTML = places.map((p) => `<li><span>${esc(p.name)}</span><b>${p.n}</b></li>`).join("")
      + (d.unknown ? `<li><span style="color:var(--t3)">Unknown location</span><b>${d.unknown}</b></li>` : "");
    if (!map || !window.L) return;
    layer.clearLayers();
    const pts = [];
    for (const p of places) {
      if (p.lat == null) continue;
      const size = Math.round(22 + Math.min(26, Math.sqrt(p.n) * 8));
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html: `<div class="lw-dot" style="width:${size}px;height:${size}px">${p.n}</div>`, iconSize: [size, size] }) })
        .bindTooltip(`${esc(p.name)}: ${p.n} watching`, { direction: "top", offset: [0, -size / 2] }).addTo(layer);
      pts.push([p.lat, p.lng]);
    }
    if (!fitted && pts.length) {
      fitted = true;
      if (pts.length === 1) map.setView(pts[0], 7); else map.fitBounds(pts, { padding: [36, 36], maxZoom: 8 });
    }
  }

  function open() {
    if (box) return;
    ensureStyle();
    box = document.createElement("div");
    box.className = "lw-back";
    box.innerHTML = `<div class="lw" role="dialog" aria-modal="true" aria-labelledby="lw-h2">
      <div class="lw-h"><div style="flex:1"><h2 id="lw-h2">People watching now</h2><p>Loading…</p></div><button type="button" class="lw-x" aria-label="Close">×</button></div>
      <div class="lw-map" id="lw-map"></div>
      <ul class="lw-list"></ul>
      <div class="lw-f">Places are estimated by city from each viewer's internet address, looked up on JAFO's own server. Addresses are never stored or shown, and anything finer than a city is never shown. VPNs and phone networks can put people in the wrong city. IP geolocation: <a href="https://db-ip.com" target="_blank" rel="noopener" style="color:var(--a)">DB-IP.com</a> (CC BY 4.0).</div></div>`;
    document.body.appendChild(box);
    box.addEventListener("click", (e) => { if (e.target === box || e.target.closest(".lw-x")) close(); });
    document.addEventListener("keydown", onKey);
    if (window.L) {
      map = L.map("lw-map", { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([30, -97], 4);
      const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 12, subdomains: "abc", className: dark ? "lw-tiles dark" : "lw-tiles", attribution: "© OpenStreetMap contributors" }).addTo(map);
      layer = L.layerGroup().addTo(map);
      setTimeout(() => map && map.invalidateSize(), 60);
    } else box.querySelector(".lw-map").hidden = true;
    fitted = false;
    load();
    timer = setInterval(load, 20000);
  }
  function close() {
    clearInterval(timer); timer = null;
    document.removeEventListener("keydown", onKey);
    if (map) { map.remove(); map = null; }
    if (box) { box.remove(); box = null; }
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("#watching, [data-listeners]");
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    open();
  }, true);
  // make the existing counters look and act clickable
  function mark() {
    document.querySelectorAll("#watching").forEach((el) => {
      el.style.cursor = "pointer"; el.setAttribute("role", "button"); el.tabIndex = 0;
      el.title = "See where people are watching from";
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mark); else mark();
  window.openListeners = open;
})();
