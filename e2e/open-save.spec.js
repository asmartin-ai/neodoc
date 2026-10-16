// 2. Open a real fixture through the hidden `#open-input` and save it.
//
// The guarantee under test is the compatibility contract of the whole project:
// the document on disk is what `neodoc fmt` would emit, byte for byte. The editor
// edits the live DOM, so the only way the saved bytes can be canonical is if Save
// runs them through the same `format()` the CLI runs. Two things are asserted:
//   - the saved text passes `neodoc fmt --check` (the CLI gate CI uses), and
//   - a non-canonical attribute put into the live DOM by browser code (not by the
//     user) is gone from the saved bytes — format() must have dropped it, which a
//     plain `outerHTML` write never would.

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import {
  FIXTURE_NAME, SERVERLESS_EDITOR, downloadText, expectCanonical, expectClean, stagedFixture, tmpDir, watchPage,
} from './helpers.js';

test('opens a fixture and saves canonical bytes (fmt --check)', async ({ page }) => {
  const dir = await tmpDir();
  const file = await stagedFixture(dir);
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);

  await page.setInputFiles('#open-input', file);

  // The status bar names the file it opened, and the document's own blocks are live.
  await expect(page.locator('#st-state')).toContainText(FIXTURE_NAME);
  await expect(page.locator('body > h1')).toHaveText('Basic formatting');

  // Edit the live DOM: a user click plus typing.
  await page.locator('body > h1').first().click();
  await page.keyboard.type('ZZEDIT');
  await expect(page.locator('body > h1')).toContainText('ZZEDIT');

  // And a browser-side attribute that the closed vocabulary does not allow.
  // Browser HTML must never reach the file; only format()'s output may.
  await page.evaluate(() => document.querySelector('body > h1').setAttribute('class', 'browser-html-not-a-format'));

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('button[data-cmd="save"]').click(),
  ]);

  expect(download.suggestedFilename()).toBe(FIXTURE_NAME);
  const saved = await downloadText(download);

  expect(saved).toContain('ZZEDIT');
  expect(saved).not.toContain('browser-html-not-a-format');
  expect(saved).not.toContain('class=');
  await expectCanonical(saved, join(dir, 'saved.nd.html'));
  // The saved name is the one the editor reports, so a user can find the file.
  await expect(page.locator('#st-state')).toContainText(FIXTURE_NAME);
  await expect(page.locator('#st-dirty')).toHaveText('saved');

  expectClean(noise);
});
