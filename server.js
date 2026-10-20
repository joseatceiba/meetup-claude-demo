'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'links.db');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const MAX_BODY_BYTES = 8 * 1024;
const MAX_URL_LENGTH = 2048;
const CODE_LENGTH = 6;
const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // codes are case-insensitive; skip look-alikes (l, 1, 0)
const CUSTOM_CODE_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const RESERVED = new Set(['api', 'favicon.ico', 'robots.txt', 'index.html']);

// --- Database ---------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
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

const stmt = {
  byCode: db.prepare('SELECT code, url FROM links WHERE code = ?'),
  existingRandom: db.prepare('SELECT code FROM links WHERE url = ? AND is_custom = 0 LIMIT 1'),
  insert: db.prepare('INSERT INTO links (code, url, is_custom) VALUES (?, ?, ?)'),
  click: db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?'),
};

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

function isUniqueViolation(err) {
  return err && /UNIQUE constraint failed/.test(err.message);
}

// --- Validation -------------------------------------------------------------

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let raw = input.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;
  // Be forgiving: "example.com/foo" -> "https://example.com/foo"
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = 'https://' + raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) return null;
  return parsed.href;
}

// --- HTTP helpers -----------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function notFoundPage(code) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link not found</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box;
         background: Canvas; color: CanvasText; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; } p { opacity: .7; margin: 0 0 24px; }
  code { padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, CanvasText 10%, transparent); }
  a { color: #4f46e5; font-weight: 600; text-decoration: none; }
</style></head><body><main>
<h1>Link not found</h1>
<p>No short link exists for <code>/${escapeHtml(code)}</code>.</p>
<a href="/">&larr; Shorten a URL</a>
</main></body></html>`;
}

// --- Routes -----------------------------------------------------------------

async function handleShorten(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }

  const url = normalizeUrl(body.url);
  if (!url) return sendJson(res, 400, { error: "That doesn't look like a valid http(s) URL." });

  const custom = typeof body.code === 'string' ? body.code.trim() : '';
  const base = baseUrl(req);

  if (custom) {
    if (!CUSTOM_CODE_RE.test(custom) || RESERVED.has(custom.toLowerCase())) {
      return sendJson(res, 400, { error: 'Custom alias must be 3–32 letters, numbers, - or _.' });
    }
    const existing = stmt.byCode.get(custom);
    if (existing) {
      if (existing.url === url) return sendJson(res, 200, { code: existing.code, url, shortUrl: `${base}/${existing.code}` });
      return sendJson(res, 409, { error: 'That alias is already taken. Try another.' });
    }
    try {
      stmt.insert.run(custom, url, 1);
    } catch (err) {
      if (isUniqueViolation(err)) return sendJson(res, 409, { error: 'That alias is already taken. Try another.' });
      throw err;
    }
    return sendJson(res, 201, { code: custom, url, shortUrl: `${base}/${custom}` });
  }

  const reuse = stmt.existingRandom.get(url);
  if (reuse) return sendJson(res, 200, { code: reuse.code, url, shortUrl: `${base}/${reuse.code}` });

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode();
    try {
      stmt.insert.run(code, url, 0);
      return sendJson(res, 201, { code, url, shortUrl: `${base}/${code}` });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return sendJson(res, 500, { error: 'Could not generate a unique code. Please try again.' });
}

function handleRedirect(req, res, code) {
  const row = stmt.byCode.get(code);
  if (!row) {
    return send(res, 404, notFoundPage(code), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (req.method === 'GET') stmt.click.run(row.code);
  send(res, 302, null, { Location: row.url, 'Cache-Control': 'no-store' });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/shorten') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      return await handleShorten(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/' || pathname === '/index.html') {
      return send(res, 200, INDEX_HTML, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (pathname === '/favicon.ico') return send(res, 204, null);

    let code;
    try {
      code = decodeURIComponent(pathname.slice(1));
    } catch {
      code = '';
    }
    if (code && !code.includes('/')) return handleRedirect(req, res, code);

    return send(res, 404, notFoundPage(pathname.slice(1)), { 'Content-Type': 'text/html; charset=utf-8' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`URL shortener running at http://localhost:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
