import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';
import { parseSelector, query, queryAll, selectorOf } from '../src/select.js';
import { descendants, isEl } from '../src/tree.js';

const doc = (bodyHtml) =>
  parse(`<!doctype html><html lang="en" data-neodoc="1"><head><title>T</title></head><body>${bodyHtml}</body></html>`).root;

const bodyOf = (root) => {
  for (const node of descendants(root)) if (isEl(node, 'body')) return node;
  throw new Error('no body');
};

const names = (hits) => hits.map((h) => h.node.name);
const ids = (hits) => hits.map((h) => h.node.attrs.id);

test('parse errors are short and actionable', () => {
  const cases = [
    ['', /empty selector/],
    ['  ', /empty selector/],
    ['.foo', /class selectors are not supported: \.foo/],
    ['p.foo', /class selectors are not supported: \.foo/],
    ['[data-x', /unclosed \[ in selector/],
    ['[data-x=', /missing value after '='/],
    ['[href~="x"]', /unsupported attribute operator '~'/],
    ['[href!="x"]', /unsupported attribute operator '!'/],
    ['p:nth-child(2n+1)', /unsupported :nth-child\(2n\+1\)/],
    ['p:nth-child(0)', /:nth-child\(\) is 1-based, got 0/],
    ['p:nth-of-type(a)', /unsupported :nth-of-type\(a\)/],
    ['p:hover', /unsupported pseudo-class :hover/],
    ['p:not(:first-child)', /unsupported :not\(:first-child\)/],
    ['p >', /expected an element after '>'/],
    ['p,,h2', /empty selector part/],
    ['p,', /empty selector part/],
    ['#', /empty #id/],
    [':', /empty pseudo-class after ':'/],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => parseSelector(input), expected, `input: ${JSON.stringify(input)}`);
  }
  assert.throws(() => parseSelector(null), /selector must be a string/);
});

test('parseSelector reports the parsed shape', () => {
  const sel = parseSelector('body > section:nth-child(2) > h2');
  assert.equal(sel.text, 'body > section:nth-child(2) > h2');
  assert.equal(sel.groups.length, 1);
  assert.deepEqual(sel.groups[0].map((p) => p.combinator), ['self', 'child', 'child']);
  assert.deepEqual(sel.groups[0][0].compound, { tag: 'body', id: null, attrs: [], pseudos: [] });
  assert.deepEqual(sel.groups[0][1].compound.pseudos, [{ name: 'nth-child', arg: 2 }]);
});

test('child is not descendant', () => {
  const root = doc('<h2 id="top">Top</h2><section><p id="in">a</p></section><p id="out">b</p>');
  const body = bodyOf(root);
  assert.deepEqual(ids(queryAll(body, 'body > p')), ['out']);
  assert.deepEqual(ids(queryAll(body, 'body p')), ['in', 'out']);
  assert.deepEqual(ids(queryAll(body, 'section > p')), ['in']);
  assert.throws(() => queryAll(body, 'h2 + p'), /unsupported combinator '\+'/);
});

test('nth-child counts elements only, nth-of-type counts same tag', () => {
  const root = doc('<h2 id="h1">H</h2>\n<p id="p1">1</p>\n<h2 id="h2">H2</h2>\n<p id="p2">2</p>\n');
  const body = bodyOf(root);
  // The whitespace text nodes between blocks must not shift the counts.
  assert.deepEqual(ids(queryAll(body, 'body > :nth-child(1)')), ['h1']);
  assert.deepEqual(ids(queryAll(body, 'body > :nth-child(2)')), ['p1']);
  assert.deepEqual(ids(queryAll(body, 'body > p:nth-of-type(2)')), ['p2']);
  assert.deepEqual(ids(queryAll(body, 'body > p:nth-child(2)')), ['p1']);
  assert.deepEqual(ids(queryAll(body, 'body > h2:first-child')), ['h1']);
  assert.deepEqual(ids(queryAll(body, 'body > p:last-child')), ['p2']);
  assert.deepEqual(ids(queryAll(body, 'body > h2:last-child')), []);
  assert.deepEqual(ids(queryAll(body, 'body > p:nth-of-type(3)')), []);
});

test('comma unions dedupe and return document order', () => {
  const root = doc('<p id="a">a</p><h2 id="b">B</h2><p id="c">c</p>');
  const body = bodyOf(root);
  assert.deepEqual(ids(queryAll(body, 'h2, p')), ['a', 'b', 'c']);
  assert.deepEqual(ids(queryAll(body, 'p, body > p, #c')), ['a', 'c']);
});

test('attribute selectors: presence, =, ^=, $=, *=', () => {
  const root = doc('<a id="pdf" href="https://x.example/y.pdf">d</a><a id="html" href="https://x.example/y.html">h</a>');
  const body = bodyOf(root);
  assert.deepEqual(ids(queryAll(body, '[href]')), ['pdf', 'html']);
  assert.deepEqual(ids(queryAll(body, 'a[href="https://x.example/y.pdf"]')), ['pdf']);
  assert.deepEqual(ids(queryAll(body, '[href^="https://x.example/y.h"]')), ['html']);
  assert.deepEqual(ids(queryAll(body, '[href$=".pdf"]')), ['pdf']);
  assert.deepEqual(ids(queryAll(body, '[href$=".PDF"]')), [], 'values are case-sensitive');
  assert.deepEqual(ids(queryAll(body, '[href*="x.example"]')), ['pdf', 'html']);
  assert.deepEqual(ids(queryAll(body, '[data-nope]')), []);
  assert.deepEqual(ids(queryAll(body, "[href$='.html']")), ['html'], 'single quotes are accepted');
});

test('star and :not', () => {
  const root = doc('<p id="a">a <strong>s</strong></p><img id="i" alt="" src="x.png">');
  const body = bodyOf(root);
  const all = queryAll(body, '*');
  assert.deepEqual(names(all), ['p', 'strong', 'img']);
  assert.ok(all.every((h) => h.node.type === 'element'));
  assert.ok(!all.some((h) => h.node === body), 'star does not match the root itself');
  assert.deepEqual(ids(queryAll(body, 'body > *:not(p)')), ['i']);
  assert.deepEqual(ids(queryAll(body, 'body > :not(img):not(p)')), []);
  assert.deepEqual(names(queryAll(body, 'p *')), ['strong'], 'star matches descendants only');
});

test('the bare body selector returns the body element', () => {
  const root = doc('<p>a</p>');
  const body = bodyOf(root);
  assert.equal(query(body, 'body').node, body);
  assert.equal(query(root, 'body').node, body);
  assert.equal(query(root, 'BODY').node, body, 'tag names are case-insensitive');
  const hits = queryAll(root, 'body');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].parent.name, 'html');
  assert.equal(hits[0].index, 1, 'doctype is not an element child of html');
});

