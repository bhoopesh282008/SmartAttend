// Read-side queries shared by the routes, the exports and the tests.
import { parseOutline } from './outline.js';

export const ATTENDANCE_THRESHOLD = 0.75;

/** Closes lectures whose closing time has passed, at that time (not at the moment someone looked). */
export function closeExpiredLectures(db, now) {
  return db
    .prepare('UPDATE sessions SET closed_at = auto_close_at WHERE closed_at IS NULL AND auto_close_at IS NOT NULL AND auto_close_at <= ?')
    .run(now).changes;
}

export const getCourse = (db, id) => db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
export const getSession = (db, id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);

export function isEnrolled(db, courseId, studentId) {
  return !!db.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?').get(courseId, studentId);
}

const parseReasons = (json) => {
  try {
    return JSON.parse(json ?? '[]');
  } catch {
    return [];
  }
};

/** Every enrolled student with their status in one lecture; absentees are listed too. */
export function roster(db, session) {
  const rows = db
    .prepare(
      `SELECT u.id AS studentId, u.name, u.roll_no AS rollNo,
              s.id AS scanId, s.status, s.ts, s.method,
              s.distance_m AS distanceM, s.accuracy_m AS accuracyM,
              s.risk, s.scored_by AS scoredBy,
              s.reasons_json AS reasons, s.note
         FROM enrollments e
         JOIN users u ON u.id = e.student_id
         LEFT JOIN scans s ON s.session_id = ? AND s.student_id = u.id
                          AND s.status IN ('present', 'review', 'manual')
        WHERE e.course_id = ?
        ORDER BY u.roll_no`,
    )
    .all(session.id, session.course_id);
  return rows.map((row) => ({
    ...row,
    status: row.status ?? 'absent',
    reasons: parseReasons(row.reasons),
    // Arrived well after the lecture began (the at-risk model reads the same fact).
    late: row.method === 'qr' && row.ts != null && row.ts - session.started_at > LATE_AFTER_MS,
  }));
}

/** Blocked attempts in one lecture (rejected scans), newest first. */
export function attempts(db, session) {
  return db
    .prepare(
      `SELECT s.id, s.ts, s.reject_code AS code, s.reasons_json AS reasons,
              s.distance_m AS distanceM, s.decided_by AS decidedBy,
              u.id AS studentId, u.name, u.roll_no AS rollNo
         FROM scans s JOIN users u ON u.id = s.student_id
        WHERE s.session_id = ? AND s.status = 'rejected'
        ORDER BY s.ts DESC`,
    )
    .all(session.id)
    .map((row) => ({ ...row, reasons: parseReasons(row.reasons) }));
}

export function counts(rosterRows, attemptRows) {
  const tally = { present: 0, manual: 0, review: 0, absent: 0 };
  for (const row of rosterRows) tally[row.status] += 1;
  return { ...tally, enrolled: rosterRows.length, blocked: attemptRows.length };
}

/** Classes a student can still miss and finish at 75% of the planned lectures. Plain arithmetic. */
export function canStillMiss({ attended, held, planned }) {
  const remaining = Math.max(0, planned - held);
  const needed = Math.ceil(ATTENDANCE_THRESHOLD * planned);
  return attended + remaining - needed;
}

/** Class register: students x lectures, with each student's percentage over closed lectures. */
export function register(db, course) {
  const lectures = db
    .prepare('SELECT id, lecture_no AS lectureNo, title, started_at AS startedAt, closed_at AS closedAt FROM sessions WHERE course_id = ? ORDER BY lecture_no')
    .all(course.id);
  const students = db
    .prepare(
      `SELECT u.id, u.name, u.roll_no AS rollNo
         FROM enrollments e JOIN users u ON u.id = e.student_id
        WHERE e.course_id = ? ORDER BY u.roll_no`,
    )
    .all(course.id);
  const marks = db
    .prepare(
      `SELECT s.session_id AS sessionId, s.student_id AS studentId, s.status
         FROM scans s JOIN sessions x ON x.id = s.session_id
        WHERE x.course_id = ? AND s.status IN ('present', 'review', 'manual')`,
    )
    .all(course.id);
  const byKey = new Map(marks.map((m) => [`${m.sessionId}:${m.studentId}`, m.status]));
  const closed = lectures.filter((l) => l.closedAt != null);

  const rows = students.map((student) => {
    const cells = lectures.map((l) => ({ sessionId: l.id, status: byKey.get(`${l.id}:${student.id}`) ?? 'absent' }));
    const attended = closed.filter((l) => {
      const status = byKey.get(`${l.id}:${student.id}`);
      return status === 'present' || status === 'manual';
    }).length;
    const held = closed.length;
    return { ...student, cells, attended, held, pct: held ? attended / held : null };
  });
  return { course: { id: course.id, code: course.code, name: course.name }, lectures, students: rows };
}

// A scan this long after the lecture started counts as late (kept in step with ml/config.py).
export const LATE_AFTER_MS = 10 * 60 * 1000;

/**
 * Each enrolled student's lecture-by-lecture record over the CLOSED lectures, in the shape the
 * at-risk model takes. Only lectures already held are used, so nothing about the future leaks in.
 */
