// In-browser face descriptors. A photo is turned into 128 numbers on the phone and ONLY those
// numbers are sent anywhere; the picture itself never leaves the browser and is never stored.
//
// The library (about 1.3 MB) and its models (about 7 MB, served from /models/face, no CDN) are
// loaded the first time they are needed, so the rest of the app is unaffected.
import { yawFromLandmarks } from './liveness.js';

const MODEL_URL = '/models/face';
let engine = null;

export function loadFaceEngine() {
  engine ??= (async () => {
    const faceapi = await import('@vladmandic/face-api');
    try {
      await faceapi.tf.setBackend('webgl');
    } catch {
      await faceapi.tf.setBackend('cpu'); // slower, but works where WebGL does not
    }
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    await warmUp(faceapi);
    return faceapi;
  })().catch((error) => {
    engine = null; // let a later attempt try again
    throw error;
  });
  return engine;
}

// The first run of each network compiles GPU programs, which measured about 10 s on one machine.
// That must not land on the student while a 60-second code is ticking, so each network is run once
// on a blank picture while the camera is still starting. Failure here is harmless.
async function warmUp(faceapi) {
  try {
    const blank = (size) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      return canvas;
    };
    await faceapi.detectAllFaces(blank(320), new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }));
    await faceapi.nets.faceLandmark68Net.detectLandmarks(blank(112));
    await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(blank(150));
  } catch {
    /* the first real photo will simply be slower */
  }
}

// The face must fill at least this share of the picture's width to be read reliably.
const MIN_FACE_WIDTH_SHARE = 0.2;
const MIN_DETECTION_SCORE = 0.6;
// While following a head turn, a weaker detection still counts (see readYaw).
const TURNED_FACE_MIN_SCORE = 0.3;

function options(faceapi) {
  return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
}

/** Quick check used for live feedback: 'none', 'many', 'far', 'unclear' or 'ok'. */
export async function checkFraming(source) {
  const faceapi = await loadFaceEngine();
  const faces = await faceapi.detectAllFaces(source, options(faceapi));
  return judge(faces);
}

// One verdict from what the detector saw: no face, several, too small, too unclear, or fine.
function judge(faces) {
  if (faces.length === 0) return 'none';
  if (faces.length > 1) return 'many';
  const { box, score, imageDims } = faces[0];
  if (box.width / imageDims.width < MIN_FACE_WIDTH_SHARE) return 'far';
  if (score < MIN_DETECTION_SCORE) return 'unclear';
  return 'ok';
}

/**
 * Reads one face from an image, video or canvas.
 * Returns { ok: true, descriptor: number[128] } or { ok: false, problem: 'none' | 'many' | 'far' | 'unclear' }.
 */
export async function describeFace(source) {
  const faceapi = await loadFaceEngine();
  const faces = await faceapi.detectAllFaces(source, options(faceapi)).withFaceLandmarks().withFaceDescriptors();
  const verdict = judge(faces.map((f) => f.detection));
  if (verdict !== 'ok') return { ok: false, problem: verdict };
  return { ok: true, descriptor: Array.from(faces[0].descriptor, (v) => Math.round(v * 1e5) / 1e5) };
}

/**
 * How far the head is turned right now (see liveness.js), or null if exactly one face cannot be read.
 * Looser than a photo needs to be: a turned face scores lower and is smaller, and it must still be read.
 */
export async function readYaw(source) {
  const faceapi = await loadFaceEngine();
  // The detector is least sure of a face exactly when it is turned, and the turned face is the one this
  // has to read, so it accepts weaker detections than the framing check does (0.5). A test with a camera
  // playing a turned face found that the stricter cutoff made a left turn invisible.
  const faces = await faceapi
    .detectAllFaces(source, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: TURNED_FACE_MIN_SCORE }))
    .withFaceLandmarks();
  if (faces.length !== 1) return null;
  const { detection, landmarks } = faces[0];
  if (detection.box.width / detection.imageDims.width < 0.12) return null;
  return yawFromLandmarks(landmarks.positions);
}

export const FRAMING_HELP = {
  none: 'No face found. Face the camera in good light.',
  many: 'More than one face is in view. Only you should be in the picture.',
  far: 'Move closer so your face fills more of the picture.',
  unclear: 'The face is not clear. Face the camera in good light and hold still.',
  ok: 'Face found.',
};
