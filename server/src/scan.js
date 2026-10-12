import { checkSignature, checkWindow, parseToken } from './token.js';
import { judgeLocation } from './geo.js';
import { parseOutline } from './outline.js';
import { distance, loadTemplate, MATCH_THRESHOLD } from './face.js';
import { getCourse, getSession, isEnrolled } from './queries.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BURST_WINDOW_MS = 5000;

// What a student is told when a scan is refused. Reasons behind a "review" are NOT sent
// to the student (only to faculty), so that nobody can tune a scan to slip under a rule.
const STUDENT_MESSAGE = {
  bad_token: "That isn't a valid attendance code.",
  bad_code: "That code isn't right, or it has run out. Check the digits on your lecturer's screen.",
  session_closed: 'This lecture has closed. Ask your lecturer to mark you.',
  expired: 'That code has expired. Scan the new one on the lecturer’s screen.',
  not_enrolled: "You aren't enrolled in this course. Ask your lecturer to add you.",
  declined: 'Your lecturer has already declined this scan. Ask them directly.',
  device_used: 'This phone has already marked a different student in this lecture.',
  too_far: 'You appear to be too far from the classroom to mark attendance.',
};

const rejection = (code, extra = {}) => ({
  outcome: 'rejected',
  status: 'rejected',
  code,
  message: STUDENT_MESSAGE[code],
  ...extra,
});

/**
 * Is this a genuine code for an open lecture, and still inside its 60 seconds?
 * Returns { ok: true, session, ageMs } or { ok: false, code }.
 */
export function inspectToken(db, now, token) {
  const parsed = parseToken(token);
  const session = parsed ? getSession(db, parsed.sessionId) : null;
  if (!parsed || !session || !checkSignature(session.secret, parsed)) return { ok: false, code: 'bad_token' };
  if (session.closed_at != null) return { ok: false, code: 'session_closed' };
  const window = checkWindow(parsed, now);
  if (!window.ok) return { ok: false, code: window.code };
  return { ok: true, session, ageMs: window.ageMs };
}

export const rejectionMessage = (code) => STUDENT_MESSAGE[code];

/**
 * One scan, start to finish:
 *   1 token (signature, lecture open, 60 s window)   -> rejected
 *   2 enrolled; already marked                       -> rejected / already
 *   3 device gate (one phone, one student)           -> rejected
 *   4 location block (clearly far, good GPS fix)     -> rejected
 *   5 borderline evidence (location, face, phone history, then the risk model) -> review
 *   6 otherwise                                      -> present
 *
 * `score` is an optional async hook that a risk model can plug into; without it the
 * rules above are the whole decision. `faceVault` opens the student's enrolled face template.
 */
