import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM } from './fixtures.mjs';
import { launchChrome, signedInPage, startFakeOverpass, startStack } from './harness.mjs';

// Positions are worked out relative to the classroom's point, a few metres at a time.
const M = 111_195;
const offset = (east, north, accuracy = 10) => ({
  latitude: ROOM.latitude + north / M,
  longitude: ROOM.longitude + east / (M * Math.cos((ROOM.latitude * Math.PI) / 180)),
  accuracy,
});
// A building 100 m square with the classroom's point at its middle, as the ring OpenStreetMap would give.
const BUILDING = [offset(-50, -50), offset(50, -50), offset(50, 50), offset(-50, 50)].map((p) => [p.latitude, p.longitude]);

let stack;
let overpass;
let browser;
let faculty;
before(async () => {
  overpass = await startFakeOverpass(BUILDING);
  stack = await startStack({ overpassUrl: overpass.url });
  browser = await launchChrome();
  faculty = await stack.login(1);
});
after(async () => {
  await browser?.close();
  await stack.stop();
  await overpass.stop();
});

const courseCard = (page) => page.locator('section[aria-labelledby="course-1"]');
const useDevice = (page) => page.getByRole('button', { name: /(Use this device.s position|Update from this device)/ });

test('the lecturer sets the classroom from the browser position, and a vague position is refused with advice', { timeout: 120_000 }, async () => {
  const good = await signedInPage(browser, stack, 1, { geolocation: offset(0, 0, 12) });
  await good.page.goto(`${stack.base}/faculty`);
  await useDevice(courseCard(good.page)).click();
  await good.page.getByText('Classroom position saved.').waitFor({ timeout: 30_000 });
  await courseCard(good.page).getByText(/accurate to about 12 m/).waitFor();
  assert.deepEqual(good.problems, []);

  // A fresh browser context (so it does not reuse the cached good fix) that can only offer a vague one.
  const vague = await signedInPage(browser, stack, 1, { geolocation: offset(0, 0, 800) });
  await vague.page.goto(`${stack.base}/faculty`);
  await useDevice(courseCard(vague.page)).click();
  await vague.page.getByText(/too vague to mark a classroom/).waitFor({ timeout: 30_000 });
  await courseCard(vague.page).getByText(/accurate to about 12 m/).waitFor(); // still the good one: nothing was overwritten
  await good.context.close();
  await vague.context.close();
});

test('on a device that cannot find its position, coordinates can be typed in instead', { timeout: 120_000 }, async () => {
  const typed = await signedInPage(browser, stack, 1); // no location permission: like a desktop with no way to find itself
  await typed.page.goto(`${stack.base}/faculty`);
  await useDevice(courseCard(typed.page)).click();
  await typed.page.getByText(/Type the coordinates instead/).waitFor({ timeout: 30_000 });

  const form = courseCard(typed.page);
  await form.getByLabel('Latitude, longitude').fill('not a place');
  await form.getByRole('button', { name: 'Save position' }).click();
  await form.getByText(/Could not read that/).waitFor();

  await form.getByLabel('Latitude, longitude').fill(`${ROOM.latitude}, ${ROOM.longitude}`);
  await form.getByLabel('Accurate to about').selectOption('25');
  await form.getByRole('button', { name: 'Save position' }).click();
  await form.getByText('Classroom position saved.').waitFor({ timeout: 20_000 });
  await form.getByText(/accurate to about 25 m \(typed in\)/).waitFor();
  assert.deepEqual(typed.problems, []);
  await typed.context.close();
});

test('the building outline is added on request, drawn, and then students are checked against the walls', { timeout: 240_000 }, async () => {
  const lecturer = await signedInPage(browser, stack, 1);
  await lecturer.page.goto(`${stack.base}/faculty`);
  const card = courseCard(lecturer.page);

  await card.getByRole('button', { name: 'Add building outline' }).click();
  await card.getByText(/Building outline added \(OpenStreetMap way 4242, Block A\)/).waitFor({ timeout: 30_000 });
  await card.getByText(/with building outline/).waitFor();
  assert.equal(await card.locator('svg[role=img] polygon').count(), 2, 'the outline and its margin are drawn');
  assert.equal(overpass.calls.length, 1, 'OpenStreetMap was asked exactly once');
  assert.match(overpass.calls[0], /around:60,27\.717200,85\.324000/);

  // Start a location-checked lecture from the page. With an outline the check measures from the walls.
  await card.getByLabel('Lecture title').fill('Walls and circles');
  await card.getByLabel('Check students are in the room').check();
  await card.getByLabel(/Allowed distance outside the walls/).waitFor();
  assert.equal(await card.getByLabel(/Allowed distance outside the walls/).inputValue(), '50');
  await card.getByRole('button', { name: 'Start lecture' }).click();
  await lecturer.page.getByText(/location check on \(50 m\)/).waitFor({ timeout: 20_000 });
  await lecturer.page.getByText(/closes by itself at/).waitFor();
  const lectureId = Number(new URL(lecturer.page.url()).pathname.split('/').pop());

  const scanAs = async (studentId, geolocation) => {
    const student = await signedInPage(browser, stack, studentId, { geolocation });
    const token = (await stack.api('POST', `/api/sessions/${lectureId}/qr`, { token: faculty, body: { origin: stack.base } })).data.token;
    await student.page.goto(`${stack.base}/s/${token}`);
    const heading = student.page.getByRole('heading', { name: /Marked present|Not marked|Recorded, waiting/ });
    await heading.waitFor({ timeout: 40_000 });
    const result = { heading: await heading.innerText(), text: await student.page.locator('main').innerText(), problems: student.problems };
    await student.context.close();
    return result;
  };

  // Standing at the far corner inside the building, about 64 m from the classroom's point: fine against the walls.
  const inside = await scanAs(100, offset(45, 45, 10));
  assert.equal(inside.heading, 'Marked present');
  assert.deepEqual(inside.problems, []);

  // 2 km away with a good fix: refused with the reason in plain words.
  const far = await scanAs(101, offset(0, 2000, 10));
  assert.equal(far.heading, 'Not marked');
  assert.match(far.text, /too far from the classroom/);

  // A vague fix cannot judge distance: held for the lecturer, who sees why.
  const vague = await scanAs(102, offset(0, 3000, 400));
  assert.match(vague.heading, /Recorded, waiting/);

  // No permission to share a position at all: held for review, and the student is told what that means.
  const refused = await scanAs(103, undefined);
  assert.match(refused.heading, /Recorded, waiting/);
  assert.match(refused.text, /Location was not shared/);

  const roster = (await stack.api('GET', `/api/sessions/${lectureId}`, { token: faculty })).data.roster;
  const reasonOf = (id) => roster.find((r) => r.studentId === id).reasons.map((r) => r.code);
  // The rules give the first reason; when the risk model is running it may add its own (3 km away is outside the room, however vague).
  assert.ok(reasonOf(102).includes('location_imprecise'), reasonOf(102).join());
  assert.ok(reasonOf(103).includes('location_missing'), reasonOf(103).join());
  const [insideRow] = stack.query('SELECT distance_m FROM scans WHERE session_id = ? AND student_id = ?', lectureId, 100);
  assert.equal(insideRow.distance_m, 0, 'inside the building is 0 m from its walls');
  await lecturer.context.close();
});
