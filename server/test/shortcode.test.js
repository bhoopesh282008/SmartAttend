import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';
import { issueShortCode, makeAttemptLimiter, normaliseCode, resolveShortCode } from '../src/shortcode.js';
import { signToken, GRACE_MS, TOKEN_TTL_MS } from '../src/token.js';
import { startTestApp } from './helpers.js';

describe('the 6-digit code, in itself', () => {
  const NOW = Date.UTC(2026, 9, 12, 9, 0, 0);
  const freshDb = () => {
    const db = openDb(':memory:');
    seedDemo(db, { now: () => NOW });
    // one open lecture of CS301 (course 1; students 100-129), one of MA201 (course 3; students 100-119)
    db.prepare("INSERT INTO sessions (id, course_id, lecture_no, title, started_at, secret) VALUES (900, 1, 99, 'L', ?, 'secret-a')").run(NOW);
    db.prepare("INSERT INTO sessions (id, course_id, lecture_no, title, started_at, secret) VALUES (901, 3, 99, 'L', ?, 'secret-b')").run(NOW);
    return db;
  };

  test('typed digits are tidied, and anything that is not six digits is refused', () => {
    for (const ok of ['482913', '482 913', '482-913', ' 482 913 ', '000123']) assert.match(normaliseCode(ok), /^\d{6}$/, ok);
    assert.equal(normaliseCode('482 913'), '482913');
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x', null, undefined, 482913]) {
      if (typeof bad === 'number') assert.equal(normaliseCode(bad), '482913', 'a number is fine once it is six digits');
      else assert.equal(normaliseCode(bad), null, String(bad));
    }
  });

  test('a code is six digits, kept padded, and never repeats while another is live', () => {
    const db = freshDb();
    assert.equal(issueShortCode(db, 900, NOW, () => 42), '000042');
    // 42 is taken for the next 62 s, so the next pick that is not 42 wins
    const picks = [42, 42, 7];
    assert.equal(issueShortCode(db, 900, NOW + 1000, () => picks.shift()), '000007');
    // once the first has run out, its digits may be used again
    assert.equal(issueShortCode(db, 900, NOW + TOKEN_TTL_MS + GRACE_MS + 1000, () => 42), '000042');
  });

  test('old rows are swept so the table stays tiny', () => {
    const db = freshDb();
    issueShortCode(db, 900, NOW, () => 1);
    issueShortCode(db, 900, NOW + 6 * 60_000, () => 2);
    assert.deepEqual(db.prepare('SELECT code FROM codes').all().map((r) => r.code), ['000002']);
  });

  test('the digits stand for exactly the token of that QR, for students in that course', () => {
    const db = freshDb();
    issueShortCode(db, 900, NOW, () => 123456);
    const expected = signToken('secret-a', 900, NOW);
    assert.equal(resolveShortCode(db, NOW + 5000, 100, '123456'), expected);
    assert.equal(resolveShortCode(db, NOW + 5000, 125, '123456'), expected, 'students 125-129 are in CS301 only, and CS301 is the lecture');
  });

  test('it does not reach lectures of courses the student is not in', () => {
    const db = freshDb();
    issueShortCode(db, 901, NOW, () => 654321); // MA201: students 100-119
    assert.ok(resolveShortCode(db, NOW, 110, '654321'));
    assert.equal(resolveShortCode(db, NOW, 125, '654321'), null, 'student 125 is not in MA201');
  });

  test('it runs out with the QR, and not before', () => {
    const db = freshDb();
    issueShortCode(db, 900, NOW, () => 111111);
    assert.ok(resolveShortCode(db, NOW + TOKEN_TTL_MS, 100, '111111'), 'good at 60 s');
    assert.ok(resolveShortCode(db, NOW + TOKEN_TTL_MS + GRACE_MS, 100, '111111'), 'and for the network grace');
    assert.equal(resolveShortCode(db, NOW + TOKEN_TTL_MS + GRACE_MS + 1, 100, '111111'), null);
    assert.equal(resolveShortCode(db, NOW - 1, 100, '111111'), null, 'not before it was issued');
  });

  test('it does nothing once the lecture is closed', () => {
    const db = freshDb();
    issueShortCode(db, 900, NOW, () => 222222);
    db.prepare('UPDATE sessions SET closed_at = ? WHERE id = 900').run(NOW + 1000);
    assert.equal(resolveShortCode(db, NOW + 2000, 100, '222222'), null);
  });

  test('wrong guesses are limited per student, and forgiven after the window', () => {
    let t = 0;
    const limiter = makeAttemptLimiter({ now: () => t, limit: 3, windowMs: 1000 });
    assert.equal(limiter.blocked('a'), false);
    limiter.fail('a');
    limiter.fail('a');
    assert.equal(limiter.blocked('a'), false);
    limiter.fail('a');
    assert.equal(limiter.blocked('a'), true);
    assert.equal(limiter.blocked('b'), false, 'someone else is not affected');
    t = 1001;
    assert.equal(limiter.blocked('a'), false, 'forgiven after the window');
  });
});

