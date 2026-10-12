import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLocation } from '../src/geo.js';
import {
  distanceToPolygonM, fetchBuildingOutline, parseOutline, pickBuilding, pointInPolygon, thinRing,
} from '../src/outline.js';
import { KATHMANDU, startTestApp } from './helpers.js';

// A square building 100 m on a side, its south-west corner at the room point, as [lat, lng] pairs.
const M = 111_195;
const at = (east, north) => [KATHMANDU.lat + north / M, KATHMANDU.lng + east / (M * Math.cos((KATHMANDU.lat * Math.PI) / 180))];
const SQUARE = [at(0, 0), at(100, 0), at(100, 100), at(0, 100)];

describe('building geometry', () => {
  test('inside and outside, including a concave (L-shaped) building', () => {
    assert.ok(pointInPolygon(...at(50, 50), SQUARE));
    assert.ok(!pointInPolygon(...at(150, 50), SQUARE));
    assert.ok(!pointInPolygon(...at(50, -10), SQUARE));
    const ell = [at(0, 0), at(100, 0), at(100, 40), at(40, 40), at(40, 100), at(0, 100)];
    assert.ok(pointInPolygon(...at(20, 80), ell), 'the tall arm');
    assert.ok(!pointInPolygon(...at(70, 70), ell), 'the notch of the L is outside');
  });

  test('distance to the walls is 0 inside and the real gap outside', () => {
    assert.equal(distanceToPolygonM(...at(50, 50), SQUARE), 0);
    assert.ok(Math.abs(distanceToPolygonM(...at(150, 50), SQUARE) - 50) < 0.5, 'due east of the east wall');
    assert.ok(Math.abs(distanceToPolygonM(...at(50, -30), SQUARE) - 30) < 0.5, 'due south of the south wall');
    const corner = distanceToPolygonM(...at(130, 140), SQUARE); // 30 east, 40 north of the corner
    assert.ok(Math.abs(corner - 50) < 0.5, `diagonal off a corner, got ${corner}`);
  });

  test('a long ring is thinned, a short one left alone', () => {
    const big = Array.from({ length: 500 }, (_, i) => [i, i]);
    assert.equal(thinRing(big, 120).length, 120);
    assert.deepEqual(thinRing(SQUARE), SQUARE);
  });

  test('a stored outline is read back, and junk is "no outline"', () => {
    assert.deepEqual(parseOutline(JSON.stringify(SQUARE)), SQUARE);
    for (const junk of [null, '', 'not json', '[]', '[[1,2],[3,4]]', '[[1,"a"],[2,3],[4,5]]', '{"a":1}']) assert.equal(parseOutline(junk), null, String(junk));
  });
});

describe('choosing a building from OpenStreetMap data', () => {
  const way = (id, ring, tags = { building: 'yes' }, close = true) => ({
    type: 'way', id, tags,
    geometry: [...ring, ...(close ? [ring[0]] : [])].map(([lat, lon]) => ({ lat, lon })),
  });

  test('takes the building that contains the point, with its name', () => {
    const far = [at(300, 300), at(400, 300), at(400, 400), at(300, 400)];
    const found = pickBuilding([way(1, far), way(2, SQUARE, { building: 'university', name: 'Block A' })], ...at(50, 50));
    assert.equal(found.id, 2);
    assert.equal(found.name, 'Block A');
    assert.equal(found.ring.length, 4, 'stored without the repeated closing point');
    assert.equal(found.distance, 0);
  });

  test('takes the nearest wall within 40 m when the point is just outside, and nothing when it is farther', () => {
    assert.equal(pickBuilding([way(2, SQUARE)], ...at(130, 50))?.id, 2);
    assert.equal(pickBuilding([way(2, SQUARE)], ...at(160, 50)), null);
  });

  test('skips unclosed lines, relations and tiny junk', () => {
    const elements = [way(3, SQUARE, { building: 'yes' }, false), { type: 'relation', id: 9, members: [] }, { type: 'way', id: 4, geometry: [{ lat: 1, lon: 1 }] }];
    assert.equal(pickBuilding(elements, ...at(50, 50)), null);
  });

  test('the Overpass call: a good answer, an error status, a timeout, and "nothing mapped"', async () => {
    const answer = (elements) => async () => ({ ok: true, json: async () => ({ elements }) });
    const found = await fetchBuildingOutline({ lat: KATHMANDU.lat + 0.0005, lng: KATHMANDU.lng + 0.0005, fetchImpl: answer([way(7, SQUARE)]) });
    assert.equal(found.osmId, 7);
    assert.equal(await fetchBuildingOutline({ lat: 1, lng: 1, fetchImpl: answer([]) }), null);
    await assert.rejects(fetchBuildingOutline({ lat: 1, lng: 1, fetchImpl: async () => ({ ok: false, status: 429 }) }), /429/);
    await assert.rejects(
      fetchBuildingOutline({ lat: 1, lng: 1, timeoutMs: 30, fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }),
      /aborted/,
    );
  });

  test('the query asks for buildings around the point and says who is asking', async () => {
    let seen;
    await fetchBuildingOutline({ lat: 27.7172, lng: 85.324, fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ elements: [] }) }; } });
    assert.match(decodeURIComponent(seen.init.body), /way\(around:60,27\.717200,85\.324000\)\["building"\]/);
    assert.match(seen.init.headers['User-Agent'], /SmartAttend/);
  });
});

