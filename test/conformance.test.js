// SPEC §10 conformance protocol. Ports run the same rules (docs/PORTING.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { format } from '../src/format.js';
import { lint } from '../src/lint.js';

const DIR = new URL('../fixtures/', import.meta.url).pathname;
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
