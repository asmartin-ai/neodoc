// 4. The generated page really has no server and no network.
//
// editor/neodoc-editor.html is the "email me one file" build: it must run from a
// `file://` URL with nothing behind it. The regression this guards against is the
// bundle silently gaining an external reference (a stray `<script src=...>`, a
// link, a font, a fetch) — and the `$&` corruption found in tools/bundle.js, where
// `String.replace(pattern, code)` expanded `$&` inside the bundled source and
// spliced a literal `<script src="editor.js">` into the middle of the inline
// module. That corruption is invisible to a "file changed" check and fatal in every
// engine: the injected tag closes the inline script, the module never runs, and the
// truncated remainder is parsed as HTML (so the browser even requests a URL built
// out of leftover source text).

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, SERVERLESS_EDITOR, watchPage } from './helpers.js';

test('the generated page is one self-contained script and asks for nothing remote', async ({ page }) => {
  const noise = watchPage(page);

  await page.goto(SERVERLESS_EDITOR);
  await page.waitForFunction(() => !!window.neodocEditor);
  await expect(page.locator('#toolbar')).toBeVisible();

  // Boot must not have loaded anything but this file: the only permitted departure
  // is the deliberate `GET /doc` probe, which fails here and is ignored by design.
  // (Chromium does not even issue it for `file://`; it logs the refusal instead.)
  const offLimits = noise.requests.filter((url) => !url.startsWith('file://') && url !== `${SERVERLESS_EDITOR}/doc`);
  expect(offLimits, `non-file requests: ${offLimits.join(', ')}`).toEqual([]);
  expect([...new Set(noise.requests)].filter((url) => url !== SERVERLESS_EDITOR)).toEqual([]);

  // Static half of the same guarantee: this file has no external subresource.
  const html = await readFile(join(ROOT, 'editor', 'neodoc-editor.html'), 'utf8');
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toMatch(/<link[^>]+href=/);
  // One module, closed once, and it is the last thing on the page. The `$&`
  // corruption spliced a second `</script>` in and truncated the rest.
  expect(html.split('</script>').length - 1, 'exactly one script in the page').toBe(1);
  expect(html).toContain('</script>\n</body>');

  // The inline module keeps module source byte for byte, so the escaping helper in
  // src/markdown.js (`s.replace(ESC, '\\$&')`) is still present verbatim. If a
  // replacement pattern ever expands again, this string becomes a script tag.
  const module = html.slice(html.indexOf('<script type="module">'), html.lastIndexOf('</script>'));
  expect(module).toContain("'\\\\$&'");
  expect(module).not.toContain('<script type="module" src="editor.js">');
});
