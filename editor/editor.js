// WYSIWYG editor for a Neodoc file (docs/SPEC.md §4).
//
// The design in one sentence: the live <body> IS the document. Its children are
// the document's blocks, typing mutates them directly, and Save canonicalizes the
// live tree with format() from src/format.js — the same function `neodoc fmt`
// runs, so the browser and the CLI cannot produce different bytes. There is no
// model to sync, no preview pane and no re-render per keystroke.
//
// Browser HTML never reaches disk: every write goes through format() first, and
// format() drops anything outside the closed vocabulary (docs/SPEC.md §3).
//
// The one editor-owned node in <body> is #chrome (toolbar/sidebar/status bar);
// together with the editor stylesheet link it is detached for the duration of
// canonicalText(), and restored immediately after. document.execCommand is never
// used anywhere: it is deprecated and produces per-browser HTML that would
// corrupt the file.

import { format, formatFragment, serialize } from '../src/format.js';
import { parse } from '../src/parse.js';
import { RENAMES, VOCAB, isAttrAllowed } from '../src/tree.js';
import { query } from '../src/select.js';
import { fromMarkdown } from '../src/markdown.js';
import {
  addComment, listComments, resolveComment, replyToComment, acceptChanges, rejectChanges,
} from '../src/comments.js';

const AUTHOR = 'editor';
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const CHROME = document.getElementById('chrome');
const CSS_LINK = document.getElementById('editor-css');
const $ = (sel) => document.querySelector(sel);

// Elements a caret can live in (the "block" in the status bar and in commands).
const LEAF = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'figcaption', 'pre']);
const CONTAINER = new Set(['ul', 'ol', 'blockquote', 'section', 'aside', 'figure', 'table',
  'thead', 'tbody', 'tr', 'li', 'td', 'th', 'figcaption']);
// Dropped outright from pasted content; everything else outside the vocabulary is
// unwrapped (kept as its children) so a paste can never inject behaviour.
const PASTE_DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
  'button', 'video', 'audio', 'svg', 'link', 'base', 'meta', 'title', 'head', 'body', 'html', 'template']);

const state = { name: 'untitled.nd.html', mode: 'inline', dirty: false, served: false, handle: null, suggest: false, embed: true };

// ------------------------------------------------------------------ dom helpers

function h(name, attrs = {}, ...kids) {
  const n = document.createElement(name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
}
const text = (s) => document.createTextNode(s);

function setCaret(node, offset = 0) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  focusRange(r);
}
function setCaretAfter(node) {
  const r = document.createRange();
  r.setStartAfter(node);
  r.collapse(true);
  focusRange(r);
}
function selectContents(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  focusRange(r);
}
function focusRange(r) {
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function caretRange() {
  const sel = document.getSelection();
  return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
}

/** Nearest leaf block around a node, or null when the caret is between blocks. */
function blockOf(node) {
  let n = node && node.nodeType === 3 ? node.parentNode : node;
  while (n && n !== document.body && n.nodeType === 1) {
    const p = n.parentNode;
    if (p === document.body || (p && CONTAINER.has(p.nodeName.toLowerCase()))) {
      return LEAF.has(n.nodeName.toLowerCase()) ? n : null;
    }
    n = p;
  }
  return null;
}
/** Caret at the very start of its block? */
function atBlockStart(range, block) {
  const r = document.createRange();
  r.setStart(block, 0);
  r.setEnd(range.startContainer, range.startOffset);
  return r.toString() === '';
}
function blocksInBody() {
  return [...document.body.children].filter((n) => n !== CHROME);
}
function treeToDom(node) {
  if (!node) return null;
  if (node.type === 'text') return text(node.text);
  if (node.type === 'comment') return document.createComment(node.text);
  if (node.type === 'doctype') return null;
  const n = document.createElement(node.name);
  for (const [k, v] of Object.entries(node.attrs || {})) n.setAttribute(k, v);
  for (const c of (node.children || []).map(treeToDom)) if (c) n.append(c);
  return n;
}
function* textNodesIn(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) yield w.currentNode;
}

function status(message) {
  $('#st-state').textContent = message;
}

// ------------------------------------------------------- canonicalization / IO

function headOf(root) {
  const html = (root.children || []).find((c) => c.type === 'element' && c.name === 'html');
  return html ? (html.children || []).find((c) => c.name === 'head') : null;
}
const modeOfText = (src) => {
  const head = headOf(parse(src).root);
  return head && head.children.some((c) => c.name === 'style') ? 'inline' : 'none';
};

/**
 * The live document as canonical text. #chrome, the editor stylesheet and the
 * editing attributes are pulled out of the tree for the duration of format() so
 * `document.documentElement.outerHTML` is exactly the document, nothing else.
 */
function canonicalText() {
  const assets = [...document.head.children].filter((n) => n === CSS_LINK);
  const attrs = ['contenteditable', 'spellcheck'];
  const body = document.body;
  const saved = attrs.map((a) => body.getAttribute(a));
  CHROME.remove();
  for (const n of assets) n.remove();
  for (const a of attrs) body.removeAttribute(a);
  let html;
  try {
    html = '<!doctype html>\n' + document.documentElement.outerHTML;
  } finally {
    attrs.forEach((a, i) => { if (saved[i] !== null) body.setAttribute(a, saved[i]); });
    for (const n of assets) document.head.append(n);
    body.append(CHROME);
  }
  return format(html, { style: state.mode });
}

