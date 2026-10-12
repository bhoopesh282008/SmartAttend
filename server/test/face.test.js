import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';
import { createApp } from '../src/app.js';
import {
  average, createFaceVault, distance, DESCRIPTOR_LENGTH, ENROL_MAX_SPREAD, loadFaceKey, makeTemplate, MATCH_THRESHOLD, validateDescriptor,
} from '../src/face.js';
import { startTestApp } from './helpers.js';

// Deterministic stand-ins for face descriptors: a base "person", and photos of them at a chosen distance.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
const person = (seed) => {
  const r = rng(seed);
  const raw = Array.from({ length: DESCRIPTOR_LENGTH }, () => r());
  const norm = Math.hypot(...raw);
  return raw.map((v) => v / norm); // length 1, like a real descriptor
};
// A photo of `base` that lands exactly `dist` away from it.
const photo = (base, dist, seed) => {
  const r = rng(seed);
  const noise = Array.from({ length: DESCRIPTOR_LENGTH }, () => r());
  const norm = Math.hypot(...noise);
  return base.map((v, i) => v + (noise[i] / norm) * dist);
};
const ALICE = person(1);
const BOB = person(2);

describe('descriptors', () => {
  test('a descriptor is 128 finite numbers', () => {
    assert.equal(validateDescriptor(ALICE).length, 128);
    for (const bad of [null, 'x', [], ALICE.slice(1), [...ALICE.slice(1), NaN], [...ALICE.slice(1), 'a'], [...ALICE.slice(1), 9]]) {
      assert.throws(() => validateDescriptor(bad), RangeError);
    }
  });

  test('distance is the Euclidean distance', () => {
    assert.equal(distance(ALICE, ALICE), 0);
    const a = new Array(128).fill(0);
    const b = new Array(128).fill(0);
    b[5] = 3;
    b[9] = 4;
    assert.equal(distance(a, b), 5);
    assert.equal(distance(ALICE, BOB), distance(BOB, ALICE));
  });

  test('a template is the average of the photos, and says how far apart they were', () => {
    const photos = [photo(ALICE, 0.2, 1), photo(ALICE, 0.2, 2), photo(ALICE, 0.2, 3)];
    const { template, spread } = makeTemplate(photos);
    assert.ok(distance(template, ALICE) < 0.2, 'averaging pulls toward the person');
    assert.ok(spread > 0 && spread < ENROL_MAX_SPREAD);
    assert.deepEqual(average([[1, 2], [3, 4]].map((d) => [...d, ...new Array(126).fill(0)])).slice(0, 2), [2, 3]);
  });

  test('the synthetic helpers behave: the same person is close, a different one is far', () => {
    assert.ok(distance(ALICE, photo(ALICE, 0.35, 5)) < MATCH_THRESHOLD);
    assert.ok(distance(ALICE, BOB) > MATCH_THRESHOLD);
  });
});

describe('the vault', () => {
  const KEY = 'a'.repeat(64);
  const vault = createFaceVault({ keyHex: KEY });

  test('seals and opens a template, and the sealed text holds no readable numbers', () => {
    const sealed = vault.seal(ALICE, 7);
    assert.ok(sealed.startsWith('v1.'));
    assert.ok(!sealed.includes(String(Math.round(ALICE[0] * 1e6) / 1e6)));
    const opened = vault.open(sealed, 7);
    assert.ok(distance(opened, ALICE) < 1e-5);
  });

  test('a template does not open for another student, with another key, or after tampering', () => {
    const sealed = vault.seal(ALICE, 7);
    assert.throws(() => vault.open(sealed, 8));
    assert.throws(() => createFaceVault({ keyHex: 'b'.repeat(64) }).open(sealed, 7));
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    assert.throws(() => vault.open(parts.join('.'), 7));
    assert.throws(() => vault.open('garbage', 7));
  });

  test('two sealings of the same template differ (fresh random IV)', () => {
    assert.notEqual(vault.seal(ALICE, 7), vault.seal(ALICE, 7));
  });

  test('a bad key is refused', () => {
    assert.throws(() => createFaceVault({ keyHex: 'short' }));
  });

  test('the key file is created once and reused; FACE_KEY overrides it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'facekey-')), 'sub', 'face.key');
    const saved = process.env.FACE_KEY;
    delete process.env.FACE_KEY;
    try {
      const first = loadFaceKey(file);
      assert.match(first, /^[0-9a-f]{64}$/);
      assert.ok(existsSync(file));
      assert.equal(loadFaceKey(file), first);
      assert.equal(readFileSync(file, 'utf8').trim(), first);
      process.env.FACE_KEY = 'c'.repeat(64);
      assert.equal(loadFaceKey(file), 'c'.repeat(64));
    } finally {
      if (saved === undefined) delete process.env.FACE_KEY;
      else process.env.FACE_KEY = saved;
    }
  });
});

