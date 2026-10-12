import { DatabaseSync } from 'node:sqlite';

// One session = one lecture. A scan row is either a mark (present / review / manual)
// or a blocked attempt (rejected). A student has at most one mark per lecture; blocked
// attempts are kept as history and do not use up the student's slot.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('faculty', 'student')),
  name TEXT NOT NULL,
  roll_no TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  faculty_id INTEGER NOT NULL REFERENCES users(id),
  room_lat REAL,
  room_lng REAL,
  room_set_at INTEGER,
  planned_lectures INTEGER NOT NULL DEFAULT 40
);

CREATE TABLE IF NOT EXISTS enrollments (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, student_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lecture_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  closed_at INTEGER,
  secret TEXT NOT NULL,
  radius_m REAL,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  UNIQUE (course_id, lecture_no)
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT NOT NULL,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (device_id, student_id)
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT,
  ip_hash TEXT,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'qr' CHECK (method IN ('qr', 'manual')),
  distance_m REAL,
  accuracy_m REAL,
  face_distance REAL,
  token_age_s REAL,
  status TEXT NOT NULL CHECK (status IN ('present', 'review', 'rejected', 'manual')),
  reject_code TEXT,
  risk REAL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at INTEGER
);

-- The 6-digit fallback code that stands for a QR code for its 60 seconds (see shortcode.js).
CREATE TABLE IF NOT EXISTS codes (
  code TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  issued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS codes_by_code ON codes (code, issued_at);

CREATE UNIQUE INDEX IF NOT EXISTS scans_one_mark
  ON scans (session_id, student_id) WHERE status IN ('present', 'review', 'manual');
CREATE INDEX IF NOT EXISTS scans_by_session ON scans (session_id);
CREATE INDEX IF NOT EXISTS scans_by_device ON scans (session_id, device_id);
CREATE INDEX IF NOT EXISTS scans_by_student ON scans (student_id, ts);
`;

// Columns added after the first release. An existing database file gets them on open.
const ADDED_COLUMNS = [
  // 'rules' when only the rules decided, otherwise the version of the model that scored the scan.
  ['scans', 'scored_by', 'TEXT'],
  // Face check: an encrypted template of 128 numbers (never a photo), and whether a lecture asks for one.
  ['users', 'face_template', 'TEXT'],
  ['users', 'face_enrolled_at', 'INTEGER'],
  ['sessions', 'face_required', 'INTEGER NOT NULL DEFAULT 0'],
  // The classroom's position has an error of its own, and may carry a building outline from OpenStreetMap.
  ['courses', 'room_accuracy_m', 'REAL'],
  ['courses', 'room_source', 'TEXT'], // 'device' or 'manual'
  ['courses', 'room_outline', 'TEXT'], // JSON ring of [lat, lng]
  ['courses', 'room_outline_note', 'TEXT'], // where the outline came from
  // A head-turn challenge before the face photo (checked in the browser only), and automatic closing.
  ['sessions', 'face_liveness', 'INTEGER NOT NULL DEFAULT 0'],
  ['sessions', 'auto_close_at', 'INTEGER'],
];

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

// Runs fn inside a transaction; rolls back if it throws.
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