describe('the room check with the room’s own error and with an outline', () => {
  const point = { lat: KATHMANDU.lat, lng: KATHMANDU.lng };
  const student = (east, north, accuracy = 10) => ({ lat: at(east, north)[0], lng: at(east, north)[1], accuracy });

  test('the room position’s error is subtracted too, so a vague room cannot make students look far', () => {
    const farish = student(0, 200); // 200 m north of the point
    assert.equal(judgeLocation({ room: { ...point, accuracyM: 0 }, radiusM: 150, location: farish }).action, 'review');
    assert.equal(judgeLocation({ room: { ...point, accuracyM: 100 }, radiusM: 150, location: farish }).action, 'ok', '200 - 10 - 100 = 90 is inside 150');
    // 450 m away: clearly far on its own, but within the doubt about where the room really is.
    const veryFar = student(0, 450);
    assert.equal(judgeLocation({ room: { ...point, accuracyM: 0 }, radiusM: 150, location: veryFar }).action, 'reject');
    assert.equal(judgeLocation({ room: { ...point, accuracyM: 200 }, radiusM: 150, location: veryFar }).action, 'review', '450 - 10 - 200 = 240 is between 150 and 300');
  });

  test('with an outline the distance is metres outside the walls, 0 anywhere inside', () => {
    const room = { ...point, accuracyM: 0, outline: SQUARE };
    const inside = judgeLocation({ room, radiusM: 50, location: student(90, 90) }); // 127 m from the SW corner point, but inside
    assert.equal(inside.action, 'ok');
    assert.equal(inside.distanceM, 0);
    const near = judgeLocation({ room, radiusM: 50, location: student(130, 50) }); // 30 m outside the east wall
    assert.equal(near.action, 'ok');
    assert.ok(Math.abs(near.distanceM - 30) < 1);
    const grey = judgeLocation({ room, radiusM: 50, location: student(200, 50) }); // 100 m outside: 100 - 10 - 5 = 85, between 50 and 100
    assert.equal(grey.action, 'review');
    assert.match(grey.reasons[0].text, /from the building/);
    assert.equal(judgeLocation({ room, radiusM: 50, location: student(300, 50) }).action, 'reject');
    // The point of the outline: a student standing INSIDE the building, 127 m from the room's point, is
    // thrown out by a small circle (127 - 10 > 2 x 50) but is fine against the walls.
    assert.equal(judgeLocation({ room: { ...point, accuracyM: 0 }, radiusM: 50, location: student(90, 90) }).action, 'reject');
  });

  test('a degenerate outline falls back to the circle', () => {
    const room = { ...point, accuracyM: 0, outline: [at(0, 0), at(1, 1)] };
    assert.equal(judgeLocation({ room, radiusM: 150, location: student(0, 20) }).action, 'ok');
  });
});

