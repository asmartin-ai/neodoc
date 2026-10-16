// 6. Images: insert one, and save a document that still satisfies the format.
//
// `<img src="data:…">` is the only way a document stays self-contained (SPEC §3),
// and it is a large base64 blob going through the canonicalizer, so it is worth
// asserting end to end rather than only in the Node tests: the data URI must reach
// the document unchanged and the saved file must still pass `fmt --check`.

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { IMAGE_FIXTURE, SERVERLESS_EDITOR, downloadText, expectCanonical, tmpDir } from './helpers.js';

test('inserts an image as a data URI that survives a canonical save', async ({ page }) => {
  const dir = await tmpDir();

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);

  await page.locator('body > p').first().click();
  await page.keyboard.type('With an image: ');

  // "embed images" is on by default, so the file becomes a data URI in the document.
  await page.setInputFiles('#image-input', IMAGE_FIXTURE);

  const image = page.locator('body img');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute('alt', 'tiny');
  const src = await image.getAttribute('src');
  expect(src.startsWith('data:image/png;base64,')).toBe(true);
  expect(src.slice('data:image/png;base64,'.length)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('button[data-cmd="save"]').click(),
  ]);
  const saved = await downloadText(download);
  expect(saved).toContain(`src="${src}"`);
  expect(saved).toContain('alt="tiny"');
  await expectCanonical(saved, join(dir, 'image.nd.html'));
});
