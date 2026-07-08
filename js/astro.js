// Astronomy core — faithful JS port of skyraven/astro.py (itself a port of the
// original SkyRaven C++). Conventions are unchanged:
//   * RA and LST are in HOURS (0-24). Multiply by 15 for degrees.
//   * DEC, latitude, longitude are in DEGREES.
//   * Azimuth is degrees EAST from NORTH (0=N, 90=E, 180=S, 270=W).
//   * utcOffset (a.k.a. location_time) is the integer hours ADDED to local civil
//     time to reach UT (e.g. +5 for US Eastern Standard Time).
//
// Datetimes are passed as explicit civil components {y,mo,d,h,mi,s} so results
// never depend on the browser's local timezone — matching Python's naive datetimes.

// The original hard-codes this value of pi everywhere; keep it for faithful results.
export const PI = 3.14159265359;

// --- angle helpers ---------------------------------------------------------
export function norm360(value) {
  while (value < 0) value += 360.0;
  while (value > 360.0) value -= 360.0;
  return value;
}

export function norm24(value) {
  while (value < 0) value += 24.0;
  while (value > 24.0) value -= 24.0;
  return value;
}

export function toRad(value) {
  return (2.0 * PI) * (value / 360.0);
}

export function toDeg(value) {
  return (value * 180.0) / PI;
}

// Resolve atan() quadrant ambiguity given the signs of x and y.
export function adjustAmbiguity(x, y, value) {
  if (x >= 0.0 && y >= 0.0) return value;
  if (x < 0.0 && y >= 0.0) return 180.0 + value;
  if (x < 0.0 && y < 0.0) return 180.0 + value;
  if (x >= 0.0 && y < 0.0) return 360.0 + value;
  return value;
}

// --- time ------------------------------------------------------------------
// Julian Date for a (possibly fractional) calendar date.
export function julian(year, month, day) {
  if (month === 1 || month === 2) {
    year -= 1;
    month += 12;
  }
  const a = Math.trunc(year / 100.0);
  const b = 2 - a + Math.trunc(a / 4.0);
  const c = Math.trunc(365.25 * year);
  const d = Math.trunc(30.6001 * (month + 1));
  return b + c + d + day + 1720994.5;
}

// Add `hours` to a civil {y,mo,d,h,mi,s} and return the new components (UTC math,
// so day/month rollover is handled exactly like Python's datetime + timedelta).
function addHours(dt, hours) {
  const ms = Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s) + hours * 3600 * 1000;
  const x = new Date(ms);
  return {
    y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(),
    h: x.getUTCHours(), mi: x.getUTCMinutes(), s: x.getUTCSeconds(),
  };
}

// Local Sidereal Time (hours, 0-24). `dt` is civil time; `utcOffset` hours to add
// to reach UT; `longitude` East-positive degrees.
export function localSiderealTime(dt, longitude, utcOffset) {
  const u = addHours(dt, utcOffset);
  let ut = u.h + (u.mi / 60.0) + (u.s / 3600.0);
  const dday = u.d + (ut / 24.0);
  const jd = julian(u.y, u.mo, dday);

  const sJD = jd - 2451545.0;
  const t = sJD / 36525.0;
  let t0 = 6.697374558 + (2400.051336 * t) + (0.000025862 * t * t);
  t0 = norm24(t0);
  ut = ut * 1.002737909;
  ut = norm24(ut + t0);
  const gst = ut;
  return norm24(gst + (longitude / 15.0));
}

// Days since 1990-01-01 used by the sun/moon/planet routines.
export function daysSince1990(dt, gmtOffset) {
  const spanDays = (Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s)
    - Date.UTC(1990, 0, 1)) / 86400000.0;
  return spanDays + 1 + (gmtOffset / 24.0);
}

