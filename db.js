import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      code       TEXT PRIMARY KEY,
      url        TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const byCode = db.prepare('SELECT url FROM links WHERE code = ?');
  const byUrl = db.prepare('SELECT code FROM links WHERE url = ?');
  const insert = db.prepare('INSERT INTO links (code, url) VALUES (?, ?)');

  return {
    findByCode: (code) => byCode.get(code)?.url,
    findByUrl: (url) => byUrl.get(url)?.code,
    insert: (code, url) => void insert.run(code, url),
    close: () => db.close(),
  };
}
