// ISS next-VISIBLE-pass — web port of the vestaboard iss_ephem1 idea.
//
// The original used PyEphem + a hand-pasted TLE and reported the next geometric
// pass. Here we:
//   1. fetch the LIVE TLE from api.wheretheiss.at (CORS-enabled, no API key), so
//      it stays fresh automatically;
//   2. propagate it with satellite.js (SGP4) — the JS stand-in for PyEphem;
//   3. search forward for the next pass above the horizon; and
//   4. keep only VISIBLE passes: the observer is in darkness (Sun well below the
//      horizon) AND the ISS itself is sunlit (not in Earth's shadow). The Sun
//      position reuses skyraven's own astro core for consistency.
//
// No API keys are carried over from the vestaboard project; this needs none.

import { daysSince1990, sunRaDec, localSiderealTime, calculatePosition } from "./astro.js";

const TLE_URL = "https://api.wheretheiss.at/v1/satellites/25544/tles";
const BUNDLED_TLE_URL = "./data/iss-tle.json";   // same-origin fallback (refreshed at deploy)
const EARTH_R_KM = 6378.137;
const MIN_PEAK_EL = 10;        // ignore marginal passes below this culmination (deg)
const SUN_DARK_EL = -6;        // observer "dark enough" when Sun is below this (deg)
const TLE_MAX_AGE_MS = 3 * 3600 * 1000;
const TLE_FETCH_TIMEOUT_MS = 8000;   // never hang the panel on a stalled network
const TLE_STALE_WARN_MS = 4 * 24 * 3600 * 1000;   // flag the epoch once it's this old

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

let tleCache = null;           // { satrec, fetchedAt }