// --- Sun (epoch 1990) ------------------------------------------------------
export function sunRaDec(days) {
  const eg = 279.403303, wg = 282.768422, e = 0.016713;
  const n = norm360((360.0 / 365.242191) * days);
  let mo = n + eg - wg;
  if (mo < 0.0) mo += 360.0;
  const ec = (360.0 / PI) * e * Math.sin(toRad(mo));

  let yo = n + ec + eg;
  if (yo > 360.0) yo -= 360.0;

  const bo = 0.0;
  const e1 = 23.441884;
  const dd = (Math.sin(bo) * Math.cos(toRad(e1)))
    + (Math.cos(bo) * Math.sin(toRad(e1)) * Math.sin(toRad(yo)));
  const dec = toDeg(Math.asin(dd));

  const y = (Math.sin(toRad(yo)) * Math.cos(toRad(e1))) - (Math.tan(bo) * Math.sin(toRad(e1)));
  const x = Math.cos(toRad(yo));
  const a = adjustAmbiguity(x, y, toDeg(Math.atan(y / x)));
  return [a / 15.0, dec];
}

// --- Moon (epoch 1990) -----------------------------------------------------
export function kepler(manomaly) {
  const e = 0.016713, ee = 0.00000010, wg = 282.768422;
  const mRad = toRad(manomaly);
  let bigE = toRad(mRad); // original converts twice; harmless
  for (;;) {
    const d = bigE - (e * Math.sin(bigE)) - mRad;
    if (Math.abs(d) <= ee) break;
    bigE = bigE - (d / (1.0 - (e * Math.cos(bigE))));
  }
  const v2 = Math.sqrt((1.0 + e) / (1.0 - e)) * Math.tan(bigE / 2.0);
  const v = (Math.atan(v2) * 2.0) * (180.0 / PI);
  return norm360(v + wg);
}

export function moonPhaseRaDec(days) {
  const eg = 279.403303, wg = 282.768422, lo = 318.351648, po = 36.340410;

  const manomalySun = norm360(((360.0 / 365.242191) * days) + eg - wg);
  const longSun = kepler(manomalySun);
  const manomalyInRad = toRad(manomalySun);
  const sinManomaly = Math.sin(manomalyInRad);

  const bigL = norm360((13.1763966 * days) + lo);
  const mm = norm360(bigL - (0.1114041 * days) - po);
  const ae = 0.1858 * sinManomaly;
  const a3 = 0.37 * sinManomaly;
  const c = bigL - longSun;
  const cInRad = toRad(c);
  const mmInRad = toRad(mm);
  const ev = 1.2739 * Math.sin((2.0 * cInRad) - mmInRad);
  const mm1 = mm + ev - ae - a3;
  const mm1InRad = toRad(mm1);
  const ec = 6.2886 * Math.sin(mm1InRad);
  const a4 = 0.214 * Math.sin(2 * mm1InRad);
  const l1 = bigL + ev + ec - ae + a4;
  const v = 0.6583 * Math.sin(2 * toRad(l1 - longSun));
  const l11 = l1 + v;
  const theta = l11 - longSun;
  const phase = 0.5 * (1 - Math.cos(toRad(theta))) * 100.0;

  const n = norm360(318.510107 - (0.0529539 * days));
  const n1 = n - (0.16 * Math.sin(manomalyInRad));
  const bigY = Math.sin(toRad(l11) - toRad(n1)) * Math.cos(toRad(5.145396));
  const bigX = Math.cos(toRad(l11) - toRad(n1));
  const ym = adjustAmbiguity(bigX, bigY, toDeg(Math.atan(bigY / bigX))) + n1;
  const bm = toDeg(Math.asin(Math.sin(toRad(l11) - toRad(n1)) * Math.sin(toRad(5.145396))));
  const eObl = 23.441884;
  let dec = (Math.sin(toRad(bm)) * Math.cos(toRad(eObl)))
    + (Math.cos(toRad(bm)) * Math.sin(toRad(eObl)) * Math.sin(toRad(ym)));

  const y1 = (Math.sin(toRad(ym)) * Math.cos(toRad(eObl)))
    - (Math.tan(toRad(bm)) * Math.sin(toRad(eObl)));
  const x1 = Math.cos(toRad(ym));
  const ra = adjustAmbiguity(x1, y1, toDeg(Math.atan(y1 / x1))) / 15.0;

  dec = toDeg(Math.asin(dec));
  return [ra, dec, phase];
}

