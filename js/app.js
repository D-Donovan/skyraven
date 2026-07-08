// SkyRaven web — Phase 2 renderer. Phase 1 sky rendering plus a settings panel
// (persisted to localStorage), browser geolocation "Locate", and night (red) mode.
//
// Canvas uses screen y-down (native), matching the original projection: with
// X = cx + ray*sin(az), Y = cy + ray*cos(az), North (az=0) is at the BOTTOM.

import {
  localSiderealTime, daysSince1990, calculatePosition, raDecFromAzEl,
  sunRaDec, moonPhaseRaDec, planetRaDec, PLANETS, toRad, sunTimes,
} from "./astro.js";
import { project, screenToAzEl, rayValid, rayValidDiameter } from "./projection.js";
import { loadCatalog, starStyle, rgb } from "./catalog.js";
import { updateIssPanel, getCachedSatrec, issNow, getTleTimestamp, getTleSource } from "./iss.js";

const STORE_KEY = "skyraven.web";
const STAR_NAME_CHOICES = ["None", "Bright", "Medium", "All"];

// Defaults mirror the Kivy app; overridden by anything saved in localStorage.
const LOCATION = { name: "Rochester, MN", lat: 44.02, lon: -92.47 };
const SETTINGS = {
  magLimit: 4.5,
  showGrid: true,
  showMessier: true,
  constNames: true,
  planetNames: true,
  starNames: 1,                 // 0=none,1=mag<=0.5,2=mag<=1.5,3=mag<=2.0
  nightMode: false,
  constColor: [175, 0, 0],      // RGB 0-255
};
// Snapshot for the settings panel's "reset" button — display settings only,
// location/name is left alone since that's a deliberate user choice, not a display pref.
const DEFAULT_SETTINGS = { ...SETTINGS };

// Non-canvas HUD text (top bar, status line, ISS panel, version) is driven by the
// --accent CSS var so night mode can flip it to red without duplicating the
// color logic in every element's inline style.
function applyAccentVar() {
  document.documentElement.style.setProperty("--accent", SETTINGS.nightMode ? "#c40000" : "#8fe0a0");
}

const $ = (id) => document.getElementById(id);
const canvas = $("sky");
const ctx = canvas.getContext("2d");
const issCanvas = $("iss-layer");          // transparent overlay; only the ISS marker
const issCtx = issCanvas.getContext("2d"); // is drawn here, so the sky needn't repaint
let issMarker = null;                      // {x, y, detail} for tap-to-identify

let catalog = null;
let markers = [];              // {x, y, detail} in CSS px, for tap-to-identify
let placed = [];              // placed label rects [x1,y1,x2,y2] for collision avoidance
const geom = { cx: 0, cy: 0, radius: 0 };

// --- persistence -----------------------------------------------------------
function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (raw.location) Object.assign(LOCATION, raw.location);
    if (raw.settings) Object.assign(SETTINGS, raw.settings);
  } catch { /* ignore corrupt store */ }
  applyAccentVar();
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ location: LOCATION, settings: SETTINGS }));
  } catch { /* storage full/blocked — non-fatal */ }
}

// --- color / night-mode tint ----------------------------------------------
// In night mode collapse any RGB (0-1) to a red-only luminance (dark adaptation).
function tint(c) {
  if (!SETTINGS.nightMode) return c;
  const lum = 0.30 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  return [lum, 0, 0];
}
const col = (c) => rgb(tint(c));

const C = {
  bg: [0.02, 0.02, 0.043],
  horizon: [0.6, 0.6, 0.6],
  grid: [0.18, 0.20, 0.28],
  ecliptic: [0.45, 0.38, 0.13],
  messier: [0.0, 1.0, 0.4],
  compass: [0.85, 0.85, 0.85],
  moonDark: [0.16, 0.16, 0.19],
  moonLit: [0.92, 0.91, 0.82],
  moonLabel: [0.85, 0.85, 0.85],
  planet: [0.27, 0.53, 1.0],
  planetName: [0.53, 0.67, 1.0],
  sun: [1.0, 0.87, 0.2],
  constName: [0.55, 0.55, 0.72],
  starName: [0.7, 0.7, 0.7],
  iss: [0.6, 1.0, 1.0],
};

