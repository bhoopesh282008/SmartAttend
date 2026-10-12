import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinates } from '../src/coordinates.js';

test('plain decimal degrees, the way maps copy them', () => {
  assert.deepEqual(parseCoordinates('27.7172, 85.3240'), { lat: 27.7172, lng: 85.324 });
  assert.deepEqual(parseCoordinates('27.7172,85.3240'), { lat: 27.7172, lng: 85.324 });
  assert.deepEqual(parseCoordinates('  27.7172   85.3240  '), { lat: 27.7172, lng: 85.324 });
  assert.deepEqual(parseCoordinates('27.7172; 85.3240'), { lat: 27.7172, lng: 85.324 });
  assert.deepEqual(parseCoordinates('-33.8688, 151.2093'), { lat: -33.8688, lng: 151.2093 });
  assert.deepEqual(parseCoordinates('27, 85'), { lat: 27, lng: 85 });
});

test('degree signs and hemisphere letters are understood, in either order', () => {
  assert.deepEqual(parseCoordinates('27.7172°, 85.3240°'), { lat: 27.7172, lng: 85.324 });
  assert.deepEqual(parseCoordinates('27.7172° N, 85.3240° E'), { lat: 27.7172, lng: 85.324 });
  assert.deepEqual(parseCoordinates('N 27.7172 E 85.3240'), { lat: 27.7172, lng: 85.324 });
  assert.deepEqual(parseCoordinates('33.8688 S, 151.2093 E'), { lat: -33.8688, lng: 151.2093 });
  assert.deepEqual(parseCoordinates('85.3240 E, 27.7172 N'), { lat: 27.7172, lng: 85.324 }, 'letters win over order');
  assert.deepEqual(parseCoordinates('27.7172 N, 85.3240 W'), { lat: 27.7172, lng: -85.324 });
});

test('anything unclear is refused rather than guessed', () => {
  for (const bad of [
    '', '   ', null, undefined, 'Kathmandu', '27.7172', '27.7172, 85.3240, 12', 'one, two',
    `27° 43' 1.9" N, 85° 19' 26.4" E`, // degrees-minutes-seconds
    '27.7172 N, 85.3240 N', // two latitudes
    '27.7172 N, 85.3240', // one letter among two numbers
    '95, 85', // latitude out of range
    '27, 185', // longitude out of range
    '27.7172, 85.3240 Everest',
  ]) {
    assert.equal(parseCoordinates(bad), null, JSON.stringify(bad));
  }
});