/** Show canonical text: the document's head and body replace the live ones. */
function applyDocument(src) {
  const { root } = parse(src);
  const html = (root.children || []).find((c) => c.type === 'element' && c.name === 'html');
  const head = html && (html.children || []).find((c) => c.name === 'head');
  const body = html && (html.children || []).find((c) => c.name === 'body');
  state.mode = head && head.children.some((c) => c.name === 'style') ? 'inline' : 'none';
  for (const n of [...document.head.children]) if (n !== CSS_LINK) n.remove();
  document.head.append(...(head ? head.children.map(treeToDom).filter(Boolean) : []), CSS_LINK);
  for (const a of [...document.documentElement.attributes]) {
    if (!(a.name in ((html && html.attrs) || {}))) document.documentElement.removeAttribute(a.name);
  }
  for (const [k, v] of Object.entries((html && html.attrs) || {})) document.documentElement.setAttribute(k, v);
  for (const n of [...document.body.childNodes]) if (n !== CHROME) n.remove();
  const kids = body ? body.children.map(treeToDom).filter(Boolean) : [];
  document.body.prepend(...(kids.length ? kids : [h('p')]));
  document.body.append(CHROME);
  bumpDom();
  refresh();
}

/**
 * Drop every editor-owned node that is not the document: the module <script>, the
 * comments index.html is written with, and the whitespace text nodes around them.
 * The HTML parser moves an `</head>`-time comment INTO the body, and format() keeps
 * comments, so anything left here would be written into the user's file. Runs once,
 * at boot, while the only document content is the empty <p>.
 */