// --- time ------------------------------------------------------------------
function nowParts() {
  const d = new Date();
  return {
    dt: { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(),
          h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() },
    offset: d.getTimezoneOffset() / 60.0,  // hours to add to local to reach UT
    display: d,
  };
}

// --- drawing helpers -------------------------------------------------------
function dot(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
}
function line(x1, y1, x2, y2, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
function overlaps(r) {
  for (const q of placed) {
    if (r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]) return true;
  }
  return false;
}
// Place a text label. center: anchor at (x,y); else left-middle. avoid: skip on collision.
function text(x, y, str, color, { center = false, size = 12, avoid = false } = {}) {
  ctx.font = `${size}px system-ui, sans-serif`;
  const w = ctx.measureText(str).width;
  const h = size;
  const x1 = center ? x - w / 2 : x;
  const y1 = y - h / 2;
  const rect = [x1, y1, x1 + w, y1 + h];
  if (avoid && overlaps(rect)) return;
  placed.push(rect);
  ctx.fillStyle = color;
  ctx.textAlign = center ? "center" : "left";
  ctx.textBaseline = "middle";
  ctx.fillText(str, x, y);
}
function xy(aa, exact = false) {
  return project(aa.az, aa.el, geom.cx, geom.cy, geom.radius, exact);
}

// Moon as its lit phase shape (frac = illuminated fraction 0..1). Port of _draw_moon.
function drawMoon(x, y, r, frac, waxing) {
  const dark = col(C.moonDark);
  const lit = col(C.moonLit);
  dot(x, y, r, dark);                                   // dark disc
  ctx.fillStyle = lit;                                  // lit half
  ctx.beginPath();
  if (waxing) ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2);
  else ctx.arc(x, y, r, Math.PI / 2, 3 * Math.PI / 2);
  ctx.fill();
  const a = Math.abs(Math.cos(Math.PI * frac)) * r;     // terminator half-width
  ctx.fillStyle = frac < 0.5 ? dark : lit;
  ctx.beginPath();
  ctx.ellipse(x, y, a, r, 0, 0, 2 * Math.PI);
  ctx.fill();
}

// --- overlays --------------------------------------------------------------
function drawGrid(lst) {
  const { cx, cy, radius } = geom;
  const g = col(C.grid);
  for (const alt of [30, 60]) {
    ctx.strokeStyle = g;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, ((90 - alt) / 90) * radius, 0, 2 * Math.PI);
    ctx.stroke();
  }
  for (let az = 0; az < 360; az += 45) {
    const p = project(az, 0, cx, cy, radius);
    line(cx, cy, p.x, p.y, g, 1);
  }
  drawEcliptic(lst);
}
function drawEcliptic(lst) {
  const { cx, cy, radius } = geom;
  const obl = toRad(23.4392911);
  const ecol = col(C.ecliptic);
  let prev = null;
  for (let deg = 0; deg <= 360; deg += 3) {
    const lam = toRad(deg);
    const dec = (Math.asin(Math.sin(obl) * Math.sin(lam)) * 180) / Math.PI;
    let ra = (Math.atan2(Math.cos(obl) * Math.sin(lam), Math.cos(lam)) * 180) / Math.PI / 15.0;
    if (ra < 0) ra += 24.0;
    const aa = calculatePosition(lst, ra, dec, LOCATION.lat);
    const p = project(aa.az, aa.el, cx, cy, radius);
    const cur = { up: aa.el >= 0, p };
    if (prev && prev.up && cur.up) line(prev.p.x, prev.p.y, p.x, p.y, ecol, 1);
    prev = cur;
  }
}
function fmtHM(t) {
  return t ? `${String(t.h).padStart(2, "0")}:${String(t.mi).padStart(2, "0")}` : "—";
}
function sunTimesText(dt, offset) {
  const t = sunTimes(dt, LOCATION.lon, LOCATION.lat, offset);
  if (t.alwaysUp) return "☀ up all day";
  if (t.alwaysDown) return "☀ down all day";
  return `☀ ${fmtHM(t.rise)} / ${fmtHM(t.set)}`;
}
function titleCase(name) {
  return name.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
function drawConstellations(lst) {
  const cline = col(SETTINGS.constColor.map((c) => c / 255));
  for (const [name, polys] of Object.entries(catalog.constellations)) {
    const upXY = [];
    for (const seg of polys) {
      const pts = seg.map(([ra, dec]) => calculatePosition(lst, ra, dec, LOCATION.lat));
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (a.el >= 0 && b.el >= 0) {
          const pa = xy(a), pb = xy(b);
          line(pa.x, pa.y, pb.x, pb.y, cline, 1);
        }
      }
      for (const p of pts) if (p.el >= 0) upXY.push(xy(p));
    }
    if (SETTINGS.constNames && upXY.length >= 3) {
      const lx = upXY.reduce((s, p) => s + p.x, 0) / upXY.length;
      const ly = upXY.reduce((s, p) => s + p.y, 0) / upXY.length;
      text(lx, ly, titleCase(name), col(C.constName), { center: true, size: 11, avoid: true });
    }
  }
}

