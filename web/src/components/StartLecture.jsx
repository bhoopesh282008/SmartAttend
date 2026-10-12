import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import RoomSetup from './RoomSetup.jsx';
import { Notice } from './ui.jsx';

const CIRCLE_DEFAULT_M = 150;
const OUTLINE_DEFAULT_M = 50; // measured from the walls, so it can be much smaller than a circle

/** Starting a lecture: what to check (position, face), how long it stays open, and the classroom position it relies on. */
export default function StartLecture({ course, onRoomChanged }) {
  const navigate = useNavigate();
  const hasOutline = Boolean(course.room?.outline);
  const [title, setTitle] = useState('');
  const [checkLocation, setCheckLocation] = useState(false);
  const [radius, setRadius] = useState(hasOutline ? OUTLINE_DEFAULT_M : CIRCLE_DEFAULT_M);
  const [faceRequired, setFaceRequired] = useState(false);
  const [faceLiveness, setFaceLiveness] = useState(false);
  const [autoClose, setAutoClose] = useState('120');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const radiusTouched = useRef(false);

  // The sensible radius depends on the shape: metres from a point, or metres outside the walls.
  useEffect(() => {
    if (!radiusTouched.current) setRadius(hasOutline ? OUTLINE_DEFAULT_M : CIRCLE_DEFAULT_M);
  }, [hasOutline]);

  // Setting the position for the first time is a good moment to switch the check on.
  const hadRoom = useRef(Boolean(course.room));
  useEffect(() => {
    if (course.room && !hadRoom.current) setCheckLocation(true);
    hadRoom.current = Boolean(course.room);
  }, [course.room]);

  async function start(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api(`/courses/${course.id}/sessions`, {
        method: 'POST',
        body: {
          title,
          radiusM: checkLocation ? Number(radius) : null,
          faceRequired,
          faceLiveness: faceRequired && faceLiveness,
          autoCloseMinutes: Number(autoClose) || 0,
        },
      });
      navigate(`/faculty/lectures/${id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  // The classroom panel has a form of its own (typed coordinates), and forms cannot be nested: pressing
  // Save there would also have started the lecture. So it sits beside the lecture form, not inside it.
  return (
    <div className="mt-4 grid gap-4 border-t border-slate-200 pt-4">
      <RoomSetup course={course} radiusM={Number(radius) || CIRCLE_DEFAULT_M} onChanged={onRoomChanged} />
      <form onSubmit={start} className="grid gap-4">
        <div>
          <label className="label" htmlFor={`title-${course.id}`}>Lecture title <span className="font-normal text-slate-500">(optional)</span></label>
          <input id={`title-${course.id}`} name="title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Stacks and queues…" autoComplete="off" maxLength={120} />
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className={`flex min-h-11 items-center gap-2 ${course.room ? '' : 'opacity-50'}`}>
            <input type="checkbox" name="checkLocation" checked={checkLocation} disabled={!course.room} onChange={(e) => setCheckLocation(e.target.checked)} className="h-4 w-4" />
            Check students are in the room
          </label>
          {checkLocation && (
            <label className="flex items-center gap-2">
              {hasOutline ? 'Allowed distance outside the walls' : 'Radius'}
              <input
                type="number"
                name="radius"
                min="20"
                max="5000"
                step="10"
                value={radius}
                onChange={(e) => { radiusTouched.current = true; setRadius(e.target.value); }}
                className="field !w-24"
              />
              m
            </label>
          )}
        </div>

        <div className="text-sm">
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" name="faceRequired" checked={faceRequired} onChange={(e) => setFaceRequired(e.target.checked)} className="h-4 w-4" />
            Ask students for a face check
          </label>
          {faceRequired && (
            <div className="ml-6 grid gap-1">
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" name="faceLiveness" checked={faceLiveness} onChange={(e) => setFaceLiveness(e.target.checked)} className="h-4 w-4" />
                Also ask them to turn their head
              </label>
              <p className="text-slate-600">
                Students must enrol their face first. A poor match, or no face check, goes to your review queue; it never rejects anyone.
                {faceLiveness
                  ? ' The head turn (left or right, chosen at random) stops a held-up photo, but it runs on the student’s own phone, so it cannot stop someone who tampers with it, and a video could pass.'
                  : ' Without the head turn it cannot tell a live face from a photograph.'}
              </p>
            </div>
          )}
        </div>

        <label className="flex flex-wrap items-center gap-2 text-sm">
          Close the lecture by itself after
          <input type="number" name="autoClose" min="0" max="1440" step="5" value={autoClose} onChange={(e) => setAutoClose(e.target.value)} className="field !w-24" />
          minutes <span className="text-slate-500">(0 = stays open until you close it)</span>
        </label>

        {error && <Notice tone="error">{error.message}</Notice>}
        <div>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Starting…' : 'Start lecture'}</button>
        </div>
      </form>
    </div>
  );
}
