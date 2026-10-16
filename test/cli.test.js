// The CLI is the interface agents and humans script against, so its contract —
// exit codes and the documented stdin/stdout forms — is worth pinning directly.
// Everything else about it is covered through the library tests and e2e.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/neodoc.js', import.meta.url));

function cli(args, { input = '' } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const tmpFile = (name, text) => {
  const dir = mkdtempSync(join(tmpdir(), 'neodoc-cli-'));
  const path = join(dir, name);
  if (text !== undefined) writeFileSync(path, text);
  return path;
};

const DOC = '<!doctype html>\n<html data-neodoc="1" lang="en">\n  <head>\n    <meta charset="utf-8">\n'
  + '    <title>t</title>\n    <meta content="neodoc 1.0.0" name="generator">\n  </head>\n  <body>\n'
  + '    <p>hi</p>\n  </body>\n</html>\n';

test('`new -` reads markdown from stdin and writes the document to stdout', () => {
  // docs/CLI.md documents this exact pipeline; `-` used to become a file named "-".
  const res = cli(['new', '-'], { input: '# Notes\n\n- one\n- two\n' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /<title>Notes<\/title>/);
  assert.match(res.stdout, /<h1>Notes<\/h1>/);
  assert.match(res.stdout, /<li>one<\/li>/);
});

test('`--file - --md` reads a markdown fragment from stdin', () => {
  const file = tmpFile('doc.nd.html', DOC);
  const res = cli(['set', file, 'body > p', '--file', '-', '--md'], { input: 'Second.\n' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(file, 'utf8'), /<p>Second\.<\/p>/);
});

test('exit codes: 1 is no-match, 2 is a usage or selector error', () => {
  const file = tmpFile('doc.nd.html', DOC);
  assert.equal(cli(['get', file, 'body > h1']).status, 1, 'no match');
  assert.equal(cli(['get', file, 'body > p']).status, 0, 'match');
  assert.equal(cli(['get', file, '.cls']).status, 2, 'unsupported selector');
  assert.equal(cli(['nope']).status, 2, 'unknown command');
  assert.equal(cli(['get', join(tmpdir(), 'missing.nd.html'), 'p']).status, 2, 'missing file');
});

test('accept and reject leave the file alone when nothing matched', () => {
  const file = tmpFile('doc.nd.html', DOC);
  const before = readFileSync(file, 'utf8');
  const res = cli(['accept', file, 'body > p']);
  assert.equal(res.status, 1, 'a selector that folds nothing is a no-match');
  assert.equal(readFileSync(file, 'utf8'), before, 'a no-op must not rewrite the file');
});

test('`get --json` reports ok:false when nothing matched', () => {
  const file = tmpFile('doc.nd.html', DOC);
  const res = cli(['get', file, 'body > h9', '--json']);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).ok, false, 'ok must agree with the exit code');
});

test('`note rm` on an unknown id is an error and does not rewrite the file', () => {
  const file = tmpFile('doc.nd.html', DOC);
  const before = readFileSync(file, 'utf8');
  const res = cli(['note', 'rm', file, 'nosuch']);
  assert.equal(res.status, 2, 'note done/reply already fail on an unknown id');
  assert.equal(readFileSync(file, 'utf8'), before, 'a no-op must not rewrite the file');
});

test('`note rm` removes a thread it does find', () => {
  const file = tmpFile('doc.nd.html', DOC);
  assert.equal(cli(['note', 'add', file, 'body > p', '--say', 'why?']).status, 0);
  const id = /^(\S+)/.exec(cli(['note', 'ls', file]).stdout)[1];
  assert.equal(cli(['note', 'rm', file, id]).status, 0, 'a real id still removes the thread');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /data-thread/);
});

test('the not-canonical message counts the lines that actually differ', () => {
  const scrambled = DOC
    .replace('data-neodoc="1" lang="en"', 'lang="en" data-neodoc="1"')
    .replace('content="neodoc 1.0.0" name="generator"', 'name="generator" content="neodoc 1.0.0"');
  const res = cli(['lint', tmpFile('doc.nd.html', scrambled)]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /not canonical \(2 line\(s\) differ/);
});

test('`note add --on ""` is refused instead of annotating the whole block', () => {
  const file = tmpFile('doc.nd.html', DOC);
  const before = readFileSync(file, 'utf8');
  const res = cli(['note', 'add', file, 'body > p', '--on', '', '--say', 'x']);
  assert.equal(res.status, 2, 'an empty quote selector is a usage error');
  assert.equal(readFileSync(file, 'utf8'), before);
});
