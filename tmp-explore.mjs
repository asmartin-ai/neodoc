
import { chromium, firefox } from 'playwright';
import { mkdtemp, copyFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = 'file:///tmp/neodoc-editor-built.html';
const log = (...a) => console.log(...a);

for (const [name, type] of [['chromium', chromium], ['firefox', firefox]]) {
  log('\n########', name);
  const b = await type.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const consoleErrors = [], pageErrors = [], requests = [];
  p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  p.on('pageerror', e => pageErrors.push(String(e)));
  p.on('request', r => requests.push(r.url()));
  await p.goto(url);
  await p.waitForFunction(() => !!window.neodocEditor);
  log('boot ok. status:', await p.locator('#st-state').textContent());
  // 1. heading
  await p.locator('body > p').first().click();
  await p.keyboard.type('# ');
  await p.keyboard.type('Title');
  log('h1:', JSON.stringify(await p.locator('body > h1').textContent()));
  // 2. enter -> ?
  await p.keyboard.press('Enter');
  log('after enter body html:', JSON.stringify(await p.evaluate(() => document.body.innerHTML.slice(0, 300))));
  await p.keyboard.type('**bold**');
  log('strong:', JSON.stringify(await p.locator('body strong').textContent().catch(e => 'ERR')));
  // 3. enter, list
  await p.keyboard.press('Enter');
  await p.keyboard.type('- ');
  await p.keyboard.type('item');
  log('li:', JSON.stringify(await p.locator('body ul > li').textContent().catch(e => 'ERR')));
  log('body:', JSON.stringify(await p.locator('body').innerHTML()));
  const canon = await p.evaluate(() => { const c = window.neodocEditor.canonicalText(); return typeof c === 'string' ? c : c.text; });
  log('canonical tail:', JSON.stringify(canon.slice(-260)));
  // 4. comment on selection
  await p.evaluate(() => {
    const h1 = document.querySelector('body > h1');
    const r = document.createRange(); r.selectNodeContents(h1);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  p.once('dialog', d => d.accept('Where from?'));
  await p.locator('button[data-cmd="comment"]').click();
  await p.locator('#threads li').first().waitFor({ timeout: 5000 }).catch(e => log('COMMENT ERR', e.message));
  log('threads html:', JSON.stringify(await p.locator('#threads').innerHTML()));
  log('mark:', JSON.stringify(await p.locator('body mark').first().textContent().catch(() => 'none')));
  // 5. save -> download
  const dl = p.waitForEvent('download', { timeout: 15000 });
  await p.locator('button[data-cmd="save"]').click();
  try {
    const d = await dl;
    log('download name:', d.suggestedFilename());
    const path = await d.path();
    const text = await readFile(path, 'utf8');
    log('saved head:', JSON.stringify(text.slice(0, 250)));
    await writeFile('/tmp/saved-' + name + '.nd.html', text);
  } catch (e) { log('DOWNLOAD ERR', e.message.split('\n')[0]); }
  log('status:', await p.locator('#st-state').textContent());
  log('consoleErrors:', JSON.stringify(consoleErrors));
  log('pageErrors:', JSON.stringify(pageErrors));
  log('non-file requests:', JSON.stringify(requests.filter(u => !u.startsWith('file://'))));
  log('file requests:', JSON.stringify(requests.filter(u => u.startsWith('file://'))));
  await b.close();
}
