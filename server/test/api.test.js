import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../src/token.js';
import { KATHMANDU, metresNorth, startTestApp } from './helpers.js';

let t;
let faculty1;
let faculty2;

before(async () => {
  t = await startTestApp();
  faculty1 = await t.login(1);
  faculty2 = await t.login(2);
});
after(() => t.close());

const tokenOf = (code) => code.token;
const withoutBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const rosterOf = async (sessionId, token = faculty1) => (await t.call('GET', `/api/sessions/${sessionId}`, { token })).data;
const statusOf = (detail, studentId) => detail.roster.find((r) => r.studentId === studentId).status;

describe('access control', () => {
  test('no sign-in is refused, a student cannot use faculty routes, another lecturer cannot see the course', async () => {
    assert.equal((await t.call('GET', '/api/courses')).status, 401);
    const student = await t.login(100);
    assert.equal((await t.call('GET', '/api/courses/1/register', { token: student })).status, 403);
    assert.equal((await t.call('POST', '/api/courses/1/sessions', { token: faculty2, body: {} })).status, 403);
    assert.equal((await t.call('GET', '/api/courses/1/register', { token: faculty2 })).status, 403);
  });
});

describe('core: one lecture, a 60 second code, scan to mark, list per class', () => {
  let lecture;
  test('faculty opens a lecture; every enrolled student is listed, all absent', async () => {
    lecture = await t.openLecture(faculty1, 1, { title: 'Stacks and queues' });
    const detail = await rosterOf(lecture);
    assert.equal(detail.session.title, 'Stacks and queues');
    assert.equal(detail.session.lectureNo, 9, 'eight seeded lectures come before');
    assert.equal(detail.roster.length, 30);
    assert.equal(detail.counts.absent, 30);
    assert.equal(detail.counts.present, 0);
  });

  test('a second lecture cannot be opened while one is open', async () => {
    const res = await t.call('POST', '/api/courses/1/sessions', { token: faculty1, body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'lecture_open');
    assert.equal(res.data.error.details.sessionId, lecture);
  });

  test('the QR carries a link to the scan page and a 60 second expiry', async () => {
    const code = await t.newCode(faculty1, lecture);
    assert.ok(code.url.startsWith('http://localhost:5180/s/'));
    assert.ok(code.url.endsWith(code.token));
    assert.equal(code.expiresAt - code.issuedAt, 60_000);
    assert.ok(code.svg.startsWith('<?xml') || code.svg.startsWith('<svg'));
  });

  test('a student scans and appears as present; the list updates', async () => {
    const code = await t.newCode(faculty1, lecture);
    const student = await t.login(100);
    const res = await t.scan(student, tokenOf(code), { deviceId: 'phone-of-student-100' });
    assert.equal(res.status, 200);
    assert.equal(res.data.outcome, 'marked');
    const detail = await rosterOf(lecture);
    assert.equal(statusOf(detail, 100), 'present');
    assert.equal(detail.counts.present, 1);
    assert.equal(detail.counts.absent, 29);
  });

  test('scanning twice is harmless and says so', async () => {
    const code = await t.newCode(faculty1, lecture);
    const student = await t.login(100);
    const res = await t.scan(student, tokenOf(code), { deviceId: 'phone-of-student-100' });
    assert.equal(res.data.outcome, 'already');
  });

  test('a code is good for 60 s, a code made mid-minute still lasts its own 60 s, 63 s is too late', async () => {
    const student = await t.login(101);
    const first = await t.newCode(faculty1, lecture);
    t.clock.t += 60_000;
    const atSixty = await t.scan(student, tokenOf(first), { deviceId: 'phone-of-student-101' });
    assert.equal(atSixty.data.outcome, 'marked', 'accepted at exactly 60 s');

    const late = await t.login(102);
    t.clock.t += 30_000; // 30 s into a minute
    const mid = await t.newCode(faculty1, lecture);
    t.clock.t += 59_000;
    assert.equal((await t.scan(late, tokenOf(mid), { deviceId: 'phone-of-student-102' })).data.outcome, 'marked');

    const slow = await t.login(103);
    const old = await t.newCode(faculty1, lecture);
    t.clock.t += 63_000;
    const expired = await t.scan(slow, tokenOf(old), { deviceId: 'phone-of-student-103' });
    assert.equal(expired.data.outcome, 'rejected');
    assert.equal(expired.data.code, 'expired');
  });

  test('a tampered code, a code re-labelled for another lecture, and junk are refused', async () => {
    const student = await t.login(104);
    const code = await t.newCode(faculty1, lecture);
    const flipped = code.token.slice(0, -1) + (code.token.endsWith('A') ? 'B' : 'A');
    assert.equal((await t.scan(student, flipped)).data.code, 'bad_token');

    const other = await t.openLecture(faculty1, 2);
    const [, issued, sig] = code.token.split('.');
    assert.equal((await t.scan(student, `${other}.${issued}.${sig}`)).data.code, 'bad_token');
    assert.equal((await t.scan(student, 'not-a-code')).data.code, 'bad_token');
    // Signed with a secret that is not this lecture's:
    assert.equal((await t.scan(student, signToken('x'.repeat(48), lecture, t.clock.t))).data.code, 'bad_token');
    await t.call('POST', `/api/sessions/${other}/close`, { token: faculty1 });
  });

  test('a student who is not enrolled is refused', async () => {
    const other = await t.openLecture(faculty1, 2); // CS305: students 100-123
    const code = await t.newCode(faculty1, other);
    const outsider = await t.login(125);
    const res = await t.scan(outsider, tokenOf(code));
    assert.equal(res.data.code, 'not_enrolled');
    await t.call('POST', `/api/sessions/${other}/close`, { token: faculty1 });
  });

  test('after the lecture closes, scans and new codes are refused', async () => {
    const code = await t.newCode(faculty1, lecture);
    assert.equal((await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty1 })).status, 200);
    const student = await t.login(105);
    assert.equal((await t.scan(student, tokenOf(code))).data.code, 'session_closed');
    const again = await t.call('POST', `/api/sessions/${lecture}/qr`, { token: faculty1, body: { origin: 'http://localhost:5180' } });
    assert.equal(again.status, 409);
  });

  test('bad input is a 400, not a crash', async () => {
    const student = await t.login(100);
    assert.equal((await t.call('POST', '/api/scan', { token: student, body: { token: 'x' } })).status, 400);
    assert.equal((await t.call('POST', '/api/scan', { token: student, body: { token: 'x', deviceId: 'abcdefgh', location: { lat: 999, lng: 0 } } })).status, 400);
    assert.equal((await t.call('POST', '/api/courses/1/sessions', { token: faculty1, body: { radiusM: 10 } })).status, 400);
  });
});