// --- Planets (epoch 1990) --------------------------------------------------
// {name, tp, bigE, w, e, a, i, u} — index 0..6 = Mercury..Neptune.
export const PLANETS = [
  { name: "Mercury", tp: 0.240852, bigE: 60.750646, w: 77.299833, e: 0.205633, a: 0.387099, i: 7.004540, u: 48.212740 },
  { name: "Venus", tp: 0.615211, bigE: 88.455855, w: 131.430236, e: 0.006778, a: 0.723332, i: 3.394535, u: 76.589820 },
  { name: "Mars", tp: 1.88092, bigE: 240.739474, w: 335.874939, e: 0.093396, a: 1.523688, i: 1.849736, u: 49.480308 },
  { name: "Jupiter", tp: 11.863075, bigE: 90.638185, w: 14.170747, e: 0.048482, a: 5.202561, i: 1.303613, u: 100.353142 },
  { name: "Saturn", tp: 29.47312, bigE: 287.690033, w: 92.861407, e: 0.055581, a: 9.554747, i: 2.488980, u: 113.576139 },
  { name: "Uranus", tp: 84.039492, bigE: 271.063148, w: 172.884833, e: 0.046321, a: 19.21814, i: 0.773059, u: 73.926961 },
  { name: "Neptune", tp: 164.79246, bigE: 282.349556, w: 48.009758, e: 0.009003, a: 30.109570, i: 1.770646, u: 131.670599 },
];

export function planetRaDec(days, index) {
  const p = PLANETS[index];
  const tp = p.tp, bigEepoch = p.bigE, w = p.w, e = p.e, a = p.a, i = p.i, u = p.u;

  const te = 1.00004, eeEpoch = 99.403308, we = 102.768413, ee = 0.016713;

  let np = (360.0 / 365.242191) * (days / tp);
  np = norm360(np);
  const mp = np + bigEepoch - w;
  let el = np + (360.0 / PI) * e * Math.sin(toRad(mp)) + bigEepoch;
  if (el > 360.0) el -= 360.0;
  if (el < 0.0) el += 360.0;
  const vp = el - w;
  const r = (a * (1 - (e * e))) / (1 + e * Math.cos(toRad(vp)));

  let ne = (360.0 / 365.242191) * (days / te);
  ne = norm360(ne);
  const me = ne + eeEpoch - we;
  let bigL = ne + (360.0 / PI) * ee * Math.sin(toRad(me)) + eeEpoch;
  if (bigL > 360.0) bigL -= 360.0;
  if (bigL < 0.0) bigL += 360.0;
  const ve = bigL - we;
  const bigR = (1 - (ee * ee)) / (1 + ee * Math.cos(toRad(ve)));

  let cy = Math.asin(Math.sin(toRad(el - u)) * Math.sin(toRad(i)));
  cy = toDeg(cy);
  let y = Math.sin(toRad(el - u)) * Math.cos(toRad(i));
  let x = Math.cos(toRad(el - u));
  let l1 = adjustAmbiguity(x, y, toDeg(Math.atan(y / x))) + u;
  if (l1 > 360) l1 -= 360.0;
  // (original has a quirky guard on L here; preserved faithfully)
  if (bigL < 0.0) l1 += 360.0;
  const r1 = r * Math.cos(toRad(cy));

  let lamda;
  if (index < 2) { // inner planets
    const bigA = Math.atan(
      (r1 * Math.sin(toRad(bigL - l1))) / (bigR - r1 * Math.cos(toRad(bigL - l1))));
    lamda = 180 + bigL + toDeg(bigA);
  } else { // outer planets
    lamda = Math.atan(
      (bigR * Math.sin(toRad(l1 - bigL))) / (r1 - bigR * Math.cos(toRad(l1 - bigL))));
    lamda = toDeg(lamda) + l1;
  }

  if (lamda > 360.0) lamda -= 360.0;
  if (lamda < 0.0) lamda += 360.0;
  let beta = Math.atan(
    (r1 * Math.tan(toRad(cy)) * Math.sin(toRad(lamda - l1)))
    / (bigR * Math.sin(toRad(l1 - bigL))));
  beta = toDeg(beta);

  const eObl = 23.440592;
  let d = Math.asin(
    Math.sin(toRad(beta)) * Math.cos(toRad(eObl))
    + Math.cos(toRad(beta)) * Math.sin(toRad(eObl)) * Math.sin(toRad(lamda)));
  d = toDeg(d);
  y = (Math.sin(toRad(lamda)) * Math.cos(toRad(eObl)))
    - (Math.tan(toRad(beta)) * Math.sin(toRad(eObl)));
  x = Math.cos(toRad(lamda));
  const ra = adjustAmbiguity(x, y, toDeg(Math.atan(y / x))) / 15.0;
  return [ra, d];
}