describe('enrolment and the face check at scan time', () => {
  let t;
  let faculty;
  before(async () => {
    t = await startTestApp();
    faculty = await t.login(1);
  });
  after(() => t.close());

  const enrol = async (studentId, descriptors) => t.call('POST', '/api/me/face', { token: await t.login(studentId), body: { descriptors } });
  const photos = (base, dist = 0.25) => [photo(base, dist, 11), photo(base, dist, 12), photo(base, dist, 13)];
  // Closes anything a failed test left open, so one failure cannot cascade into the next.
  const lecture = (options = {}) => {
    t.db.prepare('UPDATE sessions SET closed_at = ? WHERE course_id = 1 AND closed_at IS NULL').run(t.clock.t);
    return t.openLecture(faculty, 1, options);
  };
  const code = async (id) => (await t.newCode(faculty, id)).token;
  const scan = async (studentId, id, faceDescriptor, deviceId = `phone-of-${studentId}-xx`) =>
    t.call('POST', '/api/scan', { token: await t.login(studentId), body: { token: await code(id), deviceId, location: null, faceDescriptor } });
  const row = async (id, studentId) => (await t.call('GET', `/api/sessions/${id}`, { token: faculty })).data.roster.find((r) => r.studentId === studentId);
  const closeLecture = (id) => t.call('POST', `/api/sessions/${id}/close`, { token: faculty });

  test('enrolling stores an encrypted template; only students can enrol; the status is readable', async () => {
    assert.equal((await t.call('GET', '/api/me/face', { token: await t.login(100) })).data.enrolled, false);
    const res = await enrol(100, photos(ALICE));
    assert.equal(res.status, 201);
    const status = (await t.call('GET', '/api/me/face', { token: await t.login(100) })).data;
    assert.equal(status.enrolled, true);
    assert.ok(status.enrolledAt);
    const stored = t.db.prepare('SELECT face_template AS s FROM users WHERE id = 100').get().s;
    assert.ok(stored.startsWith('v1.'));
    assert.equal((await t.call('POST', '/api/me/face', { token: faculty, body: { descriptors: photos(ALICE) } })).status, 403);
    assert.equal((await t.call('POST', '/api/me/face', { body: { descriptors: photos(ALICE) } })).status, 401);
  });

  test('enrolment refuses too few photos, malformed numbers, and photos of different people', async () => {
    assert.equal((await enrol(101, photos(ALICE).slice(0, 2))).status, 400);
    assert.equal((await enrol(101, [[1, 2, 3], ...photos(ALICE).slice(1)])).status, 400);
    const mixed = [photo(ALICE, 0.2, 1), photo(ALICE, 0.2, 2), BOB];
    const res = await enrol(101, mixed);
    assert.equal(res.status, 422);
    assert.equal(res.data.error.code, 'face_inconsistent');
    assert.equal((await t.call('GET', '/api/me/face', { token: await t.login(101) })).data.enrolled, false);
  });

  test('a student can delete their face data', async () => {
    await enrol(102, photos(BOB));
    assert.equal((await t.call('DELETE', '/api/me/face', { token: await t.login(102) })).data.enrolled, false);
    assert.equal(t.db.prepare('SELECT face_template AS s FROM users WHERE id = 102').get().s, null);
  });

  test('preview tells the phone what the lecture will ask for, and refuses bad codes', async () => {
    const plain = await lecture();
    const student = await t.login(100);
    const a = (await t.call('POST', '/api/scan/preview', { token: student, body: { token: await code(plain) } })).data;
    assert.equal(a.valid, true);
    assert.equal(a.faceRequired, false);
    assert.equal(a.locationChecked, false);
    assert.equal(a.faceEnrolled, true);
    assert.equal(a.lecture.courseCode, 'CS301');
    await closeLecture(plain);

    const withFace = await lecture({ faceRequired: true });
    const stale = await code(withFace);
    const b = (await t.call('POST', '/api/scan/preview', { token: student, body: { token: stale } })).data;
    assert.equal(b.faceRequired, true);

    assert.equal((await t.call('POST', '/api/scan/preview', { token: student, body: { token: 'nonsense' } })).data.code, 'bad_token');
    t.clock.t += 63_000;
    const late = (await t.call('POST', '/api/scan/preview', { token: student, body: { token: stale } })).data;
    assert.equal(late.valid, false);
    assert.equal(late.code, 'expired');
    assert.match(late.message, /expired/);
    await closeLecture(withFace);
    assert.equal((await t.call('POST', '/api/scan/preview', { body: { token: stale } })).status, 401);
  });

  test('a matching face is present; the distance is kept and the descriptor is not', async () => {
    const id = await lecture({ faceRequired: true });
    const res = await scan(100, id, photo(ALICE, 0.35, 21));
    assert.equal(res.data.outcome, 'marked');
    const stored = t.db.prepare('SELECT face_distance AS d FROM scans WHERE session_id = ? AND student_id = 100').get(id).d;
    assert.ok(stored > 0.15 && stored < 0.6, `stored distance ${stored}`);
    const columns = t.db.prepare('PRAGMA table_info(scans)').all().map((c) => c.name);
    assert.ok(!columns.some((c) => /descriptor|embedding|photo|image/i.test(c)), 'no column could hold a face');
    assert.equal((await t.call('GET', `/api/sessions/${id}`, { token: faculty })).data.session.faceRequired, true);
    await closeLecture(id);
  });

  test('a face that does not match goes to review with the distance, and is never rejected', async () => {
    const id = await lecture({ faceRequired: true });
    const res = await scan(100, id, photo(BOB, 0.1, 22)); // Bob's face on Alice's account
    assert.equal(res.data.outcome, 'review');
    assert.equal(res.data.reasons, undefined, 'the student is not told which rule fired');
    const r = await row(id, 100);
    assert.equal(r.status, 'review');
    assert.equal(r.reasons[0].code, 'face_mismatch');
    assert.match(r.reasons[0].text, /distance \d\.\d\d/);
    await closeLecture(id);
  });

  test('no face check at all, or no enrolment, is held for review', async () => {
    const id = await lecture({ faceRequired: true });
    assert.equal((await scan(100, id, null)).data.outcome, 'review');
    assert.equal((await row(id, 100)).reasons[0].code, 'face_missing');
    // Student 103 never enrolled: a descriptor cannot be checked against nothing.
    assert.equal((await scan(103, id, photo(ALICE, 0.2, 23))).data.outcome, 'review');
    assert.equal((await row(id, 103)).reasons[0].code, 'face_missing');
    await closeLecture(id);
  });

  test('when the lecture does not ask for a face, a descriptor is ignored', async () => {
    const id = await lecture();
    assert.equal((await scan(100, id, photo(BOB, 0.1, 24))).data.outcome, 'marked');
    assert.equal(t.db.prepare('SELECT face_distance AS d FROM scans WHERE session_id = ? AND student_id = 100').get(id).d, null);
    await closeLecture(id);
  });

  test('a malformed descriptor is a 400', async () => {
    const id = await lecture({ faceRequired: true });
    const res = await scan(100, id, [1, 2, 3]);
    assert.equal(res.status, 400);
    await closeLecture(id);
  });

  test('after deleting their face data a student is held for review, not matched against a ghost', async () => {
    await enrol(110, photos(ALICE));
    await t.call('DELETE', '/api/me/face', { token: await t.login(110) });
    const id = await lecture({ faceRequired: true });
    assert.equal((await scan(110, id, photo(ALICE, 0.2, 25))).data.outcome, 'review');
    assert.equal((await row(id, 110)).reasons[0].code, 'face_missing');
    await closeLecture(id);
  });

  test('a student sees that the open lecture will ask for a face', async () => {
    const id = await lecture({ faceRequired: true });
    const course = (await t.call('GET', '/api/courses', { token: await t.login(100) })).data.find((c) => c.code === 'CS301');
    assert.equal(course.open.faceRequired, 1);
    await closeLecture(id);
  });
});

