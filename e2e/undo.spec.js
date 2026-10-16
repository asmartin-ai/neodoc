// 7. The undo stack, from the user's side.
//
// Three things the browser's own history cannot do once a command has replaced the
// body: undo a structural edit without destroying text elsewhere, leave the caret
// where it can be typed into, and know whether the document is back to what was saved.

import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVERLESS_EDITOR, expectClean, tmpDir, watchPage } from './helpers.js';

const THREE = `<!doctype html>
<html data-neodoc="1" lang="en">
  <head>
    <meta charset="utf-8">
    <title>Three</title>
  </head>
  <body>
    <p>one</p>
    <p>two</p>
    <p>three</p>
  </body>
</html>
`;

const open = async (page, file) => {
  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);
};

test('after an undo the next keystroke lands in the block it was in', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'three.nd.html');
  writeFileSync(file, THREE);
  const noise = watchPage(page);
  await open(page, file);

  await page.locator('body > p').nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  await expect(page.locator('body > p')).toHaveCount(4);

  await page.keyboard.press('Control+z');
  await expect(page.locator('body > p')).toHaveCount(3);

  // The block the caret was in is gone; it must land in the block that is now in its
  // place, not loose in <body> (where the keystroke used to go nowhere) and not in the
  // first paragraph (where it used to land once the caret fell back to the body).
  await page.keyboard.type('y');
  // At the end of the block that took its place — not after "th", where a reused
  // offset from the vanished block used to land.
  await expect(page.locator('body > p').nth(2)).toHaveText('threey');
  await expect(page.locator('body > p').first()).not.toContainText('y');
  expectClean(noise);
});

test('a dropped fragment can be undone', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'three.nd.html');
  writeFileSync(file, THREE);
  const noise = watchPage(page);
  await open(page, file);

  // A drop lands at the caret, so the caret has to be somewhere sensible first.
  await page.locator('body > p').last().click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>DROPPED</p>');
    dt.setData('text/plain', 'DROPPED');
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('body')).toContainText('DROPPED');

  await page.keyboard.press('Control+z');
  await expect(page.locator('body')).not.toContainText('DROPPED');
  await expect(page.locator('body > p')).toHaveCount(3);
  expectClean(noise);
});

test('undo back to the saved state is not "unsaved"', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'three.nd.html');
  writeFileSync(file, THREE);
  const noise = watchPage(page);
  await open(page, file);

  await expect(page.locator('#st-dirty')).toHaveText('saved');
  await page.locator('body > p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('z');
  await expect(page.locator('#st-dirty')).toHaveText('unsaved');

  await page.keyboard.press('Control+z');
  await expect(page.locator('body > p').first()).toHaveText('one');
  await expect(page.locator('#st-dirty')).toHaveText('saved');
  expectClean(noise);
});

test('a quoted attribute on <html> survives an undo', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'attrs.nd.html');
  writeFileSync(file, `<!doctype html>
<html data-neodoc="1" lang="en" data-x="a&quot;b" title="a&quot;b">
  <head>
    <meta charset="utf-8">
    <title>Attrs</title>
  </head>
  <body>
    <p>alpha</p>
    <pre>code</pre>
  </body>
</html>
`);
  const noise = watchPage(page);
  await open(page, file);

  await page.locator('body > p').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');

  // The snapshot serializes the live page: interpolating attribute values by hand
  // truncated `a"b` to `a` and invented an attribute from the quote.
  const attrs = await page.evaluate(() => ({
    x: document.documentElement.getAttribute('data-x'),
    title: document.documentElement.getAttribute('title'),
    names: [...document.documentElement.attributes].map((a) => a.name).sort(),
  }));
  expect(attrs.x).toBe('a"b');
  expect(attrs.title).toBe('a"b');
  expect(attrs.names).toEqual(['data-neodoc', 'data-x', 'lang', 'title']);
  expectClean(noise);
});

test('an undo after a <pre> line break puts the caret back at the end', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'pre.nd.html');
  writeFileSync(file, `<!doctype html>
<html data-neodoc="1" lang="en">
  <head>
    <meta charset="utf-8">
    <title>Pre</title>
  </head>
  <body>
    <p>alpha</p>
    <pre>code</pre>
  </body>
</html>
`);
  const noise = watchPage(page);
  await open(page, file);

  await page.locator('pre').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); // leaves the caret at an element position
  await page.keyboard.press('Control+z');
  await page.keyboard.type('y');
  await expect(page.locator('pre')).toHaveText('codey');
  expectClean(noise);
});
