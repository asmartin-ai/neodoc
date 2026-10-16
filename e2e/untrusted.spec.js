// 4. Untrusted documents. A document can arrive from anyone: downloaded, mailed,
// pasted from a wiki. `fmt` keeps whatever is in the file (that is the format's
// promise) and `lint` reports what is outside the vocabulary, so the editor — the
// only component that puts a document into a live DOM — refuses to load a document
// whose own elements would run script, fetch a stylesheet or retarget URLs.
//
// The assertions are about side effects, not about messages: a script that sets a
// global must find that global undefined, and an executable link must not run.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  CLI, SERVERLESS_EDITOR, expectClean, freePort, stagedFixture, tmpDir, waitForServer, watchPage,
} from './helpers.js';

/** Children started by this worker, killed in afterAll whatever the test did. */
const children = new Set();

test.afterAll(() => {
  for (const child of children) child.kill();
  children.clear();
});

const harness = (body, extra = '') => `<!doctype html>
<html data-neodoc="1" lang="en">
  <head>
    <meta charset="utf-8">
    <title>Invoice</title>
    <meta content="neodoc 1.0.0" name="generator">
  </head>
  <body>
${body}
${extra}  </body>
</html>
`;

const SCRIPT_DOC = harness('    <p>Looks harmless.</p>', "    <script>window.__pwned = 'ran';</script>\n");
const LINK_DOC = harness('    <p><a href="javascript:window.__clicked = 1">click me</a></p>');

test('a served document cannot run its own script', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'invoice.nd.html');
  await writeFile(file, SCRIPT_DOC);
  const port = await freePort();
  const noise = watchPage(page);

  let stderr = '';
  const child = spawn(process.execPath, [CLI, 'serve', file, '--port', String(port)], { cwd: dir });
  children.add(child);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitForServer(port, child, () => stderr);

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !!window.neodocEditor);
  await expect(page.locator('#st-state')).toContainText(/refused/i);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator('body > script')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Looks harmless.');
  expectClean(noise);
});

test('an opened file cannot run its own script', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'invoice.nd.html');
  await writeFile(file, SCRIPT_DOC);
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);
  await expect(page.locator('#st-state')).toContainText(/refused/i);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expectClean(noise);
});

test('an executable link does not run, and a safe document still opens', async ({ page }) => {
  const dir = await tmpDir();
  const unsafe = join(dir, 'link.nd.html');
  await writeFile(unsafe, LINK_DOC);
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', unsafe);
  await expect(page.locator('body > p a')).toHaveText('click me');
  await page.locator('body > p a').click();
  expect(await page.evaluate(() => window.__clicked)).toBeUndefined();
  await expect(page.locator('#st-state')).toContainText(/executable URL/i);

  // Control: the refusal is about executable content, not about opening documents.
  const safe = await stagedFixture(dir);
  await page.setInputFiles('#open-input', safe);
  await expect(page.locator('#st-state')).toContainText(/opened basic\.nd\.html/i);
  await expect(page.locator('body > h1')).toHaveText('Basic formatting');
  expectClean(noise);
});

test('a nested <head> in the body cannot smuggle a script past the refusal', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'nested-head.nd.html');
  // Contradictory HTML, and `fmt` keeps it as written. Skipping any element *named*
  // `head` (the first version of the check) skipped this whole subtree with it.
  await writeFile(file, harness(`    <head><script>window.__pwned = 'ran';</script></head>
    <p>Looks harmless.</p>`));
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);
  await expect(page.locator('#st-state')).toContainText(/refused/i);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.body.querySelectorAll('script').length)).toBe(0);
  expectClean(noise);
});

test('a document cannot retarget the editor page through its head', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'refresh.nd.html');
  // `meta[http-equiv=refresh]` survives `fmt` (it needs a `name`) and, adopted into the
  // editor's head, navigated the page away — a fetch to wherever it pointed.
  await writeFile(file, `<!doctype html>
<html data-neodoc="1" lang="en">
  <head>
    <meta charset="utf-8">
    <title>Invoice</title>
    <meta content="neodoc 1.0.0" name="generator">
    <meta name="refresh" http-equiv="refresh" content="0;url=http://127.0.0.1:9/evil">
  </head>
  <body>
    <p>Looks harmless.</p>
  </body>
</html>
`);
  const outside = [];
  page.on('request', (req) => { if (!req.url().startsWith('file:')) outside.push(req.url()); });
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);
  await expect(page.locator('body > p')).toHaveText('Looks harmless.');
  await page.waitForTimeout(400); // a refresh would have fired by now
  expect(page.url()).toContain('neodoc-editor.html');
  expect(outside.filter((u) => !u.includes('/doc'))).toEqual([]);
  expectClean(noise);
});
