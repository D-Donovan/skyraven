// Projection — alt/az <-> screen (x, y) for the circular, zenith-centered chart.
// Faithful JS port of skyraven/projection.py (azimuthal-equidistant: zenith at the
// centre, horizon a circle of radius `radius`, distance from centre ~ (90 - el)).
//
// Returns SCREEN coordinates (y increases downward), matching the original:
//   X = cx + ray*sin(az), Y = cy + ray*cos(az)
// so North (az=0) is at the BOTTOM, South at TOP, East RIGHT, West LEFT.
// A y-up renderer should flip Y with (height - Y).

import { PI } from "./astro.js";

// Alt/Az (degrees) -> {x, y}. When exact is false, objects below the horizon are
// pushed just outside the circle (ray = radius + 2); when true, the linear formula
// is used regardless of sign (for the Sun/Moon discs).
export function project(az, el, cx, cy, radius, exact = false) {
  let ray;
  if (exact) ray = ((90.0 - el) * radius) / 90.0;
  else if (el >= 0.0) ray = ((90.0 - el) * radius) / 90.0;
  else ray = radius + 2;

  const azRad = ((2.0 * PI) * az) / 360.0;
  const x = cx + (ray * Math.sin(azRad));
  const y = cy + (ray * Math.cos(azRad));
  return { x, y };
}

export function rayValid(el) {
  return el >= 0.0;
}

export function rayValidDiameter(el, diameter) {
  return (el + (diameter / 2.0)) >= 0.0;
}

// Inverse of project: screen (x, y) -> {az, el} in degrees.
export function screenToAzEl(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  const ray = Math.sqrt((dx * dx) + (dy * dy));
  const el = 90.0 - ((ray * 90.0) / radius);
  let az = (Math.atan2(dx, dy) * 180.0) / Math.PI; // x = ray*sin(az), y = ray*cos(az)
  if (az < 0.0) az += 360.0;
  return { az, el };
}
