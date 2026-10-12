import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';
import { createApp } from '../src/app.js';

// Seed facts the tests rely on (see src/seed.js):
//   faculty 1 owns CS301 (course 1, students 100-129) and CS305 (course 2, students 100-123)
//   faculty 2 owns MA201 (course 3, students 100-119)
//   students 125-129 are in CS301 only

export const KATHMANDU = { lat: 27.7172, lng: 85.324 };
// About 111 km per degree of latitude: 0.0009 deg ~ 100 m, 0.00225 deg ~ 250 m, 0.018 deg ~ 2 km.
export const metresNorth = (m) => ({ lat: KATHMANDU.lat + m / 111_195, lng: KATHMANDU.lng });

export async function startTestApp(options = {}) {
  const clock = { t: Date.UTC(2026, 9, 12, 9, 0, 0) };
  const now = () => clock.t;
  const db = openDb(':memory:');
  seedDemo(db, { now });
  const app = createApp({ db, now, demo: true, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  async function login(userId) {
    const { data } = await call('POST', '/api/auth/login', { body: { userId } });
    return data.token;
  }

  // Convenience: faculty 1 opens a lecture on a course and gets a first code.
  async function openLecture(facultyToken, courseId, options = {}) {
    const res = await call('POST', `/api/courses/${courseId}/sessions`, { token: facultyToken, body: options });
    if (res.status !== 201) throw new Error(`could not open lecture: ${JSON.stringify(res.data)}`);
    return res.data.id;
  }
  async function newCode(facultyToken, sessionId) {
    const { data } = await call('POST', `/api/sessions/${sessionId}/qr`, {
      token: facultyToken,
      body: { origin: 'http://localhost:5180' },
    });
    return data;
  }
  const scan = (studentToken, token, extra = {}) =>
    call('POST', '/api/scan', {
      token: studentToken,
      body: { token, deviceId: extra.deviceId ?? 'device-default-0001', location: extra.location ?? null },
    });

  return {
    base, clock, db, call, login, openLecture, newCode, scan,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
