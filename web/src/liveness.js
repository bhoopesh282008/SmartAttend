// A head-turn challenge, to tell a live head from a held-up photograph.
//
// The phone first takes a steady reading of how the person's head sits while they look at the screen
// (their own "straight ahead"), then asks them to turn to one side (chosen at random) and look back at
// the camera. A photograph cannot do both: a frontal one never turns, a turned one never comes back.
// The face photo that is actually matched is taken only AFTER the head has returned.
//
// Everything is measured RELATIVE to that first reading, because nobody's "straight ahead" is exactly
// zero: a real webcam measured a person looking at the screen as +0.07 and the next time as drifting
// through zero, so a fixed "centred" band would have left real people stuck on "look straight back".
//
// HONEST LIMITS. This runs in the student's own browser, so the server cannot verify it: someone who
// tampers with their own phone can skip it, and a video of a person turning their head can pass it.
// It stops the casual cheat (holding up a picture), nothing more. The random direction means a
// recording of one particular turn does not work every time.
//
// This module is pure logic (no camera, no page), so it can be tested exhaustively.

// The nose has to move this far from where it started, as a share of the face's width.
export const TURN_YAW = 0.12;
// ...and come back to within this of where it started to count as "looking at the camera" again.
export const CENTRED_YAW = 0.07;
// Consecutive readings needed, so that one jittery frame cannot pass the test.
export const STEADY_READINGS = 2;
// The starting reading needs this many steady readings in a row, no more than this far apart, and
// the head must not already be far turned (a profile view is not "looking at the camera").
export const BASELINE_READINGS = 3;
export const BASELINE_SPREAD = 0.04;
export const BASELINE_MAX_YAW = 0.25;

export const pickDirection = (random = Math.random) => (random() < 0.5 ? 'left' : 'right');

export const instruction = (direction) => `Turn your head to your ${direction}, then look straight at the camera.`;

/**
 * Where the nose sits between the two edges of the face, as an offset from the middle (about 0 when
 * facing the camera). Positive means the person has turned to THEIR left: the camera looks at them, so
 * their left is on the right of the picture, and their nose moves that way. Takes the 68 face
 * landmarks as [{x, y}, ...] in the picture's own (unmirrored) coordinates.
 */
export function yawFromLandmarks(points) {
  if (!Array.isArray(points) || points.length < 68) return null;
  const leftEdge = points[0].x;
  const rightEdge = points[16].x;
  const width = rightEdge - leftEdge;
  if (!(width > 0)) return null;
  return (points[30].x - leftEdge) / width - 0.5;
}

// Both take the change from the person's own starting reading.
export const hasTurned = (change, direction) => (direction === 'left' ? change >= TURN_YAW : change <= -TURN_YAW);
export const isCentred = (change) => Math.abs(change) <= CENTRED_YAW;

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Runs the challenge. `readYaw()` returns the current yaw, or null when no single face can be read
 * (a lost face resets the count rather than counting as a turn). `onPhase('ready' | 'turn' | 'return')`
 * lets the screen say what to do. Resolves to { ok: true } or { ok: false, reason } where reason is
 * 'no_baseline' (no steady, roughly frontal reading to start from), 'no_turn' or 'no_return'.
 */
export async function runChallenge({
  direction,
  readYaw,
  onPhase = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  baselineMs = 6000,
  turnMs = 8000,
  returnMs = 6000,
  pollMs = 120,
}) {
  async function untilSteady(test, limitMs) {
    const started = now();
    let streak = 0;
    while (now() - started < limitMs) {
      const yaw = await readYaw();
      streak = yaw != null && test(yaw) ? streak + 1 : 0;
      if (streak >= STEADY_READINGS) return true;
      await sleep(pollMs);
    }
    return false;
  }

  // 1. The person's own "straight ahead": a few steady readings in a row.
  onPhase('ready');
  let baseline = null;
  const recent = [];
  const started = now();
  while (baseline === null && now() - started < baselineMs) {
    const yaw = await readYaw();
    if (yaw == null) recent.length = 0;
    else recent.push(yaw);
    if (recent.length > BASELINE_READINGS) recent.shift();
    if (recent.length === BASELINE_READINGS && Math.max(...recent) - Math.min(...recent) <= BASELINE_SPREAD && Math.abs(median(recent)) <= BASELINE_MAX_YAW) {
      baseline = median(recent);
    } else {
      await sleep(pollMs);
    }
  }
  if (baseline === null) return { ok: false, reason: 'no_baseline' };

  // 2. Turn to the side asked, 3. and come back.
  onPhase('turn');
  if (!(await untilSteady((yaw) => hasTurned(yaw - baseline, direction), turnMs))) return { ok: false, reason: 'no_turn' };
  onPhase('return');
  if (!(await untilSteady((yaw) => isCentred(yaw - baseline), returnMs))) return { ok: false, reason: 'no_return' };
  return { ok: true };
}

export const FAILURE_TEXT = {
  no_baseline: 'We could not get a steady look at your face. Face the camera in good light and hold still for a moment, then try again.',
  no_turn: 'That did not look like a head turn. Turn slowly toward the side asked, keeping your face in view.',
  no_return: 'Please look straight back at the camera once you have turned.',
};
