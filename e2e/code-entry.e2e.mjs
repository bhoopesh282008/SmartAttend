import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, signedInPage, startStack } from './harness.mjs';

let stack;
let browser;
before(async () => {
  stack = await startStack();
  browser = await launchChrome(); // no camera file, and no camera permission is granted below
});
after(async () => {
  await browser?.close();
  await stack.stop();
});

test('six digits under the QR, typed on a phone with no usable camera, mark the student present', { timeout: 120_000 }, async () => {
  const lecturer = await signedInPage(browser, stack, 1);
  await lecturer.page.goto(`${stack.base}/faculty`);
  await lecturer.page.getByLabel('Lecture title').first().fill('Typed codes');
  await lecturer.page.locator('section[aria-labelledby="course-1"]').getByRole('button', { name: 'Start lecture' }).click();
  const shortCode = lecturer.page.getByTestId('short-code');
  await shortCode.waitFor({ timeout: 30_000 });
  const digits = (await shortCode.innerText()).replace(/\s+/g, '');
  assert.match(digits, /^\d{6}$/, 'the lecturer sees six digits, grouped in threes');
  assert.match(await shortCode.innerText(), /^\d{3} \d{3}$/);

  const student = await signedInPage(browser, stack, 100); // camera permission NOT granted
  await student.page.goto(`${stack.base}/scan`);
  // The camera prompt is simply left unanswered here, as by a student who ignores it; typing must not depend on it.
  await student.page.getByLabel(/Type the 6 digits under the QR code/).fill(`${digits.slice(0, 3)} ${digits.slice(3)}`);
  await student.page.getByRole('button', { name: 'Mark me present' }).click();
  await student.page.getByRole('heading', { name: 'Marked present' }).waitFor({ timeout: 30_000 });
  assert.match(new URL(student.page.url()).pathname, /^\/c\/\d{6}$/);
  assert.deepEqual(student.problems, []);

  // The lecturer's list picks it up live.
  await lecturer.page.locator('tr', { hasText: 'Aarav Sharma' }).getByText('Present').waitFor({ timeout: 15_000 });
  await student.context.close();
  await lecturer.context.close();
});

test('a wrong code is refused in plain words and offers another try; ordinary typos are caught before sending', { timeout: 120_000 }, async () => {
  const student = await signedInPage(browser, stack, 101);
  await student.page.goto(`${stack.base}/scan`);
  const input = student.page.getByLabel(/Type the 6 digits under the QR code/);
  const send = student.page.getByRole('button', { name: 'Mark me present' });

  await input.fill('12 34');
  assert.equal(await send.isDisabled(), true, 'not enough digits yet');

  await input.fill('000000');
  await send.click();
  await student.page.getByRole('heading', { name: 'Not marked' }).waitFor({ timeout: 20_000 });
  await student.page.getByText(/Check the digits on your lecturer/).waitFor();
  await student.page.getByRole('link', { name: 'Scan again' }).click();
  await student.page.getByLabel(/Type the 6 digits under the QR code/).waitFor();
  assert.deepEqual(student.problems, []);
  await student.context.close();
});

test('guessing is slowed down: after a handful of wrong codes the student is asked to wait', { timeout: 120_000 }, async () => {
  const student = await signedInPage(browser, stack, 102);
  let sawWait = false;
  for (let i = 0; i < 10 && !sawWait; i += 1) {
    await student.page.goto(`${stack.base}/c/${String(100000 + i)}`);
    const outcome = student.page.getByRole('heading', { name: /Not marked|Could not send your scan/ });
    await outcome.waitFor({ timeout: 20_000 });
    sawWait = /Could not send your scan/.test(await outcome.innerText());
  }
  assert.ok(sawWait, 'the ninth wrong guess in a minute is refused');
  await student.page.getByText(/Too many wrong codes/).waitFor();
  await student.context.close();
});
