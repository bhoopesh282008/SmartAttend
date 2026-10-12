import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { faceFrame, launchChrome, mjpegFile, mjpegSequence, signedInPage, startStack } from './harness.mjs';

let stack;
let renderer;
let faculty;
const videos = {};
const STUDENT = 100;

before(async () => {
  stack = await startStack();
  renderer = await launchChrome();
  faculty = await stack.login(1);
  const [front, left, right] = await Promise.all(['personC', 'turnedLeft', 'turnedRight'].map((key) => faceFrame(renderer, key)));
  // A still photograph of someone facing the camera (what a cheat would hold up).
  videos.still = mjpegFile(stack.dir, 'still', front);
  // A real head turning to one side, then the other, then looking at the camera for a few seconds, over and over.
  videos.turning = mjpegSequence(stack.dir, 'turning', [
    { jpeg: right, frames: 45 }, // 1.5 s turned to their right
    { jpeg: left, frames: 45 }, // 1.5 s turned to their left
    { jpeg: front, frames: 90 }, // 3 s facing the camera
  ]);
});
after(async () => {
  await renderer?.close();
  await stack.stop();
});

async function lectureWithHeadTurn() {
  for (const { id } of stack.query('SELECT id FROM sessions WHERE course_id = 1 AND closed_at IS NULL')) {
    await stack.api('POST', `/api/sessions/${id}/close`, { token: faculty });
  }
  const lecture = (await stack.api('POST', '/api/courses/1/sessions', { token: faculty, body: { faceRequired: true, faceLiveness: true } })).data.id;
  const token = (await stack.api('POST', `/api/sessions/${lecture}/qr`, { token: faculty, body: { origin: stack.base } })).data.token;
  return { lecture, token };
}

test('the student enrols, and the lecturer starts a lecture that asks for a head turn', { timeout: 200_000 }, async () => {
  const browser = await launchChrome({ video: videos.still });
  try {
    const { page } = await signedInPage(browser, stack, STUDENT, { permissions: ['camera'] });
    await page.goto(`${stack.base}/face`);
    await page.getByLabel(/I understand, and I agree/).check();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByText('Face found.').waitFor({ timeout: 90_000 });
    for (const n of [1, 2, 3]) {
      await page.getByRole('button', { name: `Take photo ${n}`, exact: true }).click();
      if (n < 3) await page.getByText(`${n} of 3 taken`).waitFor({ timeout: 30_000 });
    }
    await page.getByText('Your face is enrolled.').waitFor({ timeout: 30_000 });
  } finally {
    await browser.close();
  }
});

test('a head that turns and comes back passes, and the photo that is matched is the one taken afterwards', { timeout: 200_000 }, async () => {
  const { lecture, token } = await lectureWithHeadTurn();
  const browser = await launchChrome({ video: videos.turning });
  try {
    const { page, problems } = await signedInPage(browser, stack, STUDENT, { permissions: ['camera'] });
    await page.goto(`${stack.base}/s/${token}`);
    await page.getByText(/You will be asked to turn your head/).waitFor({ timeout: 60_000 });
    await page.getByText('Face found.').waitFor({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Start the face check' }).click();
    // The screen tells the student what to do, at each step.
    await page.getByText(/Turn your head to your (left|right)/).first().waitFor({ timeout: 15_000 });
    await page.getByText('Now look straight at the camera.').waitFor({ timeout: 30_000 });
    await page.getByRole('heading', { name: 'Marked present' }).waitFor({ timeout: 40_000 });

    const [row] = stack.query('SELECT status, face_distance FROM scans WHERE session_id = ? AND student_id = ?', lecture, STUDENT);
    assert.equal(row.status, 'present');
    assert.ok(row.face_distance < 0.35, `the face read after the turn should match the enrolment, was ${row.face_distance}`);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test('a photograph held up to the camera never turns, so the check fails and nothing is marked', { timeout: 200_000 }, async () => {
  const { lecture, token } = await lectureWithHeadTurn();
  const browser = await launchChrome({ video: videos.still });
  try {
    const { page } = await signedInPage(browser, stack, STUDENT, { permissions: ['camera'] });
    await page.goto(`${stack.base}/s/${token}`);
    await page.getByText('Face found.').waitFor({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Start the face check' }).click();
    // The challenge gives a person eight seconds to turn; a picture cannot, and is told so.
    await page.getByText(/did not look like a head turn/).waitFor({ timeout: 30_000 });
    const [none] = stack.query('SELECT COUNT(*) AS n FROM scans WHERE session_id = ? AND student_id = ?', lecture, STUDENT);
    assert.equal(none.n, 0, 'nothing was sent for a failed challenge');

    // The student can still send the scan without the face check; the lecturer then has to confirm it.
    await page.getByRole('button', { name: 'Skip the face check' }).click();
    await page.getByRole('heading', { name: /Recorded, waiting/ }).waitFor({ timeout: 30_000 });
    const row = (await stack.api('GET', `/api/sessions/${lecture}`, { token: faculty })).data.roster.find((r) => r.studentId === STUDENT);
    assert.equal(row.status, 'review');
    assert.ok(row.reasons.some((r) => r.code === 'face_missing'), JSON.stringify(row.reasons));
  } finally {
    await browser.close();
  }
});
