// `neodoc serve FILE` — local/online rendering + edit loop.
// The document renders statically in any browser; this server only exists so the
// editor can load and save in place without the File System Access API.

import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `open`/`start`/`xdg-open`: the one OS-specific bit in the whole tool. */
function opener(url) {
  const [cmd, prefix] = process.platform === 'darwin' ? ['open', []]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '']]
      : ['xdg-open', []];
  spawn(cmd, [...prefix, url], { detached: true, stdio: 'ignore' }).unref();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function serve({ file, port = 8765, open = false }) {
  const root = process.cwd();
  const assets = resolve(fileURLToPath(new URL('..', import.meta.url))); // the neodoc install (editor/, src/)
  const server = createServer((req, res) => handle(req, res, { root, assets, file }));
  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/`;
      process.stdout.write(`neodoc serving ${file}\n  ${url}\n`);
      if (open) opener(url);
      ok(server);
    });
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    // A 404 here is logged as a console error by branded Chrome/Edge; the editor
    // has no icon, so answer politely instead of failing every clean-console test.
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/doc') return await doc(req, res, ctx);
    if (url.pathname === '/save' && req.method === 'POST') return await save(req, res, ctx);
    // `/` must land on the editor *page*, not on the editor's HTML served at the
    // document root: the page's own relative URLs (`editor.css`, `editor.js`) then
    // resolve under /editor/ and are found in the install dir.
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/editor/index.html' });
      return res.end();
    }
    const rel = url.pathname;
    // editor/ and src/ come from the neodoc install; everything else is relative
    // to the served document so a doc's own images and attachments work.
    const base = /^\/(editor|src)\//.test(rel) ? ctx.assets : dirname(ctx.file ?? join(ctx.root, 'x'));
    const path = safeJoin(base, rel);
    if (!path) return send(res, 403, 'outside project');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, String(e.message ?? e));
  }
}

async function doc(req, res, ctx) {
  const path = ctx.file ?? safeJoin(ctx.root, new URL(req.url, 'http://x').searchParams.get('path') ?? '');
  if (!path) return send(res, 403, 'outside project');
  const text = await readFile(path, 'utf8');
  send(res, 200, JSON.stringify({
    path: ctx.file ? process.cwd() : '',
    name: path.split(sep).pop(),
    mode: /<style[\s>]/i.test(text) ? 'inline' : 'none',
    text,
  }), { 'content-type': TYPES['.json'] });
}

async function save(req, res, ctx) {
  const path = safeJoin(ctx.root, new URL(req.url, 'http://x').searchParams.get('path') ?? '');
  if (!path) return send(res, 403, 'outside project');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const tmp = `${path}.neodoc-${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
  send(res, 200, JSON.stringify({ ok: true, bytes: Buffer.byteLength(text) }), { 'content-type': TYPES['.json'] });
}

function safeJoin(root, rel) {
  const base = resolve(root);
  const path = resolve(base, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  return path === base || path.startsWith(base + sep) ? path : null;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
