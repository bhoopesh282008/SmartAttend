import { randomBytes } from 'node:crypto';
import { transaction } from './db.js';

// DEMO DATA. Every name, roll number and past lecture below is invented so the product can be
// shown with a believable class. The history is generated, not measured, and the interface
// says so ("Demo data").

const DAY = 24 * 60 * 60 * 1000;

const FIRST = [
  'Aarav', 'Anjali', 'Bibek', 'Chandni', 'Deepak', 'Elina', 'Gaurav', 'Hema', 'Isha', 'Kiran',
  'Laxmi', 'Manish', 'Nisha', 'Prabin', 'Rojina', 'Sagar', 'Trisha', 'Utsav', 'Yuvraj', 'Zara',
  'Rahul', 'Sneha', 'Pooja', 'Arjun', 'Divya', 'Rohan', 'Kavya', 'Aditya', 'Ritu', 'Sujan',
];
const LAST = ['Sharma', 'Thapa', 'Karki', 'Gurung', 'Rai', 'Joshi', 'Patel', 'Singh', 'Shrestha', 'Basnet'];

// Small deterministic generator so a reset always gives the same class.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COURSES = [
  { code: 'CS301', name: 'Data Structures', faculty: 1, students: 30, past: 8, planned: 40 },
  { code: 'CS305', name: 'Operating Systems', faculty: 1, students: 24, past: 6, planned: 40 },
  { code: 'MA201', name: 'Discrete Mathematics', faculty: 2, students: 20, past: 5, planned: 36 },
];

const TABLES_IN_DELETE_ORDER = ['scans', 'devices', 'sessions', 'enrollments', 'courses', 'users'];

export function seedDemo(db, { now = Date.now } = {}) {
  const rand = mulberry32(2026);
  const at = now();

  transaction(db, () => {
    // meta (login secret, ip salt) is kept so people stay signed in across a reset.
    for (const table of TABLES_IN_DELETE_ORDER) db.exec(`DELETE FROM ${table}`);

    const addUser = db.prepare('INSERT INTO users (id, role, name, roll_no) VALUES (?, ?, ?, ?)');
    addUser.run(1, 'faculty', 'Dr. Meera Khanal', null);
    addUser.run(2, 'faculty', 'Prof. Sanjay Adhikari', null);

    const studentIds = [];
    for (let i = 0; i < 30; i += 1) {
      const id = 100 + i;
      studentIds.push(id);
      addUser.run(id, 'student', `${FIRST[i]} ${LAST[i % LAST.length]}`, `CS23-${String(i + 1).padStart(3, '0')}`);
    }

    const addCourse = db.prepare('INSERT INTO courses (id, code, name, faculty_id, planned_lectures) VALUES (?, ?, ?, ?, ?)');
    const enroll = db.prepare('INSERT INTO enrollments (course_id, student_id) VALUES (?, ?)');
    const addSession = db.prepare(
      `INSERT INTO sessions (id, course_id, lecture_no, title, started_at, closed_at, secret, radius_m, auto_renew)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
    );
    const addScan = db.prepare(
      `INSERT INTO scans (session_id, student_id, device_id, ts, method, token_age_s, status, reasons_json)
       VALUES (?, ?, ?, ?, 'qr', ?, 'present', '[]')`,
    );

    let sessionId = 1;
    COURSES.forEach((course, index) => {
      const courseId = index + 1;
      addCourse.run(courseId, course.code, course.name, course.faculty, course.planned);
      const enrolled = studentIds.slice(0, course.students);
      for (const studentId of enrolled) enroll.run(courseId, studentId);

      // Each student has a made-up attendance habit; a few are shaky so the register has variety.
      const habit = new Map(enrolled.map((id) => [id, 0.6 + rand() * 0.39]));

      for (let lecture = 1; lecture <= course.past; lecture += 1) {
        const started = at - (course.past - lecture + 2) * DAY + (9 + index) * 60 * 60 * 1000 - (at % DAY);
        addSession.run(sessionId, courseId, lecture, `Lecture ${lecture}`, started, started + 55 * 60 * 1000, randomBytes(16).toString('hex'));
        for (const studentId of enrolled) {
          if (rand() < habit.get(studentId)) {
            // Students with a weaker habit also tend to arrive late.
            const arrivesLate = rand() < (1 - habit.get(studentId)) * 0.6;
            const minutes = arrivesLate ? 12 + rand() * 18 : 1 + rand() * 6;
            const when = started + Math.round(minutes * 60 * 1000);
            addScan.run(sessionId, studentId, `demo-device-${studentId}`, when, Math.round(rand() * 55 * 10) / 10);
          }
        }
        sessionId += 1;
      }
    });
  });
}
