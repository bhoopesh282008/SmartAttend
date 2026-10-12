import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASELINE_MAX_YAW, BASELINE_READINGS, CENTRED_YAW, hasTurned, instruction, isCentred, pickDirection, runChallenge, STEADY_READINGS, TURN_YAW, yawFromLandmarks,
} from '../src/liveness.js';

// A clock that only moves when the challenge sleeps, so "8 seconds" costs no real time.
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}
// readYaw that plays back a list of readings, then repeats the last one.
const reader = (values) => {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
};
// A reader that never settles: it keeps cycling through the values.
const cycling = (values) => {
  let i = 0;
  return async () => values[i++ % values.length];
};
// Every challenge starts with a person looking at the screen: a few steady readings of their own "straight ahead".
const settle = (straight = 0.0) => Array(BASELINE_READINGS + 1).fill(straight);
const run = (direction, values, extra = {}) => runChallenge({ direction, readYaw: reader(values), ...fakeTime(), ...extra });

// 68 landmark points with the jaw edges at x=100 and x=200 and the nose tip where we say.
function landmarks(noseX) {
  const points = Array.from({ length: 68 }, () => ({ x: 150, y: 150 }));
  points[0] = { x: 100, y: 120 };
  points[16] = { x: 200, y: 120 };
  points[30] = { x: noseX, y: 150 };
  return points;
}

describe('reading the head turn from landmarks', () => {
  test('facing the camera is about zero, turning to your left is positive, to your right negative', () => {
    assert.ok(Math.abs(yawFromLandmarks(landmarks(150))) < 1e-9);
    assert.ok(yawFromLandmarks(landmarks(170)) > 0.19, 'the nose moves toward the right of the picture when you turn left');
    assert.ok(yawFromLandmarks(landmarks(130)) < -0.19);
  });

  test('a face that cannot be measured gives null, not zero', () => {
    assert.equal(yawFromLandmarks(null), null);
    assert.equal(yawFromLandmarks([]), null);
    assert.equal(yawFromLandmarks(landmarks(150).slice(0, 60)), null);
    const flat = landmarks(150);
    flat[16] = { x: 100, y: 120 }; // zero width
    assert.equal(yawFromLandmarks(flat), null);
  });

  test('the thresholds are about change from where the head started', () => {
    assert.ok(hasTurned(0.2, 'left') && !hasTurned(0.2, 'right'));
    assert.ok(hasTurned(-0.2, 'right') && !hasTurned(-0.2, 'left'));
    assert.ok(!hasTurned(0.05, 'left'), 'a slight lean is not a turn');
    assert.ok(isCentred(0.03) && isCentred(-0.03) && !isCentred(0.1));
    assert.ok(CENTRED_YAW < TURN_YAW, 'there is a gap, so a reading cannot be both turned and back');
  });

  test('the direction is random but only ever left or right', () => {
    const seen = new Set(Array.from({ length: 200 }, () => pickDirection()));
    assert.deepEqual([...seen].sort(), ['left', 'right']);
    assert.equal(pickDirection(() => 0.1), 'left');
    assert.equal(pickDirection(() => 0.9), 'right');
    assert.match(instruction('left'), /left/);
  });
});

