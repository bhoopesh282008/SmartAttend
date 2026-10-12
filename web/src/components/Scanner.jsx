import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { tokenFromText } from '../lib.js';

const MESSAGES = {
  starting: 'Starting the camera…',
  scanning: 'Point the camera at the code on the lecturer’s screen.',
  denied: 'Camera permission was denied. Allow the camera for this site, or paste the link below.',
  unsupported: 'This page cannot use the camera here (phones need https for that). Scan the QR with your phone’s own camera app, or paste the link below.',
  error: 'The camera could not be started. Paste the link below instead.',
};

/**
 * Reads QR codes from the camera with jsQR (pure JavaScript, so it works offline and on
 * every browser). Calls onToken once with the attendance token found in the code.
 */
export default function Scanner({ onToken }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [state, setState] = useState('starting');

  useEffect(() => {
    let stream = null;
    let frame = 0;
    let stopped = false;
    let lastRead = 0;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unsupported');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
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
      setState('scanning');

      const canvas = canvasRef.current;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const tick = (time) => {
        if (stopped) return;
        frame = requestAnimationFrame(tick);
        if (time - lastRead < 120 || video.readyState < 2 || !video.videoWidth) return;
        lastRead = time;
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
        const token = hit ? tokenFromText(hit.data) : null;
        if (token) {
          stopped = true;
          onToken(token);
        }
      };
      frame = requestAnimationFrame(tick);
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [onToken]);

  return (
    <div>
      <div className="relative mx-auto aspect-square w-full max-w-md overflow-hidden rounded-lg border border-slate-300 bg-slate-900">
        <video ref={videoRef} className="h-full w-full object-cover" playsInline muted aria-label="Camera view" />
        <canvas ref={canvasRef} className="hidden" />
        {state === 'scanning' && (
          <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-white/80" aria-hidden="true" />
        )}
      </div>
      <p className="mt-3 text-center text-sm text-slate-600" role="status">{MESSAGES[state]}</p>
    </div>
  );
}
