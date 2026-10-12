import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { seedDemo } from './seed.js';
import { createApp } from './app.js';
import { createMlClient } from './ml.js';
import { loadFaceKey } from './face.js';
import { fetchBuildingOutline } from './outline.js';
import { dbPath, faceKeyFile, host, mlUrl, overpassUrl, port, webDist } from './config.js';

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

// First run: load the demo class so there is something to show.
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  seedDemo(db);
  console.log('Loaded demo data (invented class, generated history).');
}

// The model service is optional. If it is not running, scans are checked by rules alone.
const ml = process.env.ML_URL === 'off' ? null : createMlClient({ url: mlUrl });
const app = createApp({
  db, webDist, ml, faceKey: loadFaceKey(faceKeyFile), demo: process.env.DEMO_MODE !== 'off',
  findOutline: overpassUrl ? (args) => fetchBuildingOutline({ ...args, url: overpassUrl }) : undefined,
});
app.listen(port, host, () => {
  console.log(`SmartAttend server on http://${host}:${port}  (database: ${dbPath})`);
  if (ml) {
    ml.health().then((status) => {
      console.log(status.available ? `Risk models online at ${mlUrl}: ${JSON.stringify(status.models)}` : `Risk models not reachable at ${mlUrl}; scans use rules only until it starts.`);
    });
  }
});
