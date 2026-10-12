import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { seedDemo } from './seed.js';
import { dbPath } from './config.js';

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
seedDemo(db);
const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
console.log(`Demo data loaded into ${dbPath}: ${users} users, ${sessions} past lectures.`);