describe('setting the classroom’s position', () => {
  let t;
  let faculty;
  let outlineCalls;
  let outlineAnswer;
  before(async () => {
    outlineCalls = [];
    outlineAnswer = async () => ({ ring: SQUARE, osmId: 4242, name: 'Block A', distanceM: 0 });
    t = await startTestApp({ findOutline: async (args) => { outlineCalls.push(args); return outlineAnswer(args); } });
    faculty = await t.login(1);
  });
  after(() => t.close());

  const setRoom = (body, token = faculty) => t.call('PATCH', '/api/courses/1/room', { token, body });
  const room = async () => (await t.call('GET', '/api/courses', { token: faculty })).data.find((c) => c.id === 1).room;

  test('a position needs its accuracy, and one that is too vague is refused with advice', async () => {
    assert.equal((await setRoom({ lat: 27.7, lng: 85.3 })).status, 400, 'accuracy is required');
    const vague = await setRoom({ lat: 27.7, lng: 85.3, accuracy: 800 });
    assert.equal(vague.status, 422);
    assert.equal(vague.data.error.code, 'room_fix_too_vague');
    assert.match(vague.data.error.message, /type the coordinates/);
    assert.equal(await room(), null, 'nothing was saved');
    assert.equal((await setRoom({ lat: 999, lng: 85.3, accuracy: 10 })).status, 400);
  });

  test('a good position is kept with its accuracy and where it came from', async () => {
    assert.equal((await setRoom({ lat: 27.7172, lng: 85.324, accuracy: 18 })).status, 200);
    const saved = await room();
    assert.equal(saved.accuracyM, 18);
    assert.equal(saved.source, 'device');
    assert.equal(saved.outline, null);
    await setRoom({ lat: 27.7172, lng: 85.324, accuracy: 25, source: 'manual' });
    assert.equal((await room()).source, 'manual');
  });

  test('another lecturer cannot move it', async () => {
    assert.equal((await setRoom({ lat: 1, lng: 1, accuracy: 5 }, await t.login(2))).status, 403);
  });

  test('the outline needs a room first, is fetched once on request, stored, and shown to the lecturer', async () => {
    const fresh = await startTestApp({ findOutline: async () => ({ ring: SQUARE, osmId: 1, name: null, distanceM: 0 }) });
    const f = await fresh.login(1);
    assert.equal((await fresh.call('POST', '/api/courses/1/room/outline', { token: f })).status, 400, 'no room yet');
    await fresh.close();

    outlineCalls.length = 0;
    const res = await t.call('POST', '/api/courses/1/room/outline', { token: faculty });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.outline, SQUARE);
    assert.match(res.data.note, /OpenStreetMap way 4242, Block A/);
    assert.equal(outlineCalls.length, 1);
    assert.ok(Math.abs(outlineCalls[0].lat - 27.7172) < 1e-9, 'it asked about the classroom’s own position');
    const saved = await room();
    assert.deepEqual(saved.outline, SQUARE);
    assert.match(saved.outlineNote, /Block A/);
  });

  test('students are checked against the building once it is known, and a new point drops it', async () => {
    const lecture = await t.openLecture(faculty, 1, { radiusM: 50 });
    const scanFrom = async (studentId, east, north, accuracy = 10) => {
      const code = await t.newCode(faculty, lecture);
      const [lat, lng] = at(east, north);
      return t.scan(await t.login(studentId), code.token, { deviceId: `phone-of-${studentId}-xx`, location: { lat, lng, accuracy } });
    };
    // 90 m east and north of the point is inside the 100 m building: fine, though 127 m from the point.
    assert.equal((await scanFrom(100, 90, 90)).data.outcome, 'marked');
    // 300 m east of the building's east wall: clearly out.
    assert.equal((await scanFrom(101, 400, 50)).data.code, 'too_far');
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty });

    await setRoom({ lat: 27.7172, lng: 85.324, accuracy: 10 });
    assert.equal((await room()).outline, null, 'a new point means the old outline no longer fits');
  });

  test('what OpenStreetMap does not give us is explained, not hidden', async () => {
    outlineAnswer = async () => null;
    const none = await t.call('POST', '/api/courses/1/room/outline', { token: faculty });
    assert.equal(none.status, 404);
    assert.equal(none.data.error.code, 'outline_not_found');
    outlineAnswer = async () => { throw new Error('network down'); };
    const down = await t.call('POST', '/api/courses/1/room/outline', { token: faculty });
    assert.equal(down.status, 502);
    assert.equal(down.data.error.code, 'outline_unavailable');
    assert.match(down.data.error.message, /circle still works/);
  });

  test('the outline can be removed', async () => {
    outlineAnswer = async () => ({ ring: SQUARE, osmId: 1, name: null, distanceM: 0 });
    await t.call('POST', '/api/courses/1/room/outline', { token: faculty });
    assert.equal((await t.call('DELETE', '/api/courses/1/room/outline', { token: faculty })).status, 200);
    assert.equal((await room()).outline, null);
  });
});