function sweepEditorNodes() {
  for (const n of [...document.documentElement.childNodes]) {
    if (n !== document.head && n !== document.body) n.remove();
  }
  for (const n of [...document.body.childNodes]) {
    if (n === CHROME) continue;
    if (n.nodeType !== 1) n.remove();
    else if (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE' || n.nodeName === 'LINK') n.remove();
  }
}

/** Mutate the document tree and show the result. `fn(tree)` gets the #root. */
function mutate(fn) {
  const { text: src } = canonicalText();
  const tree = parse(src).root;
  const result = fn(tree);
  applyDocument(serialize(tree));
  state.dirty = true;
  refresh();
  return result;
}

async function openText(name, src, handle = null) {
  const { text: canonical, warnings } = format(src, { style: modeOfText(src) });
  state.name = name || state.name;
  state.handle = handle;
  state.dirty = false;
  applyDocument(canonical);
  const note = canonical === src ? 'already canonical' : 'rewritten to canonical form';
  status(`opened ${state.name} (${note}, ${warnings.length} warning(s))`);
  if (warnings.length) console.info('neodoc: format warnings', warnings);
}

async function loadServed() {
  try {
    const res = await fetch('/doc');
    if (!res.ok) return false;
    const doc = await res.json();
    state.served = true;
    state.mode = doc.mode === 'none' ? 'none' : 'inline';
    await openText(doc.name, doc.text);
    return true;
  } catch { return false; }
}

function download(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/html;charset=utf-8' }));
  const a = h('a', { href: url, download: state.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function save() {
  const { text: src, warnings } = canonicalText();
  const bytes = new Blob([src]).size;
  let how;
  try {
    if (state.handle && state.handle.createWritable) {
      const w = await state.handle.createWritable();
      await w.write(src);
      await w.close();
      how = `wrote ${state.name}`;
    } else {
      const res = await fetch(`/save?path=${encodeURIComponent(state.name)}`, {
        method: 'POST', body: src, headers: { 'content-type': 'text/html;charset=utf-8' },
      });
      if (!res.ok) throw new Error(`POST /save -> ${res.status}`);
      how = `posted ${state.name}`;
    }
  } catch (err) {
    download(src);
    how = `downloaded ${state.name} (${err.message})`;
  }
  state.dirty = false;
  status(`${how} — ${bytes} bytes, ${warnings.length} warning(s)`);
  if (warnings.length) console.info('neodoc: save warnings', warnings);
  refresh();
}

// -------------------------------------------------------------- live tree view

let cachedTree = null;
let cachedRev = -1;
let domRev = 0;
const bumpDom = () => { domRev += 1; };
/** The live body as a parse tree — used for selectors and comment listing only. */
function liveTree() {
  if (cachedTree && cachedRev === domRev) return cachedTree;
  const html = blocksInBody().map((n) => n.outerHTML).join('\n');
  cachedTree = parse(`<body>\n${html}\n</body>`);
  cachedRev = domRev;
  return cachedTree;
}
/**
 * Canonical selector of a live element, e.g. `body > section:nth-child(2) > p:nth-child(3)`.
 *
 * select.js's selectorOf/pathOf stop walking when they reach the root they were
 * given, so they can never emit the leading `body` segment (selectorOf(body, el)
 * returns '' for a direct child of body). The path is therefore built here and
 * then resolved through select.js's query — the same engine `neodoc get` and
 * `addComment` use — so the status bar never prints a command that cannot run.
 */
function liveSelector(el) {
  const parts = [];
  for (let n = el; n && n !== document.body; n = n.parentNode) {
    const sibs = [...n.parentNode.children].filter((c) => c !== CHROME);
    const sameTag = sibs.filter((c) => c.nodeName === n.nodeName);
    let seg = n.nodeName.toLowerCase();
    if (n.id) seg += `#${n.id}`;
    else if (sibs.length > 1) {
      seg += sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(n) + 1})` : `:nth-child(${sibs.indexOf(n) + 1})`;
    }
    parts.unshift(seg);
  }
  const sel = ['body', ...parts].join(' > ');
  const body = liveTree().root.children[0];
  try { return query(body, sel) ? sel : 'body'; } catch { return 'body'; }
}

// ---------------------------------------------------------------- input rules

const INLINE_RULES = [
  [/!\[([^\]\n]*)\]\(([^)\s]+)\)$/, (m) => h('img', { alt: m[1], src: m[2] })],
  [/\[([^\]\n]+)\]\(([^)\s]+)\)$/, (m) => h('a', { href: m[2] }, text(m[1]))],
  [/\*\*([^*\n]+)\*\*$/, (m) => h('strong', {}, text(m[1]))],
  [/~~([^~\n]+)~~$/, (m) => h('s', {}, text(m[1]))],
  [/==([^=\n]+)==$/, (m) => h('mark', {}, text(m[1]))],
  [/`([^`\n]+)`$/, (m) => h('code', {}, text(m[1]))],
  [/(?<![*\w])\*([^*\n]+)\*$/, (m) => h('em', {}, text(m[1]))],
];

/** Replace a block and put the caret in `caretTarget` (default: the new block). */
function replaceBlock(block, next, caretTarget = next) {
  block.replaceWith(next);
  setCaret(caretTarget, 0);
  return true;
}

/**
 * Put the caret just after `node` so the next keystroke starts new content instead
 * of continuing the element we just created. Anchoring the range at
 * (parent, index+1) does not work: a browser resolves a block-final position to the
 * inside of a trailing inline element, so typing after `**bold**` would extend the
 * <strong>. A zero-length text node is unambiguous — and format() drops empty text
 * nodes, so it never reaches the file.
 */
function caretAfter(node) {
  const t = text('');
  node.after(t);
  setCaret(t, 0);
}

/** Block-start markdown rules: `# `, `- `, `1. `, `> `, ```` ``` ````, `---`. */
function runBlockRule() {
  const r = caretRange();
  if (!r || !r.collapsed) return false;
  const block = blockOf(r.startContainer);
  // Only a plain-text paragraph converts; an existing inline element means edit, not input.
  if (!block || block.nodeName !== 'P' || block.firstElementChild) return false;
  const pre = document.createRange();
  pre.setStart(block, 0);
  pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange();
  post.setStart(r.startContainer, r.startOffset);
  post.setEnd(block, block.childNodes.length);
  if (post.toString() !== '') return false;
  // Browsers type a trailing space as U+00A0; the markdown marker is " ".
  const s = pre.toString().replace(/\u00a0/g, ' ');
  let m;
  if ((m = /^(#{1,6}) $/.exec(s))) return replaceBlock(block, h(`h${m[1].length}`));
  if (/^[-*+] $/.test(s)) { const li = h('li'); return replaceBlock(block, h('ul', {}, li), li); }
  if (/^\d+\. $/.test(s)) { const li = h('li'); return replaceBlock(block, h('ol', {}, li), li); }
  if (s === '> ') { const p = h('p'); return replaceBlock(block, h('blockquote', {}, p), p); }
  if (s === '```') return replaceBlock(block, h('pre'));
  if (s === '---') {
    const hr = h('hr');
    block.replaceWith(hr);
    const after = h('p');
    hr.after(after);
    setCaret(after, 0);
    return true;
  }
  return false;
}

/** Closing-delimiter rules: `**b**`, `*i*`, `` `c` ``, `~~s~~`, `==m==`, `[t](u)`, `![a](u)`. */
function runInlineRule() {
  const r = caretRange();
  if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return false;
  const node = r.startContainer;
  const before = node.data.slice(0, r.startOffset);
  for (const [re, make] of INLINE_RULES) {
    const m = re.exec(before);
    if (!m) continue;
    const range = document.createRange();
    range.setStart(node, m.index);
    range.setEnd(node, r.startOffset);
    const el = make(m);
    range.deleteContents();
    range.insertNode(el);
    setCaretAfter(el);
    return true;
  }
  return false;
}

function onInput(e) {
  if (e && e.inputType && !/^insert(Text|CompositionText|FromComposition)$/.test(e.inputType)) return;
  if (state.suggest) return; // suggest mode inserts its own nodes
  runBlockRule();
  runInlineRule();
  edited();
}
const edited = () => { state.dirty = true; bumpDom(); refresh(); };

// ------------------------------------------------------------------- block edits

function setBlockName(block, name) {
  if (block.nodeName.toLowerCase() === name) name = 'p';
  const nu = h(name);
  while (block.firstChild) nu.append(block.firstChild);
  block.replaceWith(nu);
  selectContents(nu);
  return nu;
}
function toggleList(block, type) {
  const p = block.parentNode;
  if (block.nodeName === 'LI' && p.nodeName.toLowerCase() === type && p.children.length === 1) {
    const nu = h('p');
    while (block.firstChild) nu.append(block.firstChild);
    p.replaceWith(nu);
    selectContents(nu);
    return nu;
  }
  if (block.nodeName === 'LI' && p.nodeName.toLowerCase() === type) {
    const nu = h('p');
    while (block.firstChild) nu.append(block.firstChild);
    block.replaceWith(nu);
    selectContents(nu);
    return nu;
  }
  const li = h('li');
  while (block.firstChild) li.append(block.firstChild);
  block.replaceWith(h(type, {}, li));
  setCaret(li, 0);
  return li;
}
function toggleBlockquote(block) {
  if (block.parentNode.nodeName === 'BLOCKQUOTE' && block.parentNode.children.length === 1) {
    const q = block.parentNode;
    q.replaceWith(block);
    selectContents(block);
    return block;
  }
  const q = h('blockquote');
  block.replaceWith(q);
  q.append(block);
  selectContents(block);
  return block;
}
function toPre(block) {
  if (block.nodeName === 'PRE') {
    const nu = h('p');
    while (block.firstChild) nu.append(block.firstChild);
    block.replaceWith(nu);
    setCaret(nu, 0);
    return nu;
  }
  const pre = h('pre');
  while (block.firstChild) pre.append(block.firstChild);
  block.replaceWith(pre);
  setCaret(pre, 0);
  return pre;
}
function insertHrHere() {
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  const hr = h('hr');
  if (!block) { document.body.insertBefore(hr, CHROME); return; }
  block.after(hr);
  const p = h('p');
  hr.after(p);
  setCaret(p, 0);
}

function toggleInline(name, attrs = {}) {
  const r = caretRange();
  if (!r) return;
  const holder = r.collapsed ? null : ancestorNamed(r.commonAncestorContainer, name);
  if (holder && !r.collapsed) {
    const kids = [...holder.childNodes];
    holder.replaceWith(...kids);
    const sel = document.createRange();
    sel.setStartBefore(kids[0]);
    sel.setEndAfter(kids[kids.length - 1]);
    focusRange(sel);
    return;
  }
  const el = h(name, attrs);
  if (r.collapsed) {
    r.insertNode(el);
    setCaret(el, 0);
    return;
  }
  el.append(r.extractContents());
  r.insertNode(el);
  selectContents(el);
}
function ancestorNamed(node, name) {
  let n = node.nodeType === 3 ? node.parentNode : node;
  while (n && n !== document.body) {
    if (n.nodeName.toLowerCase() === name) return n;
    n = n.parentNode;
  }
  return null;
}

// -------------------------------------------------------------------- keyboard

function onEnter(e) {
  const r = caretRange();
  if (!r) return;
  e.preventDefault();
  const block = blockOf(r.startContainer);
  if (!block) {
    const p = h('p');
    r.deleteContents();
    r.insertNode(p);
    setCaret(p, 0);
    return edited();
  }
  const name = block.nodeName.toLowerCase();
  if (name === 'pre' || name === 'td' || name === 'th') return insertBreak();
  if (name === 'li') {
    if (block.textContent === '') {
      // Empty item: leave the list (or remove it, if it was the only item).
      const list = block.parentNode;
      const left = h('p');
      block.replaceWith(left);
      if (!list.children.length) list.remove();
      setCaret(left, 0);
    } else {
      const li = h('li');
      li.append(takeTail(block, r));
      block.after(li);
      setCaret(li, 0);
    }
    return edited();
  }
  if (name === 'p' && block.parentNode.nodeName === 'BLOCKQUOTE'
      && block.parentNode.children.length === 1 && block.textContent === '') {
    const q = block.parentNode;
    const after = h('p');
    q.after(after);
    q.remove();
    setCaret(after, 0);
    return edited();
  }
  const next = h('p');
  next.append(takeTail(block, r));
  block.after(next);
  if (!block.hasChildNodes()) block.remove();
  setCaret(next, 0);
  return edited();
}
/** Everything from the caret to the end of the block, as a fragment. */
function takeTail(block, range) {
  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(block, block.childNodes.length);
  const frag = after.extractContents();
  range.deleteContents();
  return frag;
}
/** A hard line break inside the current block (`<br>` is in the vocabulary). */
function insertBreak() {
  const r = caretRange();
  if (!r) return edited();
  r.deleteContents();
  const br = h('br');
  r.insertNode(br);
  setCaretAfter(br);
  edited();
}

function onShiftEnter(e) {
  e.preventDefault();
  insertBreak();
}

function onBackspace(e) {
  const r = caretRange();
  if (!r || !r.collapsed || state.suggest) return;
  const block = blockOf(r.startContainer);
  if (!block || !atBlockStart(r, block)) return;
  const name = block.nodeName.toLowerCase();
  if (name.startsWith('h') || name === 'li' || name === 'p') {
    if (block.textContent !== '') return;
    const container = block.parentNode;
    if (name === 'p' && container.nodeName !== 'BLOCKQUOTE') return;
    e.preventDefault();
    const left = h('p');
    while (block.firstChild) left.append(block.firstChild);
    if (container.nodeName === 'UL' || container.nodeName === 'OL') {
      container.after(left); // an empty item at the start of a list leaves the list
      block.remove();
      if (!container.children.length) container.remove();
    } else {
      block.replaceWith(left);
      if (container.nodeName === 'BLOCKQUOTE' && !container.children.length) container.remove();
    }
    setCaret(left, 0);
    return edited();
  }
  if (name !== 'p' || block.textContent !== '') return;
  const prev = block.previousElementSibling;
  if (!prev || !LEAF.has(prev.nodeName.toLowerCase())) return;
  e.preventDefault();
  while (prev.firstChild) block.prepend(prev.lastChild);
  prev.remove();
  setCaret(block, 0);
  return edited();
}

function onTab(e) {
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  if (!block || block.nodeName !== 'LI') return;
  e.preventDefault();
  const list = block.parentNode;
  if (e.shiftKey) {
    const outer = list.parentNode;
    if (outer === document.body || !['UL', 'OL', 'LI'].includes(outer.nodeName)) {
      // Top-level item: leave the list entirely.
      const left = h('p');
      while (block.firstChild) left.append(block.firstChild);
      block.replaceWith(left);
      if (!list.children.length) list.remove();
      setCaret(left, 0);
      return edited();
    }
    list.after(block);
    if (!list.children.length) list.remove();
    setCaret(block, 0);
    return edited();
  }
  const prev = block.previousElementSibling;
  if (!prev) return;
  let sub = prev.lastElementChild;
  if (!sub || sub.nodeName.toLowerCase() !== list.nodeName.toLowerCase()) {
    sub = h(list.nodeName.toLowerCase());
    prev.append(sub);
  }
  sub.append(block);
  setCaret(block, 0);
  return edited();
}

// --------------------------------------------------------------- suggest mode

/** Text offset of (container, offset) inside `block`. */
function offsetIn(block, container, offset) {
  if (container === block) {
    let n = 0;
    for (let i = 0; i < offset && i < block.childNodes.length; i++) n += block.childNodes[i].textContent.length;
    return n;
  }
  let n = 0;
  for (const t of textNodesIn(block)) {
    if (t === container) return n + offset;
    n += t.data.length;
  }
  return n;
}
function locate(block, offset) {
  let left = offset;
  for (const t of textNodesIn(block)) {
    if (left <= t.data.length) return [t, left];
    left -= t.data.length;
  }
  return [block, block.childNodes.length];
}
function suggestDelete(kind) {
  const r = caretRange();
  if (!r) return false;
  const block = blockOf(r.startContainer);
  if (!block) return false;
  const text0 = block.textContent;
  if (r.collapsed) {
    const back = /Backward/.test(kind);
    const word = /Word|Line/.test(kind);
    const at = offsetIn(block, r.startContainer, r.startOffset);
    let from = at;
    let to = at;
    if (back) {
      to = at;
      from = word ? wordBack(text0, at) : Math.max(0, at - 1);
    } else {
      from = at;
      to = word ? wordFwd(text0, at) : Math.min(text0.length, at + 1);
    }
    if (from === to) return false;
    const [sn, so] = locate(block, from);
    const [en, eo] = locate(block, to);
    r.setStart(sn, so);
    r.setEnd(en, eo);
  }
  if (!r.toString()) return false;
  const del = ancestorNamed(r.commonAncestorContainer, 'del');
  const ins = ancestorNamed(r.commonAncestorContainer, 'ins');
  if (del) { r.deleteContents(); return true; } // deleting our own deletion
  const removed = r.toString();
  const node = h('del', { 'data-author': AUTHOR, 'data-at': now() });
  node.append(r.extractContents());
  r.insertNode(node);
  if (ins) { /* deleting existing text inside our own insertion: still track it */ }
  setCaretAfter(node);
  console.info(`neodoc: tracked deletion of ${JSON.stringify(removed)}`);
  return true;
}
const wordBack = (s, at) => { let i = at; while (i > 0 && !/\s/.test(s[i - 1])) i--; while (i > 0 && /\s/.test(s[i - 1]) && i === at) i--; return i; };
const wordFwd = (s, at) => { let i = at; while (i < s.length && !/\s/.test(s[i])) i++; return i; };

function suggestInsert(data) {
  const r = caretRange();
  if (!r) return false;
  if (!r.collapsed) {
    // Replacing a selection under suggestion mode = tracked delete + tracked insert.
    const del = h('del', { 'data-author': AUTHOR, 'data-at': now() });
    del.append(r.extractContents());
    r.insertNode(del);
    if (!del.textContent) del.remove();
  }
  const r2 = caretRange();
  if (!blockOf(r2.startContainer)) ensureBlock(r2); // no inline element directly in <body>
  const at = caretRange();
  const host = currentIns(at.startContainer);
  if (host) {
    at.insertNode(text(data));
  } else {
    const ins = h('ins', { 'data-author': AUTHOR, 'data-at': now() }, text(data));
    at.insertNode(ins);
    setCaretAfter(ins.firstChild);
  }
  return true;
}
/** Put a caret inside a block, creating a <p> when the caret sits between blocks. */
function ensureBlock(range) {
  if (blockOf(range.startContainer)) return;
  const p = h('p');
  range.deleteContents();
  range.insertNode(p);
  setCaret(p, 0);
}
/** Reuse the <ins> the caret is already inside (same author) so runs stay merged. */
function currentIns(node) {
  const el = ancestorNamed(node, 'ins');
  return el && el.getAttribute('data-author') === AUTHOR ? el : null;
}

function onBeforeInput(e) {
  if (!state.suggest) return;
  const t = e.inputType || '';
  if (t === 'insertText' && e.data) {
    e.preventDefault();
    suggestInsert(e.data);
    edited();
  } else if (/^delete(Content|Word|SoftLine|HardLine)/.test(t)) {
    e.preventDefault();
    suggestDelete(t);
    edited();
  }
}

// ----------------------------------------------------------------------- paste

/** Drop or unwrap anything outside the vocabulary: pasted HTML is never trusted. */
function sanitizeTree(node) {
  const kids = [];
  for (const c of node.children || []) {
    if (c.type === 'text') { kids.push(c); continue; }
    if (c.type === 'comment') continue;
    const name = RENAMES[c.name] || c.name.toLowerCase();
    sanitizeTree(c);
    if (PASTE_DROP.has(name)) continue;
    if (name === 'aside' && c.attrs['data-thread']) continue; // pasted threads are metadata
    if (!VOCAB.has(name)) { kids.push(...(c.children || [])); continue; } // unwrap wrappers like <div>/<span>
    c.name = name;
    const attrs = {};
    for (const [k, v] of Object.entries(c.attrs || {})) if (isAttrAllowed(name, k)) attrs[k] = v;
    if (name === 'a') {
      const href = attrs.href || '';
      // Only navigable URLs survive; javascript:/data: hrefs would be behaviour.
      const ok = /^(https?:|mailto:|#|\/|\.)/i.test(href) || /^[\w.~-]+(\/|$)/.test(href);
      if (!ok || /^\s*(javascript|vbscript|data):/i.test(href)) delete attrs.href;
      if (!attrs.href && !attrs.id) { kids.push(...(c.children || [])); continue; }
    }
    if (name === 'img') {
      if (!attrs.src) continue;
      if (!attrs.alt) attrs.alt = '';
    }
    if (name === 'mark') delete attrs['data-c']; // an orphaned anchor would be a lint error
    c.attrs = attrs;
    kids.push(c);
  }
  node.children = kids;
}
function sanitizedNodes(html) {
  const { lines } = formatFragment(html);
  if (!lines.length) return [];
  const { root } = parse(`<body>\n${lines.join('\n')}\n</body>`);
  const body = root.children[0];
  if (!body) return [];
  sanitizeTree(body);
  return body.children.map(treeToDom).filter(Boolean);
}
function markdownNodes(md) {
  const { html, warnings } = fromMarkdown(md);
  if (warnings.length) console.info('neodoc: markdown paste warnings', warnings);
  return sanitizedNodes(html);
}
function onPaste(e) {
  const dt = e.clipboardData;
  if (!dt) return;
  const html = dt.getData('text/html');
  const md = dt.getData('text/markdown');
  const plain = dt.getData('text/plain');
  if (!html && !md && !plain) return;
  e.preventDefault();
  if (html) return insertNodes(sanitizedNodes(html));
  if (md) return insertNodes(markdownNodes(md));
  const nodes = [];
  plain.split('\n').forEach((line, i) => {
    if (i) nodes.push(h('br'));
    if (line) nodes.push(text(line));
  });
  return insertInline(nodes);
}
/** Insert a run of inline nodes at the caret. */
function insertInline(nodes) {
  if (!nodes.length) return;
  const r = caretRange();
  if (!r) return;
  if (!blockOf(r.startContainer)) {
    ensureBlock(r);
    const at = caretRange();
    at.insertNode(nodes[0]);
    for (const n of nodes.slice(1)) nodes[0].parentNode.insertBefore(n, nodes[0].nextSibling);
    setCaretAfter(nodes[nodes.length - 1]);
    return edited();
  }
  r.deleteContents();
  const frag = document.createDocumentFragment();
  frag.append(...nodes);
  r.insertNode(frag);
  setCaretAfter(nodes[nodes.length - 1]);
  edited();
}
/** Insert whole blocks at the caret: split the caret block, splice, re-close. */
function insertNodes(nodes) {
  if (!nodes.length) return;
  const r = caretRange();
  if (!r) return;
  const hasBlock = nodes.some((n) => n.nodeType === 1 && !['A', 'CODE', 'STRONG', 'EM', 'S', 'U', 'MARK', 'INS', 'DEL', 'SUB', 'SUP', 'IMG', 'BR', 'SPAN'].includes(n.nodeName));
  const block = blockOf(r.startContainer);
  if (!hasBlock || !block) return insertInline(nodes);
  const insideLi = ['UL', 'OL'].includes(block.parentNode.nodeName);
  const tail = takeTail(block, r);
  const parent = insideLi ? block : block.parentNode;
  const anchor = insideLi ? null : block.nextSibling;
  for (const n of nodes) parent.insertBefore(n, anchor);
  const tailEl = h('p');
  tailEl.append(tail);
  if (tailEl.textContent !== '' || tailEl.childNodes.length) {
    if (insideLi) block.append(tailEl); else parent.insertBefore(tailEl, anchor);
  }
  if (block.textContent === '' && !insideLi) block.remove();
  setCaret(tailEl.childNodes.length ? tailEl : nodes[nodes.length - 1], 0);
  edited();
}

// ---------------------------------------------------------------------- images

const readAsDataURL = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(file);
});
async function insertImage(file) {
  const src = state.embed ? await readAsDataURL(file) : `assets/${file.name}`;
  const img = h('img', { alt: file.name.replace(/\.[^.]+$/, ''), src });
  insertInline([img]);
  if (!state.embed) status(`linked ${src} — copy the file into assets/`);
  refresh();
}

// -------------------------------------------------------------------- comments

const bodyNodeOf = (root) => {
  const html = (root.children || []).find((c) => c.type === 'element' && c.name === 'html');
  return html && (html.children || []).find((c) => c.name === 'body');
};
function commentOnSelection() {
  const r = caretRange();
  if (!r) return;
  const block = blockOf(r.startContainer) || ancestorNamed(r.startContainer, 'p');
  if (!block) { status('put the caret in a block first'); return; }
  const quote = r.collapsed ? '' : r.toString();
  const body = prompt('Comment');
  if (!body) return;
  const selector = liveSelector(block);
  let made;
  try {
    made = mutate((tree) => addComment(tree, {
      body: bodyNodeOf(tree), selector, quote, text: body, author: AUTHOR, at: now(),
    }));
  } catch (err) {
    status(`comment failed: ${err.message}`);
    return;
  }
  const marked = document.querySelector(`mark[data-c="${made.id}"]`);
  if (marked) selectContents(marked);
  status(`comment ${made.id} added`);
}
function renderThreads() {
  const tree = liveTree().root;
  let threads = [];
  try { threads = listComments(tree) || []; } catch (err) { console.info('neodoc: listComments', err); }
  const list = $('#threads');
  list.replaceChildren();
  $('#no-comments').hidden = threads.length > 0;
  for (const t of threads) {
    const li = h('li', { 'data-id': t.id });
    li.append(h('b', {}, `${t.id} · ${t.author || 'unknown'}`));
    const bodyP = h('p');
    bodyP.textContent = t.text || '';
    li.append(bodyP);
    if (t.anchorText) { const q = h('blockquote'); q.textContent = t.anchorText; li.append(q); }
    const actions = h('p');
    if (t.state === 'resolved') {
      actions.append(h('em', {}, 'resolved'));
    } else {
      actions.append(h('button', { type: 'button', 'aria-label': `Resolve ${t.id}` }, 'Resolve'));
    }
    actions.append(h('button', { type: 'button', 'aria-label': `Reply to ${t.id}` }, 'Reply'));
    li.append(actions);
    list.append(li);
  }
  return threads;
}
function threadAction(id, action) {
  if (action === 'resolve') mutate((tree) => resolveComment(tree, id, true));
  if (action === 'reply') {
    const body = prompt(`Reply to ${id}`);
    if (!body) return;
    mutate((tree) => replyToComment(tree, id, { text: body, author: AUTHOR, at: now() }));
  }
  refresh();
}

// -------------------------------------------------------------------- commands

const COMMANDS = {
  open: () => openFile(),
  save: () => save(),
  strong: () => toggleInline('strong'),
  em: () => toggleInline('em'),
  u: () => toggleInline('u'),
  s: () => toggleInline('s'),
  code: () => toggleInline('code'),
  mark: () => toggleInline('mark'),
  a: () => {
    const url = prompt('Link URL', 'https://');
    if (url) toggleInline('a', { href: url });
  },
  h1: () => blockCommand((b) => setBlockName(b, 'h1')),
  h2: () => blockCommand((b) => setBlockName(b, 'h2')),
  h3: () => blockCommand((b) => setBlockName(b, 'h3')),
  h4: () => blockCommand((b) => setBlockName(b, 'h4')),
  h5: () => blockCommand((b) => setBlockName(b, 'h5')),
  h6: () => blockCommand((b) => setBlockName(b, 'h6')),
  ul: () => blockCommand((b) => toggleList(b, 'ul')),
  ol: () => blockCommand((b) => toggleList(b, 'ol')),
  blockquote: () => blockCommand((b) => toggleBlockquote(b)),
  pre: () => blockCommand((b) => toPre(b)),
  hr: () => { insertHrHere(); edited(); },
  img: () => $('#image-input').click(),
  comment: () => commentOnSelection(),
  suggest: () => toggleSuggest(),
  accept: () => changeCommand(acceptChanges, 'accepted'),
  reject: () => changeCommand(rejectChanges, 'rejected'),
  'copy-cli': () => { navigator.clipboard.writeText($('#st-cli').textContent); status('CLI command copied'); },
};
function blockCommand(fn) {
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  if (!block) { status('put the caret in a block first'); return; }
  fn(block);
  edited();
}
function changeCommand(fn, label) {
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  if (!block) { status('put the caret in a block first'); return; }
  const selector = liveSelector(block);
  try {
    const counts = mutate((tree) => fn(tree, selector));
    status(`${label} ${counts.ins} ins / ${counts.del} del in ${selector}`);
  } catch (err) { status(`${label} failed: ${err.message}`); }
}
function toggleSuggest() {
  state.suggest = !state.suggest;
  const btn = document.querySelector('[data-cmd="suggest"]');
  btn.setAttribute('aria-pressed', String(state.suggest));
  status(state.suggest ? 'suggest mode on — edits are tracked' : 'suggest mode off');
}

async function openFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Neodoc document', accept: { 'text/html': ['.html', '.htm'] } }],
      });
      const file = await handle.getFile();
      return openText(file.name, await file.text(), handle);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  $('#open-input').click();
}

// ---------------------------------------------------------------------- status

function refresh() {
  const { root } = liveTree();
  const body = root.children[0];
  $('#st-blocks').textContent = `${(body ? body.children.filter((c) => c.type === 'element') : []).length} blocks`;
  const sel = caretRange();
  const block = sel ? blockOf(sel.startContainer) : null;
  const path = block ? liveSelector(block) : 'body';
  $('#st-sel').textContent = path;
  $('#st-cli').textContent = `neodoc get ${state.name} '${path}'`;
  const threads = renderThreads();
  $('#st-comments').textContent = `${threads.filter((t) => t.state !== 'resolved').length} comments`;
  $('#st-dirty').textContent = state.dirty ? 'unsaved' : 'saved';
  $('#st-dirty').dataset.dirty = String(state.dirty);
}

// ------------------------------------------------------------------------ wire

// Buttons must not steal the selection from the document.
$('#chrome').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});
$('#chrome').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (btn) { const fn = COMMANDS[btn.dataset.cmd]; if (fn) fn(); return; }
  const threadBtn = e.target.closest('#threads button');
  if (threadBtn) {
    threadAction(threadBtn.closest('li').dataset.id, /Resolve/.test(threadBtn.getAttribute('aria-label')) ? 'resolve' : 'reply');
  }
});
$('#embed').addEventListener('change', (e) => { state.embed = e.target.checked; });
$('#open-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await openText(file.name, await file.text());
  e.target.value = '';
});
$('#image-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await insertImage(file);
  e.target.value = '';
});

