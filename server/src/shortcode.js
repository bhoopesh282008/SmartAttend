// The 6-digit fallback code.
//
// The QR on the lecturer's screen is not always readable: a back row that cannot make out a projected
// code, a student whose camera is broken, a phone that will not focus. Under every QR the lecturer's
// screen therefore shows six digits that stand for the SAME code. A student types them in and the
// server turns them back into the token they stand for; from there the scan is checked exactly as if
// the QR had been read.
//
// What this does and does not change:
//   * Same lifetime: the digits are good for the same 60 seconds (plus the network grace) as the QR.
//   * Same relay risk: digits can be messaged to a friend just as a photo of the QR can. All the
//     other checks (phone, position, face, the risk model) still apply.
//   * Narrower reach: a code only resolves for a student ENROLLED in that lecture's course, so a
//     six-digit guess cannot reach other courses' lectures.
//   * Guessing is slow: there are a million codes, a code lives about a minute, and each student
//     gets a handful of wrong guesses per minute (see makeAttemptLimiter).
//
// One small row is written per code, which is the one place the "nothing is stored per code" shortcut of
// the QR itself is given up.
import { randomInt } from 'node:crypto';
import { GRACE_MS, signToken, TOKEN_TTL_MS } from './token.js';

const KEEP_MS = 5 * 60_000; // old rows are swept on the next issue

export const ATTEMPT_LIMIT = 8; // wrong codes per student per window
export const ATTEMPT_WINDOW_MS = 60_000;

/** Makes a 6-digit code for a freshly issued QR, unique among codes that are still live. */
export function issueShortCode(db, sessionId, issuedAt, pick = () => randomInt(0, 1_000_000)) {
  db.prepare('DELETE FROM codes WHERE issued_at < ?').run(issuedAt - KEEP_MS);
  const liveSince = issuedAt - TOKEN_TTL_MS - GRACE_MS;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(pick()).padStart(6, '0');
    if (!db.prepare('SELECT 1 FROM codes WHERE code = ? AND issued_at >= ?').get(code, liveSince)) {
      db.prepare('INSERT INTO codes (code, session_id, issued_at) VALUES (?, ?, ?)').run(code, sessionId, issuedAt);
      return code;
    }
  }
  throw new Error('No free 6-digit code could be found.');
}

/** Digits as people type them ("482 913", "482-913") reduced to the six digits, or null if they are not six digits. */
export function normaliseCode(text) {
  const digits = String(text ?? '').replace(/[\s-]+/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * The token a typed code stands for, for this student: only codes of lectures that are still open in
 * a course the student is enrolled in, issued within the last minute (plus grace). Otherwise null.
 */
export function resolveShortCode(db, now, studentId, code) {
  const row = db
    .prepare(
      `SELECT c.session_id AS sessionId, c.issued_at AS issuedAt, s.secret AS secret
         FROM codes c
         JOIN sessions s ON s.id = c.session_id
         JOIN enrollments e ON e.course_id = s.course_id AND e.student_id = ?
        WHERE c.code = ? AND c.issued_at BETWEEN ? AND ? AND s.closed_at IS NULL
        ORDER BY c.issued_at DESC LIMIT 1`,
    )
    .get(studentId, code, now - TOKEN_TTL_MS - GRACE_MS, now);
  return row ? signToken(row.secret, row.sessionId, row.issuedAt) : null;
}

/** Remembers wrong guesses per key and says when a key has had too many lately. In memory, which is enough for one server. */
export function makeAttemptLimiter({ now, limit = ATTEMPT_LIMIT, windowMs = ATTEMPT_WINDOW_MS }) {
  const failures = new Map();
  const recent = (key) => {
    const kept = (failures.get(key) ?? []).filter((t) => now() - t < windowMs);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };
  return {
    blocked: (key) => recent(key).length >= limit,
    fail: (key) => failures.set(key, [...recent(key), now()]),
  };
}