test('results carry {node,parent,index} with index into parent.children', () => {
  const root = doc('<h2 id="h">H</h2><p id="a">a</p>');
  const body = bodyOf(root);
  const hits = queryAll(body, 'p');
  assert.equal(hits.length, 1);
  const { node, parent, index } = hits[0];
  assert.equal(node.attrs.id, 'a');
  assert.equal(parent, body);
  assert.equal(body.children[index], node);
});

test('query returns null when nothing matches; unknown tag matches nothing', () => {
  const root = doc('<p>a</p>');
  const body = bodyOf(root);
  assert.equal(query(body, 'h1'), null);
  assert.equal(query(body, 'aside[data-thread="c9"]'), null);
  assert.deepEqual(queryAll(body, 'h3, h4'), []);
});

test('selectorOf round-trips through the engine for every element', () => {
  const root = doc('<h2 id="h">H</h2><section id="s"><p>a</p><p>b</p></section><p>c</p>');
  const body = bodyOf(root);
  const elements = [...descendants(body)].filter((n) => isEl(n));
  assert.equal(elements.length, 5);
  for (const node of elements) {
    // `pathOf` is rooted at the document root, so paths start at `body`.
    const selector = selectorOf(root, node);
    assert.notEqual(selector, '');
    assert.match(selector, /^body/);
    assert.equal(query(root, selector).node, node, `selector: ${selector}`);
  }
  assert.equal(query(root, selectorOf(root, body)).node, body);
  assert.equal(selectorOf(root, query(body, '#s').node), 'body:nth-child(2) > section#s');
  assert.equal(selectorOf(root, query(body, 'section > p').node), 'body:nth-child(2) > section#s > p:nth-of-type(1)');
});
