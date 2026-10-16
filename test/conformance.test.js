// SPEC §10 conformance protocol. Ports run the same rules (docs/PORTING.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from '../src/format.js';
import { lint } from '../src/lint.js';
import { parse } from '../src/parse.js';
import { queryAll } from '../src/select.js';
import { descendants, pathOf } from '../src/tree.js';

const DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const hasStyle = (text) => /<style[\s>]/i.test(text);
const read = (path) => readFileSync(path, 'utf8');

for (const name of readdirSync(DIR).filter((f) => f.endsWith('.nd.html')).sort()) {
  test(`${name} is canonical and lint-clean`, () => {
    const text = read(join(DIR, name));
    assert.equal(format(text, { style: hasStyle(text) ? 'inline' : 'none' }).text, text, 'fmt changed a canonical fixture');
    assert.deepEqual(lint(text), [], 'canonical fixture has lint findings');
  });
}

test('non-canonical inputs converge on the canonical fixture', () => {
  const ncDir = join(DIR, 'noncanonical');
  assert.ok(existsSync(ncDir));
  const files = readdirSync(ncDir).sort();
  assert.ok(files.length > 0);
  for (const name of files) {
    const target = join(DIR, `${name.replace(/\.html?$/, '')}.nd.html`);
    const want = read(target);
    const got = format(read(join(ncDir, name)), { style: hasStyle(want) ? 'inline' : 'none' }).text;
    assert.equal(got, want, `${name} did not canonicalize to ${target}`);
  }
});

// `neodoc get --json` hands agents a `path` they can feed straight back in, so
// every generated path must resolve to exactly the node it came from.
test('generated paths resolve to exactly one node', () => {
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.nd.html')).sort()) {
    const { root } = parse(read(join(DIR, name)));
    let checked = 0;
    for (const node of descendants(root)) {
      if (node.type !== 'element' || node.name === '#root') continue;
      const path = pathOf(root, node);
      const hits = queryAll(root, path);
      assert.equal(hits.length, 1, `${name}: ${path} matched ${hits.length} nodes`);
      assert.equal(hits[0].node, node, `${name}: ${path} resolved to a different node`);
      checked++;
    }
    assert.ok(checked > 10, `${name}: only ${checked} elements checked`);
  }
});