export function atRiskInputs(db, course) {
  const lectures = db
    .prepare('SELECT id, started_at AS startedAt FROM sessions WHERE course_id = ? AND closed_at IS NOT NULL ORDER BY lecture_no')
    .all(course.id);
  const students = db
    .prepare(
      `SELECT u.id, u.name, u.roll_no AS rollNo
         FROM enrollments e JOIN users u ON u.id = e.student_id
        WHERE e.course_id = ? ORDER BY u.roll_no`,
    )
    .all(course.id);
  const marks = db
    .prepare(
      `SELECT s.session_id AS sessionId, s.student_id AS studentId, s.method, s.ts
         FROM scans s JOIN sessions x ON x.id = s.session_id
        WHERE x.course_id = ? AND x.closed_at IS NOT NULL AND s.status IN ('present', 'manual')`,
    )
    .all(course.id);
  const flagged = db
    .prepare(
      `SELECT s.student_id AS studentId, COUNT(*) AS n
         FROM scans s JOIN sessions x ON x.id = s.session_id
        WHERE x.course_id = ? AND x.closed_at IS NOT NULL
          AND (s.status IN ('review', 'rejected') OR (s.method = 'qr' AND s.decided_by IS NOT NULL))
        GROUP BY s.student_id`,
    )
    .all(course.id);

  const markBy = new Map(marks.map((m) => [`${m.sessionId}:${m.studentId}`, m]));
  const flagsBy = new Map(flagged.map((f) => [f.studentId, f.n]));
  return {
    planned: course.planned_lectures,
    held: lectures.length,
    students: students.map((student) => {
      const attended = [];
      const late = [];
      for (const lecture of lectures) {
        const mark = markBy.get(`${lecture.id}:${student.id}`);
        attended.push(mark ? 1 : 0);
        late.push(mark && mark.method === 'qr' && mark.ts - lecture.startedAt > LATE_AFTER_MS ? 1 : 0);
      }
      return { ...student, attended, late, flags: flagsBy.get(student.id) ?? 0 };
    }),
  };
}

/** A student's courses with attendance, the open lecture (if any) and their status in it. */
export function studentCourses(db, studentId) {
  const courses = db
    .prepare(
      `SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id
        WHERE e.student_id = ? ORDER BY c.code`,
    )
    .all(studentId);
  return courses.map((course) => {
    const held = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE course_id = ? AND closed_at IS NOT NULL').get(course.id).n;
    const attended = db
      .prepare(
        `SELECT COUNT(*) AS n FROM scans s JOIN sessions x ON x.id = s.session_id
          WHERE x.course_id = ? AND x.closed_at IS NOT NULL AND s.student_id = ?
            AND s.status IN ('present', 'manual')`,
      )
      .get(course.id, studentId).n;
    const open = db
      .prepare('SELECT id, lecture_no AS lectureNo, title, face_required AS faceRequired FROM sessions WHERE course_id = ? AND closed_at IS NULL ORDER BY lecture_no DESC LIMIT 1')
      .get(course.id);
    let myStatus = null;
    if (open) {
      myStatus =
        db
          .prepare("SELECT status FROM scans WHERE session_id = ? AND student_id = ? AND status IN ('present', 'review', 'manual')")
          .get(open.id, studentId)?.status ?? null;
    }
    return {
      id: course.id,
      code: course.code,
      name: course.name,
      held,
      attended,
      pct: held ? attended / held : null,
      plannedLectures: course.planned_lectures,
      canMiss: canStillMiss({ attended, held, planned: course.planned_lectures }),
      open: open ? { ...open, myStatus } : null,
    };
  });
}

/** A faculty member's courses with the last few lectures. */
export function facultyCourses(db, facultyId) {
  const courses = db.prepare('SELECT * FROM courses WHERE faculty_id = ? ORDER BY code').all(facultyId);
  return courses.map((course) => {
    const enrolled = db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?').get(course.id).n;
    const lectures = db
      .prepare(
        `SELECT x.id, x.lecture_no AS lectureNo, x.title, x.started_at AS startedAt, x.closed_at AS closedAt,
                (SELECT COUNT(*) FROM scans s WHERE s.session_id = x.id AND s.status IN ('present', 'manual')) AS present
           FROM sessions x WHERE x.course_id = ? ORDER BY x.lecture_no DESC LIMIT 6`,
      )
      .all(course.id);
    const held = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE course_id = ? AND closed_at IS NOT NULL').get(course.id).n;
    return {
      id: course.id,
      code: course.code,
      name: course.name,
      enrolled,
      held,
      plannedLectures: course.planned_lectures,
      room: course.room_lat == null
        ? null
        : {
            lat: course.room_lat,
            lng: course.room_lng,
            setAt: course.room_set_at,
            accuracyM: course.room_accuracy_m,
            source: course.room_source,
            outline: parseOutline(course.room_outline),
            outlineNote: course.room_outline_note,
          },
      open: lectures.find((l) => l.closedAt == null) ?? null,
      lectures,
    };
  });
}
