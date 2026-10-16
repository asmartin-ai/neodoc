// 3. Served mode: `neodoc serve FILE` as a real child process.
//
// This is the optional convenience path — in-place saving in browsers without the
// File System Access API (Firefox, Safari, any hardened build) plus live reload.
// The editor auto-detects it through `GET /doc` and saves through `POST /save`, so
// the assertion is about bytes on disk, not about what the page displays.
//
// The server binds 127.0.0.1 only and edits exactly the file it was started with,
// so the document copy lives in a per-test temp dir and the child is spawned there.

import { spawn } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  CLI, FIXTURE_NAME, expectCanonical, expectClean, freePort, stagedFixture, tmpDir, waitForServer, watchPage,
} from './helpers.js';

/** Children started by this worker, killed in afterAll whatever the test did. */
const children = new Set();

test.afterAll(() => {
  for (const child of children) child.kill();
  children.clear();
});

test('serves a document, edits it, and saves it in place', async ({ page }) => {
  const dir = await tmpDir();
  const file = await stagedFixture(dir);
  const port = await freePort();
  const noise = watchPage(page);

  let stderr = '';
  const child = spawn(process.execPath, [CLI, 'serve', file, '--port', String(port)], { cwd: dir });
  children.add(child);
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', () => {});

  try {
    await waitForServer(port, child, () => stderr);

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => !!window.neodocEditor);

    // The editor found the served document: its name is in the status bar.
    await expect(page.locator('#st-state')).toContainText(FIXTURE_NAME);
    await expect(page.locator('body > h1')).toHaveText('Basic formatting');

    await page.locator('body > h1').first().click();
    await page.keyboard.type('Servededit');
    await expect(page.locator('#st-dirty')).toHaveText('unsaved');

    await page.locator('button[data-cmd="save"]').click();

    // No download, no fallback: the page posted the bytes to the server.
    await expect(page.locator('#st-state')).toContainText('posted');
    await expect(page.locator('#st-state')).toContainText(FIXTURE_NAME);
    await expect(page.locator('#st-dirty')).toHaveText('saved');

    // A second save must reach the file too: the page compares the revision the server
    // gave it, and used to send back the one from *load* time, so every save after the
    // first was refused as stale and silently became a download. (Before the checks
    // below, because they rewrite the file to test canonicality, which legitimately
    // makes the page's revision stale.)
    // No caret gymnastics: where the click lands differs between engines (`End` does not
    // move the caret in macOS WebKit), and what matters is that the second save reaches
    // the file at all.
    const beforeSecond = await readFile(file, 'utf8');
    await page.locator('body > h1').first().click();
    await page.keyboard.type('AGAIN');
    await page.locator('button[data-cmd="save"]').click();
    await expect(page.locator('#st-dirty')).toHaveText('saved');
    const afterSecond = await readFile(file, 'utf8');
    expect(afterSecond).not.toBe(beforeSecond); // a download fallback would leave it alone
    expect(afterSecond).toContain('AGAIN');

    const onDisk = await readFile(file, 'utf8');
    expect(onDisk).toContain('Servededit');
    expect(onDisk).toContain('AGAIN');
    await expectCanonical(onDisk, file);

    expectClean(noise);
  } finally {
    child.kill();
    children.delete(child);
  }
});
