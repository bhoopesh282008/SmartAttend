import { distanceToPolygonM } from './outline.js';

const EARTH_RADIUS_M = 6_371_000;

// Beyond this reported error a GPS fix cannot prove anything about distance.
export const MAX_USABLE_ACCURACY_M = 100;
// A classroom position vaguer than this cannot anchor a room check at all.
export const MAX_ROOM_FIX_M = 200;
// How far a mapped building outline can be from the real walls.
export const OUTLINE_UNCERTAINTY_M = 5;

export function haversineM(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function metres(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

/**
 * Decides what the location evidence allows.
 *
 *   skipped  location checking is off for this lecture (or the room is not set)
 *   ok       a good fix, inside the room's radius
 *   review   missing, imprecise or borderline evidence: a person decides
 *   reject   a good fix that puts the student clearly outside the room
 *
 * Missing is not zero: a student who did not share a location is never treated as
 * being at distance 0. The reported accuracy is subtracted from the distance, so a
 * vague fix cannot make an honest student look far away. The same goes for the room
 * itself: its position has an error too, so that is subtracted as well.
 *
 * `room` is { lat, lng, accuracyM, outline }. With an `outline` (a ring of [lat, lng] for the
 * building) the distance is "metres outside the walls" and 0 anywhere inside; otherwise it is the
 * distance to the room's point.
 */
export function judgeLocation({ room, radiusM, location }) {
  const enabled = radiusM != null && room && room.lat != null && room.lng != null;
  if (!enabled) {
    return { action: 'skipped', distanceM: null, accuracyM: null, reasons: [] };
  }
  const outline = room.outline?.length >= 3 ? room.outline : null;
  const roomUncertaintyM = outline ? OUTLINE_UNCERTAINTY_M : (room.accuracyM ?? 0);
  const where = outline ? 'from the building' : 'from the classroom';
  if (!location) {
    return {
      action: 'review',
      distanceM: null,
      accuracyM: null,
      reasons: [{ code: 'location_missing', text: 'Location was not shared, so the position could not be checked' }],
    };
  }

  const distanceM = outline ? distanceToPolygonM(location.lat, location.lng, outline) : haversineM(location.lat, location.lng, room.lat, room.lng);
  const accuracyM = location.accuracy ?? Infinity;
  const stored = { distanceM, accuracyM: Number.isFinite(accuracyM) ? accuracyM : null };

  if (accuracyM > MAX_USABLE_ACCURACY_M) {
    return {
      action: 'review',
      ...stored,
      reasons: [
        {
          code: 'location_imprecise',
          text: Number.isFinite(accuracyM)
            ? `Location was too imprecise to check (accurate only to about ${metres(accuracyM)})`
            : 'Location was too imprecise to check (no accuracy reported)',
        },
      ],
    };
  }

  const margin = distanceM - accuracyM - roomUncertaintyM;
  if (margin > 2 * radiusM) {
    return {
      action: 'reject',
      ...stored,
      reasons: [
        {
          code: 'too_far',
          text: `${metres(distanceM)} ${where} (limit ${metres(radiusM)}), with a good GPS fix`,
        },
      ],
    };
  }
  if (margin > radiusM) {
    return {
      action: 'review',
      ...stored,
      reasons: [
        {
          code: 'outside_room',
          text: `About ${metres(distanceM)} ${where} (limit ${metres(radiusM)})`,
        },
      ],
    };
  }
  return { action: 'ok', ...stored, reasons: [] };
}
