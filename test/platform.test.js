// Cross-platform invariants. These run on Linux, macOS and Windows in CI because
// "the same bytes everywhere" is the format's whole promise (docs/SPEC.md §4.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from '../src/format.js';
import { lint } from '../src/lint.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.nd.html'));

test('a CRLF checkout canonicalizes to the same bytes as a LF one', () => {
  for (const name of fixtures) {
    const text = readFileSync(join(FIXTURES, name), 'utf8');
    assert.ok(!text.includes('\r'), `${name} is stored with CRLF`);
    const crlf = text.replace(/\n/g, '\r\n');
    assert.equal(format(crlf, { style: 'inline' }).text, text, `${name}: CRLF input changed the canonical bytes`);
  }
});

test('canonical fixtures are LF-only and end with exactly one newline', () => {
  for (const name of fixtures) {
    const text = readFileSync(join(FIXTURES, name), 'utf8');
    assert.ok(text.endsWith('\n'), `${name} has no trailing newline`);
    assert.ok(!text.endsWith('\n\n'), `${name} ends with a blank line`);
    assert.ok(!/[ \t]+\n/.test(text.replace(/(?<=<pre[^>]*>)[\s\S]*?(?=<\/pre>)/g, '')), `${name} has trailing whitespace`);
  }
});

/** Scan code, not prose: these checks must not fire on a comment that names the hazard. */
const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the canonical path never depends on the host', () => {
  // Locale, clock and platform reads in the normalize/serialize path would make
  // output differ between machines, which no conformance corpus can hide.
  const banned = /\b(localeCompare|toLocaleDateString|toLocaleString|toLocaleTimeString|Date\.now|Math\.random|process\.platform|process\.env|Intl\.)\b/;
  for (const file of ['format.js', 'parse.js', 'tree.js', 'entities.js', 'lint.js', 'theme.js', 'version.js']) {
    const source = codeOnly(readFileSync(join(ROOT, 'src', file), 'utf8'));
    const hit = banned.exec(source);
    assert.equal(hit, null, `src/${file} uses ${hit && hit[0]} — canonical bytes must be host independent`);
  }
});

test('the CLI entry point is a portable shebang script', () => {
  const source = readFileSync(join(ROOT, 'bin/neodoc.js'), 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node\n'), 'bin/neodoc.js needs a LF shebang');
  assert.ok(!source.includes('\r'), 'bin/neodoc.js contains CRLF');
});

test('no first-party file derives a filesystem path from URL.pathname', () => {
  // A raw `new URL(...).pathname` yields `/C:/…` on Windows; fileURLToPath does not.
  const files = [
    ...readdirSync(join(ROOT, 'src')).map((f) => `src/${f}`),
    ...readdirSync(join(ROOT, 'test')).map((f) => `test/${f}`),
    'tools/bundle.js',
  ];
  for (const file of files) {
    const source = codeOnly(readFileSync(join(ROOT, file), 'utf8'));
    assert.equal(/new URL\([^)]*\)\.pathname/.exec(source), null, `${file} breaks on Windows paths`);
  }
});

test('the fixtures lint clean on any host', () => {
  for (const name of fixtures) {
    const findings = lint(readFileSync(join(FIXTURES, name), 'utf8'));
    assert.deepEqual(findings, [], `${name} lints dirty`);
  }
});
