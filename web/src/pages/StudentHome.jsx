import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { AttendanceBar, Loading, Notice, PageTitle, StatusChip } from '../components/ui.jsx';
import { percent } from '../lib.js';

function MissLine({ course }) {
  if (course.held === 0) return <p className="text-sm text-slate-600">No lectures held yet.</p>;
  if (course.canMiss < 0) {
    return (
      <p className="text-sm text-blocked">
        Even if you attend every remaining lecture you would finish below 75%. Talk to your lecturer.
      </p>
    );
  }
  return (
    <p className="text-sm text-slate-700">
      You can still miss <strong>{course.canMiss}</strong> of the {Math.max(0, course.plannedLectures - course.held)} lectures left and finish on 75%.
    </p>
  );
}

function CourseCard({ course }) {
  const low = course.pct != null && course.pct < 0.75;
  return (
    <section className="card p-5" aria-labelledby={`c-${course.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={`c-${course.id}`} className="text-lg font-semibold"><span className="text-slate-500">{course.code}</span> {course.name}</h2>
          <p className="mt-1 text-sm text-slate-600">Attended {course.attended} of {course.held} lectures held</p>
        </div>
        <p className={`text-3xl font-semibold ${low ? 'text-blocked' : ''}`} aria-label={`Attendance ${percent(course.pct)}`}>{percent(course.pct)}</p>
      </div>
      <div className="mt-4"><AttendanceBar fraction={course.pct} /></div>
      <p className="mt-1 text-xs text-slate-500">The line is 75%.</p>
      <div className="mt-3"><MissLine course={course} /></div>

      {course.open && (
        <div className="mt-4">
          {course.open.myStatus ? (
            <Notice tone={course.open.myStatus === 'review' ? 'warn' : 'ok'} action={<StatusChip status={course.open.myStatus} />}>
              Lecture {course.open.lectureNo} is in progress{course.open.title && course.open.title !== `Lecture ${course.open.lectureNo}` ? `: ${course.open.title}` : ''}. You&rsquo;re already marked.
            </Notice>
          ) : (
            <Notice tone="warn" action={<Link to="/scan" className="btn-primary">Scan the code</Link>}>
              <strong>Lecture {course.open.lectureNo} is in progress.</strong> Scan the code on your lecturer&rsquo;s screen to mark attendance.
            </Notice>
          )}
        </div>
      )}
    </section>
  );
}

export default function StudentHome() {
  const [courses, setCourses] = useState(null);
  const [error, setError] = useState(null);
  const [faceEnrolled, setFaceEnrolled] = useState(null);

  useEffect(() => {
    api('/me/face').then((s) => setFaceEnrolled(s.enrolled)).catch(() => setFaceEnrolled(null));
  }, []);

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
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const inProgress = courses?.some((c) => c.open && !c.open.myStatus);
  const asksForFace = courses?.some((c) => c.open?.faceRequired && !c.open.myStatus);

  return (
    <>
      <PageTitle title="My courses" subtitle="Your attendance, and what to do when a lecture is in progress.">
        <Link to="/scan" className={inProgress ? 'btn-primary' : 'btn-secondary'}>Scan a code</Link>
      </PageTitle>
      {error && <Notice tone="error" action={<button type="button" className="btn-secondary btn-sm" onClick={load}>Try again</button>}>{error.message}</Notice>}
      {asksForFace && faceEnrolled === false && (
        <div className="mb-4">
          <Notice tone="warn" action={<Link to="/face" className="btn-primary">Enrol my face</Link>}>
            A lecture in progress asks for a face check, and you have not enrolled yet. It takes a minute and only numbers, never a photo, are kept.
          </Notice>
        </div>
      )}
      {!courses && !error && <Loading />}
      {courses?.length === 0 && <Notice>You are not enrolled in any course yet.</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        {courses?.map((c) => <CourseCard key={c.id} course={c} />)}
      </div>
    </>
  );
}
