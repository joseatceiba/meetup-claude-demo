import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, '');
const DATA_DIR = join(import.meta.dirname, 'data');
const INDEX_HTML = readFileSync(join(import.meta.dirname, 'public', 'index.html'));

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GENERATED_LENGTH = 7;
const CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
const RESERVED = new Set(['api', 'public']);
const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 8 * 1024;

// --- Storage -----------------------------------------------------------------

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'links.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS links (
    code       TEXT PRIMARY KEY COLLATE NOCASE,
    url        TEXT NOT NULL,
    is_custom  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    clicks     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS links_url ON links (url);
`);

const findByCode = db.prepare('SELECT code, url FROM links WHERE code = ?');
const findGenerated = db.prepare('SELECT code FROM links WHERE url = ? AND is_custom = 0');
const insertLink = db.prepare('INSERT INTO links (code, url, is_custom) VALUES (?, ?, ?)');
const countClick = db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?');

// --- Shortening --------------------------------------------------------------

function generateCode() {
  let code = '';
  for (let i = 0; i < GENERATED_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href.length <= MAX_URL_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

// Returns [statusCode, body]. DatabaseSync is synchronous, so check-then-insert can't race.
function shorten({ url, alias }) {
  const target = normalizeUrl(url);
  if (!target) return [400, { error: 'Enter a valid http:// or https:// URL.', field: 'url' }];

  alias = alias == null ? '' : String(alias).trim();
  if (alias) {
    if (!CODE_PATTERN.test(alias)) {
      return [400, { error: 'Alias must be 3–32 letters, numbers, - or _.', field: 'alias' }];
    }
    if (RESERVED.has(alias.toLowerCase())) return [400, { error: 'That alias is reserved.', field: 'alias' }];
    if (findByCode.get(alias)) return [409, { error: 'That alias is already taken.', field: 'alias' }];
    insertLink.run(alias, target, 1);
    return [201, { code: alias }];
  }

  const existing = findGenerated.get(target);
  if (existing) return [200, { code: existing.code, existing: true }];

  let code;
  do code = generateCode(); while (findByCode.get(code));
  insertLink.run(code, target, 0);
  return [201, { code }];
}

// --- HTTP --------------------------------------------------------------------

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Link not found</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;text-align:center;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}a{color:#2563eb}</style></head>
<body><main><h1>Link not found</h1><p>This short link doesn't exist.</p><p><a href="/">Shorten a URL</a></p></main></body></html>`;

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/') {
      return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && pathname === '/api/shorten') {
      const body = await readJson(req);
      if (!body) return sendJson(res, 400, { error: 'Invalid request.' });
      const [status, result] = shorten(body);
      if (result.code) result.shortUrl = `${BASE_URL ?? `http://${req.headers.host}`}/${result.code}`;
      return sendJson(res, status, result);
    }

    const code = pathname.slice(1);
    if (req.method === 'GET' && CODE_PATTERN.test(code)) {
      const link = findByCode.get(code);
      if (link) {
        countClick.run(link.code);
        res.writeHead(302, { Location: link.url, 'Cache-Control': 'no-store' });
        return res.end();
      }
    }

    send(res, 404, NOT_FOUND_HTML, 'text/html; charset=utf-8');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

server.listen(PORT, () => console.log(`URL shortener running at http://localhost:${PORT}`));
