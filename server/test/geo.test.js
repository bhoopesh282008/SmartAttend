import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineM, judgeLocation } from '../src/geo.js';
import { KATHMANDU, metresNorth } from './helpers.js';

const room = { lat: KATHMANDU.lat, lng: KATHMANDU.lng };
const at = (metres, accuracy) => ({ ...metresNorth(metres), accuracy });
const judge = (location, radiusM = 150) => judgeLocation({ room, radiusM, location });

test('haversine is about right (1 degree of latitude is about 111 km)', () => {
  const d = haversineM(27, 85, 28, 85);
  assert.ok(Math.abs(d - 111_195) < 300, String(d));
});

test('checking is skipped when off or when the room is not set', () => {
  assert.equal(judgeLocation({ room, radiusM: null, location: null }).action, 'skipped');
  assert.equal(judgeLocation({ room: { lat: null, lng: null }, radiusM: 150, location: at(0, 5) }).action, 'skipped');
});

test('inside the room with a good fix is ok', () => {
  assert.equal(judge(at(100, 10)).action, 'ok');
});

test('a missing location is review, never distance zero', () => {
  const result = judge(null);
  assert.equal(result.action, 'review');
  assert.equal(result.distanceM, null);
  assert.equal(result.reasons[0].code, 'location_missing');
});

test('an imprecise fix is review even if it looks far', () => {
  const result = judge(at(2000, 800));
  assert.equal(result.action, 'review');
  assert.equal(result.reasons[0].code, 'location_imprecise');
});

test('accuracy is subtracted, so a vague fix cannot look far', () => {
  // 280 m away with 90 m error: margin 190 m, past the 150 m limit but within 2 x, so review not reject.
  assert.equal(judge(at(280, 90)).action, 'review');
  // 200 m away with 90 m error: margin 110 m, inside the limit.
  assert.equal(judge(at(200, 90)).action, 'ok');
});

test('grey zone goes to review; clearly far with a good fix is rejected', () => {
  assert.equal(judge(at(250, 10)).action, 'review');
  const far = judge(at(2000, 20));
  assert.equal(far.action, 'reject');
  assert.equal(far.reasons[0].code, 'too_far');
});

test('no accuracy reported counts as imprecise', () => {
  assert.equal(judge({ ...metresNorth(10), accuracy: null }).action, 'review');
});