// --- main render -----------------------------------------------------------
function draw() {
  if (!catalog) return;
  const { cx, cy, radius } = geom;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  markers = [];
  placed = [];

  const { dt, offset, display } = nowParts();
  const lst = localSiderealTime(dt, LOCATION.lon, offset);
  const days = daysSince1990(dt, offset);
  const [sra, sdec] = sunRaDec(days);   // needed early for Moon waxing/waning

  ctx.fillStyle = col(C.bg);
  ctx.fillRect(0, 0, w, h);

  if (SETTINGS.showGrid) drawGrid(lst);

  // horizon circle
  ctx.strokeStyle = col(C.horizon);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
  ctx.stroke();

  drawConstellations(lst);

  if (SETTINGS.showMessier) {
    for (const o of catalog.messier) {
      const aa = calculatePosition(lst, o.ra, o.dec, LOCATION.lat);
      if (aa.el > 0) {
        const p = xy(aa);
        dot(p.x, p.y, 1, col(C.messier));
        markers.push({ x: p.x, y: p.y, detail: `${o.name} — deep-sky object` });
      }
    }
  }

  // stars
  for (const st of catalog.stars) {
    if (st.mag > SETTINGS.magLimit) continue;
    const aa = calculatePosition(lst, st.ra, st.dec, LOCATION.lat);
    if (aa.el <= 0) continue;
    const p = xy(aa);
    const { color, size } = starStyle(st.mag, st.bv);
    dot(p.x, p.y, size, col(color));
    const label = st.name || st.cnst;
    markers.push({ x: p.x, y: p.y, detail: `${label} — star, mag ${st.mag.toFixed(1)}` });
    if (st.name && (
      (SETTINGS.starNames === 1 && st.mag <= 0.5)
      || (SETTINGS.starNames === 2 && st.mag <= 1.5)
      || (SETTINGS.starNames === 3 && st.mag <= 2.0))) {
      text(p.x + 4, p.y, st.name, col(C.starName), { avoid: true });
    }
  }

  // compass (N bottom, S top, E right, W left) — degree label inset toward
  // center so it never clips at the canvas edge.
  for (const [az, lbl, deg] of [[0, "N", "0°"], [180, "S", "180°"], [90, "E", "90°"], [270, "W", "270°"]]) {
    const p = project(az, 0, cx, cy, radius);
    text(p.x, p.y, lbl, col(C.compass), { center: true, size: 14 });
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const inset = 16;
    const dp = { x: p.x - (dx / len) * inset, y: p.y - (dy / len) * inset };
    text(dp.x, dp.y, deg, col(C.compass), { center: true, size: 10 });
  }

  // Moon
  const [mra, mdec, phase] = moonPhaseRaDec(days);
  const maa = calculatePosition(lst, mra, mdec, LOCATION.lat);
  if (rayValidDiameter(maa.el, 0.5)) {
    const p = xy(maa, true);
    const waxing = ((((mra - sra) % 24.0) + 24.0) % 24.0) < 12.0;
    drawMoon(p.x, p.y, 7, phase / 100.0, waxing);
    text(p.x + 9, p.y, `Moon ${phase.toFixed(0)}%`, col(C.moonLabel), { avoid: true });
    markers.push({ x: p.x, y: p.y, detail: `Moon — ${phase.toFixed(0)}% illuminated` });
  }

  // planets
  for (let idx = 0; idx < PLANETS.length; idx++) {
    const [ra, dec] = planetRaDec(days, idx);
    const aa = calculatePosition(lst, ra, dec, LOCATION.lat);
    if (rayValid(aa.el)) {
      const p = xy(aa);
      dot(p.x, p.y, 2, col(C.planet));
      markers.push({ x: p.x, y: p.y, detail: `${PLANETS[idx].name} — planet` });
      if (SETTINGS.planetNames) {
        text(p.x + 5, p.y, PLANETS[idx].name, col(C.planetName), { avoid: false });
      }
    }
  }

  // Sun
  const saa = calculatePosition(lst, sra, sdec, LOCATION.lat);
  if (rayValidDiameter(saa.el, 0.533)) {
    const p = xy(saa, true);
    dot(p.x, p.y, 4, col(C.sun));
    text(p.x + 8, p.y, "Sun", col(C.sun));
    markers.push({ x: p.x, y: p.y, detail: "Sun" });
  }

  // header
  $("clock").textContent = display.toLocaleString([], {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const ns = LOCATION.lat >= 0 ? "N" : "S";
  const ew = LOCATION.lon >= 0 ? "E" : "W";
  $("loc").innerHTML = `<b>${LOCATION.name || "SkyRaven"}</b> &nbsp; `
    + `${Math.abs(LOCATION.lat).toFixed(2)}°${ns}, ${Math.abs(LOCATION.lon).toFixed(2)}°${ew}`;
  $("suntimes").textContent = sunTimesText(dt, offset);

  drawISS();
}

// Draw ONLY the ISS marker, on its own transparent overlay — so animating it every
// 2 s during a pass never repaints the whole sky. Clears to nothing when not visible.
function drawISS() {
  const w = issCanvas.clientWidth, h = issCanvas.clientHeight;
  issCtx.clearRect(0, 0, w, h);
  issMarker = null;
  const satrec = getCachedSatrec();
  if (!satrec) return;
  const iss = issNow(satrec, { lat: LOCATION.lat, lonE: LOCATION.lon }, new Date());
  if (!(iss.visible && iss.el > 0)) return;   // marker only during a visible pass
  const { cx, cy, radius } = geom;
  const p = project(iss.az, iss.el, cx, cy, radius);
  const c = col(C.iss);
  issCtx.fillStyle = c;
  issCtx.beginPath();
  issCtx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
  issCtx.fill();
  issCtx.strokeStyle = c;                      // ring to set it apart from stars
  issCtx.lineWidth = 1.2;
  issCtx.beginPath();
  issCtx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
  issCtx.stroke();
  issCtx.fillStyle = c;
  issCtx.font = "12px system-ui, sans-serif";
  issCtx.textAlign = "left";
  issCtx.textBaseline = "middle";
  issCtx.fillText("ISS", p.x + 9, p.y);
  issMarker = { x: p.x, y: p.y, detail: `ISS — visible now, alt ${Math.round(iss.el)}°` };
}

// Brief highlight ring around a tapped object, drawn on the transient overlay
// canvas so it doesn't require repainting the whole sky. Auto-clears via drawISS().
let highlightTimer = null;
function flashHighlight(x, y) {
  clearTimeout(highlightTimer);
  issCtx.save();
  issCtx.strokeStyle = "#ffdf5e";
  issCtx.lineWidth = 2;
  issCtx.beginPath();
  issCtx.arc(x, y, 12, 0, 2 * Math.PI);
  issCtx.stroke();
  issCtx.restore();
  highlightTimer = setTimeout(drawISS, 550);
}

function identify(px, py) {
  const { cx, cy, radius } = geom;
  const aa = screenToAzEl(px, py, cx, cy, radius);
  const { dt, offset } = nowParts();
  const lst = localSiderealTime(dt, LOCATION.lon, offset);
  const rd = raDecFromAzEl(lst, aa.az, aa.el, LOCATION.lat);

  let nearestM = null, best = 18.0;
  const all = issMarker ? markers.concat(issMarker) : markers;
  for (const m of all) {
    const d = Math.hypot(m.x - px, m.y - py);
    if (d < best) { best = d; nearestM = m; }
  }
  if (nearestM) flashHighlight(nearestM.x, nearestM.y);
  const obj = nearestM ? `${nearestM.detail}   ·   ` : "";
  $("status").textContent = `${obj}Az ${aa.az.toFixed(1)}°  El ${aa.el.toFixed(1)}°   `
    + `RA ${rd.ra.toFixed(2)}h  Dec ${rd.dec.toFixed(1)}°`;
}

// Recompute + redraw the ISS next-visible-pass panel (async, fire-and-forget).
// Also refreshes the Settings panel's TLE line once the fetch resolves, so a
// panel that was opened before the TLE loaded (or is still open) doesn't get
// stuck showing "not yet loaded".
function refreshISS() {
  updateIssPanel(LOCATION, SETTINGS).then(() => {
    if (!$("overlay").hidden) fillPanel();
  });
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const cv of [canvas, issCanvas]) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  issCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  geom.cx = w / 2;
  geom.cy = h / 2;
  geom.radius = Math.min(w, h) / 2 - 14;
  draw();
}

// --- settings panel --------------------------------------------------------
function fillPanel() {
  $("set-name").value = LOCATION.name;
  $("set-lat").value = LOCATION.lat;
  $("set-lon").value = LOCATION.lon;
  $("set-mag").value = SETTINGS.magLimit;
  $("magval").textContent = `≤ ${SETTINGS.magLimit.toFixed(1)}`;
  $("set-starnames").value = STAR_NAME_CHOICES[SETTINGS.starNames];
  $("set-messier").checked = SETTINGS.showMessier;
  $("set-planets").checked = SETTINGS.planetNames;
  $("set-const").checked = SETTINGS.constNames;
  $("set-grid").checked = SETTINGS.showGrid;
  $("set-night").checked = SETTINGS.nightMode;

  const tleEl = $("set-tleinfo");
  if (tleEl) {
    const ts = getTleTimestamp();
    if (ts) {
      const src = getTleSource();
      const when = new Date(ts * 1000).toLocaleString([], {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
      tleEl.textContent = `ISS TLE epoch: ${when}${src ? ` (${src})` : ""}`;
    } else {
      tleEl.textContent = "ISS TLE: not yet loaded";
    }
  }
}

function applyPanel() {
  LOCATION.name = $("set-name").value.trim();
  const lat = parseFloat($("set-lat").value);
  const lon = parseFloat($("set-lon").value);
  if (Number.isFinite(lat)) LOCATION.lat = lat;
  if (Number.isFinite(lon)) LOCATION.lon = lon;
  SETTINGS.magLimit = parseFloat($("set-mag").value);
  $("magval").textContent = `≤ ${SETTINGS.magLimit.toFixed(1)}`;
  SETTINGS.starNames = Math.max(0, STAR_NAME_CHOICES.indexOf($("set-starnames").value));
  SETTINGS.showMessier = $("set-messier").checked;
  SETTINGS.planetNames = $("set-planets").checked;
  SETTINGS.constNames = $("set-const").checked;
  SETTINGS.showGrid = $("set-grid").checked;
  SETTINGS.nightMode = $("set-night").checked;
  applyAccentVar();
  saveStore();
  draw();
  refreshISS();   // location may have changed; night mode recolors the panel
}

function resetDisplaySettings() {
  Object.assign(SETTINGS, DEFAULT_SETTINGS);
  applyAccentVar();
  fillPanel();
  saveStore();
  draw();
  refreshISS();
}

function locate() {
  const st = $("set-locstatus");
  if (!navigator.geolocation) { st.textContent = "Geolocation not supported by this browser."; return; }
  st.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      LOCATION.lat = Number(pos.coords.latitude.toFixed(4));
      LOCATION.lon = Number(pos.coords.longitude.toFixed(4));
      if (!LOCATION.name || /,/.test(LOCATION.name)) {
        LOCATION.name = `${LOCATION.lat.toFixed(3)}, ${LOCATION.lon.toFixed(3)}`;
      }
      fillPanel();
      saveStore();
      draw();
      refreshISS();
      st.textContent = `Set to ${LOCATION.lat.toFixed(3)}, ${LOCATION.lon.toFixed(3)}`;
    },
    (err) => { st.textContent = `Location error: ${err.message}`; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 600000 },
  );
}

// Debounce free-typed fields (name/lat/lon) so a redraw + localStorage write doesn't
// fire on every keystroke; checkboxes/selects/range still apply immediately.
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
const applyPanelDebounced = debounce(applyPanel, 400);

function wirePanel() {
  $("gear").addEventListener("click", () => { fillPanel(); $("overlay").hidden = false; });
  $("set-close").addEventListener("click", () => { $("overlay").hidden = true; });
  $("set-reset").addEventListener("click", resetDisplaySettings);
  $("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") $("overlay").hidden = true; });
  $("set-locate").addEventListener("click", locate);
  const debouncedIds = new Set(["set-name", "set-lat", "set-lon"]);
  // live-apply on any control change
  for (const id of ["set-name", "set-lat", "set-lon", "set-mag", "set-starnames",
    "set-messier", "set-planets", "set-const", "set-grid", "set-night"]) {
    $(id).addEventListener("input", debouncedIds.has(id) ? applyPanelDebounced : applyPanel);
  }
}