describe('typing the code instead of scanning, through the app', () => {
  let t;
  let faculty;
  before(async () => {
    t = await startTestApp();
    faculty = await t.login(1);
  });
  after(() => t.close());

  const typed = async (studentId, code, extra = {}) =>
    t.call('POST', '/api/scan', { token: await t.login(studentId), body: { code, deviceId: `phone-of-${studentId}-xx`, location: null, ...extra } });

  test('every QR comes with six digits, and they mark the student present like the QR would', async () => {
    const lecture = await t.openLecture(faculty, 1);
    const code = await t.newCode(faculty, lecture);
    assert.match(code.shortCode, /^\d{6}$/);
    const res = await typed(100, `${code.shortCode.slice(0, 3)} ${code.shortCode.slice(3)}`);
    assert.equal(res.data.outcome, 'marked');
    const row = (await t.call('GET', `/api/sessions/${lecture}`, { token: faculty })).data.roster.find((r) => r.studentId === 100);
    assert.equal(row.status, 'present');
    assert.equal(row.method, 'qr', 'it is recorded like any other scan');
    // a second student can use the same digits from their own phone
    assert.equal((await typed(101, code.shortCode)).data.outcome, 'marked');
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty });
  });

  test('the preview takes the digits too, and hands back the token to send', async () => {
    const lecture = await t.openLecture(faculty, 1, { faceRequired: true, faceLiveness: true });
    const code = await t.newCode(faculty, lecture);
    const preview = (await t.call('POST', '/api/scan/preview', { token: await t.login(102), body: { code: code.shortCode } })).data;
    assert.equal(preview.valid, true);
    assert.equal(preview.faceRequired, true);
    assert.equal(preview.faceLiveness, true);
    assert.equal(preview.token, code.token);
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty });
  });

  test('a wrong code is refused with an explanation, and nothing is recorded', async () => {
    const lecture = await t.openLecture(faculty, 1);
    await t.newCode(faculty, lecture);
    const res = await typed(103, '000000');
    assert.equal(res.data.outcome, 'rejected');
    assert.equal(res.data.code, 'bad_code');
    assert.match(res.data.message, /Check the digits/);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM scans WHERE session_id = ? AND student_id = 103').get(lecture).n, 0);
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty });
  });

  test('guessing is slowed: too many wrong codes in a minute are refused, for that student only, and forgiven later', async () => {
    const lecture = await t.openLecture(faculty, 1);
    const code = await t.newCode(faculty, lecture);
    for (let i = 0; i < 8; i += 1) assert.equal((await typed(104, '999999')).data.code, 'bad_code');
    const blocked = await typed(104, code.shortCode);
    assert.equal(blocked.status, 429, 'even the right code, while blocked');
    assert.equal(blocked.data.error.code, 'too_many_attempts');
    assert.equal((await typed(105, code.shortCode)).data.outcome, 'marked', 'another student is unaffected');
    t.clock.t += 61_000;
    const fresh = await t.newCode(faculty, lecture);
    assert.equal((await typed(104, fresh.shortCode)).data.outcome, 'marked', 'a minute later it works again');
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty });
  });

  test('a code for another course does not work for a student who is not in it', async () => {
    const lecture = await t.openLecture(faculty, 2); // CS305: students 100-123
    const code = await t.newCode(faculty, lecture);
    const outsider = await typed(125, code.shortCode); // student 125 is not in CS305
    assert.equal(outsider.data.code, 'bad_code');
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty });
  });

  test('it expires with the QR, and sending nothing at all is a 400', async () => {
    const lecture = await t.openLecture(faculty, 1);
    const code = await t.newCode(faculty, lecture);
    t.clock.t += 63_000;
    assert.equal((await typed(106, code.shortCode)).data.code, 'bad_code');
    const none = await t.call('POST', '/api/scan', { token: await t.login(106), body: { deviceId: 'phone-of-106-xx' } });
    assert.equal(none.status, 400);
    const short = await t.call('POST', '/api/scan', { token: await t.login(106), body: { code: '123', deviceId: 'phone-of-106-xx' } });
    assert.equal(short.status, 400);
    await t.call('POST', `/api/sessions/${lecture}/close`, { token: faculty });
  });
});
