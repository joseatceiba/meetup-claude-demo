import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';

let server;
let base;
let tmp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'shortener-'));
  server = createServer({ dbPath: join(tmp, 'test.db') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

const shorten = (url) =>
  fetch(`${base}/api/shorten`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

test('shortens a URL and redirects to it', async () => {
  const res = await shorten('https://example.com/some/long/path?x=1');
  assert.equal(res.status, 201);
  const { code, shortUrl } = await res.json();
  assert.match(code, /^[A-Za-z0-9]{7}$/);
  assert.equal(shortUrl, `${base}/${code}`);

  const redirect = await fetch(shortUrl, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/some/long/path?x=1');
});

test('shortening the same URL twice returns the same code', async () => {
  const first = await (await shorten('https://example.com/same')).json();
  const secondRes = await shorten('https://example.com/same');
  assert.equal(secondRes.status, 200);
  assert.equal((await secondRes.json()).code, first.code);
});

test('rejects invalid input', async () => {
  const cases = [
    'not a url',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/file',
    '',
    `https://example.com/${'a'.repeat(2100)}`,
    base + '/abcdefg',
  ];
  for (const input of cases) {
    const res = await shorten(input);
    assert.equal(res.status, 400, `expected 400 for ${input.slice(0, 40)}`);
    assert.ok((await res.json()).error);
  }
});

test('rejects a non-JSON body', async () => {
  const res = await fetch(`${base}/api/shorten`, { method: 'POST', body: 'url=https://example.com' });
  assert.equal(res.status, 400);
});

test('rejects an oversized body', async () => {
  const res = await shorten('https://example.com/' + 'a'.repeat(20 * 1024));
  assert.equal(res.status, 413);
});

test('unknown codes return 404', async () => {
  const res = await fetch(`${base}/zzzzzzz`, { redirect: 'manual' });
  assert.equal(res.status, 404);
  const other = await fetch(`${base}/not-a-code`, { redirect: 'manual' });
  assert.equal(other.status, 404);
});

test('serves the page and assets', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Shorten a link/);

  for (const path of ['/styles.css', '/app.js']) {
    assert.equal((await fetch(base + path)).status, 200);
  }
});
