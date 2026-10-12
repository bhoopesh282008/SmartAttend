import { useState } from 'react';
import { api } from '../api.js';
import { parseCoordinates } from '../coordinates.js';
import { dateOf, getLocation, timeOf } from '../lib.js';
import { Notice } from './ui.jsx';
import RoomPreview from './RoomPreview.jsx';

const ACCURACY_CHOICES = [10, 25, 50];

const WHY_NOT = {
  denied: 'Location permission was denied in this browser.',
  timeout: 'This device could not find its position in time. Many laptops and desktops cannot find it at all.',
  unavailable: 'This device could not work out its position. Many laptops and desktops cannot.',
  unsupported: 'This browser cannot share a position.',
};

/**
 * The classroom's position, which the location check measures students against. It can come from this
 * device or be typed in (laptops and desktops often cannot find their own position), it records how
 * accurate it is, and it can be refined with the building's outline from OpenStreetMap.
 */
export default function RoomSetup({ course, radiusM, onChanged }) {
  const room = course.room;
  const [busy, setBusy] = useState(null); // 'device' | 'typed' | 'outline'
  const [note, setNote] = useState(null); // { tone, text }
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [accuracy, setAccuracy] = useState(25);

  async function save(body, which) {
    setBusy(which);
    setNote(null);
    try {
      await api(`/courses/${course.id}/room`, { method: 'PATCH', body });
      await onChanged();
      setNote({ tone: 'ok', text: 'Classroom position saved.' });
      return true;
    } catch (err) {
      setNote({ tone: 'error', text: err.message });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function useThisDevice() {
    setBusy('device');
    setNote(null);
    const { location, reason } = await getLocation(15_000);
    if (!location) {
      setBusy(null);
      setTyping(true);
      setNote({ tone: 'warn', text: `${WHY_NOT[reason]} Type the coordinates instead (right-click the classroom on a map and copy them), or open this page on a phone.` });
      return;
    }
    await save({ lat: location.lat, lng: location.lng, accuracy: location.accuracy, source: 'device' }, 'device');
  }

  async function saveTyped(event) {
    event.preventDefault();
    const parsed = parseCoordinates(text);
    if (!parsed) {
      setNote({ tone: 'error', text: 'Could not read that. Use decimal degrees with latitude first, for example 27.7172, 85.3240.' });
      return;
    }
    if (await save({ ...parsed, accuracy, source: 'manual' }, 'typed')) {
      setTyping(false);
      setText('');
    }
  }

  async function addOutline() {
    setBusy('outline');
    setNote(null);
    try {
      const found = await api(`/courses/${course.id}/room/outline`, { method: 'POST' });
      await onChanged();
      setNote({ tone: 'ok', text: `Building outline added (${found.note}). Students inside the building count as in the room, and the distance is now measured from its walls.` });
    } catch (err) {
      setNote({ tone: 'warn', text: err.message });
    } finally {
      setBusy(null);
    }
  }

  async function removeOutline() {
    try {
      await api(`/courses/${course.id}/room/outline`, { method: 'DELETE' });
      await onChanged();
      setNote({ tone: 'ok', text: 'Outline removed. The circle is used again.' });
    } catch (err) {
      setNote({ tone: 'error', text: err.message });
    }
  }

  const status = room
    ? `Set ${dateOf(room.setAt)} ${timeOf(room.setAt)}, accurate to about ${Math.round(room.accuracyM ?? 0)} m${room.source === 'manual' ? ' (typed in)' : ''}${room.outline ? ', with building outline' : ''}`
    : 'Not set. Location checks stay off until it is.';

  return (
    <div className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-medium">Classroom position</h4>
        <span className="text-slate-600">{status}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={useThisDevice} disabled={busy !== null}>
          {busy === 'device' ? 'Finding position…' : room ? 'Update from this device' : 'Use this device’s position'}
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setTyping((v) => !v)} aria-expanded={typing}>
          Type coordinates
        </button>
        {room && !room.outline && (
          <button type="button" className="btn-secondary btn-sm" onClick={addOutline} disabled={busy !== null} title="Asks OpenStreetMap for the outline of the building at this position">
            {busy === 'outline' ? 'Looking…' : 'Add building outline'}
          </button>
        )}
        {room?.outline && (
          <button type="button" className="btn-secondary btn-sm" onClick={removeOutline}>Remove outline</button>
        )}
      </div>

      {typing && (
        <form onSubmit={saveTyped} className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div>
            <label className="label" htmlFor={`coords-${course.id}`}>Latitude, longitude</label>
            <input id={`coords-${course.id}`} name="coordinates" className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="27.7172, 85.3240" autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label className="label" htmlFor={`acc-${course.id}`}>Accurate to about</label>
            <select id={`acc-${course.id}`} name="accuracy" className="field" value={accuracy} onChange={(e) => setAccuracy(Number(e.target.value))}>
              {ACCURACY_CHOICES.map((m) => <option key={m} value={m}>{m} m</option>)}
            </select>
          </div>
          <button type="submit" className="btn-primary" disabled={busy !== null || !text.trim()}>Save position</button>
        </form>
      )}

      {note && <div className="mt-3"><Notice tone={note.tone}>{note.text}</Notice></div>}
      {room && <RoomPreview room={room} radiusM={radiusM} />}
      {!room && (
        <p className="mt-2 text-xs text-slate-500">
          Phones find their position well. Laptops and desktops often cannot: if this fails, right-click the classroom on a map,
          copy the coordinates, and type them in.
        </p>
      )}
    </div>
  );
}