describe('lectures close themselves, and late arrivals are marked', () => {
  let t;
  let faculty;
  before(async () => {
    t = await startTestApp();
    faculty = await t.login(1);
  });
  after(() => t.close());
  const detail = async (id) => (await t.call('GET', `/api/sessions/${id}`, { token: faculty })).data;

  test('an open lecture closes at its closing time and then refuses scans', async () => {
    const id = await t.openLecture(faculty, 1, { autoCloseMinutes: 10 });
    const first = await detail(id);
    assert.equal(first.session.autoCloseAt, first.session.startedAt + 10 * 60_000);
    assert.equal(first.session.closedAt, null);

    const code = await t.newCode(faculty, id);
    t.clock.t += 9 * 60_000;
    assert.equal((await detail(id)).session.closedAt, null, 'still open at 9 minutes');
    t.clock.t += 2 * 60_000; // 11 minutes in
    const closed = await detail(id);
    assert.equal(closed.session.closedAt, closed.session.autoCloseAt, 'closed at its time, not at the moment someone looked');
    assert.equal((await t.scan(await t.login(100), code.token)).data.code, 'session_closed');
    assert.equal((await t.call('POST', `/api/sessions/${id}/qr`, { token: faculty, body: { origin: 'http://localhost:5180' } })).status, 409);
    // a new lecture can now be started
    assert.equal((await t.call('POST', '/api/courses/1/sessions', { token: faculty, body: {} })).status, 201);
  });

  test('the default is two hours, 0 means never, and silly values are refused', async () => {
    const [{ id }] = t.db.prepare('SELECT id FROM sessions WHERE course_id = 1 AND closed_at IS NULL').all();
    const standard = await detail(id);
    assert.equal(standard.session.autoCloseAt - standard.session.startedAt, 120 * 60_000);
    await t.call('POST', `/api/sessions/${id}/close`, { token: faculty });

    const never = await t.openLecture(faculty, 1, { autoCloseMinutes: 0 });
    assert.equal((await detail(never)).session.autoCloseAt, null);
    t.clock.t += 24 * 60 * 60_000;
    faculty = await t.login(1); // logins last 12 hours, so the lecturer signs in again
    assert.equal((await detail(never)).session.closedAt, null, 'a day later it is still open');
    await t.call('POST', `/api/sessions/${never}/close`, { token: faculty });

    assert.equal((await t.call('POST', '/api/courses/1/sessions', { token: faculty, body: { autoCloseMinutes: 1 } })).status, 400);
    assert.equal((await t.call('POST', '/api/courses/1/sessions', { token: faculty, body: { autoCloseMinutes: 99999 } })).status, 400);
  });

  test('a scan more than ten minutes after the start is late, in the list and in the CSV', async () => {
    const id = await t.openLecture(faculty, 2, { autoCloseMinutes: 0 });
    const early = await t.newCode(faculty, id);
    await t.scan(await t.login(100), early.token, { deviceId: 'phone-of-100-early' });
    t.clock.t += 12 * 60_000;
    const later = await t.newCode(faculty, id);
    await t.scan(await t.login(101), later.token, { deviceId: 'phone-of-101-later' });
    const rows = (await detail(id)).roster;
    assert.equal(rows.find((r) => r.studentId === 100).late, false);
    assert.equal(rows.find((r) => r.studentId === 101).late, true);
    assert.equal(rows.find((r) => r.studentId === 102).late, false, 'absent is not late');

    const csv = (await t.call('GET', `/api/sessions/${id}/export.csv`, { token: faculty })).data.split('\r\n');
    const col = csv[0].replace(/^﻿/, '').split(',').indexOf('Late');
    assert.ok(col > 0);
    assert.equal(csv.find((l) => l.startsWith('CS23-002')).split(',')[col], 'Late');
    assert.equal(csv.find((l) => l.startsWith('CS23-001')).split(',')[col], '');
  });
});
