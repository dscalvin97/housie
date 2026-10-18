import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/housie.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    code TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated INTEGER NOT NULL
  );
`);

const upsertStmt = db.prepare('INSERT INTO games (code, state, updated) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET state = excluded.state, updated = excluded.updated');

export function saveGame(game) {
  upsertStmt.run(game.code, JSON.stringify(game), Date.now());
}

export function loadGame(code) {
  const row = db.prepare('SELECT state FROM games WHERE code = ?').get(code);
  return row ? JSON.parse(row.state) : null;
}

export function allCodes() {
  return db.prepare('SELECT code FROM games ORDER BY updated DESC').all().map(r => r.code);
}