document.addEventListener('input', (e) => {
  if (e.target === document.body || document.body.contains(e.target)) onInput(e);
});
document.addEventListener('beforeinput', onBeforeInput);
document.addEventListener('paste', onPaste);
document.addEventListener('selectionchange', () => {
  if (!document.body.contains(document.getSelection()?.anchorNode ?? document.body)) return;
  refresh();
});
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) {
    if (e.key === 'Tab') return onTab(e);
    if (e.key === 'Enter') return e.shiftKey ? onShiftEnter(e) : onEnter(e);
    if (e.key === 'Backspace') return onBackspace(e);
    return;
  }
  const code = e.code;
  if (e.altKey) {
    if (/^Digit[1-6]$/.test(code)) { e.preventDefault(); return COMMANDS[`h${code.slice(5)}`](); }
    if (code === 'KeyM') { e.preventDefault(); return commentOnSelection(); }
    return;
  }
  if (e.shiftKey) {
    if (code === 'Digit7') { e.preventDefault(); return COMMANDS.ol(); }
    if (code === 'Digit8') { e.preventDefault(); return COMMANDS.ul(); }
    return;
  }
  switch (e.key.toLowerCase()) {
    case 's': e.preventDefault(); return save();
    case 'b': e.preventDefault(); return COMMANDS.strong();
    case 'i': e.preventDefault(); return COMMANDS.em();
    case 'u': e.preventDefault(); return COMMANDS.u();
    case 'k': e.preventDefault(); return COMMANDS.a();
    default: return;
  }
});
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  const file = e.dataTransfer && [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  await insertImage(file);
});

// ------------------------------------------------------------------------ boot

sweepEditorNodes();
if (!(await loadServed())) {
  status('no file open — Open a .nd.html file, or run neodoc serve');
}
if (!blocksInBody().length) document.body.prepend(h('p'));
refresh();
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

// Exposed for the CLI/e2e driver: no behaviour depends on it.
window.neodocEditor = { canonicalText, save, openText, applyDocument, state, liveSelector };