describe('stretch: block proxy marking by device', () => {
  test('a second student on the same phone is rejected, logged, and not locked out', async () => {
    const lecture = await t.openLecture(faculty1, 1);
    const code = await t.newCode(faculty1, lecture);
    const a = await t.login(110);
    const b = await t.login(111);
    assert.equal((await t.scan(a, tokenOf(code), { deviceId: 'shared-phone-0001' })).data.outcome, 'marked');
    const blocked = await t.scan(b, tokenOf(code), { deviceId: 'shared-phone-0001' });
    assert.equal(blocked.data.outcome, 'rejected');
    assert.equal(blocked.data.code, 'device_used');

    let detail = await rosterOf(lecture);
    assert.equal(statusOf(detail, 111), 'absent');
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.attempts[0].code, 'device_used');
    assert.equal(detail.attempts[0].rollNo, 'CS23-012');

    // Their own phone still works: the blocked attempt did not use up their slot.
    assert.equal((await t.scan(b, tokenOf(code), { deviceId: 'own-phone-of-111' })).data.outcome, 'marked');
    detail = await rosterOf(lecture);
    assert.equal(statusOf(detail, 111), 'present');
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty1 });
  });

  test('a phone that marked someone else earlier in the week is held for review, not blocked', async () => {
    const lecture = await t.openLecture(faculty1, 2);
    const code = await t.newCode(faculty1, lecture);
    // The seed gives student 100 the phone 'demo-device-100' in past lectures.
    const res = await t.scan(await t.login(119), tokenOf(code), { deviceId: 'demo-device-100' });
    assert.equal(res.data.outcome, 'review');
    const row = (await rosterOf(lecture)).roster.find((r) => r.studentId === 119);
    assert.equal(row.reasons[0].code, 'device_shared');
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty1 });
  });
});

