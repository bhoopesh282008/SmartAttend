// Reading a position typed or pasted by a person, for the many laptops and desktops that cannot find
// their own location. Maps copy positions as plain decimal degrees ("27.7172, 85.3240"), so that is
// what is accepted, with the tidying people actually do (a degree sign, N/S/E/W letters before or after
// the numbers, a semicolon or just a space between them). Degrees-minutes-seconds are refused on
// purpose: guessing at them would put a classroom in the wrong place.

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const DEG = String.raw`\s*°?`;
const SEP = String.raw`(?:\s*[,;]\s*|\s+)`;
const LETTER = '([NSEW])';
// "27.7172 N, 85.3240 E" (letters, if any, after the numbers) and "N 27.7172, E 85.3240" (before).
const AFTER = new RegExp(`^${NUM}${DEG}\\s*${LETTER}?${SEP}${NUM}${DEG}\\s*${LETTER}?$`, 'i');
const BEFORE = new RegExp(`^${LETTER}\\s*${NUM}${DEG}${SEP}${LETTER}\\s*${NUM}${DEG}$`, 'i');

const inRange = (lat, lng) => lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/** { lat, lng } for something like "27.7172, 85.3240", or null if it is not a clear pair of decimal degrees. */
export function parseCoordinates(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  let first;
  let second;
  const after = AFTER.exec(raw);
  const before = after ? null : BEFORE.exec(raw);
  if (after) {
    first = { value: Number(after[1]), letter: after[2]?.toUpperCase() ?? null };
    second = { value: Number(after[3]), letter: after[4]?.toUpperCase() ?? null };
  } else if (before) {
    first = { value: Number(before[2]), letter: before[1].toUpperCase() };
    second = { value: Number(before[4]), letter: before[3].toUpperCase() };
  } else {
    return null;
  }

  if (!first.letter && !second.letter) return inRange(first.value, second.value) ? { lat: first.value, lng: second.value } : null;
  if (!first.letter || !second.letter) return null; // one letter among two numbers is ambiguous

  // Letters decide which number is which, and the sign: S and W are negative.
  const signed = (p) => (p.letter === 'S' || p.letter === 'W' ? -Math.abs(p.value) : Math.abs(p.value));
  const latitude = [first, second].find((p) => p.letter === 'N' || p.letter === 'S');
  const longitude = [first, second].find((p) => p.letter === 'E' || p.letter === 'W');
  if (!latitude || !longitude) return null; // two latitudes or two longitudes
  const lat = signed(latitude);
  const lng = signed(longitude);
  return inRange(lat, lng) ? { lat, lng } : null;
}