// --- TLE fetch (cached) ----------------------------------------------------
// LIVE TLE from api.wheretheiss.at — aborted after a timeout so a network that
// silently drops the request (corporate proxy / endpoint security) can't hang us.
async function fetchLiveTle() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TLE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(TLE_URL, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();   // { line1, line2, ... }
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error(`TLE fetch timed out after ${TLE_FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// SAME-ORIGIN fallback baked in at deploy (tools/fetch_iss_tle.py) — works even
// when the live host is blocked or the app is fully offline (SW-cached).
async function fetchBundledTle() {
  const resp = await fetch(BUNDLED_TLE_URL);
  if (!resp.ok) throw new Error(`bundled TLE HTTP ${resp.status}`);
  return await resp.json();     // { line1, line2, tle_timestamp }
}

export async function getSatrec() {
  const sat = globalThis.satellite;
  if (!sat) throw new Error("satellite.js not loaded");
  const now = Date.now();
  if (tleCache && (now - tleCache.fetchedAt) < TLE_MAX_AGE_MS) return tleCache.satrec;
  let j, source = "live";
  try {
    j = await fetchLiveTle();
  } catch (liveErr) {
    if (tleCache) return tleCache.satrec;   // in-memory (even stale) beats the bundle
    try {
      j = await fetchBundledTle();          // last resort for blocked / offline networks
      source = "bundled";
    } catch {
      throw liveErr;                        // surface the live error — it's the informative one
    }
  }
  const satrec = sat.twoline2satrec(j.line1, j.line2);
  tleCache = { satrec, fetchedAt: now, source, tleTimestamp: j.tle_timestamp ?? null };
  console.log(`ISS TLE source: ${source}`
    + (j.tle_timestamp ? ` (published ${new Date(j.tle_timestamp * 1000).toISOString()})` : ""));
  return satrec;
}

// Which TLE the cached orbit came from: "live" | "bundled" | null (none yet).
export function getTleSource() {
  return tleCache ? tleCache.source : null;
}

// Unix seconds the cached TLE was published/generated (from tle_timestamp), or null.
export function getTleTimestamp() {
  return tleCache ? tleCache.tleTimestamp : null;
}

// --- geometry helpers ------------------------------------------------------
// Observer az/el (deg) of the satellite at `date`, plus its ECI position (km).
function look(satrec, observerGd, date) {
  const sat = globalThis.satellite;
  const pv = sat.propagate(satrec, date);
  if (!pv || !pv.position) return null;
  const gmst = sat.gstime(date);
  const ecf = sat.eciToEcf(pv.position, gmst);
  const la = sat.ecfToLookAngles(observerGd, ecf);
  return { az: la.azimuth * R2D, el: la.elevation * R2D, eci: pv.position };
}

// Sun's geocentric unit vector in ECI, and the observer's Sun elevation (deg),
// derived from skyraven's astro core for the absolute instant `date`.
function sunState(date, lat, lonE) {
  const dt = {
    y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate(),
    h: date.getHours(), mi: date.getMinutes(), s: date.getSeconds(),
  };
  const offset = date.getTimezoneOffset() / 60.0;
  const days = daysSince1990(dt, offset);
  const [sra, sdec] = sunRaDec(days);
  const lst = localSiderealTime(dt, lonE, offset);
  const obsEl = calculatePosition(lst, sra, sdec, lat).el;
  const ra = sra * 15 * D2R;
  const dec = sdec * D2R;
  const unit = { x: Math.cos(dec) * Math.cos(ra), y: Math.cos(dec) * Math.sin(ra), z: Math.sin(dec) };
  return { obsEl, unit };
}

// Is the satellite sunlit? (Outside Earth's cylindrical shadow.)
function issSunlit(eci, sun) {
  const dot = eci.x * sun.x + eci.y * sun.y + eci.z * sun.z;
  if (dot >= 0) return true;                       // on the sunward side
  const px = eci.x - dot * sun.x;
  const py = eci.y - dot * sun.y;
  const pz = eci.z - dot * sun.z;
  return Math.sqrt(px * px + py * py + pz * pz) > EARTH_R_KM;  // above the shadow cylinder
}

function visibleAt(date, eci, lat, lonE) {
  const sun = sunState(date, lat, lonE);
  return sun.obsEl < SUN_DARK_EL && issSunlit(eci, sun.unit);
}

// Cached orbit for the synchronous renderer (null until the first TLE loads).
export function getCachedSatrec() {
  return tleCache ? tleCache.satrec : null;
}

// Current ISS look angle + whether it's naked-eye visible right now.
// Returns { az, el, visible } (degrees); el < 0 means below the horizon.
export function issNow(satrec, { lat, lonE, heightKm = 0 }, date) {
  const observerGd = { longitude: lonE * D2R, latitude: lat * D2R, height: heightKm };
  const l = look(satrec, observerGd, date);
  if (!l) return { az: 0, el: -90, visible: false };
  if (l.el <= 0) return { az: l.az, el: l.el, visible: false };
  const sun = sunState(date, lat, lonE);
  const visible = sun.obsEl < SUN_DARK_EL && issSunlit(l.eci, sun.unit);
  return { az: l.az, el: l.el, visible };
}

// --- next visible pass -----------------------------------------------------
// Returns { rise:{date,az}, max:{date,el}, set:{date,az} } or null.
export function nextVisiblePass(satrec, { lat, lonE, heightKm = 0 }, start, hours = 48) {
  const observerGd = { longitude: lonE * D2R, latitude: lat * D2R, height: heightKm };
  const stepMs = 30 * 1000;
  const endMs = start.getTime() + hours * 3600 * 1000;

  let prev = null;       // { t, el }
  let riseT = null, peak = null;

  const azAt = (t) => { const l = look(satrec, observerGd, new Date(t)); return l ? l.az : 0; };

  for (let t = start.getTime(); t <= endMs; t += stepMs) {
    const l = look(satrec, observerGd, new Date(t));
    if (!l) { prev = null; continue; }
    const el = l.el;

    if (prev && prev.el < 0 && el >= 0) {           // rising through the horizon
      riseT = prev.t + (t - prev.t) * (0 - prev.el) / (el - prev.el);
      peak = { el: -90, t, az: 0, eci: l.eci };
    }
    if (riseT !== null && el > peak.el) peak = { el, t, az: l.az, eci: l.eci };

    if (riseT !== null && prev && prev.el >= 0 && el < 0) {   // setting
      const setT = prev.t + (t - prev.t) * (0 - prev.el) / (el - prev.el);
      if (peak.el >= MIN_PEAK_EL && visibleAt(new Date(peak.t), peak.eci, lat, lonE)) {
        return {
          rise: { date: new Date(riseT), az: azAt(riseT) },
          max: { date: new Date(peak.t), el: peak.el },
          set: { date: new Date(setT), az: azAt(setT) },
        };
      }
      riseT = null; peak = null;
    }
    prev = { t, el };
  }
  return null;
}

// Same as nextVisiblePass, but won't skip a pass that's already in progress.
// nextVisiblePass only detects a rise crossing *after* its start time, so if
// called mid-pass it reports the pass after this one. Here we start the scan
// a bit before `now` (long enough to cover any realistic pass duration) and,
// if the first result already ended before `now`, keep searching forward
// from its set time until we find one whose set is still ahead of us.
const LOOKBACK_MS = 15 * 60 * 1000;   // ISS passes rarely exceed ~12 min above 10°
export function nextOrCurrentVisiblePass(satrec, loc, now, hours = 48) {
  const endMs = now.getTime() + hours * 3600 * 1000;
  let searchStart = new Date(now.getTime() - LOOKBACK_MS);
  while (searchStart.getTime() < endMs) {
    const remainingHours = (endMs - searchStart.getTime()) / 3600000;
    const pass = nextVisiblePass(satrec, loc, searchStart, remainingHours);
    if (!pass) return null;
    if (pass.set.date.getTime() >= now.getTime()) return pass;  // active or upcoming
    searchStart = new Date(pass.set.date.getTime() + 1000);      // already over — keep looking
  }
  return null;
}

// --- panel render ----------------------------------------------------------
function fmtDate(date) {
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function fmtClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export async function updateIssPanel(location, settings, elId = "iss") {
  const el = document.getElementById(elId);
  if (!el) return;
  el.style.color = "var(--accent)";   // --accent already flips to red in night mode
  if (!globalThis.satellite) { el.textContent = "ISS — library unavailable"; return; }
  el.textContent = "ISS — computing next pass…";
  try {
    const satrec = await getSatrec();
    // TLE freshness — a quick current/needs-refresh flag rather than spelling out
    // the epoch date, so it fits inline on the header without adding height.
    const tleTs = getTleTimestamp();
    const tleAgeMs = tleTs ? (Date.now() - tleTs * 1000) : null;
    const isStale = tleAgeMs !== null && tleAgeMs > TLE_STALE_WARN_MS;
    const freshFlag = tleTs
      ? ` <span title="${isStale ? "TLE needs refresh" : "TLE current"} — epoch ${new Date(tleTs * 1000).toISOString()}" `
        + `style="display:inline-block;width:7px;height:7px;border-radius:50%;vertical-align:middle;`
        + (isStale
          ? `background:transparent;border:2px solid #ff3b30;box-sizing:border-box"></span>`
          : `background:var(--accent);border:2px solid var(--accent);box-sizing:border-box"></span>`)
      : "";
    const now = new Date();
    const pass = nextOrCurrentVisiblePass(satrec, { lat: location.lat, lonE: location.lon }, now, 48);
    if (!pass) {
      el.innerHTML = `<b>ISS</b>${freshFlag}<br>no visible pass in 48 h`;
      return;
    }
    const active = pass.rise.date.getTime() <= now.getTime();   // rise already happened, set hasn't
    const az = (a) => `${Math.round(a)}°`;
    const row = (label, time, detail) =>
      `<tr><td style="padding-right:8px">${label}</td>`
      + `<td style="padding-right:8px;text-align:right;font-variant-numeric:tabular-nums">${time}</td>`
      + `<td style="text-align:right;font-variant-numeric:tabular-nums">${detail}</td></tr>`;
    const passTable = `<table style="border-collapse:collapse;margin-top:2px">`
      + row("Rise", fmtClock(pass.rise.date), `az ${az(pass.rise.az)}`)
      + row("Max", fmtClock(pass.max.date), `alt ${Math.round(pass.max.el)}°`)
      + row("Set", fmtClock(pass.set.date), `az ${az(pass.set.az)}`)
      + `</table>`;
    el.innerHTML = `<b>ISS — ${active ? "visible now" : "next visible pass"}</b>${freshFlag}<br>`
      + `${fmtDate(pass.rise.date)}`
      + passTable;
  } catch (err) {
    el.innerHTML = `<b>ISS</b><br>unavailable (${err.message})`;
  }
}
