import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { faceFrame, launchChrome, mjpegFile, signedInPage, startStack } from './harness.mjs';

let stack;
let renderer;
const videos = {};
before(async () => {
  stack = await startStack();
  renderer = await launchChrome();
  for (const person of ['personA', 'personB']) videos[person] = mjpegFile(stack.dir, person, await faceFrame(renderer, person));
});
after(async () => {
  await renderer?.close();
  await stack.stop();
});

const STUDENT = 100;

async function enrol(page) {
  await page.goto(`${stack.base}/face`);
  await page.getByLabel(/I understand, and I agree/).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByText('Face found.').waitFor({ timeout: 90_000 });
  for (const n of [1, 2, 3]) {
    await page.getByRole('button', { name: `Take photo ${n}`, exact: true }).click();
    // After the third photo the page goes straight to "enrolled", so there is no "3 of 3" to wait for.
    if (n < 3) await page.getByText(`${n} of 3 taken`).waitFor({ timeout: 30_000 });
  }
  await page.getByText('Your face is enrolled.').waitFor({ timeout: 30_000 });
}

// Starts a lecture that asks for a face and returns a fresh code. Codes last 60 s, so call this late.
async function faceLecture(faculty, options = {}) {
  await stack.query('SELECT 1'); // the database is readable from the test
  const open = stack.query("SELECT id FROM sessions WHERE course_id = 1 AND closed_at IS NULL");
  for (const { id } of open) await stack.api('POST', `/api/sessions/${id}/close`, { token: faculty });
  const lecture = (await stack.api('POST', '/api/courses/1/sessions', { token: faculty, body: { faceRequired: true, ...options } })).data.id;
  const token = (await stack.api('POST', `/api/sessions/${lecture}/qr`, { token: faculty, body: { origin: stack.base } })).data.token;
  return { lecture, token };
}

test('enrolling through the real camera UI, then a matching face is marked present and a different face is held for review', { timeout: 300_000 }, async () => {
  const faculty = await stack.login(1);

  // 1. Enrol with person A in front of the camera.
  const browserA = await launchChrome({ video: videos.personA });
  try {
    const a = await signedInPage(browserA, stack, STUDENT, { permissions: ['camera'] });
    await enrol(a.page);
    const status = (await stack.api('GET', '/api/me/face', { token: a.token })).data;
    assert.equal(status.enrolled, true);

    // The server holds an encrypted template and nothing that looks like a picture.
    const [{ face_template: sealed }] = stack.query('SELECT face_template FROM users WHERE id = ?', STUDENT);
    assert.match(sealed, /^v1\./);

    // 2. Person A scans: a match.
    const first = await faceLecture(faculty);
    await a.page.goto(`${stack.base}/s/${first.token}`);
    await a.page.getByText('Face found.').waitFor({ timeout: 90_000 });
    await a.page.getByRole('button', { name: 'Take photo and send' }).click();
    await a.page.getByRole('heading', { name: 'Marked present' }).waitFor({ timeout: 40_000 });
    const [match] = stack.query('SELECT status, face_distance FROM scans WHERE session_id = ? AND student_id = ?', first.lecture, STUDENT);
    assert.equal(match.status, 'present');
    assert.ok(match.face_distance < 0.35, `the same face should be close to its enrolment, was ${match.face_distance}`);
    assert.deepEqual(a.problems, []);
  } finally {
    await browserA.close();
  }

  // 3. A different person's face on the same account: held for review, with the distance on record.
  const browserB = await launchChrome({ video: videos.personB });
  try {
    const b = await signedInPage(browserB, stack, STUDENT, { permissions: ['camera'] });
    const second = await faceLecture(faculty);
    await b.page.goto(`${stack.base}/s/${second.token}`);
    await b.page.getByText('Face found.').waitFor({ timeout: 90_000 });
    await b.page.getByRole('button', { name: 'Take photo and send' }).click();
    await b.page.getByRole('heading', { name: 'Recorded, waiting for your lecturer' }).waitFor({ timeout: 40_000 });

    const row = (await stack.api('GET', `/api/sessions/${second.lecture}`, { token: faculty })).data.roster.find((r) => r.studentId === STUDENT);
    assert.equal(row.status, 'review');
    assert.ok(row.reasons.some((r) => r.code === 'face_mismatch'), JSON.stringify(row.reasons));
    const [mismatch] = stack.query('SELECT face_distance FROM scans WHERE session_id = ? AND student_id = ?', second.lecture, STUDENT);
    assert.ok(mismatch.face_distance > 0.6, `a different face should be far from the enrolment, was ${mismatch.face_distance}`);
    assert.deepEqual(b.problems, []);
  } finally {
    await browserB.close();
  }
});
