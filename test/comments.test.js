import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parse.js';
import { query } from '../src/select.js';
import { descendants, isEl, textOf, walk } from '../src/tree.js';
import {
  acceptChanges, addComment, listComments, newId, rejectChanges, removeComment,
  replyToComment, resolveComment,
} from '../src/comments.js';

const doc = (bodyHtml) =>
  parse(`<!doctype html><html lang="en" data-neodoc="1"><head><title>T</title></head><body>\n${bodyHtml}\n</body></html>`).root;

const bodyOf = (root) => query(root, 'body').node;
const find = (root, name) => [...descendants(root)].filter((n) => isEl(n, name));
const outline = (node) => (node.children || []).map((c) => (c.type === 'text' ? c.text : c.name));

test('addComment with a quote splits the text node in three', () => {
  const root = doc('<h1 id="h">Intro</h1>\n<p id="p1">Hello world, this is fine.</p>');
  const body = bodyOf(root);
  const res = addComment(root, {
    body, selector: '#p1', quote: 'world', text: 'Why?', author: 'ada', at: '2026-10-16T09:12:00Z',
  });
  assert.equal(res.id, 'c1');
  assert.equal(res.anchor.name, 'mark');
  assert.equal(res.anchor.attrs['data-c'], 'c1');
  const p = query(body, '#p1').node;
  assert.deepEqual(outline(p), ['Hello ', 'mark', ', this is fine.']);
  assert.equal(p.children[1], res.anchor);
  assert.equal(res.anchor.children[0].text, 'world');
  assert.equal(textOf(p), 'Hello world, this is fine.', 'text is unchanged by the anchor');
});

test('a quote nested inside inline markup is split in place', () => {
  const root = doc('<p id="p">See <strong>the appendix</strong> now.</p>');
  const body = bodyOf(root);
  addComment(root, { body, selector: '#p', quote: 'appendix', text: 'Which one?' });
  const strong = query(body, 'strong').node;
  assert.deepEqual(outline(strong), ['the ', 'mark']);
  assert.equal(textOf(strong), 'the appendix');
});

test('without a quote the whole block content is wrapped', () => {
  const root = doc('<p id="p">a <em>b</em> c</p>');
  const body = bodyOf(root);
  const res = addComment(root, { body, selector: '#p', text: 'note' });
  const p = query(body, '#p').node;
  assert.deepEqual(outline(p), ['mark']);
  assert.equal(p.children[0], res.anchor);
  assert.equal(textOf(p), 'a b c');
});

test('the thread lands right after the block, never inside a section', () => {
  const root = doc('<section id="s"><h2>T</h2><p id="q">x</p></section>\n<p id="after">y</p>');
  const body = bodyOf(root);
  const res = addComment(root, { body, selector: '#q', text: 'hm', author: 'ada', at: '2026-10-16T09:12:00Z' });
  assert.deepEqual(
    body.children.filter((c) => isEl(c)).map((c) => c.name),
    ['section', 'aside', 'p'],
  );
  assert.deepEqual(outline(query(body, '#s').node), ['h2', 'p'], 'nothing was inserted inside the section');
  assert.equal(query(body, 'section aside'), null);
  assert.equal(res.threadPath, 'body > aside:nth-child(2)');
  assert.equal(query(body, res.threadPath).node.attrs['data-thread'], 'c1');
});

test('the thread climbs out of nested sections', () => {
  const root = doc('<section id="outer"><p id="o">o</p><section id="inner"><p id="i">i</p></section></section>');
  const body = bodyOf(root);
  addComment(root, { body, selector: '#i', text: 'deep' });
  assert.deepEqual(body.children.filter((c) => isEl(c)).map((c) => c.name), ['section', 'aside']);
  assert.deepEqual(outline(query(body, '#outer').node), ['p', 'section']);
});

test('ids are generated deterministically and never reuse one', () => {
  const root = doc('<p>a <mark data-c="c1">x</mark></p>\n<aside data-thread="c1" data-state="open"><p data-author="ada">q</p></aside>\n<aside data-thread="c2" data-note="info"><p>doc-level annotation</p></aside>');
  const body = bodyOf(root);
  assert.equal(newId(root), 'c3');
  const res = addComment(root, { body, selector: 'p', text: 'second' });
  assert.equal(res.id, 'c3');
  assert.equal(newId(root), 'c4', 'the new thread now occupies c3');
});

