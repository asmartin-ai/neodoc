// The editor ships as one self-contained page so it works from a `file://` URL:
// no server, no network. These tests keep that file honest about being generated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundle } from '../tools/bundle.js';

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
