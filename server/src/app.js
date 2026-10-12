import express from 'express';
import QRCode from 'qrcode';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuth, HttpError } from './auth.js';
import { signToken, TOKEN_TTL_MS } from './token.js';
import { inspectToken, processScan, rejectionMessage } from './scan.js';
import { createFaceVault, ENROL_MAX_SPREAD, ENROL_PHOTOS, makeTemplate, validateDescriptor } from './face.js';
import { MAX_ROOM_FIX_M } from './geo.js';
import { fetchBuildingOutline } from './outline.js';
import { issueShortCode, makeAttemptLimiter, normaliseCode, resolveShortCode } from './shortcode.js';
import { seedDemo } from './seed.js';
import { toCsv, stamp, fileSafe } from './csv.js';
import { createRiskScorer } from './ml.js';
import { modelsDir as defaultModelsDir } from './config.js';
import {
  atRiskInputs, attempts, canStillMiss, closeExpiredLectures, counts, facultyCourses, getCourse, getSession, isEnrolled,
  register, roster, studentCourses,
} from './queries.js';

const STATUS_WORD = { present: 'Present', manual: 'Manual', review: 'Pending review', absent: 'Absent' };
// A lecture closes itself after this long unless the lecturer chose otherwise (or closes it sooner).
const DEFAULT_AUTO_CLOSE_MINUTES = 120;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function number(value, { min, max, name }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, 'bad_request', `${name} must be a number from ${min} to ${max}.`);
  }
  return n;
}

