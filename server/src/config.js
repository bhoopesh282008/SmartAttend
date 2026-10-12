import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const dbPath = process.env.DB_PATH ?? join(here, '..', 'data', 'smartattend.db');
export const port = Number(process.env.PORT ?? 3001);
// Localhost by default: in development the web app's proxy is the only client.
export const host = process.env.HOST ?? '127.0.0.1';
export const webDist = process.env.WEB_DIST ?? join(here, '..', '..', 'web', 'dist');
// Where the key for sealing face templates is kept (outside the database file on purpose).
export const faceKeyFile = process.env.FACE_KEY_FILE ?? join(dirname(dbPath), 'face.key');
// Where building outlines come from. Only tests need to change it.
export const overpassUrl = process.env.OVERPASS_URL ?? null;
// The model service (ml/app.py) and the model cards its training scripts write.
export const mlUrl = process.env.ML_URL ?? 'http://127.0.0.1:8001';
export const modelsDir = process.env.ML_MODELS_DIR ?? join(here, '..', '..', 'ml', 'models');
