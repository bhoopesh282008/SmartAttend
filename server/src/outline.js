// Building outlines for the room check.
//
// A circle around one point is a blunt shape for a real building: a lecture hall in a long block can
// be 150 m from the point a lecturer happened to stand on. When the outline of the building is known
// (from OpenStreetMap), the check can use "how far outside the walls" instead. This file holds the
// geometry, and the one call to the public Overpass service, made only when a lecturer asks for it.
//
// Limits: only simple building outlines (OSM "ways") are read, not multipolygon relations (a courtyard
// building drawn as a relation is skipped); OSM may not map your building; a mapped outline can be a
// few metres off. All of that is why the outline is optional and the circle still works.
const EARTH_RADIUS_M = 6_371_000;
const RAD = Math.PI / 180;

// Metres east/north of a reference point (flat-earth, fine over a few hundred metres).
function project(lat, lng, lat0, lng0) {
  return {
    x: (lng - lng0) * Math.cos(lat0 * RAD) * EARTH_RADIUS_M * RAD,
    y: (lat - lat0) * EARTH_RADIUS_M * RAD,
  };
}

export function pointInPolygon(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const crosses = lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Metres from a point to the nearest wall; 0 when the point is inside the outline. */
export function distanceToPolygonM(lat, lng, ring) {
  if (pointInPolygon(lat, lng, ring)) return 0;
  const points = ring.map(([la, ln]) => project(la, ln, lat, lng));
  const origin = { x: 0, y: 0 };
  let best = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    best = Math.min(best, distanceToSegment(origin, points[i], points[(i + 1) % points.length]));
  }
  return best;
}

/** Keeps at most `maxPoints` of a ring, evenly spread. Plenty for a building at this scale. */
export function thinRing(ring, maxPoints = 120) {
  if (ring.length <= maxPoints) return ring;
  const step = ring.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => ring[Math.floor(i * step)]);
}

/** Reads the stored outline JSON; anything unusable is "no outline". */
export function parseOutline(json) {
  if (!json) return null;
  try {
    const ring = JSON.parse(json);
    const ok = Array.isArray(ring) && ring.length >= 3 && ring.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    return ok ? ring : null;
  } catch {
    return null;
  }
}

/**
 * Chooses the building from an Overpass "out geom" answer: the one that contains the point, or
 * failing that the nearest wall within `maxM`.
 */
export function pickBuilding(elements, lat, lng, maxM = 40) {
  let best = null;
  for (const el of elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 4) continue;
    const ring = el.geometry.map((p) => [p.lat, p.lon]);
    const closed = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
    if (!closed) continue;
    ring.pop(); // store without the repeated closing point
    const distance = distanceToPolygonM(lat, lng, ring);
    const candidate = { ring, distance, id: el.id, name: el.tags?.name ?? el.tags?.['name:en'] ?? null };
    if (!best || candidate.distance < best.distance) best = candidate;
  }
  return best && best.distance <= maxM ? best : null;
}

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Asks OpenStreetMap's Overpass service for building outlines near a point. Throws if it cannot be reached. */
export async function fetchBuildingOutline({ lat, lng, fetchImpl = fetch, url = OVERPASS_URL, timeoutMs = 12_000 }) {
  const query = `[out:json][timeout:10];way(around:60,${lat.toFixed(6)},${lng.toFixed(6)})["building"];out geom;`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SmartAttend/0.3 (classroom geofence outline; one request when a lecturer asks)',
    },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
  const body = await res.json();
  const building = pickBuilding(body.elements, lat, lng);
  return building ? { ring: thinRing(building.ring), osmId: building.id, name: building.name, distanceM: building.distance } : null;
}
