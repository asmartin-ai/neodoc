// 5. Fallbacks — the fork / old-build guarantee, in every engine.
//
// Brands and hardened builds share an engine but not its optional APIs: Firefox
// has no File System Access API, Safari's support arrived late, Brave and Tor
// remove or gate things, and older builds may lack `CompressionStream` or
// `navigator.clipboard`. None of that may break the editor. Before the page loads
// these specs delete those APIs, then assert the whole user path still works —
// boot, open a file, edit, save as a download, and the Copy CLI command degrading
// to a message instead of an exception.

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import {
  FIXTURE_NAME, SERVERLESS_EDITOR, downloadText, expectCanonical, expectClean, stagedFixture, tmpDir, watchPage,
} from './helpers.js';

/** Delete the optional APIs before any editor code runs. */
async function withoutOptionalApis(page) {
  await page.addInitScript(() => {
    const remove = (target, name) => {
      try { delete target[name]; } catch { /* prototype getters are not deletable */ }
      try { Object.defineProperty(target, name, { configurable: true, get: () => undefined }); } catch { /* already gone */ }
    };
    remove(window, 'showSaveFilePicker');
    remove(window, 'showOpenFilePicker');
    remove(navigator, 'clipboard');
    remove(window, 'CompressionStream');
  });
}

test('boots, opens, edits and saves as a download without the optional APIs', async ({ page }) => {
  const dir = await tmpDir();
  const file = await stagedFixture(dir);
  const noise = watchPage(page);
  await withoutOptionalApis(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);

  // The deletion really happened — otherwise this spec proves nothing.
  await page.waitForFunction(() => !window.showSaveFilePicker && !window.showOpenFilePicker
    && !navigator.clipboard && !window.CompressionStream);
  await expect(page.locator('#toolbar')).toBeVisible();

  await page.setInputFiles('#open-input', file);
  await expect(page.locator('#st-state')).toContainText(FIXTURE_NAME);

  await page.locator('body > h1').first().click();
  await page.keyboard.type('Fallbackedit');
  await expect(page.locator('body > h1')).toContainText('Fallbackedit');

  // No file handle and no server: Save must fall back to a download whose name is
  // the name of the file that was opened.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('button[data-cmd="save"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe(FIXTURE_NAME);
  const saved = await downloadText(download);
  expect(saved).toContain('Fallbackedit');
  await expectCanonical(saved, join(dir, 'downloaded.nd.html'));
  await expect(page.locator('#st-dirty')).toHaveText('saved');

  // Copy CLI without `navigator.clipboard` must report, not throw.
  await page.locator('button[data-cmd="copy-cli"]').click();
  await expect(page.locator('#toolbar')).toBeVisible();

  expectClean(noise);
});

test('the Open button falls through to the hidden file input', async ({ page }) => {
  const dir = await tmpDir();
  const file = await stagedFixture(dir);
  const noise = watchPage(page);
  await withoutOptionalApis(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !window.showOpenFilePicker);
  await page.waitForFunction(() => !!window.neodocEditor);

  // With no picker, `openFile()` clicks `#open-input`; the chooser is that input.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('button[data-cmd="open"]').click(),
  ]);
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles(file);

  await expect(page.locator('#st-state')).toContainText(FIXTURE_NAME);
  await expect(page.locator('body > h1')).toHaveText('Basic formatting');

  expectClean(noise);
});
