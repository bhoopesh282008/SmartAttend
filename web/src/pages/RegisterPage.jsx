import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import AtRiskPanel from '../components/AtRiskPanel.jsx';
import { Loading, Notice, PageTitle } from '../components/ui.jsx';
import { dateOf, percent } from '../lib.js';

const CELL = {
  present: { letter: 'P', cls: 'bg-present-soft text-present', label: 'Present' },
  manual: { letter: 'M', cls: 'bg-manual-soft text-manual', label: 'Marked by hand' },
  review: { letter: 'R', cls: 'bg-review-soft text-review', label: 'Pending review' },
  absent: { letter: 'A', cls: 'bg-slate-100 text-slate-500', label: 'Absent' },
};

export default function RegisterPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [exported, setExported] = useState(null);

  useEffect(() => {
    let alive = true;
    api(`/courses/${id}/register`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id]);

  async function exportCsv() {
    try {
      setExported(await downloadCsv(`/courses/${id}/export.csv`));
    } catch (err) {
      setError(err);
    }
  }

  if (error && !data) return <Notice tone="error" action={<Link to="/faculty" className="btn-secondary btn-sm">Back to courses</Link>}>{error.message}</Notice>;
  if (!data) return <Loading />;

  const { course, lectures, students } = data;
  const closed = lectures.filter((l) => l.closedAt != null).length;

  return (
    <>
      <PageTitle
        title={`${course.code} ${course.name}`}
        subtitle={`Class register: ${students.length} students, ${lectures.length} lecture${lectures.length === 1 ? '' : 's'}. Percentages count the ${closed} closed lecture${closed === 1 ? '' : 's'}; a scan still waiting for review is not counted until you decide it.`}
      >
        <Link to="/faculty" className="btn-secondary">Back to courses</Link>
        <button type="button" className="btn-primary" onClick={exportCsv}>Export CSV</button>
      </PageTitle>
      {exported && <div className="mb-4"><Notice tone="ok">{exported} downloaded.</Notice></div>}
      {error && <div className="mb-4"><Notice tone="error">{error.message}</Notice></div>}

      <AtRiskPanel courseId={id} />

      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Key">
        {Object.values(CELL).map((c) => (
          <li key={c.letter} className="flex items-center gap-1.5">
            <span className={`grid h-5 w-5 place-items-center rounded text-[11px] font-semibold ${c.cls}`}>{c.letter}</span>{c.label}
          </li>
        ))}
        <li className="flex items-center gap-1.5"><span className="font-semibold text-blocked">Red %</span> below 75%</li>
      </ul>

      <div className="card overflow-auto">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-white text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="sticky left-0 z-10 min-w-48 bg-white px-4 py-2 font-medium">Student</th>
              {lectures.map((l) => (
                <th key={l.id} className="px-1.5 py-2 text-center font-medium" title={`${l.title}, ${dateOf(l.startedAt)}`}>
                  <Link to={`/faculty/lectures/${l.id}`} className="underline-offset-2 hover:underline">L{l.lectureNo}</Link>
                  <span className="block text-[10px] font-normal normal-case text-slate-400">{dateOf(l.startedAt)}</span>
                </th>
              ))}
              <th className="px-4 py-2 text-right font-medium">Attended</th>
              <th className="px-4 py-2 text-right font-medium">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((s) => (
              <tr key={s.id}>
                <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="block text-xs text-slate-500">{s.rollNo}</span>
                </td>
                {s.cells.map((c) => {
                  const cell = CELL[c.status];
                  return (
                    <td key={c.sessionId} className="px-1.5 py-1.5 text-center">
                      <span className={`inline-grid h-6 w-6 place-items-center rounded text-[11px] font-semibold ${cell.cls}`} title={cell.label}>{cell.letter}</span>
                    </td>
                  );
                })}
                <td className="whitespace-nowrap px-4 py-2 text-right text-slate-600">{s.attended} of {s.held}</td>
                <td className={`px-4 py-2 text-right font-semibold ${s.pct != null && s.pct < 0.75 ? 'text-blocked' : ''}`}>{percent(s.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