describe('stretch: block proxy marking by location', () => {
  let lecture;
  before(async () => {
    const room = await t.call('PATCH', '/api/courses/1/room', { token: faculty1, body: { ...KATHMANDU, accuracy: 10 } });
    assert.equal(room.status, 200);
    lecture = await t.openLecture(faculty1, 1, { radiusM: 150 });
  });
  after(async () => {
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty1 });
  });

  const near = (metres, accuracy) => ({ ...metresNorth(metres), accuracy });
  const go = async (studentId, location) => {
    const code = await t.newCode(faculty1, lecture);
    return t.scan(await t.login(studentId), tokenOf(code), { deviceId: `phone-of-student-${studentId}`, location });
  };

  test('in the room with a good fix: present', async () => {
    const res = await go(112, near(60, 10));
    assert.equal(res.data.outcome, 'marked');
  });

  test('clearly far away with a good fix: blocked, and the distance is on record', async () => {
    const res = await go(113, near(2000, 20));
    assert.equal(res.data.outcome, 'rejected');
    assert.equal(res.data.code, 'too_far');
    const detail = await rosterOf(lecture);
    assert.equal(statusOf(detail, 113), 'absent');
    const attempt = detail.attempts.find((a) => a.studentId === 113);
    assert.ok(attempt.distanceM > 1900 && attempt.distanceM < 2100);
  });

  test('a vague or borderline position goes to review, with reasons for faculty only', async () => {
    for (const [id, loc, code] of [
      [114, near(2000, 800), 'location_imprecise'],
      [115, near(250, 10), 'outside_room'],
      [116, null, 'location_missing'],
    ]) {
      const res = await go(id, loc);
      assert.equal(res.data.outcome, 'review', `student ${id}`);
      assert.equal(res.data.reasons, undefined, 'the student is not told which rule fired');
      const row = (await rosterOf(lecture)).roster.find((r) => r.studentId === id);
      assert.equal(row.status, 'review');
      assert.equal(row.reasons[0].code, code);
    }
    // A missing location is stored as missing, not as zero metres.
    const missing = (await rosterOf(lecture)).roster.find((r) => r.studentId === 116);
    assert.equal(missing.distanceM, null);
  });
});

describe('faculty decisions: review queue and manual marks', () => {
  let lecture;
  before(async () => {
    lecture = await t.openLecture(faculty1, 1, { radiusM: 150 });
  });

  test('approving a review makes it present; declining blocks a re-scan', async () => {
    const code = await t.newCode(faculty1, lecture);
    for (const id of [117, 118]) await t.scan(await t.login(id), tokenOf(code), { deviceId: `phone-of-student-${id}`, location: null });
    let detail = await rosterOf(lecture);
    const [approve, decline] = [117, 118].map((id) => detail.roster.find((r) => r.studentId === id).scanId);

    assert.equal((await t.call('PATCH', `/api/scans/${approve}`, { token: faculty1, body: { decision: 'approve' } })).status, 200);
    assert.equal((await t.call('PATCH', `/api/scans/${decline}`, { token: faculty1, body: { decision: 'reject' } })).status, 200);
    detail = await rosterOf(lecture);
    assert.equal(statusOf(detail, 117), 'present');
    assert.equal(statusOf(detail, 118), 'absent');

    const rescan = await t.scan(await t.login(118), tokenOf(await t.newCode(faculty1, lecture)), { deviceId: 'phone-of-student-118', location: null });
    assert.equal(rescan.data.code, 'declined');
    assert.equal((await t.call('PATCH', `/api/scans/${approve}`, { token: faculty1, body: { decision: 'reject' } })).status, 409, 'a decided scan cannot be decided again');
  });

  test('marking by hand needs a reason, an enrolled student, and not an already-marked one', async () => {
    const manual = (body) => t.call('POST', `/api/sessions/${lecture}/manual`, { token: faculty1, body });
    assert.equal((await manual({ studentId: 120, reason: '' })).status, 400);
    assert.equal((await manual({ studentId: 999, reason: 'phone died' })).status, 400);
    assert.equal((await manual({ studentId: 120, reason: 'phone died' })).status, 201);
    assert.equal((await manual({ studentId: 120, reason: 'again' })).status, 409);
    const row = (await rosterOf(lecture)).roster.find((r) => r.studentId === 120);
    assert.equal(row.status, 'manual');
    assert.equal(row.note, 'phone died');
  });

  test('another lecturer cannot decide this course’s scans', async () => {
    const code = await t.newCode(faculty1, lecture);
    await t.scan(await t.login(121), tokenOf(code), { deviceId: 'phone-of-student-121', location: null });
    const pending = (await rosterOf(lecture)).roster.find((r) => r.studentId === 121);
    assert.equal((await t.call('PATCH', `/api/scans/${pending.scanId}`, { token: faculty2, body: { decision: 'approve' } })).status, 403);
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty1 });
  });
});