// Version is sourced from sw.js's CACHE constant (e.g. "skyraven-v2026.07.03")
// so there's a single place to bump on each deploy.
async function loadVersion() {
  try {
    const res = await fetch("./sw.js");
    const src = await res.text();
    const m = src.match(/CACHE\s*=\s*"skyraven-v([^"]+)"/);
    return m ? m[1] : "unknown";
  } catch {
    return "unknown";
  }
}

canvas.addEventListener("pointerdown", (ev) => {
  const r = canvas.getBoundingClientRect();
  const px = ev.clientX - r.left, py = ev.clientY - r.top;
  const { cx, cy, radius } = geom;
  if (Math.hypot(px - cx, py - cy) > radius) return; // outside the drawn sky circle
  identify(px, py);
});
window.addEventListener("resize", resize);

(async function main() {
  loadStore();
  wirePanel();
  loadVersion().then((v) => { $("ver").textContent = `v${v}`; });
  $("status").textContent = "Loading star catalog…";
  try {
    catalog = await loadCatalog();
  } catch (err) {
    $("status").textContent = `Failed to load catalog: ${err.message} `
      + `(serve over http:// — file:// blocks fetch)`;
    return;
  }
  $("status").textContent = "Tap the sky to identify the nearest object.";
  resize();
  refreshISS();
  setInterval(draw, 60000);          // keep the live sky current
  setInterval(refreshISS, 600000);   // recompute the ISS pass every 10 min
  // While a visible pass is on, refresh ONLY the ISS overlay every 2 s so it glides
  // across — the sky canvas underneath is left untouched (no full repaint).
  setInterval(drawISS, 2000);

  // PWA: register the offline service worker (no-op on unsupported browsers).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();