function parseLocation(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new HttpError(400, 'bad_request', 'location must be an object or null.');
  return {
    lat: number(raw.lat, { min: -90, max: 90, name: 'latitude' }),
    lng: number(raw.lng, { min: -180, max: 180, name: 'longitude' }),
    accuracy: raw.accuracy == null ? null : number(raw.accuracy, { min: 0, max: 1e7, name: 'accuracy' }),
  };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `ml` is the optional client for the Python model service (see ml.js). Without it, or when it
 * is down, scans are decided by the rules alone and marked scored_by = 'rules'.
 */
export function createApp({
  db, now = Date.now, demo = true, webDist = null, ml = null, modelsDir = defaultModelsDir,
  faceKey = randomBytes(32).toString('hex'), findOutline = fetchBuildingOutline,
} = {}) {
  const score = ml ? createRiskScorer(ml) : null;
  const faceVault = createFaceVault({ keyHex: faceKey });
  const mlStatus = async () => (ml ? ml.health() : { available: false, models: {} });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '64kb' }));
  // Lectures that have reached their closing time are closed before anything reads them.
  app.use('/api', (req, res, next) => {
    closeExpiredLectures(db, now());
    next();
  });

  const auth = createAuth(db, now);
  const codeAttempts = makeAttemptLimiter({ now });

  /**
   * What a student sent to say which lecture they mean: the token read from the QR, or the six digits
   * they typed (turned back into the token they stand for). `null` means a typed code that is wrong
   * or has run out. Wrong guesses are counted, and too many in a minute are refused.
   */
  function credentialFrom(req) {
    const body = req.body ?? {};
    if (typeof body.token === 'string' && body.token.trim()) {
      const token = body.token.trim();
      if (token.length > 200) throw new HttpError(400, 'bad_request', 'token is too long.');
      return token;
    }
    const digits = normaliseCode(body.code);
    if (!digits) throw new HttpError(400, 'bad_request', 'Send the token from the QR code, or the 6-digit code.');
    if (codeAttempts.blocked(req.user.id)) {
      throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes just now. Wait a minute, then try again.');
    }
    const token = resolveShortCode(db, now(), req.user.id, digits);
    if (!token) codeAttempts.fail(req.user.id);
    return token;
  }

  // Loads a lecture and checks that the signed-in faculty member owns its course.
  function ownedSession(req) {
    const session = getSession(db, Number(req.params.id));
    if (!session) throw new HttpError(404, 'not_found', 'Lecture not found.');
    const course = getCourse(db, session.course_id);
    if (course.faculty_id !== req.user.id) throw new HttpError(403, 'not_yours', 'This is not your course.');
    return { session, course };
  }
  function ownedCourse(req) {
    const course = getCourse(db, Number(req.params.id));
    if (!course) throw new HttpError(404, 'not_found', 'Course not found.');
    if (course.faculty_id !== req.user.id) throw new HttpError(403, 'not_yours', 'This is not your course.');
    return course;
  }

  // ---------------------------------------------------------------- open routes
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/meta', wrap(async (req, res) => {
    res.json({ demo, lan: lanAddresses(), ttlSeconds: TOKEN_TTL_MS / 1000, ml: await mlStatus() });
  }));

  // The model card: what each model is, how it was trained and tested, and its limits. Read
  // from the files the training scripts wrote, so it works even when the model service is down.
  app.get('/api/models', auth.require(), wrap(async (req, res) => {
    res.json({
      proxy: readJson(join(modelsDir, 'proxy_metrics.json')),
      atrisk: readJson(join(modelsDir, 'atrisk_metrics.json')),
      service: await mlStatus(),
    });
  }));

  // Demo login only: lists the seeded accounts. Disabled when demo mode is off.
  app.get('/api/auth/users', (req, res) => {
    if (!demo) throw new HttpError(404, 'not_found', 'Not found.');
    res.json(db.prepare('SELECT id, role, name, roll_no AS rollNo FROM users ORDER BY role DESC, roll_no, name').all());
  });

  app.post('/api/auth/login', (req, res) => {
    if (!demo) throw new HttpError(404, 'not_found', 'Not found.');
    const user = db.prepare('SELECT id, role, name, roll_no AS rollNo FROM users WHERE id = ?').get(Number(req.body?.userId));
    if (!user) throw new HttpError(404, 'not_found', 'No such account.');
    res.json({ token: auth.issue(user), user: { ...user } });
  });

  app.get('/api/me', auth.require(), (req, res) => res.json(req.user));

  // ------------------------------------------------------------ face enrolment (students)
  // The browser sends 128-number descriptors, never photos. A student can delete theirs at any time.
  app.get('/api/me/face', auth.require('student'), (req, res) => {
    const row = db.prepare('SELECT face_template IS NOT NULL AS has, face_enrolled_at AS at FROM users WHERE id = ?').get(req.user.id);
    res.json({ enrolled: !!row.has, enrolledAt: row.has ? row.at : null });
  });

  app.post('/api/me/face', auth.require('student'), (req, res) => {
    const list = req.body?.descriptors;
    if (!Array.isArray(list) || list.length !== ENROL_PHOTOS) {
      throw new HttpError(400, 'bad_request', `Enrolment needs ${ENROL_PHOTOS} photos.`);
    }
    let made;
    try {
      made = makeTemplate(list);
    } catch (err) {
      throw new HttpError(400, 'bad_request', err.message);
    }
    if (made.spread > ENROL_MAX_SPREAD) {
      throw new HttpError(422, 'face_inconsistent', 'The photos do not look like the same person. Take them again, one person in view, facing the camera.');
    }
    db.prepare('UPDATE users SET face_template = ?, face_enrolled_at = ? WHERE id = ?').run(faceVault.seal(made.template, req.user.id), now(), req.user.id);
    res.status(201).json({ enrolled: true, enrolledAt: now() });
  });

  app.delete('/api/me/face', auth.require('student'), (req, res) => {
    db.prepare('UPDATE users SET face_template = NULL, face_enrolled_at = NULL WHERE id = ?').run(req.user.id);
    res.json({ enrolled: false });
  });

  // -------------------------------------------------------------------- courses
  app.get('/api/courses', auth.require(), (req, res) => {
    res.json(req.user.role === 'faculty' ? facultyCourses(db, req.user.id) : studentCourses(db, req.user.id));
  });

  // The classroom's position: read from the lecturer's device at the door, or typed in by hand when
  // the device cannot find its own position (many desktops and laptops cannot). Its accuracy is
  // recorded either way, because a vague position would make every student look far from the room.
  // A new point drops any old building outline.
  app.patch('/api/courses/:id/room', auth.require('faculty'), (req, res) => {
    const course = ownedCourse(req);
    const lat = number(req.body?.lat, { min: -90, max: 90, name: 'latitude' });
    const lng = number(req.body?.lng, { min: -180, max: 180, name: 'longitude' });
    const accuracy = number(req.body?.accuracy, { min: 0, max: 1e6, name: 'accuracy' });
    const source = req.body?.source === 'manual' ? 'manual' : 'device';
    if (accuracy > MAX_ROOM_FIX_M) {
      throw new HttpError(
        422,
        'room_fix_too_vague',
        `That position is only accurate to about ${Math.round(accuracy)} m, which is too vague to mark a classroom. Try again on a phone or near a window, or type the coordinates in.`,
      );
    }
    db.prepare(
      `UPDATE courses SET room_lat = ?, room_lng = ?, room_accuracy_m = ?, room_source = ?, room_set_at = ?,
                          room_outline = NULL, room_outline_note = NULL WHERE id = ?`,
    ).run(lat, lng, accuracy, source, now(), course.id);
    res.json({ ok: true });
  });

  // Optional: the outline of the building at the room's position, from OpenStreetMap. Called only
  // when the lecturer asks, and it sends the classroom's position (nobody else's) to that service.
  app.post('/api/courses/:id/room/outline', auth.require('faculty'), wrap(async (req, res) => {
    const course = ownedCourse(req);
    if (course.room_lat == null) throw new HttpError(400, 'room_not_set', 'Set the classroom position first.');
    let found;
    try {
      found = await findOutline({ lat: course.room_lat, lng: course.room_lng });
    } catch {
      throw new HttpError(502, 'outline_unavailable', 'OpenStreetMap could not be reached just now. The circle still works; try again later.');
    }
    if (!found) {
      throw new HttpError(404, 'outline_not_found', 'No building outline is mapped at this spot in OpenStreetMap, so the circle is used.');
    }
    const note = `OpenStreetMap way ${found.osmId}${found.name ? `, ${found.name}` : ''}`;
    db.prepare('UPDATE courses SET room_outline = ?, room_outline_note = ? WHERE id = ?').run(JSON.stringify(found.ring), note, course.id);
    res.json({ outline: found.ring, note });
  }));

  app.delete('/api/courses/:id/room/outline', auth.require('faculty'), (req, res) => {
    const course = ownedCourse(req);
    db.prepare('UPDATE courses SET room_outline = NULL, room_outline_note = NULL WHERE id = ?').run(course.id);
    res.json({ ok: true });
  });

  app.post('/api/courses/:id/sessions', auth.require('faculty'), (req, res) => {
    const course = ownedCourse(req);
    const body = req.body ?? {};
    const open = db.prepare('SELECT id FROM sessions WHERE course_id = ? AND closed_at IS NULL').get(course.id);
    if (open) {
      throw new HttpError(409, 'lecture_open', 'A lecture is already open for this course.', { sessionId: open.id });
    }
    let radiusM = null;
    if (body.radiusM != null) {
      radiusM = number(body.radiusM, { min: 20, max: 5000, name: 'radius' });
      if (course.room_lat == null) {
        throw new HttpError(400, 'room_not_set', 'Set the classroom location first, or turn the location check off.');
      }
    }
    const lectureNo = db.prepare('SELECT COALESCE(MAX(lecture_no), 0) + 1 AS n FROM sessions WHERE course_id = ?').get(course.id).n;
    const title = String(body.title ?? '').trim().slice(0, 120) || `Lecture ${lectureNo}`;
    const faceRequired = body.faceRequired === true;
    // The head-turn challenge only means something when a face is asked for. It runs in the student's
    // browser, so it stops a held-up photo, not someone who tampers with their own phone.
    const faceLiveness = faceRequired && body.faceLiveness === true;
    // A lecture left open would let codes be scanned all day, so it closes itself (0 or null: never).
    const started = now();
    const minutes = body.autoCloseMinutes === undefined ? DEFAULT_AUTO_CLOSE_MINUTES : body.autoCloseMinutes;
    const autoCloseAt = minutes ? started + number(minutes, { min: 5, max: 24 * 60, name: 'autoCloseMinutes' }) * 60_000 : null;
    const info = db
      .prepare(
        `INSERT INTO sessions (course_id, lecture_no, title, started_at, secret, radius_m, auto_renew, face_required, face_liveness, auto_close_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(course.id, lectureNo, title, started, randomBytes(24).toString('hex'), radiusM, body.autoRenew === false ? 0 : 1, faceRequired ? 1 : 0, faceLiveness ? 1 : 0, autoCloseAt);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  app.get('/api/courses/:id/register', auth.require('faculty'), (req, res) => {
    res.json(register(db, ownedCourse(req)));
  });

  /**
   * Who may finish the term below 75%. The model ranks students from the lectures held so far;
   * if it is not running, a rules-only list (cannot reach 75% / currently below it) is returned
   * and labelled as such. "Classes you can still miss" is exact arithmetic either way.
   */
  app.get('/api/courses/:id/at-risk', auth.require('faculty'), wrap(async (req, res) => {
    const course = ownedCourse(req);
    const inputs = atRiskInputs(db, course);
    const byId = new Map(inputs.students.map((s) => [s.id, s]));
    const finish = (rows, scoredBy) => {
      const order = { high: 0, watch: 1, low: 2, none: 3 };
      rows.sort((a, b) => (order[a.band ?? 'none'] - order[b.band ?? 'none']) || ((b.risk ?? -1) - (a.risk ?? -1)) || ((a.pct ?? 2) - (b.pct ?? 2)));
      res.json({
        course: { id: course.id, code: course.code, name: course.name },
        planned: inputs.planned,
        held: inputs.held,
        scoredBy,
        modelOnline: scoredBy !== 'rules',
        students: rows,
      });
    };

    if (ml && inputs.held > 0) {
      try {
        const out = await ml.atRisk({
          planned_lectures: inputs.planned,
          students: inputs.students.map(({ id, attended, late, flags }) => ({ id, attended, late, flags })),
        });
        return finish(out.results.map((r) => {
          const s = byId.get(r.id);
          return {
            id: r.id, name: s.name, rollNo: s.rollNo, held: r.held, attended: r.attended,
            pct: r.held ? r.attended / r.held : null, canMiss: r.can_still_miss,
            insufficient: r.insufficient, risk: r.risk, band: r.band, reasons: r.reasons.map(({ code, text }) => ({ code, text })),
          };
        }), out.model_version);
      } catch {
        /* the model service is down or slow: fall through to the rules */
      }
    }

    return finish(inputs.students.map((s) => {
      const held = s.attended.length;
      const attended = s.attended.reduce((a, b) => a + b, 0);
      const canMiss = canStillMiss({ attended, held, planned: inputs.planned });
      const pct = held ? attended / held : null;
      const enough = held >= 4;
      const band = !enough ? null : canMiss < 0 ? 'high' : pct < 0.75 ? 'watch' : 'low';
      const reasons = [];
      if (band === 'high') reasons.push({ code: 'cannot_reach', text: 'Can no longer reach 75% even by attending every remaining lecture' });
      else if (band === 'watch') reasons.push({ code: 'low_attendance', text: `Attendance so far is ${Math.round(pct * 100)}%` });
      return {
        id: s.id, name: s.name, rollNo: s.rollNo, held, attended, pct, canMiss,
        insufficient: !enough, risk: null, band, reasons,
      };
    }), 'rules');
  }));

  app.get('/api/courses/:id/export.csv', auth.require('faculty'), (req, res) => {
    const course = ownedCourse(req);
    const reg = register(db, course);
    const header = [
      'Roll no', 'Name',
      ...reg.lectures.map((l) => `L${l.lectureNo} ${new Date(l.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${l.closedAt ? '' : ' (open)'}`),
      'Attended', 'Held', 'Percent',
    ];
    const rows = reg.students.map((s) => [
      s.rollNo, s.name,
      ...s.cells.map((c) => STATUS_WORD[c.status]),
      s.attended, s.held, s.pct == null ? '' : `${Math.round(s.pct * 1000) / 10}%`,
    ]);
    sendCsv(res, `${fileSafe(course.code)}-register.csv`, [header, ...rows]);
  });

  // ------------------------------------------------------------------- lectures
  app.get('/api/sessions/:id', auth.require('faculty'), wrap(async (req, res) => {
    const { session, course } = ownedSession(req);
    const rosterRows = roster(db, session);
    const attemptRows = attempts(db, session);
    // How this lecture's scans were checked: by the risk model, or by the rules alone.
    const scoredBy = db
      .prepare(
        `SELECT scored_by AS by, COUNT(*) AS n FROM scans
          WHERE session_id = ? AND method = 'qr' AND status IN ('present', 'review') GROUP BY scored_by`,
      )
      .all(session.id);
    const modelScored = scoredBy.filter((r) => r.by && r.by !== 'rules').reduce((sum, r) => sum + r.n, 0);
    const rulesScored = scoredBy.filter((r) => !r.by || r.by === 'rules').reduce((sum, r) => sum + r.n, 0);
    res.json({
      session: {
        id: session.id,
        courseId: course.id,
        courseCode: course.code,
        courseName: course.name,
        lectureNo: session.lecture_no,
        title: session.title,
        startedAt: session.started_at,
        closedAt: session.closed_at,
        radiusM: session.radius_m,
        autoRenew: !!session.auto_renew,
        faceRequired: !!session.face_required,
        faceLiveness: !!session.face_liveness,
        autoCloseAt: session.auto_close_at,
      },
      counts: counts(rosterRows, attemptRows),
      roster: rosterRows,
      attempts: attemptRows,
      scoring: { modelScored, rulesScored, modelOnline: (await mlStatus()).available },
      serverNow: now(),
    });
  }));

  // Generates a code that is valid for 60 seconds from this moment. Nothing is stored.
  app.post('/api/sessions/:id/qr', auth.require('faculty'), wrap(async (req, res) => {
    const { session } = ownedSession(req);
    if (session.closed_at != null) throw new HttpError(409, 'session_closed', 'This lecture is closed.');
    let origin;
    try {
      const url = new URL(String(req.body?.origin));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      origin = url.origin;
    } catch {
      throw new HttpError(400, 'bad_origin', 'origin must be the web address students will open.');
    }
    const issuedAt = now();
    const token = signToken(session.secret, session.id, issuedAt);
    const url = `${origin}/s/${token}`;
    const svg = await QRCode.toString(url, {
      type: 'svg', errorCorrectionLevel: 'Q', margin: 2, color: { dark: '#111111', light: '#ffffff' },
    });
    // The six digits shown under the QR for anyone who cannot read it; they stand for this same code.
    const shortCode = issueShortCode(db, session.id, issuedAt);
    res.json({ token, shortCode, url, svg, issuedAt, expiresAt: issuedAt + TOKEN_TTL_MS, serverNow: now() });
  }));

  app.post('/api/sessions/:id/close', auth.require('faculty'), (req, res) => {
    const { session } = ownedSession(req);
    if (session.closed_at == null) {
      db.prepare('UPDATE sessions SET closed_at = ? WHERE id = ?').run(now(), session.id);
    }
    res.json({ ok: true });
  });

  // Faculty marks a student by hand (no phone, dead battery, shared-phone mix-up). A reason is required.
  app.post('/api/sessions/:id/manual', auth.require('faculty'), (req, res) => {
    const { session } = ownedSession(req);
    const studentId = Number(req.body?.studentId);
    const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
    if (reason.length < 3) throw new HttpError(400, 'reason_required', 'Give a short reason for marking by hand.');
    if (!isEnrolled(db, session.course_id, studentId)) throw new HttpError(400, 'not_enrolled', 'That student is not enrolled in this course.');
    const existing = db
      .prepare("SELECT 1 FROM scans WHERE session_id = ? AND student_id = ? AND status IN ('present', 'review', 'manual')")
      .get(session.id, studentId);
    if (existing) throw new HttpError(409, 'already_marked', 'This student is already marked. Decide the pending scan instead.');
    db.prepare(
      `INSERT INTO scans (session_id, student_id, ts, method, status, note, decided_by, decided_at)
       VALUES (?, ?, ?, 'manual', 'manual', ?, ?, ?)`,
    ).run(session.id, studentId, now(), reason, req.user.id, now());
    res.status(201).json({ ok: true });
  });

  // Decide a scan that was held for review.
  app.patch('/api/scans/:id', auth.require('faculty'), (req, res) => {
    const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(Number(req.params.id));
    if (!scan) throw new HttpError(404, 'not_found', 'Scan not found.');
    const course = getCourse(db, getSession(db, scan.session_id).course_id);
    if (course.faculty_id !== req.user.id) throw new HttpError(403, 'not_yours', 'This is not your course.');
    if (scan.status !== 'review') throw new HttpError(409, 'not_pending', 'Only scans waiting for review can be decided.');
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(400, 'bad_request', 'decision must be approve or reject.');
    const note = req.body?.note ? String(req.body.note).slice(0, 200) : null;
    if (decision === 'approve') {
      db.prepare("UPDATE scans SET status = 'present', decided_by = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?")
        .run(req.user.id, now(), note, scan.id);
    } else {
      db.prepare("UPDATE scans SET status = 'rejected', reject_code = 'declined', decided_by = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?")
        .run(req.user.id, now(), note, scan.id);
    }
    res.json({ ok: true });
  });

  app.get('/api/sessions/:id/export.csv', auth.require('faculty'), (req, res) => {
    const { session, course } = ownedSession(req);
    const rows = roster(db, session).map((r) => [
      r.rollNo, r.name, STATUS_WORD[r.status], r.ts ? stamp(r.ts) : '', r.status === 'absent' ? '' : r.method, r.late ? 'Late' : '', r.note ?? '',
    ]);
    sendCsv(res, `${fileSafe(course.code)}-L${session.lecture_no}-attendance.csv`, [
      ['Roll no', 'Name', 'Status', 'Time', 'Method', 'Late', 'Note'],
      ...rows,
    ]);
  });

  // ----------------------------------------------------------------------- scan
  // Before scanning, the phone asks what this lecture will want from the student (a position, a
  // face check) so it only asks for what is needed. Nothing is recorded here.
  app.post('/api/scan/preview', auth.require('student'), (req, res) => {
    const token = credentialFrom(req);
    if (token === null) return res.json({ valid: false, code: 'bad_code', message: rejectionMessage('bad_code') });
    const checked = inspectToken(db, now(), token);
    if (!checked.ok) return res.json({ valid: false, code: checked.code, message: rejectionMessage(checked.code) });
    const { session } = checked;
    const course = getCourse(db, session.course_id);
    const enrolled = !!db.prepare('SELECT face_template IS NOT NULL AS has FROM users WHERE id = ?').get(req.user.id).has;
    res.json({
      valid: true,
      lecture: { courseCode: course.code, courseName: course.name, lectureNo: session.lecture_no, title: session.title },
      locationChecked: session.radius_m != null && course.room_lat != null,
      faceRequired: !!session.face_required,
      faceLiveness: !!session.face_liveness,
      faceEnrolled: enrolled,
      // The scan itself is sent with the token the digits stood for, so a code that rotates mid-way cannot split the two.
      token,
    });
  });

  app.post('/api/scan', auth.require('student'), wrap(async (req, res) => {
    const body = req.body ?? {};
    const token = credentialFrom(req);
    if (token === null) return res.json({ outcome: 'rejected', status: 'rejected', code: 'bad_code', message: rejectionMessage('bad_code') });
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
    if (deviceId.length < 8 || deviceId.length > 100) throw new HttpError(400, 'bad_request', 'deviceId is required.');
    let faceDescriptor = null;
    if (body.faceDescriptor != null) {
      try {
        faceDescriptor = validateDescriptor(body.faceDescriptor);
      } catch (err) {
        throw new HttpError(400, 'bad_request', err.message);
      }
    }
    const result = await processScan(
      { db, now, ipHash: auth.hashIp(req.ip), score, faceVault },
      { student: req.user, token, deviceId, location: parseLocation(body.location), faceDescriptor },
    );
    res.json(result);
  }));

  // ----------------------------------------------------------------------- demo
  app.post('/api/demo/reset', auth.require('faculty'), (req, res) => {
    if (!demo) throw new HttpError(404, 'not_found', 'Not found.');
    seedDemo(db, { now });
    res.json({ ok: true });
  });

  // ------------------------------------------------- built web app (single-origin deploy)
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found', 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.type === 'entity.parse.failed' || err?.status === 400) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'The request body could not be read.' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on the server.' } });
  });

  return app;
}

function sendCsv(res, filename, rows) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send(toCsv(rows));
}