// --- Sunrise / sunset --------------------------------------------------------
// Standard "visible horizon" altitude: -50' for atmospheric refraction, minus
// the Sun's angular radius (~16') so we report first/last limb, not center.
const SUNRISE_ALT = -0.833;

// Sun's altitude (degrees) at civil time `civil` ({y,mo,d,h,mi,s}) for the given
// longitude/latitude, with `utcOffset` hours to add to reach UT.
function sunAltitudeAt(civil, longitude, latitude, utcOffset) {
  const days = daysSince1990(civil, utcOffset);
  const [ra, dec] = sunRaDec(days);
  const lst = localSiderealTime(civil, longitude, utcOffset);
  return calculatePosition(lst, ra, dec, latitude).el;
}

// Sunrise/sunset for the civil DATE in `dt` (time-of-day fields are ignored).
// Returns { rise, set, alwaysUp, alwaysDown }, where rise/set are {h, mi} in the
// same civil calendar used elsewhere (local time, given utcOffset to reach UT),
// or null if that edge doesn't occur that day (polar day/night).
export function sunTimes(dt, longitude, latitude, utcOffset) {
  const civilAt = (mins) => {
    const h = Math.floor(mins / 60);
    const mi = Math.floor(mins % 60);
    const s = Math.round((mins - Math.floor(mins)) * 60);
    return { y: dt.y, mo: dt.mo, d: dt.d, h, mi, s };
  };
  const altAt = (mins) => sunAltitudeAt(civilAt(mins), longitude, latitude, utcOffset);

  const STEP = 10; // minutes; fine enough to not miss a crossing, refined below
  let rise = null, set = null;
  let prevMins = 0, prevAlt = altAt(0);

  const bisect = (m0, a0, m1, a1) => {
    const risingEdge = a1 >= SUNRISE_ALT;
    for (let i = 0; i < 20; i++) {
      const mm = (m0 + m1) / 2;
      const am = altAt(mm);
      if ((am >= SUNRISE_ALT) === risingEdge && am !== a0) { m1 = mm; a1 = am; } else { m0 = mm; a0 = am; }
    }
    const mins = Math.round((m0 + m1) / 2);
    return { h: Math.floor(mins / 60) % 24, mi: mins % 60 };
  };

  for (let m = STEP; m <= 1439; m += STEP) {
    const mins = Math.min(m, 1439);
    const alt = altAt(mins);
    if (rise === null && prevAlt < SUNRISE_ALT && alt >= SUNRISE_ALT) rise = bisect(prevMins, prevAlt, mins, alt);
    if (set === null && prevAlt >= SUNRISE_ALT && alt < SUNRISE_ALT) set = bisect(prevMins, prevAlt, mins, alt);
    prevMins = mins;
    prevAlt = alt;
  }

  const alwaysUp = rise === null && set === null && prevAlt >= SUNRISE_ALT;
  const alwaysDown = rise === null && set === null && prevAlt < SUNRISE_ALT;
  return { rise, set, alwaysUp, alwaysDown };
}

// --- Moonrise / moonset ------------------------------------------------------
// Center-of-disk altitude at rise/set: the Moon's horizontal parallax (~0.95°)
// nearly cancels refraction (~34') plus its semidiameter (~16'), leaving ~+0.125°.
const MOONRISE_ALT = 0.125;

function moonAltitudeAt(civil, longitude, latitude, utcOffset) {
  const days = daysSince1990(civil, utcOffset);
  const [ra, dec] = moonPhaseRaDec(days);   // recomputed each step -> tracks fast motion
  const lst = localSiderealTime(civil, longitude, utcOffset);
  return calculatePosition(lst, ra, dec, latitude).el;
}

