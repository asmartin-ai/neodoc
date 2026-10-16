// `neodoc serve FILE` — local/online rendering + edit loop.
// The document renders statically in any browser; this server only exists so the
// editor can load and save in place without the File System Access API.
//
// Threat model: the served document is often untrusted, and the server may be
// running while the user browses. It therefore binds loopback only, answers only
// to loopback Host names (DNS rebinding), accepts writes only from its own page
// (a drive-by page must not be able to overwrite files) and edits exactly one
// file — the one it was started with.

import { createServer } from 'node:http';
import { readFile, writeFile, rename, stat, chmod, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, resolve, sep } from 'node:path';
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

/** A document is text; anything past this is a mistake or a hostile client. */
const MAX_SAVE = 32 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Loopback `Host` only: without this, a DNS name that resolves to 127.0.0.1
 *  gives a hostile page the browser's own origin for `/doc`. */
function hostAllowed(host, port) {
  const text = String(host ?? '');
  const cut = text.startsWith('[') ? text.indexOf(']:') : text.lastIndexOf(':');
  const name = cut === -1 ? text : text.slice(0, cut + (text.startsWith('[') ? 1 : 0));
  const chosen = cut === -1 ? undefined : text.slice(cut + 1);
  return LOOPBACK.has(name.toLowerCase()) && (chosen === undefined || chosen === String(port));
}

/** Writes must come from this page. Browsers always send one of these headers on a
 *  cross-origin POST, and never send them from a non-browser client, so a local
 *  script still works while a drive-by page cannot blind-write the file. */
function sameOrigin(req, port) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin';
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const { hostname, port: p } = new URL(origin);
    return LOOPBACK.has(hostname.toLowerCase()) && (p === '' || p === String(port));
  } catch {
    return false;
  }
}

export function serve({ file, port = 8765, open = false }) {
  const root = process.cwd();
  const assets = resolve(fileURLToPath(new URL('..', import.meta.url))); // install dir (editor/, src/)
  const target = resolve(file);
  const ctx = { root, assets, target, port };
  const server = createServer((req, res) => handle(req, res, ctx));
  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(port, '127.0.0.1', () => {
      ctx.port = server.address().port; // `--port 0` means "pick one"; the Host check needs the real one
      const url = `http://127.0.0.1:${ctx.port}/`;
      process.stdout.write(`neodoc serving ${target}\n  ${url}\n`);
      if (open) opener(url);
      ok(server);
    });
  });
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, `http://127.0.0.1:${ctx.port}`);
  try {
    if (!hostAllowed(req.headers.host, ctx.port)) return send(res, 403, 'host not allowed');
    // A 404 here is logged as a console error by branded Chrome/Edge; the editor
    // has no icon, so answer politely instead of failing every clean-console test.
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/doc') return await doc(req, res, ctx);
    if (url.pathname === '/save') {
      if (req.method !== 'POST') return send(res, 404, 'not found');
      if (!sameOrigin(req, ctx.port)) return send(res, 403, 'cross-origin write refused');
      return await save(req, res, ctx);
    }
    // `/` must land on the editor *page*, not on the editor's HTML served at the
    // document root: the page's own relative URLs (`editor.css`, `editor.js`) then
    // resolve under /editor/ and are found in the install dir.
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/editor/index.html' });
      return res.end();
    }
    // editor/ and src/ come from the neodoc install; everything else is relative
    // to the served document so a doc's own images and attachments work.
    const base = /^\/(editor|src)\//.test(url.pathname) ? ctx.assets : dirname(ctx.target);
    const path = await safeFile(base, url.pathname);
    if (!path) return send(res, 403, 'outside project');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, String(e.message ?? e));
  }
}

async function doc(req, res, ctx) {
  const text = await readFile(ctx.target, 'utf8');
  send(res, 200, JSON.stringify({
    path: '',
    name: basename(ctx.target),
    mode: /<style[\s>]/i.test(text) ? 'inline' : 'none',
    text,
  }), { 'content-type': TYPES['.json'] });
}

/** Writes the served file and nothing else: `?path=` is accepted and ignored, so a
 *  client cannot name a different file (or a file outside the document's tree). */
async function save(req, res, ctx) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_SAVE) return send(res, 413, 'document too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SAVE) return send(res, 413, 'document too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const mode = await stat(ctx.target).then((s) => s.mode & 0o777).catch(() => 0o644);
  const tmp = `${ctx.target}.neodoc-${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, { flag: 'wx', mode: 0o600 });
    await chmod(tmp, mode);
    await rename(tmp, ctx.target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  send(res, 200, JSON.stringify({ ok: true, bytes: Buffer.byteLength(text) }), { 'content-type': TYPES['.json'] });
}

/** Resolve `rel` inside `base`, following symlinks, refusing anything outside it:
 *  a symlink committed to a repository must not read `/etc` or write elsewhere. */
async function safeFile(base, rel) {
  try {
    const within = await realpath(resolve(base));
    const lexical = safeJoin(within, rel);
    if (!lexical) return null;
    try {
      const real = await realpath(lexical);
      return real === within || real.startsWith(within + sep) ? real : null;
    } catch (e) {
      if (e.code !== 'ENOENT') return null;
      // Nothing there: the request should 404, not 403, but a symlinked ancestor
      // directory would still escape, so check the nearest one that exists.
      const dir = await realAncestor(dirname(lexical));
      return dir && (dir === within || dir.startsWith(within + sep)) ? lexical : null;
    }
  } catch {
    return null;
  }
}

/** `realpath` of the nearest existing ancestor, or null. */
async function realAncestor(path) {
  let probe = path;
  for (;;) {
    try {
      return await realpath(probe);
    } catch (e) {
      if (e.code !== 'ENOENT') return null;
      const up = dirname(probe);
      if (up === probe) return null;
      probe = up;
    }
  }
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
