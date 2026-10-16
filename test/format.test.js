import test from 'node:test';
import assert from 'node:assert/strict';
import { format, formatFragment, normalizePre } from '../src/format.js';
import { lint } from '../src/lint.js';

/** Canonical text without the embedded stylesheet (keeps expectations readable). */
const fmt = (s) => format(s, { style: 'none' }).text;

/** Body content of a canonical document, as lines. */
function bodyOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '<body>');
  const end = lines.findIndex((l) => l.trim() === '</body>');
  return lines.slice(start + 1, end);
}

test('fmt is idempotent on a messy document', () => {
  const messy = `<!DOCTYPE HTML>
<html>
<head><title>Hi</title>
<meta name="author" content="Ken"><meta name="generator" content="old">
</head>
<body class="x">
<h1>Hi</h1>
<p>Hello   <b>world</b>   !
<ul><li>a<li>b</ul>
<TABLE align="center"><TR><TD align=right>1</TD><TD>2</TD></TR></TABLE>
<pre>code line
    indented line

</pre>
</body>
</html>`;
  const once = fmt(messy);
  assert.equal(fmt(once), once);
});

test('whole-document canonical shape', () => {
  const src = '<!doctype html><html><body><p>a</p><section id="s"><h2>T</h2><p>b</p></section></body></html>';
  assert.equal(fmt(src), `<!doctype html>
<html data-neodoc="1" lang="en">
  <head>
    <meta charset="utf-8">
    <title></title>
    <meta content="neodoc 1.0.0" name="generator">
  </head>
  <body>
    <p>a</p>
    <section id="s">
      <h2>T</h2>
      <p>b</p>
    </section>
  </body>
</html>
`);
});

test('inline spacing survives; block edges and runs do not', () => {
  assert.deepEqual(bodyOf(fmt('<body><p>Hello <strong>x</strong> !</p><p>  spaced   out  </p></body>')), [
    '    <p>Hello <strong>x</strong> !</p>',
    '    <p>spaced out</p>',
  ]);
});

test('table cells are one per line; alignment moves to data-align', () => {
  assert.deepEqual(bodyOf(fmt('<body><table><tr><th>a</th><td align="right">2</td></tr></table></body>')), [
    '    <table>',
    '      <tr>',
    '        <th>a</th>',
    '        <td data-align="right">2</td>',
    '      </tr>',
    '    </table>',
  ]);
});

test('pre keeps relative indentation across a round trip', () => {
  const src = '<body><pre data-lang="js">a\n  b\n    c\n</pre></body>';
  const once = fmt(src);
  assert.match(once, /<pre data-lang="js">a\n {4}b\n {6}c<\/pre>/);
  assert.equal(fmt(once), once);
  // pre content is normalized to its minimum indentation, then re-indented by fmt.
  assert.equal(normalizePre(once.match(/<pre[^>]*>([\s\S]*)<\/pre>/)[1]), 'a\nb\n  c');
});

test('forbidden and unknown constructs are kept (never destroyed) and linted', () => {
  const out = fmt('<body><div><script>alert(1)</script><p onclick="x()">hi</p></div></body>');
  assert.match(out, /<div>/);
  assert.match(out, /<script>/);
  assert.match(out, /<p>hi<\/p>/);
  const rules = lint(out).map((f) => f.rule);
  assert.ok(rules.includes('vocab'));
  // The script body must not accumulate a blank line per pass (SPEC §4.7).
  assert.equal(fmt(out), out);
  assert.equal(lint(out).filter((f) => f.rule === 'format').length, 0);
});

test('unknown attributes are kept, behaviour and presentation are dropped', () => {
  // docs/SPEC.md §4.6: content we do not understand is still content, so an
  // unknown attribute survives `fmt` (and `lint` reports it, unfixable). An event
  // handler is code and a presentational attribute is what makes Word HTML
  // unmaintainable, so both are dropped with a warning.
  assert.deepEqual(bodyOf(fmt('<body><p foo="bar" data-x="1">x</p></body>')), ['    <p data-x="1" foo="bar">x</p>']);
  assert.deepEqual(bodyOf(fmt('<body><p onclick="x()" onmouseover="y()">hi</p></body>')), ['    <p>hi</p>']);
  assert.deepEqual(bodyOf(fmt('<body><p style="color:red" class="c">hi</p></body>')), ['    <p>hi</p>']);
  const doc = fmt('<!doctype html><html><head><title>t</title></head><body><p foo="bar">x</p></body></html>');
  assert.deepEqual(lint(doc).map((f) => `${f.rule}:${f.fixable}`), ['attr:false'],
    'a kept attribute must not be reported as fixable (invariant 4)');
  // A dropped one is fixed by fmt, so that finding *is* fixable — and one fmt pass
  // leaves nothing to report.
  const raw = '<!doctype html><html data-neodoc="1" lang="en"><head><meta charset="utf-8"><title>t</title>'
    + '</head><body><p onclick="x()">x</p></body></html>';
  assert.deepEqual(lint(raw).filter((f) => f.rule === 'attr').map((f) => f.fixable), [true]);
  assert.deepEqual(lint(fmt(raw)), []);
});

test('a stray equals sign is skipped, not turned into an attribute', () => {
  // Both shapes come from real converters; only one of them names an attribute.
  assert.deepEqual(bodyOf(fmt('<body><p id="a"=data-x="1">x</p></body>')), ['    <p data-x="1" id="a">x</p>']);
  assert.deepEqual(bodyOf(fmt('<body><p id="a"=junk>x</p></body>')), ['    <p id="a">x</p>']);
});

test('lint reports a non-canonical file as fixable, and clean after fmt', () => {
  assert.equal(lint(fmt('<body><p>hi</p></body>')).length, 0);
  const findings = lint('<p>hi</p>');
  assert.equal(findings.filter((f) => f.rule === 'format').length, 1);
  assert.equal(findings.find((f) => f.rule === 'format').fixable, true);
});

test('lint flags a comment anchor with no thread and a missing alt', () => {
  const rules = lint(fmt('<body><p>a <mark data-c="c1">b</mark></p><p><img src="x.png"></p></body>')).map((f) => f.rule);
  assert.ok(rules.includes('comment-anchor'));
});

test('fragments canonicalize to depth-0 lines', () => {
  const { lines } = formatFragment('<p>hi</p><ul><li>a</li></ul>');
  assert.deepEqual(lines, ['<p>hi</p>', '<ul>', '  <li>a</li>', '</ul>']);
});

test('empty inline elements are dropped, nested ones merged', () => {
  assert.deepEqual(bodyOf(fmt('<body><p><em></em>a<em><em>b</em></em></p></body>')), ['    <p>a<em>b</em></p>']);
});

test('pre whitespace-only lines survive as-is', () => {
  const out = fmt('<body><pre>a\n   \nb</pre></body>');
  assert.equal(fmt(out), out);
  assert.match(out, /a\n {4} {3}\n {4}b/);
});

test('comment threads and tracked changes round-trip', () => {
  const src = `<body>
<p>Claim <mark data-c="c1">x</mark> and <ins data-author="ada" data-at="2026-10-16T09:12:00Z">y</ins><del data-author="ada">z</del>.</p>
<aside data-state="open" data-thread="c1">
<p data-author="ada" data-at="2026-10-16T09:12:00Z">Source?</p>
</aside>
</body>`;
  const out = fmt(src);
  assert.equal(fmt(out), out);
  assert.equal(lint(out).length, 0);
});