// Moonrise/moonset for the civil DATE in `dt` (time-of-day fields ignored).
// Same contract as sunTimes(): { rise, set, alwaysUp, alwaysDown } with rise/set
// as {h, mi} in local civil time, or null if that edge doesn't occur that date.
export function moonTimes(dt, longitude, latitude, utcOffset) {
  const civilAt = (mins) => {
    const h = Math.floor(mins / 60);
    const mi = Math.floor(mins % 60);
    const s = Math.round((mins - Math.floor(mins)) * 60);
    return { y: dt.y, mo: dt.mo, d: dt.d, h, mi, s };
  };
  const altAt = (mins) => moonAltitudeAt(civilAt(mins), longitude, latitude, utcOffset);

  const STEP = 10;
  let rise = null, set = null;
  let prevMins = 0, prevAlt = altAt(0);

  const bisect = (m0, a0, m1, a1) => {
    const risingEdge = a1 >= MOONRISE_ALT;
    for (let i = 0; i < 20; i++) {
      const mm = (m0 + m1) / 2;
      const am = altAt(mm);
      if ((am >= MOONRISE_ALT) === risingEdge && am !== a0) { m1 = mm; a1 = am; } else { m0 = mm; a0 = am; }
    }
    const mins = Math.round((m0 + m1) / 2);
    return { h: Math.floor(mins / 60) % 24, mi: mins % 60 };
  };

  for (let m = STEP; m <= 1439; m += STEP) {
    const mins = Math.min(m, 1439);
    const alt = altAt(mins);
    if (rise === null && prevAlt < MOONRISE_ALT && alt >= MOONRISE_ALT) rise = bisect(prevMins, prevAlt, mins, alt);
    if (set === null && prevAlt >= MOONRISE_ALT && alt < MOONRISE_ALT) set = bisect(prevMins, prevAlt, mins, alt);
    prevMins = mins;
    prevAlt = alt;
  }

  const alwaysUp = rise === null && set === null && prevAlt >= MOONRISE_ALT;
  const alwaysDown = rise === null && set === null && prevAlt < MOONRISE_ALT;
  return { rise, set, alwaysUp, alwaysDown };
}

// --- Coordinate transforms -------------------------------------------------
// RA/Dec -> {az, el} in degrees.
export function calculatePosition(lst, ra, dec, latitude) {
  let ha = lst - ra;
  ha = ((2.0 * PI) * ha * 15) / 360.0;
  const decR = ((2.0 * PI) * dec) / 360.0;
  const latR = ((2.0 * PI) * latitude) / 360.0;

  let el = Math.sin(decR) * Math.sin(latR);
  el = el + (Math.cos(decR) * Math.cos(latR) * Math.cos(ha));
  el = Math.asin(el);

  let az = Math.sin(decR) - (Math.sin(latR) * Math.sin(el));
  az = az / (Math.cos(latR) * Math.cos(el));
  if (az > 1.0) az = 1.0;
  if (az < -1.0) az = -1.0;
  az = Math.acos(az);
  if (az < 0.0) az = az + PI;

  az = (360.0 * az) / (2.0 * PI);
  el = (360.0 * el) / (2.0 * PI);

  if (Math.sin(ha) > 0.0) az = 360.0 - az;

  return { az, el };
}

// Alt/Az -> {ra (hours), dec (deg)} inverse, for tap-to-identify.
export function raDecFromAzEl(lst, az, el, latitude) {
  if (lst === 0.0) return { ra: 0.0, dec: 0.0 };

  const latR = ((2.0 * PI) * latitude) / 360.0;
  const azR = ((2.0 * PI) * az) / 360.0;
  const elR = ((2.0 * PI) * el) / 360.0;

  let dec = (Math.sin(elR) * Math.sin(latR)) + (Math.cos(elR) * Math.cos(latR) * Math.cos(azR));
  dec = Math.asin(dec);

  let ha = (Math.sin(elR) - (Math.sin(latR) * Math.sin(dec))) / (Math.cos(latR) * Math.cos(dec));
  ha = Math.acos(Math.max(-1.0, Math.min(1.0, ha)));
  if (Math.sin(azR) > 0) ha = (2.0 * PI) - ha;

  dec = (360.0 * dec) / (2.0 * PI);
  ha = (360.0 * ha) / (2.0 * PI);
  let ra = lst - (ha / 15.0);
  if (ra < 0.0) ra = 24.0 + ra;
  return { ra, dec };
}
