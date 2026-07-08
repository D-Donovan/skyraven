// Catalog loading + star styling — JS port of skyraven/catalogs.py helpers.
// Loads the compact web/data/catalog.json produced by tools/export_web_catalog.py.

export async function loadCatalog() {
  const resp = await fetch("./data/catalog.json");
  if (!resp.ok) throw new Error(`catalog.json: HTTP ${resp.status}`);
  const raw = await resp.json();
  return {
    // stars: [ra, dec, mag, name, cnst, bv|null] -> objects
    stars: raw.stars.map(([ra, dec, mag, name, cnst, bv]) => ({ ra, dec, mag, name, cnst, bv })),
    messier: raw.messier.map(([ra, dec, mag, name]) => ({ ra, dec, mag, name })),
    constellations: raw.constellations,
  };
}

// Approximate true star color from the B-V index (rgb 0-1). Port of _bv_color.
function bvColor(bv) {
  if (bv < -0.10) return [0.61, 0.70, 1.00]; // O/B blue
  if (bv < 0.30) return [0.79, 0.86, 1.00];  // A  blue-white
  if (bv < 0.58) return [1.00, 0.99, 0.96];  // F  white
  if (bv < 0.81) return [1.00, 0.96, 0.74];  // G  yellow
  if (bv < 1.40) return [1.00, 0.80, 0.53];  // K  orange
  return [1.00, 0.63, 0.47];                 // M  red-orange
}

// Greyscale-by-magnitude fallback. Port of _mag_color.
function magColor(mag) {
  if (mag <= 0.0) return [1.0, 1.0, 0.0];
  if (mag <= 1.0) return [1.0, 0.0, 0.0];
  if (mag <= 2.0) return [1.0, 1.0, 1.0];
  if (mag <= 3.0) return [0.78, 0.78, 0.78];
  if (mag <= 4.0) return [0.69, 0.69, 0.69];
  if (mag <= 5.0) return [0.55, 0.55, 0.55];
  return [0.39, 0.39, 0.39];
}

// Returns {color: [r,g,b] 0-1, size: px radius}. Brighter stars draw larger.
export function starStyle(mag, bv) {
  const size = mag <= 1.0 ? 2 : 1;
  const color = (bv === null || bv === undefined) ? magColor(mag) : bvColor(bv);
  return { color, size };
}

export function rgb(c) {
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}
