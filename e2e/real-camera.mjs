// Uses the REAL webcam in a temporary Chrome. Run it with someone in front of the camera:
//
//     npm run e2e:camera
//
// What it does: opens the camera, listens to the app's live framing feedback for a few seconds, and
// reports what it saw. If a face is in view it also enrols that face (three photos, in a throwaway
// database) and scans it several more times, to measure how far the SAME real person is from their
// own enrolment. It prints counts and distances only. No picture is saved or printed, no descriptor is
// printed, and the throwaway database and key are deleted afterwards.
import { launchChrome, signedInPage, startStack } from './harness.mjs';

const WATCH_SECONDS = Number(process.env.E2E_WATCH_SECONDS ?? 12);
const REPEATS = Number(process.env.E2E_SCANS ?? 5);
const STUDENT = 100;

const stack = await startStack({ ml: false });
const browser = await launchChrome();
const report = { camera: null, framing: {}, enrolled: false, sameFaceDistances: [] };

try {
  const { page, token, problems } = await signedInPage(browser, stack, STUDENT, { permissions: ['camera'] });
  await page.goto(`${stack.base}/face`);
  await page.getByLabel(/I understand, and I agree/).check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  // Is there a camera, and does the page get frames from it?
  const video = page.locator('video');
  await video.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, null, { timeout: 30_000 }).catch(() => {});
  report.camera = await page.evaluate(() => {
    const v = document.querySelector('video');
    const track = v?.srcObject?.getVideoTracks?.()[0];
    return v && track ? { label: track.label, width: v.videoWidth, height: v.videoHeight, state: track.readyState } : null;
  });

  // Listen to what the app says about the picture (none / many / far / unclear / face found).
  const seen = {};
  const until = Date.now() + WATCH_SECONDS * 1000;
  while (Date.now() < until) {
    const text = (await page.locator('[role=status]').first().innerText().catch(() => '')).trim();
    if (text) seen[text] = (seen[text] ?? 0) + 1;
    await page.waitForTimeout(400);
  }
  report.framing = seen;
  const faceSeen = Boolean(seen['Face found.']);

  if (faceSeen) {
    // Enrol (three photos), then scan the same face several times and read the stored distances.
    for (const n of [1, 2, 3]) {
      await page.getByText('Face found.').waitFor({ timeout: 20_000 }).catch(() => {});
      await page.getByRole('button', { name: `Take photo ${n}`, exact: true }).click();
      if (n < 3) await page.getByText(`${n} of 3 taken`).waitFor({ timeout: 30_000 });
    }
    await page.getByText('Your face is enrolled.').waitFor({ timeout: 30_000 });
    report.enrolled = true;

    const faculty = await stack.login(1);
    for (let i = 0; i < REPEATS; i += 1) {
      for (const { id } of stack.query('SELECT id FROM sessions WHERE course_id = 1 AND closed_at IS NULL')) {
        await stack.api('POST', `/api/sessions/${id}/close`, { token: faculty });
      }
      const lecture = (await stack.api('POST', '/api/courses/1/sessions', { token: faculty, body: { faceRequired: true } })).data.id;
      const code = (await stack.api('POST', `/api/sessions/${lecture}/qr`, { token: faculty, body: { origin: stack.base } })).data.token;
      await page.goto(`${stack.base}/s/${code}`);
      await page.getByText('Face found.').waitFor({ timeout: 45_000 }).catch(() => {});
      await page.getByRole('button', { name: 'Take photo and send' }).click();
      await page.getByRole('heading').filter({ hasText: /Marked present|Recorded|Not marked/ }).first().waitFor({ timeout: 30_000 });
      const [row] = stack.query('SELECT status, face_distance FROM scans WHERE session_id = ? AND student_id = ?', lecture, STUDENT);
      if (row?.face_distance != null) report.sameFaceDistances.push({ status: row.status, distance: Number(row.face_distance.toFixed(3)) });
    }
  }
  report.pageProblems = problems;
  void token;
} finally {
  await browser.close();
  await stack.stop();
}

const d = report.sameFaceDistances.map((r) => r.distance).sort((a, b) => a - b);
console.log('\n=== Real webcam report ===');
console.log('camera:', report.camera ? `${report.camera.label} ${report.camera.width}x${report.camera.height} (${report.camera.state})` : 'NOT FOUND');
console.log(`what the app saw in ${WATCH_SECONDS}s (status text -> checks):`, report.framing);
if (!report.enrolled) {
  console.log('\nNo face was in view, so enrolment was not tried. Sit in front of the camera, in good light, and run it again.');
} else {
  console.log(`\nenrolled with the real face. ${d.length} re-scans of the same person:`);
  console.log('  distances to own enrolment:', d.join(', '));
  console.log(`  min ${d[0]}  median ${d[Math.floor(d.length / 2)]}  max ${d.at(-1)}  (match line is 0.6)`);
  console.log('  outcomes:', report.sameFaceDistances.map((r) => r.status).join(', '));
}
if (report.pageProblems?.length) console.log('page problems:', report.pageProblems);
