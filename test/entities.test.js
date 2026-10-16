// Character references (docs/SPEC.md §4.3) and the whitespace model (§4.4).
//
// These pin what a browser renders, which is the whole point of decoding at all:
// a reference we fail to decode gets escaped back into text, so `Jos&eacute;`
// would be shown to a reader as the literal characters "Jos&eacute;".
import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from '../src/format.js';
import { decodeEntities } from '../src/entities.js';

const fmt = (s) => format(s, { style: 'none' }).text;
const para = (html) => fmt(`<body><p>${html}</p></body>`).split('\n').find((l) => l.startsWith('    <p>'));

test('named references decode to the character HTML5 assigns them', () => {
  assert.equal(decodeEntities('&eacute;'), 'é');
  assert.equal(decodeEntities('&starf;'), '★'); // U+2605
  assert.equal(decodeEntities('&star;'), '☆'); // U+2606, not the black star
  assert.equal(decodeEntities('&Dagger;'), '‡'); // names are case-sensitive
  assert.equal(decodeEntities('&OElig;'), 'Œ'); // outside the old hand-written subset
  assert.equal(decodeEntities('&NotNestedGreaterGreater;'), '\u2AA2\u0338'); // multi code point
});

test('a reference that is not a valid HTML reference stays text', () => {
  // Browsers render these literally, so decoding them would destroy the text.
  assert.equal(decodeEntities('&nbsp2;'), '&nbsp2;');
  assert.equal(decodeEntities('&nosuchname;'), '&nosuchname;');
  assert.equal(decodeEntities('&hellip'), '&hellip'); // not in HTML5's legacy set
  assert.equal(decodeEntities('&middot'), '·'); // this one is
  assert.equal(decodeEntities('&nbsp'), '\u00a0');
  assert.equal(decodeEntities('&amp'), '&');
  assert.equal(decodeEntities('&ampx'), '&ampx');
});

test('invalid numeric references become the replacement character', () => {
  assert.equal(decodeEntities('&#8212;'), '—');
  assert.equal(decodeEntities('&#x2014;'), '—');
  assert.equal(decodeEntities('&#0;'), '\uFFFD');
  assert.equal(decodeEntities('&#xD800;'), '\uFFFD'); // a lone surrogate is not valid UTF-8
  assert.equal(decodeEntities('&#x110000;'), '\uFFFD');
});

test('undecodable references do not change what a reader sees', () => {
  // The bug this guards: escaping an undecoded reference into visible text.
  assert.equal(para('Jos&eacute;'), '    <p>José</p>');
  assert.equal(para('Jos&amp;eacute;'), '    <p>Jos&amp;eacute;</p>');
  assert.equal(para('&#x2014;'), '    <p>—</p>');
  assert.equal(para('&nbsp2;'), '    <p>&amp;nbsp2;</p>'); // renders as "&nbsp2;", as before
});

test('non-breaking space is content, not whitespace', () => {
  // §4.4 collapses exactly space, tab, LF, CR and FF. U+00A0 is none of those, and
  // collapsing it would drop the no-break meaning a reader depends on.
  assert.equal(para('a&nbsp;b'), '    <p>a\u00a0b</p>');
  assert.equal(para('a&nbsp;&nbsp;b'), '    <p>a\u00a0\u00a0b</p>');
  assert.equal(para('a\u00a0b'), '    <p>a\u00a0b</p>');
  assert.equal(para('a&thinsp;b'), '    <p>a\u2009b</p>');
  const once = fmt('<body><p>a&nbsp;b</p></body>');
  assert.equal(fmt(once), once, 'nbsp must survive a second pass');
});