describe('attendance list per class, and CSV export', () => {
  test('the class register has a column per lecture and percentages over closed lectures', async () => {
    const reg = (await t.call('GET', '/api/courses/1/register', { token: faculty1 })).data;
    assert.equal(reg.students.length, 30);
    assert.ok(reg.lectures.length >= 11);
    assert.equal(reg.students[0].cells.length, reg.lectures.length);
    for (const s of reg.students) {
      assert.equal(s.held, reg.lectures.filter((l) => l.closedAt != null).length);
      assert.ok(s.attended <= s.held);
    }
  });

  test('a student sees their own attendance and what they can still miss', async () => {
    const courses = (await t.call('GET', '/api/courses', { token: await t.login(100) })).data;
    const cs301 = courses.find((c) => c.code === 'CS301');
    assert.ok(cs301.held >= 8);
    assert.equal(cs301.plannedLectures, 40);
    const remaining = cs301.plannedLectures - cs301.held;
    assert.equal(cs301.canMiss, cs301.attended + remaining - 30);
  });

  test('the lecture CSV lists everyone, absentees included, and is safe to open', async () => {
    t.db.prepare("UPDATE users SET name = '=HYPERLINK(\"http://x\")' WHERE id = 129").run();
    const lecture = (await t.call('GET', '/api/courses', { token: faculty1 })).data.find((c) => c.id === 1).lectures[0].id;
    const res = await t.call('GET', `/api/sessions/${lecture}/export.csv`, { token: faculty1 });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').startsWith('text/csv'));
    assert.ok(res.headers.get('content-disposition').includes('CS301-L'));
    const lines = withoutBom(res.data).trim().split('\r\n');
    assert.equal(lines[0], 'Roll no,Name,Status,Time,Method,Late,Note');
    assert.equal(lines.length, 31);
    assert.ok(lines.some((l) => l.includes('Absent')));
    assert.ok(res.data.includes("'=HYPERLINK"), 'formula-looking names are neutralised');
  });

  test('the course CSV is the register', async () => {
    const res = await t.call('GET', '/api/courses/1/export.csv', { token: faculty1 });
    assert.equal(res.status, 200);
    const header = withoutBom(res.data).split('\r\n')[0];
    assert.ok(header.startsWith('Roll no,Name,L1 '));
    assert.ok(header.endsWith(',Attended,Held,Percent'));
  });
});

describe('demo reset', () => {
  test('puts the class back to its starting point', async () => {
    assert.equal((await t.call('POST', '/api/demo/reset', { token: faculty1 })).status, 200);
    const courses = (await t.call('GET', '/api/courses', { token: faculty1 })).data;
    assert.equal(courses.find((c) => c.id === 1).lectures.length, 6);
    assert.equal(courses.find((c) => c.id === 1).open, null);
    // People stay signed in across a reset.
    assert.equal((await t.call('GET', '/api/me', { token: faculty1 })).status, 200);
  });
});
