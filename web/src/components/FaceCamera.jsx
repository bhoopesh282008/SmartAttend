import { useEffect, useRef, useState } from 'react';
import { checkFraming, describeFace, FRAMING_HELP, loadFaceEngine, readYaw } from '../faceEngine.js';
import { FAILURE_TEXT, instruction, runChallenge } from '../liveness.js';

const CAMERA_MESSAGES = {
  denied: 'Camera permission was denied. Allow the camera for this site to continue.',
  unsupported: 'This page cannot use the camera here (phones need https for that).',
  error: 'The camera could not be started.',
};

/**
 * A front-camera preview that reads a face when the person presses the button. It reports the
 * 128-number descriptor to `onCapture`; the picture is never kept or sent. Live feedback tells
 * the person if no face, several faces, or too small a face is in view.
 *
 * With `challenge` ('left' or 'right') the button first asks for a head turn to that side and back
 * (see liveness.js), and the photo is read only once the head is facing the camera again.
 */
export default function FaceCamera({ onCapture, label = 'Take photo', busy = false, challenge = null }) {
  const videoRef = useRef(null);
  const readingRef = useRef(false);
  const [state, setState] = useState('starting'); // starting | ready | denied | unsupported | error
  const [engineError, setEngineError] = useState(null);
  const [engineReady, setEngineReady] = useState(false);
  const [framing, setFraming] = useState(null);
  const [problem, setProblem] = useState(null);
  const [reading, setReading] = useState(false);
  const [phase, setPhase] = useState(null); // 'turn' | 'return' while a head-turn challenge runs

  // The models load while the camera starts, so the first photo is not slow.
  useEffect(() => {
    let alive = true;
    loadFaceEngine()
      .then(() => alive && setEngineReady(true))
      .catch((err) => alive && setEngineError(err));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let stream = null;
    let stopped = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unsupported');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
      } catch (err) {
        setState(err?.name === 'NotAllowedError' ? 'denied' : 'error');
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setState('ready');
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Live feedback while the camera is on and the models are ready. It pauses while a photo or a
  // head-turn is being read, so the two never compete for the same processor.
  useEffect(() => {
    if (state !== 'ready' || !engineReady) return undefined;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      const video = videoRef.current;
      if (alive && !readingRef.current && video && video.readyState >= 2) {
        try {
          const result = await checkFraming(video);
          if (alive) setFraming(result);
        } catch {
          /* a single failed frame is not worth showing */
        }
      }
      if (alive) timer = setTimeout(tick, 450);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [state, engineReady]);

  async function capture() {
    readingRef.current = true;
    setReading(true);
    setProblem(null);
    try {
      if (challenge) {
        const outcome = await runChallenge({
          direction: challenge,
          readYaw: () => readYaw(videoRef.current),
          onPhase: setPhase,
        });
        setPhase(null);
        if (!outcome.ok) {
          setProblem(FAILURE_TEXT[outcome.reason]);
          return;
        }
      }
      const result = await describeFace(videoRef.current);
      if (!result.ok) {
        setProblem(FRAMING_HELP[result.problem]);
        return;
      }
      await onCapture(result.descriptor);
    } catch (err) {
      setPhase(null);
      setProblem(err?.message ?? 'The photo could not be read.');
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  }

  const cameraProblem = CAMERA_MESSAGES[state];
  const status = cameraProblem
    ?? (engineError ? 'The face models could not be loaded. Check the connection and try again.'
      : !engineReady ? 'Loading the face models (first time only)…'
        : state === 'starting' ? 'Starting the camera…'
          : phase === 'ready' ? 'Look at the camera and hold still for a moment.'
            : phase === 'turn' ? instruction(challenge)
            : phase === 'return' ? 'Now look straight at the camera.'
              : reading && challenge ? 'Reading…'
                : framing ? FRAMING_HELP[framing] : 'Looking for a face…');

  return (
    <div>
      <div className="relative mx-auto aspect-[4/3] w-full max-w-sm overflow-hidden rounded-lg border border-slate-300 bg-slate-900">
        {/* mirrored like a selfie; the photo that is read is not mirrored */}
        <video ref={videoRef} className="h-full w-full -scale-x-100 object-cover" playsInline muted aria-label="Your camera" />
        {state === 'ready' && engineReady && (
          <span
            className={`absolute left-2 top-2 rounded-full px-2.5 py-0.5 text-xs font-medium ${framing === 'ok' && !phase ? 'bg-present text-white' : 'bg-white/90 text-slate-800'}`}
          >
            {phase ? (phase === 'ready' ? 'Hold still' : phase === 'turn' ? `Turn ${challenge}` : 'Look ahead') : framing === 'ok' ? 'Face found' : 'Adjust'}
          </span>
        )}
      </div>
      <p className="mt-3 text-center text-sm text-slate-600" role="status">{status}</p>
      {problem && <p className="mt-1 text-center text-sm text-blocked" role="alert">{problem}</p>}
      <div className="mt-4 flex justify-center">
        <button
          type="button"
          className="btn-primary"
          onClick={capture}
          disabled={busy || reading || state !== 'ready' || !engineReady}
        >
          {reading ? (challenge ? 'Follow the instruction…' : 'Reading…') : label}
        </button>
      </div>
    </div>
  );
}
