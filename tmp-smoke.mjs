
import { chromium, firefox, webkit } from 'playwright';
const url = 'file:///tmp/neodoc-editor-built.html';
for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
  const logs = [], errs = [];
  try {
    const b = await type.launch();
    const p = await b.newPage();
    p.on('console', m => logs.push(m.type() + ': ' + m.text()));
    p.on('pageerror', e => errs.push(String(e)));
    p.on('request', r => { if (!r.url().startsWith('file://')) logs.push('REQ ' + r.url()); });
    p.on('requestfailed', r => logs.push('FAILED ' + r.url() + ' :: ' + (r.failure()?.errorText)));
    await p.goto(url);
    await p.waitForFunction(() => !!window.neodocEditor, null, { timeout: 15000 }).catch(e => errs.push('boot: ' + e.message));
    logs.push('STATUS: ' + await p.locator('#st-state').textContent());
    // typing test
    await p.locator('body > p').first().click();
    await p.keyboard.type('# ');
    await p.keyboard.type('Hello');
    logs.push('H1: ' + JSON.stringify(await p.locator('body > h1').first().textContent().catch(e => 'ERR ' + e.message)));
    await b.close();
  } catch (e) { errs.push('LAUNCH: ' + e.message); }
  console.log('===', name, '===');
  console.log('errors:', JSON.stringify(errs, null, 1));
  console.log('logs:', JSON.stringify(logs, null, 1));
}