export async function processScan(ctx, input) {
  const { db, now, ipHash, score, faceVault } = ctx;
  const { student, token, deviceId, location, faceDescriptor } = input;
  const at = now();

  // 1 -- token
  const checked = inspectToken(db, at, token);
  if (!checked.ok) return rejection(checked.code);
  const { session } = checked;
  const window = { ageMs: checked.ageMs };

  // 2 -- enrolment and repeats
  if (!isEnrolled(db, session.course_id, student.id)) return rejection('not_enrolled');

  const existing = db
    .prepare(
      `SELECT status, ts FROM scans WHERE session_id = ? AND student_id = ?
          AND status IN ('present', 'review', 'manual')`,
    )
    .get(session.id, student.id);
  if (existing) {
    return { outcome: 'already', status: existing.status, markedAt: existing.ts, message: alreadyMessage(existing.status) };
  }
  const declined = db
    .prepare("SELECT 1 FROM scans WHERE session_id = ? AND student_id = ? AND status = 'rejected' AND decided_by IS NOT NULL")
    .get(session.id, student.id);
  if (declined) return rejection('declined');

  const base = {
    session_id: session.id,
    student_id: student.id,
    device_id: deviceId,
    ip_hash: ipHash ?? null,
    ts: at,
    token_age_s: window.ageMs / 1000,
  };

  // 3 -- device gate: this phone already marked someone else in this lecture
  const sameDevice = db
    .prepare(
      `SELECT 1 FROM scans WHERE session_id = ? AND device_id = ? AND student_id != ?
          AND status IN ('present', 'review', 'manual')`,
    )
    .get(session.id, deviceId, student.id);
  if (sameDevice) {
    const reasons = [{ code: 'device_used', text: 'This device already marked another student in this lecture' }];
    logAttempt(db, base, 'device_used', reasons, {});
    return rejection('device_used');
  }

  // 4 -- location
  const course = getCourse(db, session.course_id);
  const place = judgeLocation({
    room: {
      lat: course.room_lat,
      lng: course.room_lng,
      accuracyM: course.room_accuracy_m ?? 0,
      outline: parseOutline(course.room_outline),
    },
    radiusM: session.radius_m,
    location,
  });
  const measured = { distance_m: place.distanceM, accuracy_m: place.accuracyM };
  if (place.action === 'reject') {
    logAttempt(db, base, 'too_far', place.reasons, measured);
    return rejection('too_far');
  }

  // 5 -- borderline evidence
  const reasons = [...place.reasons];

  // Face check: only when the lecture asks for it. A poor match, or no face check at all, sends the
  // scan to review; it never rejects (cameras fail, students are not enrolled, light is bad).
  let faceDistance = null;
  if (session.face_required) {
    const template = faceDescriptor && faceVault ? loadTemplate(db, faceVault, student.id) : null;
    if (template) faceDistance = distance(template, faceDescriptor);
    if (faceDistance == null) {
      reasons.push({ code: 'face_missing', text: 'A face check was required but was not completed' });
    } else if (faceDistance >= MATCH_THRESHOLD) {
      reasons.push({
        code: 'face_mismatch',
        text: `The face did not match the enrolled one (distance ${faceDistance.toFixed(2)}; the same person is usually under ${MATCH_THRESHOLD})`,
      });
    }
  }
  const sharedDevices = db
    .prepare(
      `SELECT COUNT(DISTINCT student_id) AS n FROM scans
        WHERE device_id = ? AND student_id != ? AND ts >= ? AND status IN ('present', 'review', 'manual')`,
    )
    .get(deviceId, student.id, at - SEVEN_DAYS_MS).n;
  if (sharedDevices > 0) {
    reasons.push({
      code: 'device_shared',
      text: `This device marked ${sharedDevices} other student${sharedDevices === 1 ? '' : 's'} in the last 7 days`,
    });
  }

  // A device is "new" only against the student's OWN history: a first-ever scan has no baseline,
  // so nobody is flagged for simply having started using the system.
  const knownDevices = db.prepare('SELECT COUNT(*) AS n FROM devices WHERE student_id = ?').get(student.id).n;
  const newDevice =
    knownDevices > 0 && !db.prepare('SELECT 1 FROM devices WHERE device_id = ? AND student_id = ?').get(deviceId, student.id);

  // Other scans from the same network in the 5 s before this one (lecture-start bursts are normal).
  const burst = base.ip_hash
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM scans
            WHERE session_id = ? AND ip_hash = ? AND student_id != ? AND ts >= ? AND ts <= ?`,
        )
        .get(session.id, base.ip_hash, student.id, at - BURST_WINDOW_MS, at).n
    : 0;

  // The risk model (when it is running) may add its own reasons and a score. If it is down or
  // slow the rules above are the whole decision and the scan says so (scored_by = 'rules').
  let risk = null;
  let scoredBy = 'rules';
  if (score) {
    const scored = await score({ session, course, student, base, place, sharedDevices, newDevice, burst, faceDistance });
    if (scored) {
      risk = scored.risk ?? null;
      scoredBy = scored.scoredBy ?? 'rules';
      if (scored.review) {
        const seen = new Set(reasons.map((r) => r.code));
        reasons.push(...scored.reasons.filter((r) => !seen.has(r.code)));
        if (scored.reasons.length === 0) {
          reasons.push({ code: 'model_flag', text: 'The risk model scored this scan above its review threshold' });
        }
      }
    }
  }

  const status = reasons.length > 0 ? 'review' : 'present';
  try {
    db.prepare(
      `INSERT INTO scans (session_id, student_id, device_id, ip_hash, ts, method, distance_m, accuracy_m,
                          face_distance, token_age_s, status, risk, scored_by, reasons_json)
       VALUES (?, ?, ?, ?, ?, 'qr', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      base.session_id, base.student_id, base.device_id, base.ip_hash, base.ts,
      measured.distance_m, measured.accuracy_m, faceDistance, base.token_age_s, status, risk, scoredBy, JSON.stringify(reasons),
    );
  } catch (err) {
    // Two taps raced: the unique index let one through. Report the winner.
    if (String(err.message).includes('UNIQUE')) {
      const winner = db
        .prepare("SELECT status, ts FROM scans WHERE session_id = ? AND student_id = ? AND status IN ('present', 'review', 'manual')")
        .get(session.id, student.id);
      if (winner) return { outcome: 'already', status: winner.status, markedAt: winner.ts, message: alreadyMessage(winner.status) };
    }
    throw err;
  }

  // Remember which phone this student uses (soft evidence for later scans).
  db.prepare('INSERT OR IGNORE INTO devices (device_id, student_id, first_seen) VALUES (?, ?, ?)').run(deviceId, student.id, at);

  return status === 'present'
    ? { outcome: 'marked', status, markedAt: at, message: "You're marked present." }
    : { outcome: 'review', status, markedAt: at, message: 'Your scan was recorded. Your lecturer will confirm it.' };
}

function alreadyMessage(status) {
  return status === 'review'
    ? 'You already scanned. Your lecturer will confirm it.'
    : "You're already marked present for this lecture.";
}

function logAttempt(db, base, code, reasons, measured) {
  db.prepare(
    `INSERT INTO scans (session_id, student_id, device_id, ip_hash, ts, method, distance_m, accuracy_m,
                        token_age_s, status, reject_code, reasons_json)
     VALUES (?, ?, ?, ?, ?, 'qr', ?, ?, ?, 'rejected', ?, ?)`,
  ).run(
    base.session_id, base.student_id, base.device_id, base.ip_hash, base.ts,
    measured.distance_m ?? null, measured.accuracy_m ?? null, base.token_age_s, code, JSON.stringify(reasons),
  );
}