describe('the model is given the face distance', () => {
  test('it is sent when the lecture asks for a face, and null when it does not', async () => {
    const clock = { t: Date.UTC(2026, 9, 12, 9, 0, 0) };
    const now = () => clock.t;
    const db = openDb(':memory:');
    seedDemo(db, { now });
    const seen = [];
    const ml = {
      proxyScore: async (f) => { seen.push(f); return { risk: 0.05, flag: false, reasons: [], model_version: 'proxy-lr-test' }; },
      health: async () => ({ available: true, models: {} }),
    };
    const app = createApp({ db, now, ml });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, token, body) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return res.json();
    };
    const login = async (id) => (await call('POST', '/api/auth/login', null, { userId: id })).token;
    try {
      const fac = await login(1);
      const stu = await login(100);
      await call('POST', '/api/me/face', stu, { descriptors: [photo(ALICE, 0.2, 31), photo(ALICE, 0.2, 32), photo(ALICE, 0.2, 33)] });
      const lec = (await call('POST', '/api/courses/1/sessions', fac, { faceRequired: true })).id;
      const token = (await call('POST', `/api/sessions/${lec}/qr`, fac, { origin: 'http://localhost:5180' })).token;
      await call('POST', '/api/scan', stu, { token, deviceId: 'phone-100-ml-xx', location: null, faceDescriptor: photo(ALICE, 0.3, 34) });
      assert.ok(seen.at(-1).face_distance > 0.1 && seen.at(-1).face_distance < 0.6, JSON.stringify(seen.at(-1).face_distance));

      await call('POST', `/api/sessions/${lec}/close`, fac);
      const plain = (await call('POST', '/api/courses/1/sessions', fac, {})).id;
      const token2 = (await call('POST', `/api/sessions/${plain}/qr`, fac, { origin: 'http://localhost:5180' })).token;
      await call('POST', '/api/scan', stu, { token: token2, deviceId: 'phone-100-ml-xx', location: null });
      assert.equal(seen.at(-1).face_distance, null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
