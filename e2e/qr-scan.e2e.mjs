import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, mjpegFile, qrFrame, signedInPage, startStack } from './harness.mjs';

let stack;
before(async () => {
  stack = await startStack();
});
after(async () => {
  await stack.stop();
});

// A code is good for 60 s, so everything from generating it to reading it has to happen inside that.
async function lectureWithCodeOnCamera() {
  const faculty = await stack.login(1);
  const lecture = (await stack.api('POST', '/api/courses/1/sessions', { token: faculty, body: {} })).data.id;
  const code = (await stack.api('POST', `/api/sessions/${lecture}/qr`, { token: faculty, body: { origin: stack.base } })).data;
  const drawing = await launchChrome();
  const jpeg = await qrFrame(drawing, code.svg);
  await drawing.close();
  return { faculty, lecture, code, video: mjpegFile(stack.dir, `qr-${lecture}`, jpeg) };
}

test('the in-app scanner reads a QR code from a browser camera stream and marks the student present', { timeout: 120_000 }, async () => {
  const { faculty, lecture, video } = await lectureWithCodeOnCamera();
  const browser = await launchChrome({ video });
  try {
    const { page, problems } = await signedInPage(browser, stack, 100, { permissions: ['camera'] });
    await page.goto(`${stack.base}/scan`);
    // It should have started the camera (not shown a camera error) and then found the code on its own.
    await page.getByRole('heading', { name: 'Marked present' }).waitFor({ timeout: 60_000 });
    assert.match(page.url(), /\/s\/\d+\.\d+\./, 'the scanner moved to the scan link it found in the picture');

    const roster = (await stack.api('GET', `/api/sessions/${lecture}`, { token: faculty })).data.roster;
    assert.equal(roster.find((r) => r.studentId === 100).status, 'present');
    assert.deepEqual(problems, [], 'no page errors');
  } finally {
    await browser.close();
  }
});

test('a camera showing something that is not an attendance code does nothing, and the paste-a-link fallback still works', { timeout: 120_000 }, async () => {
  const faculty = await stack.login(1);
  await stack.api('POST', '/api/sessions/' + (await stack.api('GET', '/api/courses', { token: faculty })).data.find((c) => c.id === 1).lectures[0].id + '/close', { token: faculty });
  const lecture = (await stack.api('POST', '/api/courses/2/sessions', { token: faculty, body: {} })).data.id;

  // A QR for something else entirely (a web address) must not be mistaken for a code.
  const drawing = await launchChrome();
  const other = (await import('qrcode')).default;
  const svg = await other.toString('https://example.com/not-an-attendance-code', { type: 'svg', margin: 2 });
  const video = mjpegFile(stack.dir, 'other', await qrFrame(drawing, svg));
  await drawing.close();

  const browser = await launchChrome({ video });
  try {
    const { page, problems } = await signedInPage(browser, stack, 101, { permissions: ['camera'] });
    await page.goto(`${stack.base}/scan`);
    await page.getByText('Point the camera at the code').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2500); // long enough for dozens of frames to be read
    assert.match(new URL(page.url()).pathname, /^\/scan$/, 'still on the scan page: the stranger QR was ignored');

    // The fallback: paste a real link.
    const token = (await stack.api('POST', `/api/sessions/${lecture}/qr`, { token: faculty, body: { origin: stack.base } })).data.token;
    await page.getByLabel('Or paste the link').fill(`${stack.base}/s/${token}`);
    await page.getByRole('button', { name: 'Use', exact: true }).click();
    await page.getByRole('heading', { name: 'Marked present' }).waitFor({ timeout: 30_000 });
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});
