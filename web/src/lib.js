// Small helpers shared by the pages.

const DEVICE_KEY = 'smartattend.device';
let fallbackDeviceId = null;

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The "device ID" is a random id kept in this browser. A web page cannot read a phone's
 * hardware identifiers (IMEI, MAC), and clearing site data resets this one, so it is
 * evidence that a phone was reused, not proof of who holds it.
 */
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = randomId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    fallbackDeviceId ??= randomId();
    return fallbackDeviceId;
  }
}

/**
 * Asks the phone for its position. Resolves with `location: null` and a reason if the
 * student declines or the phone cannot say: a missing position is reported as missing,
 * never as zero.
 */
export function getLocation(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ location: null, reason: 'unsupported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        location: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy },
        reason: null,
      }),
      (err) => resolve({ location: null, reason: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10_000 },
    );
  });
}

// A scanned QR holds a link like https://host/s/<token>; a pasted value may be the link or the bare token.
const TOKEN_PATTERN = /(\d{1,12}\.\d{10,16}\.[A-Za-z0-9_-]{22})/;
export function tokenFromText(text) {
  const match = TOKEN_PATTERN.exec(String(text ?? ''));
  return match ? match[1] : null;
}

export const timeOf = (ms) =>
  ms == null ? '' : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export const dateOf = (ms) =>
  ms == null ? '' : new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export const percent = (fraction) => (fraction == null ? '–' : `${Math.round(fraction * 100)}%`);

export const STATUS_LABEL = { present: 'Present', manual: 'Marked by hand', review: 'Pending review', absent: 'Absent' };

export function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/** Web addresses that students might be able to reach, best guess first. */
export function candidateOrigins(lanAddresses = []) {
  const here = window.location;
  const lan = lanAddresses.map((ip) => `${here.protocol}//${ip}${here.port ? `:${here.port}` : ''}`);
  const ordered = isLocalHost(here.hostname) ? [...lan, here.origin] : [here.origin, ...lan];
  return [...new Set(ordered)];
}
