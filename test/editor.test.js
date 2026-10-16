// The editor ships as one self-contained page so it works from a `file://` URL:
// no server, no network. These tests keep that file honest about being generated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '../tools/bundle.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FILE = new URL('../editor/neodoc-editor.html', import.meta.url).pathname;
const read = () => readFileSync(FILE, 'utf8');

test('the committed self-contained editor matches the modules it is built from', () => {
  assert.equal(read(), bundle(), 'run: node tools/bundle.js');
});

test('the bundled editor needs no server and no network', () => {
  const html = read();
  const script = html.match(/<script type="module">\n([\s\S]*)<\/script>/)[1];
  assert.ok(!/^\s*(import|export)\s/m.test(script), 'module syntax survived bundling');
  assert.ok(!/(?:src|href)="(?:\.{1,2}\/|\/)/.test(html), 'external asset reference survived bundling');
  assert.match(html, /<style>/, 'stylesheet is not inlined');
  assert.match(html, /<body contenteditable="true"/);
  for (const id of ['src/tree', 'src/format', 'src/select', 'src/markdown', 'src/comments', 'editor/editor']) {
    assert.ok(script.includes(`__mods["${id}"]`), `${id} missing from the bundle`);
  }
});

// Regression: `String.replace(pattern, codeString)` expands `$&` and friends found
// in the *replacement*, which silently spliced a literal script tag into the middle
// of the bundled module and truncated the page. The bundle must carry source text
// through byte for byte.
test('bundling does not expand $-patterns from module source', () => {
  const html = read();
  const lines = readFileSync(join(ROOT, 'src/markdown.js'), 'utf8').split('\n').filter((l) => l.includes('$&'));
  assert.ok(lines.length > 0, 'expected a $-expansion hazard to exist in src/markdown.js');
  for (const line of lines) assert.ok(html.includes(line), `bundle lost this line: ${line.trim()}`);
  // The corruption injected this exact tag; module source may legitimately mention
  // `<script` while escaping it, so assert on the tag, not on a count of `<script`.
  assert.ok(!html.includes('<script type="module" src="editor.js">'), 'the source tag was spliced into the bundle');
  assert.ok(html.includes('</script>\n</body>'), 'the inline module is not the last thing in the page');
});
