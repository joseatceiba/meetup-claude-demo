import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { openDb } from './db.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 7;
const CODE_PATTERN = new RegExp(`^/([A-Za-z0-9]{${CODE_LENGTH}})$`);
const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 10 * 1024;

// Fixed allowlist: nothing outside this table can ever be served from disk.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'",
};

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function sendNotFound(res) {
  send(
    res,
    404,
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Not found</title><body style="font-family:system-ui,sans-serif;text-align:center;margin-top:20vh">' +
      '<h1>Link not found</h1><p><a href="/">Create a short link</a></p></body>',
    { 'Content-Type': 'text/html; charset=utf-8' },
  );
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Returns { url } with the normalized URL, or { error } with a user-facing message.
function validateUrl(input, ownHosts) {
  if (typeof input !== 'string' || !input.trim()) return { error: 'Please enter a URL.' };
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) return { error: `URL is too long (max ${MAX_URL_LENGTH} characters).` };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: 'That doesn’t look like a valid URL. Include http:// or https://.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http:// and https:// links can be shortened.' };
  }
  if (ownHosts.has(parsed.host)) return { error: 'That link already points to this shortener.' };
  return { url: parsed.href };
}

async function handleShorten(req, res, db, ownHosts, baseUrl) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    if (err.status === 413) return sendJson(res, 413, { error: 'Request too large.' });
    return sendJson(res, 400, { error: 'Request body must be JSON.' });
  }

  const result = validateUrl(payload?.url, ownHosts);
  if (result.error) return sendJson(res, 400, { error: result.error });

  const existing = db.findByUrl(result.url);
  const code = existing ?? newCode(db);
  if (!existing) db.insert(code, result.url);

  sendJson(res, existing ? 200 : 201, { code, shortUrl: `${baseUrl}/${code}` });
}

// The server is single-threaded and node:sqlite is synchronous, so checking
// before inserting cannot race with another request.
function newCode(db) {
  let code;
  do code = generateCode();
  while (db.findByCode(code));
  return code;
}

export function createServer({ dbPath = process.env.DB_PATH ?? join(ROOT, 'data', 'links.db'), baseUrl = process.env.BASE_URL } = {}) {
  const db = openDb(dbPath);
  const configuredBase = baseUrl?.replace(/\/+$/, '');

  const server = createHttpServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const isRead = req.method === 'GET' || req.method === 'HEAD';

      const hostHeader = req.headers.host?.toLowerCase() ?? 'localhost';
      const ownHosts = new Set([hostHeader]);
      if (configuredBase) ownHosts.add(new URL(configuredBase).host);
      const base = configuredBase ?? `http://${hostHeader}`;

      if (req.method === 'POST' && pathname === '/api/shorten') {
        return await handleShorten(req, res, db, ownHosts, base);
      }

      if (isRead && Object.hasOwn(STATIC_FILES, pathname)) {
        const [file, type] = STATIC_FILES[pathname];
        return send(res, 200, await readFile(join(PUBLIC_DIR, file)), { 'Content-Type': type });
      }

      const match = isRead && CODE_PATTERN.exec(pathname);
      if (match) {
        const target = db.findByCode(match[1]);
        if (target) return send(res, 302, '', { Location: target });
      }

      sendNotFound(res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
      else res.end();
    }
  });

  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log(`URL shortener running at http://localhost:${port}`));
}
