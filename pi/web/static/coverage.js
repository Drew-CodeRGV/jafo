// coverage.js — 3D antenna reception envelope.
//
// Renders the /api/coverage grid (max detection range per 1° bearing ×
// altitude band) as an interactive 3D dome. Three view modes mirror the
// upstream ADS-B-3D-Antenna-Range-Visualizer:
//   • Orbit — drag-to-orbit 3D coverage surface (slow auto-rotate)
//   • Top   — straight-down view, tar1090-style range rings
//   • Slice — vertical cross-section along one bearing: confirmed coverage,
//             geometrically-possible-but-unheard, and below-horizon
//
// Data reflects THIS antenna's real reception (local dump1090/readsb only).
// Lazy-initialised the first time the panel opens; render loop pauses when the
// panel is collapsed (see coverageSetActive, called from scanner.js).

(function () {
  "use strict";

  const DOME_R = 120;          // world units for the max range
  const DOME_H = 78;           // world units for the top altitude band
  const REFRESH_MS = 15000;    // re-poll cadence while the panel is open
  const RX_HEIGHT_FT = 50;     // assumed antenna height for the horizon line

  const COV = {
    active: false,
    inited: false,
    mode: "orbit",
    data: null,
    raf: null,
    pollTimer: null,
    // three.js
    scene: null, camera: null, renderer: null, dome: null, refGroup: null,
    // custom orbit controls
    theta: Math.PI * 0.25, phi: Math.PI * 0.32, radius: 300,
    target: null, dragging: false, lastX: 0, lastY: 0, autorotate: true,
    // slice
    slice2d: null, sliceCtx: null, sliceBearing: 0, sliceDrag: false,
  };

  // --- 5-stop cool→warm colormap (range low→high) -------------------------
  function ramp(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [
      [0.00, 0x24, 0x3b, 0x9a],  // deep blue
      [0.25, 0x16, 0x9b, 0xd7],  // cyan
      [0.50, 0x2e, 0xcc, 0x6a],  // green
      [0.75, 0xf2, 0xd1, 0x3c],  // yellow
      [1.00, 0xe8, 0x4a, 0x3a],  // red
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const a = stops[i - 1], b = stops[i];
        const f = (t - a[0]) / (b[0] - a[0] || 1);
        return [
          (a[1] + (b[1] - a[1]) * f) / 255,
          (a[2] + (b[2] - a[2]) * f) / 255,
          (a[3] + (b[3] - a[3]) * f) / 255,
        ];
      }
    }
    return [1, 0.29, 0.23];
  }

  // Circular linear interpolation to fill null bearings in one altitude ring.
  // Returns null if the band has no samples at all.
  function fillRing(row) {
    const n = row.length;
    const known = [];
    for (let i = 0; i < n; i++) if (typeof row[i] === "number") known.push(i);
    if (!known.length) return null;
    const out = row.slice();
    for (let j = 0; j < known.length; j++) {
      const a = known[j], b = known[(j + 1) % known.length];
      let span = (b - a + n) % n;
      if (span <= 1) continue;
      const va = row[a], vb = row[b];
      for (let k = 1; k < span; k++) {
        out[(a + k) % n] = va + (vb - va) * (k / span);
      }
    }
    return out;
  }

  // ---- geometry ----------------------------------------------------------
  function buildDome() {
    const d = COV.data;
    if (COV.dome) { COV.scene.remove(COV.dome); disposeObj(COV.dome); COV.dome = null; }
    if (!d || !d.grid || !d.grid.length) return;

    const nBear = d.grid.length;
    const nBand = d.bands.length;
    const maxR = d.max_range || 1;
    const topAlt = d.bands[nBand - 1].hi || 1;
    const hScale = DOME_R / maxR;
    const vScale = DOME_H / topAlt;

    // Transpose to rings per band; drop empty bands, fill gaps in the rest.
    const rings = [];   // {alt, radii[nBear]}
    for (let bi = 0; bi < nBand; bi++) {
      const raw = new Array(nBear);
      for (let b = 0; b < nBear; b++) raw[b] = d.grid[b][bi];
      const filled = fillRing(raw);
      if (filled) rings.push({ alt: (d.bands[bi].lo + d.bands[bi].hi) / 2, radii: filled });
    }
    if (!rings.length) return;

    // Prepend a ground skirt so the volume has a base (and a single band still
    // yields a surface).
    rings.unshift({ alt: 0, radii: rings[0].radii });

    const cols = nBear + 1;               // +1 to close the seam
    const rows = rings.length;
    const pos = [], col = [], idx = [];
    for (let r = 0; r < rows; r++) {
      const ring = rings[r];
      for (let c = 0; c < cols; c++) {
        const b = c % nBear;
        const rng = ring.radii[b];
        const az = (b * Math.PI) / 180;   // bearing → radians, 0 = north
        const R = rng * hScale;
        pos.push(R * Math.sin(az), ring.alt * vScale, -R * Math.cos(az));
        const [cr, cg, cb] = ramp(rng / maxR);
        col.push(cr, cg, cb);
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, bb = a + 1, cc = a + cols, dd = cc + 1;
        idx.push(a, cc, bb, bb, cc, dd);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      transparent: true, opacity: 0.92, roughness: 0.65, metalness: 0.05,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(geo, mat);

    // Wireframe overlay for the lattice look.
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.18 })
    );
    mesh.add(wire);

    COV.dome = mesh;
    COV.scene.add(mesh);
  }

  // Ground reference: concentric range rings, radial spokes, N/E/S/W labels.
  function buildReference() {
    if (COV.refGroup) { COV.scene.remove(COV.refGroup); disposeObj(COV.refGroup); }
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x2b3b57, transparent: true, opacity: 0.5 });
    const steps = 4;
    for (let s = 1; s <= steps; s++) {
      const rr = (DOME_R * s) / steps;
      const pts = [];
      for (let a = 0; a <= 360; a += 4) {
        const ar = (a * Math.PI) / 180;
        pts.push(new THREE.Vector3(rr * Math.sin(ar), 0, -rr * Math.cos(ar)));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    for (let a = 0; a < 360; a += 45) {
      const ar = (a * Math.PI) / 180;
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(DOME_R * Math.sin(ar), 0, -DOME_R * Math.cos(ar)),
      ]), mat));
    }
    const card = [["N", 0], ["E", 90], ["S", 180], ["W", 270]];
    for (const [txt, deg] of card) {
      const ar = (deg * Math.PI) / 180;
      const spr = makeLabel(txt);
      spr.position.set((DOME_R + 14) * Math.sin(ar), 2, -(DOME_R + 14) * Math.cos(ar));
      g.add(spr);
    }
    COV.refGroup = g;
    COV.scene.add(g);
  }

  function makeLabel(text) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = "#8fb3e0";
    x.font = "bold 40px monospace";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    spr.scale.set(16, 16, 1);
    return spr;
  }

  function disposeObj(obj) {
    obj.traverse && obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const m = Array.isArray(o.material) ? o.material : [o.material];
        m.forEach((x) => { if (x.map) x.map.dispose(); x.dispose(); });
      }
    });
  }

  // ---- scene setup -------------------------------------------------------
  function initScene() {
    const canvas = document.getElementById("cc-coverage-canvas");
    if (!canvas || typeof THREE === "undefined") return false;

    COV.scene = new THREE.Scene();
    COV.scene.background = new THREE.Color(0x070c15);
    COV.target = new THREE.Vector3(0, DOME_H * 0.33, 0);

    COV.camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
    COV.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    COV.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    COV.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(120, 220, 160);
    COV.scene.add(dir);

    buildReference();
    bindControls(canvas);
    resize();
    COV.inited = true;
    return true;
  }

  function applyCamera() {
    const t = COV.target;
    COV.camera.position.set(
      t.x + COV.radius * Math.sin(COV.phi) * Math.sin(COV.theta),
      t.y + COV.radius * Math.cos(COV.phi),
      t.z + COV.radius * Math.sin(COV.phi) * Math.cos(COV.theta)
    );
    COV.camera.lookAt(t);
  }

  function bindControls(canvas) {
    canvas.addEventListener("pointerdown", (e) => {
      COV.dragging = true; COV.lastX = e.clientX; COV.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!COV.dragging) return;
      const dx = e.clientX - COV.lastX, dy = e.clientY - COV.lastY;
      COV.lastX = e.clientX; COV.lastY = e.clientY;
      COV.theta -= dx * 0.008;
      COV.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, COV.phi - dy * 0.006));
    });
    const end = (e) => {
      COV.dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      COV.radius = Math.max(120, Math.min(900, COV.radius * (1 + Math.sign(e.deltaY) * 0.08)));
    }, { passive: false });
  }

  function resize() {
    const stage = document.getElementById("cov-stage");
    if (!stage || !COV.renderer) return;
    const w = stage.clientWidth || 600, h = stage.clientHeight || 360;
    COV.renderer.setSize(w, h, false);
    COV.camera.aspect = w / h;
    COV.camera.updateProjectionMatrix();
    if (COV.slice2d) sizeSlice();
    if (COV.mode === "slice") drawSlice();
  }

  function loop() {
    COV.raf = requestAnimationFrame(loop);
    if (!COV.active || COV.mode === "slice" || !COV.renderer) return;
    if (COV.mode === "orbit" && COV.autorotate && !COV.dragging) COV.theta += 0.0022;
    applyCamera();
    COV.renderer.render(COV.scene, COV.camera);
  }

  // ---- slice (2D vertical cross-section) ---------------------------------
  function ensureSlice() {
    if (COV.slice2d) return;
    const stage = document.getElementById("cov-stage");
    const c = document.createElement("canvas");
    c.className = "cov-slice hidden";
    stage.appendChild(c);
    COV.slice2d = c;
    COV.sliceCtx = c.getContext("2d");
    c.addEventListener("pointerdown", (e) => { COV.sliceDrag = true; sliceFromX(e); });
    c.addEventListener("pointermove", (e) => { if (COV.sliceDrag) sliceFromX(e); });
    const end = () => { COV.sliceDrag = false; };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointerleave", end);
  }

  function sliceFromX(e) {
    const r = COV.slice2d.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    COV.sliceBearing = Math.round(f * 359);
    drawSlice();
  }

  function sizeSlice() {
    const stage = document.getElementById("cov-stage");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    COV.slice2d.width = (stage.clientWidth || 600) * dpr;
    COV.slice2d.height = (stage.clientHeight || 360) * dpr;
    COV.sliceCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Radio horizon (nm) for a target at alt_ft given the receiver height.
  function horizonNm(altFt) {
    return 1.23 * (Math.sqrt(RX_HEIGHT_FT) + Math.sqrt(Math.max(0, altFt)));
  }

  function drawSlice() {
    const d = COV.data, ctx = COV.sliceCtx;
    if (!d || !ctx) return;
    const stage = document.getElementById("cov-stage");
    const W = stage.clientWidth || 600, H = stage.clientHeight || 360;
    const padL = 54, padR = 18, padT = 16, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxR = d.max_range || 1;
    const topAlt = d.bands[d.bands.length - 1].hi || 1;
    const X = (nm) => padL + (nm / maxR) * plotW;
    const Y = (ft) => padT + plotH - (ft / topAlt) * plotH;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#070c15";
    ctx.fillRect(0, 0, W, H);

    // Below-horizon region (geometrically impossible) — shaded.
    ctx.fillStyle = "rgba(120,140,170,0.07)";
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    for (let a = 0; a <= topAlt; a += topAlt / 60) {
      const hz = Math.min(maxR, horizonNm(a));
      ctx.lineTo(X(hz), Y(a));
    }
    ctx.lineTo(X(0), Y(topAlt));
    ctx.closePath();
    ctx.fill();

    // Confirmed coverage polygon for the chosen bearing.
    const bb = COV.sliceBearing % d.grid.length;
    ctx.fillStyle = "rgba(46,204,106,0.28)";
    ctx.strokeStyle = "#2ecc6a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    let drew = false;
    for (let bi = 0; bi < d.bands.length; bi++) {
      const rng = d.grid[bb][bi];
      if (typeof rng !== "number") continue;
      const alt = (d.bands[bi].lo + d.bands[bi].hi) / 2;
      ctx.lineTo(X(rng), Y(alt));
      drew = true;
    }
    ctx.lineTo(X(0), Y(topAlt));
    ctx.closePath();
    if (drew) { ctx.fill(); ctx.stroke(); }

    // Radio-horizon limit line (confirmed ≤ this is plausible; beyond ≈ impossible).
    ctx.strokeStyle = "#f2d13c";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let a = 0; a <= topAlt; a += topAlt / 80) {
      const hz = Math.min(maxR, horizonNm(a));
      a === 0 ? ctx.moveTo(X(hz), Y(a)) : ctx.lineTo(X(hz), Y(a));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Axes + ticks.
    ctx.strokeStyle = "#2b3b57";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = "#6f86a8";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    for (let s = 0; s <= 4; s++) {
      const nm = (maxR * s) / 4;
      ctx.fillText(Math.round(nm) + " nm", X(nm), padT + plotH + 14);
    }
    ctx.textAlign = "right";
    for (let s = 0; s <= 4; s++) {
      const ft = (topAlt * s) / 4;
      ctx.fillText(Math.round(ft / 1000) + "k", padL - 6, Y(ft) + 3);
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "#8fb3e0";
    ctx.font = "bold 11px monospace";
    ctx.fillText("BRG " + String(COV.sliceBearing).padStart(3, "0") + "°  ·  drag ↔ to rotate", padL + 4, padT + 12);
  }

  // ---- mode switching ----------------------------------------------------
  function setMode(mode) {
    COV.mode = mode;
    document.querySelectorAll("#cov-modes .cov-mode").forEach((b) =>
      b.classList.toggle("active", b.dataset.covMode === mode));
    const canvas = document.getElementById("cc-coverage-canvas");
    const slicing = mode === "slice";
    if (canvas) canvas.classList.toggle("hidden", slicing);
    if (slicing) {
      ensureSlice();
      COV.slice2d.classList.remove("hidden");
      sizeSlice();
      drawSlice();
    } else if (COV.slice2d) {
      COV.slice2d.classList.add("hidden");
    }
    if (mode === "top") { COV.phi = 0.02; COV.autorotate = false; }
    else if (mode === "orbit") { COV.phi = Math.min(COV.phi, Math.PI * 0.4) || Math.PI * 0.32; COV.autorotate = true; if (COV.phi < 0.1) COV.phi = Math.PI * 0.32; }
  }

  // ---- data --------------------------------------------------------------
  function renderOverlay(msg) {
    const ov = document.getElementById("cov-overlay");
    const canvas = document.getElementById("cc-coverage-canvas");
    if (!ov) return;
    if (msg) { ov.innerHTML = msg; ov.classList.remove("hidden"); if (canvas) canvas.classList.add("hidden"); }
    else { ov.classList.add("hidden"); if (canvas && COV.mode !== "slice") canvas.classList.remove("hidden"); }
  }

  function updateFooter() {
    const d = COV.data;
    const legend = document.getElementById("cov-legend");
    const stat = document.getElementById("cov-stat");
    if (legend) {
      legend.innerHTML =
        '<span class="cov-lg-lbl">0</span>' +
        '<span class="cov-lg-bar"></span>' +
        '<span class="cov-lg-lbl">' + (d ? Math.round(d.max_range) : 0) + ' nm</span>';
    }
    if (stat && d) {
      const src = d.receiver && d.receiver.source === "receiver.json" ? "RX locked" : "RX≈region";
      stat.textContent = `max ${Math.round(d.max_range)} nm · ${d.samples.toLocaleString()} hits · ${src}`;
    }
  }

  async function fetchData() {
    let d;
    try {
      const r = await fetch("/api/coverage");
      d = await r.json();
    } catch (e) { return; }
    COV.data = d;
    if (!d.available) {
      renderOverlay("📡 <b>No local ADS-B receiver</b><br>" +
        "Coverage is built from this node's own dump1090/readsb feed. " +
        "It appears here once a local decoder is running.");
      updateFooter();
      return;
    }
    const hasHits = d.grid && d.grid.some((row) => row.some((v) => typeof v === "number"));
    if (!hasHits) {
      renderOverlay("📡 <b>Listening…</b><br>The coverage dome fills in as aircraft are heard. Leave this open for a while.");
      updateFooter();
      return;
    }
    renderOverlay(null);
    buildDome();
    updateFooter();
    if (COV.mode === "slice") drawSlice();
  }

  // ---- public entry (called by scanner.js) -------------------------------
  function coverageSetActive(on) {
    COV.active = on;
    if (on) {
      if (!COV.inited && !initScene()) return;    // THREE missing → bail quietly
      resize();
      fetchData();
      if (!COV.pollTimer) COV.pollTimer = setInterval(() => { if (COV.active) fetchData(); }, REFRESH_MS);
      if (!COV.raf) loop();
    } else {
      if (COV.pollTimer) { clearInterval(COV.pollTimer); COV.pollTimer = null; }
      if (COV.raf) { cancelAnimationFrame(COV.raf); COV.raf = null; }
    }
  }

  window.coverageSetActive = coverageSetActive;

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("#cov-modes .cov-mode").forEach((b) =>
      b.addEventListener("click", () => setMode(b.dataset.covMode)));
    window.addEventListener("resize", () => { if (COV.active) resize(); });
  });
})();
