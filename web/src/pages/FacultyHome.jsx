import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import StartLecture from '../components/StartLecture.jsx';
import { Loading, Notice, PageTitle } from '../components/ui.jsx';
import { dateOf } from '../lib.js';

function CourseCard({ course, onRoomChanged }) {
  return (
    <section className="card p-5" aria-labelledby={`course-${course.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`course-${course.id}`} className="text-lg font-semibold">
            <span className="text-slate-500">{course.code}</span> {course.name}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {course.enrolled} students enrolled &middot; {course.held} lecture{course.held === 1 ? '' : 's'} held of {course.plannedLectures} planned
          </p>
        </div>
        <Link to={`/faculty/courses/${course.id}/register`} className="btn-secondary">Class register</Link>
      </div>

      {course.open ? (
        <div className="mt-4">
          <Notice tone="ok" action={<Link to={`/faculty/lectures/${course.open.id}`} className="btn-primary">Resume lecture</Link>}>
            <strong>Lecture {course.open.lectureNo}</strong> is open{course.open.title ? `: ${course.open.title}` : ''}. {course.open.present} marked so far.
          </Notice>
        </div>
      ) : (
        <StartLecture course={course} onRoomChanged={onRoomChanged} />
      )}

      {course.lectures.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent lectures</h3>
          <ul className="divide-y divide-slate-100 text-sm">
            {course.lectures.map((l) => (
              <li key={l.id}>
                <Link to={`/faculty/lectures/${l.id}`} className="flex min-h-11 items-center justify-between gap-3 rounded px-1 hover:bg-slate-50">
                  <span><span className="font-medium">L{l.lectureNo}</span> {l.title} <span className="text-slate-500">&middot; {dateOf(l.startedAt)}</span></span>
                  <span className="text-slate-600">{l.present} of {course.enrolled} present{l.closedAt == null ? ' (open)' : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function FacultyHome() {
  const [courses, setCourses] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setCourses(await api('/courses'));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageTitle title="Your courses" subtitle="One lecture, one QR code. Start a lecture, show the code, and students scan it." />
      {error && <Notice tone="error" action={<button type="button" className="btn-secondary btn-sm" onClick={load}>Try again</button>}>{error.message}</Notice>}
      {!courses && !error && <Loading />}
      <div className="grid gap-4">
        {courses?.map((course) => <CourseCard key={course.id} course={course} onRoomChanged={load} />)}
      </div>
    </>
  );
}