test('addComment rejects bad input with actionable errors', () => {
  const root = doc('<p id="p">Hello</p>');
  const body = bodyOf(root);
  assert.throws(() => addComment(root, { body, selector: '#p', quote: 'nope', text: 'x' }), /quote not found in the block matched by "#p": nope/);
  assert.throws(() => addComment(root, { body, selector: '#missing', text: 'x' }), /selector matched no element: #missing/);
  assert.throws(() => addComment(root, {}), /addComment needs \{ body, selector \}/);
  assert.throws(() => addComment(root, { body: root, selector: 'title', text: 'x' }), /cannot anchor a comment inside <head>: title/);
  assert.equal(query(body, 'aside'), null, 'a failed add leaves no thread behind');
});

test('listComments reports state, author, anchor text, path and replies', () => {
  const root = doc('<p id="p">Hello world.</p>');
  const body = bodyOf(root);
  const res = addComment(root, {
    body, selector: '#p', quote: 'world', text: 'Why?', author: 'ada', at: '2026-10-16T09:12:00Z',
  });
  replyToComment(root, res.id, { text: 'Because.', author: 'ken', at: '2026-10-16T10:00:00Z' });
  const [thread] = listComments(root);
  assert.deepEqual(thread, {
    id: 'c1',
    state: 'open',
    author: 'ada',
    at: '2026-10-16T09:12:00Z',
    text: 'Why?',
    anchorText: 'world',
    path: res.threadPath,
    replies: [{ author: 'ken', at: '2026-10-16T10:00:00Z', text: 'Because.' }],
  });
  resolveComment(root, 'c1');
  assert.equal(listComments(root)[0].state, 'resolved');
  resolveComment(root, 'c1', false);
  assert.equal(listComments(root)[0].state, 'open');
});

test('a document-level annotation lists with empty anchorText and default state', () => {
  const root = doc('<p>a</p>\n<aside data-thread="n1"><p data-author="ada">note</p></aside>');
  const [note] = listComments(root);
  assert.equal(note.id, 'n1');
  assert.equal(note.state, 'open');
  assert.equal(note.anchorText, '');
  assert.equal(note.text, 'note');
  assert.deepEqual(note.replies, []);
});

test('resolve/reply on an unknown id throw', () => {
  const root = doc('<p>a</p>');
  assert.throws(() => resolveComment(root, 'c9'), /no comment thread c9/);
  assert.throws(() => replyToComment(root, 'c9', { text: 'x' }), /no comment thread c9/);
});

test('removeComment drops the mark and the thread, leaving no orphan text', () => {
  const root = doc('<p id="p">Hello world, ok.</p>');
  const body = bodyOf(root);
  const res = addComment(root, { body, selector: '#p', quote: 'world', text: 'Why?' });
  const counts = removeComment(root, res.id);
  assert.deepEqual(counts, { marks: 1, threads: 1 });
  const p = query(body, '#p').node;
  assert.deepEqual(outline(p), ['Hello world, ok.'], 'the split is merged back into one text node');
  assert.equal(textOf(p), 'Hello world, ok.');
  assert.deepEqual(find(root, 'mark'), []);
  assert.deepEqual(find(root, 'aside'), []);
  assert.equal(query(body, '[data-c]'), null);
});

test('removeComment unwraps every mark with the id and is a no-op otherwise', () => {
  const root = doc('<p>a <mark data-c="c1">x</mark> b <mark data-c="c1">y</mark></p>\n<aside data-thread="c1"><p>t</p></aside>');
  assert.deepEqual(removeComment(root, 'c1'), { marks: 2, threads: 1 });
  assert.deepEqual(find(root, 'mark'), []);
  assert.equal(textOf(query(root, 'p').node), 'a x b y');
  assert.deepEqual(removeComment(root, 'c1'), { marks: 0, threads: 0 });
});

test('acceptChanges: ins text stays, del text is deleted', () => {
  const root = doc('<p id="p">a <ins data-author="ada" data-at="2026-10-16T09:12:00Z">new</ins> b <del>old</del> c</p>');
  const body = bodyOf(root);
  assert.deepEqual(acceptChanges(root), { ins: 1, del: 1 });
  const p = query(body, '#p').node;
  assert.deepEqual(find(p, 'ins'), []);
  assert.deepEqual(find(p, 'del'), []);
  assert.equal(textOf(p), 'a new b  c');
});

test('acceptChanges keeps nested inline markup of the insertion', () => {
  const root = doc('<p>x <ins>a <strong>bold</strong> b</ins> y</p>');
  const body = bodyOf(root);
  acceptChanges(root);
  assert.deepEqual(outline(query(body, 'p').node), ['x ', 'a ', 'strong', ' b', ' y']);
  assert.equal(textOf(query(body, 'p').node), 'x a bold b y');
});

test('rejectChanges is the inverse: del text comes back, ins text goes away', () => {
  const root = doc('<p id="p">a <ins>new</ins> b <del>old</del> c</p>');
  const body = bodyOf(root);
  assert.deepEqual(rejectChanges(root), { ins: 1, del: 1 });
  const p = query(body, '#p').node;
  assert.deepEqual(find(p, 'ins'), []);
  assert.deepEqual(find(p, 'del'), []);
  assert.equal(textOf(p), 'a  b old c');
});

test('accept/reject only touch what the selector scopes in', () => {
  const root = doc('<p id="p1">x <ins>i1</ins> <del>d1</del></p>\n<p id="p2">y <ins>i2</ins> <del>d2</del></p>');
  const body = bodyOf(root);
  assert.deepEqual(acceptChanges(root, '#p2'), { ins: 1, del: 1 });
  assert.equal(textOf(query(body, '#p1').node), 'x i1 d1');
  assert.equal(textOf(query(body, '#p2').node), 'y i2 ');
  assert.deepEqual(rejectChanges(root, '#p1'), { ins: 1, del: 1 });
  assert.equal(textOf(query(body, '#p1').node), 'x  d1');
  assert.equal(find(root, 'ins').length, 0);
  assert.equal(find(root, 'del').length, 0);
});

test('nested changes fold innermost-first without losing text', () => {
  const root = doc('<p>a <ins>in<del>gone</del>sert</ins> b</p>');
  const body = bodyOf(root);
  acceptChanges(root);
  assert.equal(textOf(query(body, 'p').node), 'a insert b');
});

test('a whole comment round-trip survives format()', async () => {
  const { format } = await import('../src/format.js');
  const root = doc('<h1 id="h">Intro</h1>\n<p id="p1">Hello world, this is fine.</p>');
  const body = bodyOf(root);
  addComment(root, { body, selector: '#p1', quote: 'world', text: 'Why?', author: 'ada', at: '2026-10-16T09:12:00Z' });
  const lines = format(`<!doctype html><html><head><title>T</title></head><body>\n${serialize(body)}\n</body></html>`, { style: 'none' }).text.split('\n');
  assert.ok(lines.some((l) => l.includes('<mark data-c="c1">world</mark>')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('<aside data-state="open" data-thread="c1">')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('data-at="2026-10-16T09:12:00Z"') && l.includes('Why?')), lines.join('\n'));
});

/** Minimal serializer for the test above — format() is the real one. */
function serialize(node) {
  if (node.type === 'text') return node.text;
  if (node.type === 'comment') return `<!--${node.text}-->`;
  const attrs = Object.entries(node.attrs || {}).map(([k, v]) => ` ${k}="${v}"`).join('');
  const kids = (node.children || []).map(serialize).join('');
  return `<${node.name}${attrs}>${kids}</${node.name}>`;
}

test('walk() sees the anchors and threads that were created', () => {
  const root = doc('<p id="p">one two</p>');
  const body = bodyOf(root);
  addComment(root, { body, selector: '#p', quote: 'two', text: 'q', author: 'ada' });
  const marks = [];
  walk(root, (n) => { if (isEl(n, 'mark')) marks.push(n); });
  assert.equal(marks.length, 1);
  assert.equal(marks[0].attrs['data-c'], 'c1');
});
