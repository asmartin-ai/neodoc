// `neodoc serve FILE` — local/online rendering + edit loop.
// The document renders statically in any browser; this server only exists so the
// editor can load and save in place without the File System Access API.

import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, resolve, sep } from 'node:path';

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
  const server = createServer((req, res) => handle(req, res, { root, file }));
  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/`;
      process.stdout.write(`neodoc serving ${file}\n  ${url}\n`);
      if (open) spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      ok(server);
    });
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/doc') return await doc(req, res, ctx);
    if (url.pathname === '/save' && req.method === 'POST') return await save(req, res, ctx);
    const rel = url.pathname === '/' ? '/editor/index.html' : url.pathname;
    const path = safeJoin(ctx.root, rel);
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
  const path = resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  return path === root || path.startsWith(root + sep) ? path : null;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
