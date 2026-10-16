// Shared plumbing for the e2e specs: paths, temp dirs, the CLI assertion, and the
// one piece of browser noise the specs have to understand.
//
// Console noise: the editor probes its two optional server endpoints (`GET /doc`
// at boot, `POST /save` on save) and is *designed* to fall back when they fail.
// From a `file://` URL they always fail, and engines report it differently —
// Chromium logs `Fetch API cannot load file:///doc. URL scheme "file" is not
// supported.`, Firefox logs nothing (the rejection is caught). The specs therefore
// ignore console errors that name those two endpoints, and fail on every other
// console error and every uncaught page error. Ignored lines are kept in the
// record so a failing test can print what it decided to ignore.

import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'bin', 'neodoc.js');
export const SERVERLESS_EDITOR = pathToFileURL(join(ROOT, 'editor', 'neodoc-editor.html')).href;
export const IMAGE_FIXTURE = join(ROOT, 'e2e', 'tiny.png');
export const FIXTURE_NAME = 'basic.nd.html';

/** `GET /doc` and `POST /save` are the only endpoints the editor ever probes. */
const PROBE_NOISE = /\/(?:doc|save)\b/;

/** A fresh temp dir per test, so no test can see another one's files. */
export const tmpDir = () => mkdtemp(join(tmpdir(), 'neodoc-e2e-'));

/** Copy `fixtures/<name>` into `dir` and return the absolute path to the copy. */
export async function stagedFixture(dir, name = FIXTURE_NAME) {
  const path = join(dir, name);
  await copyFile(join(ROOT, 'fixtures', name), path);
  return path;
}

/**
 * Record everything a page says, splitting console errors into the ignored probe
 * noise and the real ones. Attach before `page.goto()`.
 */
export function watchPage(page) {
  const record = { consoleErrors: [], pageErrors: [], requests: [], ignored: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    (PROBE_NOISE.test(msg.text()) ? record.ignored : record.consoleErrors).push(msg.text());
  });
  page.on('pageerror', (err) => record.pageErrors.push(String(err)));
  page.on('request', (req) => record.requests.push(req.url()));
  return record;
}

/** Fail unless the page produced no uncaught error and no unexpected console error. */
export function expectClean(record) {
  expect(record.pageErrors, `uncaught page errors: ${record.pageErrors.join(' | ')}`).toEqual([]);
  expect(record.consoleErrors, `unexpected console errors: ${record.consoleErrors.join(' | ')}`).toEqual([]);
}

/** Run the CLI and return its exit code plus combined output. */
function cli(...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * Write `text` to `file` and assert the CLI considers it byte-canonical.
 * This is the guarantee under test: whatever the editor wrote must be exactly what
 * `neodoc fmt` would emit, so `fmt --check` (the CI gate) accepts it.
 */
export async function expectCanonical(text, file) {
  await writeFile(file, text);
  const { status, output } = cli('fmt', '--check', file);
  expect(status, `neodoc fmt --check ${file} exited ${status}:\n${output}\n--- saved bytes ---\n${text.slice(0, 4000)}`).toBe(0);
}

/** Read a Playwright download to text (fails loudly when the download never landed). */
export async function downloadText(download) {
  const path = await download.path();
  expect(path, 'download has no local path').not.toBeNull();
  return readFile(path, 'utf8');
}

/** An unused 127.0.0.1 port. */
export function freePort() {
  return new Promise((ok, no) => {
    const probe = createServer();
    probe.on('error', no);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/** Wait until the spawned `neodoc serve` answers `GET /doc` (no fixed sleeps). */
export async function waitForServer(port, child, stderr) {
  const url = `http://127.0.0.1:${port}/doc`;
  const deadline = Date.now() + 20_000;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`neodoc serve exited early (code ${child.exitCode})\n${stderr()}`);
    }
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`neodoc serve on 127.0.0.1:${port} never answered /doc (last: ${last})\n${stderr()}`);
}
