// `neodoc serve` is optional, but the served editor page must actually boot: the
// page's own relative asset URLs resolve under /editor/, not at the document root.
// Nothing in the browser-free test suite caught that until this test existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { serve } from '../src/serve.js';
import { format } from '../src/format.js';

test('serve routes the editor page, its assets and the document', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'neodoc-serve-'));
  const file = join(dir, 'doc.nd.html');
  writeFileSync(file, format('<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>', { style: 'inline' }).text);

  const server = await serve({ file, port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302, '`/` must point at the editor page, not serve it at the root');
  assert.equal(root.headers.get('location'), '/editor/index.html');

  for (const path of ['/editor/index.html', '/editor/editor.js', '/editor/editor.css', '/src/format.js']) {
    assert.equal((await fetch(base + path)).status, 200, `${path} must be served from the install`);
  }

  assert.equal((await fetch(`${base}/favicon.ico`)).status, 204, 'no favicon 404: branded browsers log it as a console error');

  const doc = await fetch(`${base}/doc`);
  assert.equal(doc.status, 200);
  assert.equal((await doc.json()).name, 'doc.nd.html');

  const saved = await fetch(`${base}/save?path=doc.nd.html`, { method: 'POST', body: '<!doctype html>\n' });
  assert.equal(saved.status, 200);
  assert.ok((await saved.json()).bytes > 0);

  assert.equal((await fetch(`${base}/../../etc/passwd`)).status, 404, 'path traversal must be refused');
});

test('serve refuses a document it cannot hand over intact', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'neodoc-serve-'));
  const file = join(dir, 'latin1.nd.html');
  const original = Buffer.concat([
    Buffer.from('<!doctype html><html><body><p>caf'),
    Buffer.from([0xe9]), // latin-1 'é': served as U+FFFD it would be written back that way
    Buffer.from('</p></body></html>'),
  ]);
  writeFileSync(file, original);

  const server = await serve({ file, port: 0 });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/doc`);
  assert.equal(res.status, 415, 'the editor must not be handed a decode that already lost bytes');
  assert.match((await res.json()).error, /not valid UTF-8/);
});

test('the loopback Host allow-list accepts a bracketed IPv6 form with a port', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'neodoc-serve-'));
  const file = join(dir, 'doc.nd.html');
  writeFileSync(file, format('<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>', { style: 'none' }).text);
  const server = await serve({ file, port: 0 });
  t.after(() => server.close());
  const port = server.address().port;
  const status = (host) => new Promise((resolve) => {
    // `fetch` cannot set Host, and these are all the same address.
    const req = http.request({ host: '127.0.0.1', port, path: '/doc', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.equal(await status(`[::1]:${port}`), 200, 'bracketed IPv6 with a port');
  assert.equal(await status('[::1]'), 200, 'bracketed IPv6 without one');
  assert.equal(await status(`127.0.0.1:${port}`), 200);
  assert.equal(await status(`evil.example:${port}`), 403);
});
