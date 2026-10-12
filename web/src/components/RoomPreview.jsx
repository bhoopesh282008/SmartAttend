const EARTH_RADIUS_M = 6_371_000;
const RAD = Math.PI / 180;

// Metres east (x) and north (y) of the room's point; flat-earth is fine over a few hundred metres.
function local(lat, lng, room) {
  return [(lng - room.lng) * Math.cos(room.lat * RAD) * EARTH_RADIUS_M * RAD, (lat - room.lat) * EARTH_RADIUS_M * RAD];
}

/**
 * A small drawing of the shape that will be checked, to a common scale: the room's point, how
 * uncertain that point is (dotted ring), and either the circle of the allowed radius or, when the
 * building's outline is known, the outline with the allowed margin around its walls.
 */
export default function RoomPreview({ room, radiusM }) {
  const outline = room.outline?.map(([lat, lng]) => local(lat, lng, room)) ?? null;
  const reach = Math.max(
    radiusM,
    room.accuracyM ?? 0,
    ...(outline ? outline.map(([x, y]) => Math.hypot(x, y) + radiusM) : [0]),
  );
  const half = reach * 1.1;
  const summary = outline
    ? `Building outline with a margin of ${Math.round(radiusM)} m around its walls`
    : `Circle of ${Math.round(radiusM)} m around the classroom's position`;

  return (
    <figure className="mt-3">
      <svg viewBox={`${-half} ${-half} ${2 * half} ${2 * half}`} className="mx-auto block aspect-square w-full max-w-[220px] rounded-md border border-slate-200 bg-slate-50" role="img" aria-label={summary}>
        {/* north is up: flip the y axis */}
        <g transform="scale(1,-1)">
          {outline ? (
            <>
              <polygon points={outline.map((p) => p.join(',')).join(' ')} fill="#94a3b8" fillOpacity="0.25" stroke="#94a3b8" strokeOpacity="0.25" strokeWidth={2 * radiusM} strokeLinejoin="round" />
              <polygon points={outline.map((p) => p.join(',')).join(' ')} fill="#cbd5e1" stroke="#334155" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </>
          ) : (
            <circle r={radiusM} fill="#94a3b8" fillOpacity="0.25" stroke="#334155" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          )}
          {room.accuracyM > 0 && <circle r={room.accuracyM} fill="none" stroke="#475569" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
          <circle r={half * 0.025} fill="#0f172a" />
        </g>
      </svg>
      <figcaption className="mt-1 text-center text-xs text-slate-500">{summary}. The dot is the position; the dotted ring is how sure it is.</figcaption>
    </figure>
  );
}