describe('the challenge', () => {
  test('a head that turns to the asked side and comes back passes, and the screen is told each phase', async () => {
    const phases = [];
    const result = await run('left', [...settle(), 0.02, 0.1, 0.16, 0.18, 0.12, 0.05, 0.02, 0.01], { onPhase: (p) => phases.push(p) });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(phases, ['ready', 'turn', 'return']);
  });

  test('turning to the right works the same way', async () => {
    assert.deepEqual(await run('right', [...settle(), -0.15, -0.2, -0.1, 0, 0.01]), { ok: true });
  });

  test('everyone has their own "straight ahead": a head that rests at +0.08 passes with the same movements', async () => {
    // Absolute thresholds would have failed this person: they never get within 0.07 of zero.
    const result = await run('left', [...settle(0.08), 0.12, 0.2, 0.24, 0.2, 0.12, 0.09, 0.08, 0.08]);
    assert.deepEqual(result, { ok: true });
    // and a head that rests at -0.1 turning to its left has to move a full 0.12 from there, not from zero
    assert.deepEqual(await run('left', [...settle(-0.1), -0.02, -0.01, -0.02]), { ok: false, reason: 'no_turn' }, '+0.08 from where it started is not enough');
    assert.deepEqual(await run('left', [...settle(-0.1), 0.03, 0.05, -0.08, -0.1, -0.1]), { ok: true });
  });

  test('a picture facing the camera never turns, so it fails', async () => {
    assert.deepEqual(await run('left', [...settle(), 0.01, 0.0, 0.02, -0.01]), { ok: false, reason: 'no_turn' });
  });

  test('turning the wrong way does not count', async () => {
    assert.deepEqual(await run('left', [...settle(), -0.2, -0.25, -0.2]), { ok: false, reason: 'no_turn' });
  });

  test('a picture of a turned head never comes back, so it fails', async () => {
    assert.deepEqual(await run('left', [...settle(), 0.2, 0.2, 0.21, 0.2]), { ok: false, reason: 'no_return' });
  });

  test('one jittery frame is not a turn: it takes consecutive readings', async () => {
    assert.ok(STEADY_READINGS >= 2);
    const result = await run('left', [...settle(), 0.3, 0, 0.3, 0, 0.3, 0]);
    assert.equal(result.ok, false, 'spikes that never hold do not pass');
  });

  test('losing the face resets the count rather than counting as a turn', async () => {
    assert.deepEqual(await run('left', [...settle(), 0.2, null, 0.2, null, 0.2, null]), { ok: false, reason: 'no_turn' });
    // but a brief loss followed by a held turn and a return still passes
    assert.deepEqual(await run('left', [...settle(), 0.2, null, 0.2, 0.22, 0.1, null, 0.02, 0.0]), { ok: true });
  });

  test('it gives up after the time limit instead of waiting for ever', async () => {
    const time = fakeTime();
    let calls = 0;
    const result = await runChallenge({ direction: 'left', readYaw: async () => { calls += 1; return 0; }, ...time, turnMs: 1000, pollMs: 100 });
    assert.equal(result.reason, 'no_turn');
    assert.ok(calls <= 20, `polled ${calls} times`);
    assert.ok(time.now() >= 1000);
  });
});

describe('the starting reading', () => {
  test('it waits for the person to settle: an unsteady head at first is fine if it steadies in time', async () => {
    const result = await run('left', [0.3, -0.2, 0.15, ...settle(0.02), 0.2, 0.22, 0.05, 0.02]);
    assert.deepEqual(result, { ok: true });
  });

  test('without a steady look at the face there is nothing to compare with, and it says so', async () => {
    const phases = [];
    const swaying = [0.0, 0.15, -0.1, 0.2, -0.15, 0.1];
    const result = await runChallenge({ direction: 'left', readYaw: cycling(swaying), ...fakeTime(), onPhase: (p) => phases.push(p) });
    assert.deepEqual(result, { ok: false, reason: 'no_baseline' });
    assert.deepEqual(phases, ['ready'], 'it never got as far as asking for a turn');
    assert.deepEqual(await run('left', [null, null, null]), { ok: false, reason: 'no_baseline' });
  });

  test('a head that is already in profile is not "looking at the camera"', async () => {
    assert.ok(0.4 > BASELINE_MAX_YAW);
    assert.deepEqual(await run('left', Array(8).fill(0.4)), { ok: false, reason: 'no_baseline' });
  });

  test('a lost face resets the starting window', async () => {
    const result = await run('left', [0.0, 0.0, null, 0.0, 0.0, 0.0, 0.0, 0.2, 0.2, 0.01, 0.0]);
    assert.deepEqual(result, { ok: true });
  });
});
