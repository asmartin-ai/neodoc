// 6. A command that rebuilds the body must leave the caret where it was.
//
// Every command goes through `mutate()`, which serializes the live DOM, changes the
// tree and replaces the whole body. The replacement used to take the selection with
// it: after clicking Accept the caret sat at (body, 0), so the next keystroke went
// nowhere and Enter inserted a block before the paragraph the user was in.

import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVERLESS_EDITOR, expectClean, tmpDir, watchPage } from './helpers.js';

const DOC = `<!doctype html>
<html data-neodoc="1" lang="en">
  <head>
    <meta charset="utf-8">
    <title>Changes</title>
  </head>
  <body>
    <h1>Changes</h1>
    <p>The price is <del data-author="ada" data-at="2026-10-16T10:00:00Z">ten</del><ins data-author="ada" data-at="2026-10-16T10:00:00Z">twenty</ins> dollars.</p>
    <p>Second paragraph.</p>
  </body>
</html>
`;

test('a command leaves the caret in its block, not at the top of the body', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'changes.nd.html');
  writeFileSync(file, DOC);
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);
  await expect(page.locator('body > h1')).toHaveText('Changes');

  // Caret at the start of the changed paragraph, then fold the change.
  await page.locator('body > p').first().click();
  await page.keyboard.press('Home');
  await page.locator('button[data-cmd="accept"]').click();
  await expect(page.locator('body > p').first()).toContainText('twenty dollars');

  await page.keyboard.type('MORE');
  await expect(page.locator('body > p').first()).toContainText('MORE');
  await expect(page.locator('body > h1')).not.toContainText('MORE');
  await expect(page.locator('body > p')).toHaveCount(2);

  expectClean(noise);
});

test('Ctrl+Z undoes a structural edit instead of deleting text from another block', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'changes.nd.html');
  writeFileSync(file, DOC);
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);
  await page.locator('body > h1').click();
  await page.keyboard.press('End');
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(page.locator('body > p')).toHaveCount(3);

  // The browser's own undo history is stale after the editor moves nodes: it used to
  // delete characters from the heading rather than undo the Enter.
  await page.keyboard.press('Control+z');
  await expect(page.locator('body > p')).toHaveCount(2);
  await expect(page.locator('body > h1')).toHaveText('Changesabc');

  await page.keyboard.press('Control+z');
  await expect(page.locator('body > h1')).toHaveText('Changes');

  await page.keyboard.press('Control+z');
  await expect(page.locator('body > h1')).toHaveText('Changes');
  await expect(page.locator('#st-state')).toContainText('nothing to undo');

  expectClean(noise);
});

test('Ctrl+Z brings a folded change back', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'changes.nd.html');
  writeFileSync(file, DOC);
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);
  const price = page.locator('body > p').filter({ hasText: 'The price' });
  await price.click();
  await page.locator('button[data-cmd="accept"]').click();
  await expect(price).toContainText('The price is twenty dollars.');

  await page.keyboard.press('Control+z');
  await expect(price).toContainText('tentwenty');

  expectClean(noise);
});

test('a block command keeps a list item a list item', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'list.nd.html');
  writeFileSync(file, `<!doctype html>
<html data-neodoc="1" lang="en">
  <head><meta charset="utf-8"><title>List</title></head>
  <body><ul><li>x</li></ul></body>
</html>
`);
  const noise = watchPage(page);
  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);

  await page.locator('li').click();
  await page.locator('button[data-cmd="h1"]').click();
  // Renaming the item produced `<ul><h1>x</h1></ul>`, whose markdown export is empty.
  expect(await page.evaluate(() => document.querySelector('ul').outerHTML)).toBe('<ul><li><h1>x</h1></li></ul>');
  const md = await page.evaluate(() => window.neodocEditor.canonicalText().text);
  expect(md).toContain('<li>');
  expect(md).toContain('<h1>');
  expectClean(noise);
});

test('an inline command refuses a selection that spans blocks', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'two.nd.html');
  writeFileSync(file, `<!doctype html>
<html data-neodoc="1" lang="en">
  <head><meta charset="utf-8"><title>Two</title></head>
  <body><p>alpha</p><p>beta</p></body>
</html>
`);
  const noise = watchPage(page);
  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);

  await page.evaluate(() => {
    const ps = document.querySelectorAll('body > p');
    const r = document.createRange();
    r.setStart(ps[0].firstChild, 0);
    r.setEnd(ps[1].firstChild, 4);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.keyboard.press('Control+b');

  // `<strong><p>alpha</p><p>beta</p></strong>` is not a shape the format has.
  expect(await page.evaluate(() => document.body.innerHTML.split('<div id="chrome"')[0].replace(/\s+/g, ' ').trim()))
    .toBe('<p>alpha</p><p>beta</p>');
  await expect(page.locator('#st-state')).toContainText(/inside one block/i);
  expectClean(noise);
});

test('Tab does not build a container out of a bare list item', async ({ page }) => {
  const dir = await tmpDir();
  const file = join(dir, 'bare.nd.html');
  writeFileSync(file, `<!doctype html>
<html data-neodoc="1" lang="en">
  <head><meta charset="utf-8"><title>Bare</title></head>
  <body><p>before</p><li>bare</li></body>
</html>
`);
  const noise = watchPage(page);
  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await page.setInputFiles('#open-input', file);

  await page.locator('li').click();
  await page.keyboard.press('Tab');
  // `list` was the body, so the indent branch built a `<body>` element inside the
  // paragraph above.
  expect(await page.evaluate(() => document.body.querySelectorAll('body > p body').length)).toBe(0);
  expect(await page.evaluate(() => document.body.innerHTML.split('<div id="chrome"')[0].replace(/\s+/g, ' ').trim()))
    .toBe('<p>before</p><li>bare</li>');
  await expect(page.locator('#st-state')).toContainText(/not inside a list/i);
  expectClean(noise);
});
