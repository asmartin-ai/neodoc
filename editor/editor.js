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
/**
 * Head nodes that belong to the editor rather than to the document: its
 * stylesheet. index.html serves it as `<link id="editor-css">`, the bundled
 * single-file page inlines it as `<style>`; at boot nothing else is in the head,
 * so anything style-like found now is ours. These nodes are kept out of the
 * canonical text and are never dropped when a document replaces the head.
 */
const EDITOR_HEAD = new Set([...document.head.children]
  .filter((n) => n.nodeName === 'STYLE' || n.nodeName === 'LINK'));
const $ = (sel) => document.querySelector(sel);

// Elements a caret can live in (the "block" in the status bar and in commands).
const LEAF = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'figcaption', 'pre']);
const CONTAINER = new Set(['ul', 'ol', 'blockquote', 'section', 'aside', 'figure', 'table',
  'thead', 'tbody', 'tr', 'li', 'td', 'th', 'figcaption']);
// Dropped outright from pasted content; everything else outside the vocabulary is
// unwrapped (kept as its children) so a paste can never inject behaviour.
const PASTE_DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
  'button', 'video', 'audio', 'svg', 'link', 'base', 'meta', 'title', 'head', 'body', 'html', 'template']);
// A document is untrusted input too, and these do something just by entering this
// page's DOM: run script, fetch a stylesheet, retarget every URL, or reload. `fmt`
// keeps them (they are content) and `lint` reports them, so a document containing
// one is refused here instead of being loaded — see README "Threat model".
const UNSAFE_IN_BODY = new Set(['script', 'style', 'link', 'base', 'meta', 'iframe', 'object', 'embed']);
/** Does this URL use a scheme that runs or loads in *this* page? */
const executableUrl = (href) => /^\s*(javascript|vbscript|data):/i.test(href.replace(/[\t\n\r]/g, ''));

/**
 * What may the editor do with this head child?
 *
 * `adopt`: `title`, `style` (already replaced by the canonical one) and any `meta`
 * without `http-equiv` — the document's name, charset, author, date, description.
 * `refuse`: `script`, `link`, `base` and `meta[http-equiv]`, which would execute, fetch
 * or retarget in the editor's own page (measured: a refresh meta navigates it), and
 * anything that is not metadata at all, which would render above the document.
 *
 * A head child the editor does **not** adopt is a head child the next save deletes,
 * because `canonicalText()` serializes what the live page holds — so refusing is the
 * only honest alternative to adopting. Narrowing this to `title` + `meta[charset]` once
 * dropped every `meta[name]` (author, date, description) from the file, silently.
 */
function headPolicy(node) {
  const name = RENAMES[node.name] || String(node.name).toLowerCase();
  if (name === 'title' || name === 'style') return 'adopt';
  if (name !== 'meta') return 'refuse';
  return (node.attrs || {})['http-equiv'] === undefined ? 'adopt' : 'refuse';
}

/** Head children this page must not adopt, by name. */
function unsafeHeadElements(root) {
  const html = (root.children || []).find((c) => c.type === 'element' && c.name === 'html');
  const head = html && (html.children || []).find((c) => c.name === 'head');
  const found = new Set();
  for (const c of (head && head.children) || []) {
    if (c.type === 'element' && headPolicy(c) === 'refuse') found.add(RENAMES[c.name] || String(c.name).toLowerCase());
  }
  return [...found];
}

const state = {
  name: 'untitled.nd.html', mode: 'inline', dirty: false, handle: null, suggest: false,
  embed: true, undo: [], savedText: '',
};

// An entry is a copy of the whole document, so the history is bounded by bytes.
const UNDO_BYTES = 4 * 1024 * 1024;
// Typing is coalesced into one entry per pause: 50 entries of per-keystroke history
// would be a serialization per keystroke, which a big document cannot afford.
const TYPING_PAUSE = 500;
let lastSnapshotAt = 0;

// Caret anchors. A browser resolves a block-final range to the end of the last
// *text* position, so once an input rule creates `<strong>x</strong>` at the end of
// a block, further typing extends the <strong> instead of starting new text — an
// empty text node or an empty element is not respected as an anchor (measured in
// Chromium). A zero-width space is, so anchors are seeded with one, and
// canonicalText() strips every ZWSP before format() runs: it never reaches a file.
const ZERO = '\u200B';
const textOnly = (s) => s.replace(/\u200B/g, '');
/** Is a block empty for editing purposes? ZWSP caret anchors are not content, and a
 *  lone `<br>` is a browser placeholder (or a break in an otherwise empty block). */
const blockEmpty = (el) => textOnly(el.textContent).trim() === '' && !el.querySelector('img, hr');

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
  if (!node.hasChildNodes()) node.append(text(ZERO)); // an empty node has no caret position
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
  return textOnly(r.toString()) === '';
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

/**
 * Body elements this page must not adopt, by name.
 *
 * Walks the `<body>` subtree only. Skipping anything *named* `head` (the first
 * version of this) is a bypass: `<body><head><script>…` is contradictory HTML that
 * `fmt` keeps as written, and skipping that subtree let a document with a script in
 * it through the refusal.
 */
function unsafeBodyElements(root) {
  const html = (root.children || []).find((c) => c.type === 'element' && c.name === 'html');
  const body = html && (html.children || []).find((c) => c.name === 'body');
  if (!body) return [];
  const found = new Set();
  (function walk(node) {
    for (const c of node.children || []) {
      if (c.type !== 'element') continue;
      const name = RENAMES[c.name] || String(c.name).toLowerCase();
      if (UNSAFE_IN_BODY.has(name)) found.add(name);
      walk(c);
    }
  })(body);
  return [...found];
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
  const assets = [...document.head.children].filter((n) => EDITOR_HEAD.has(n));
  const attrs = ['contenteditable', 'spellcheck'];
  const body = document.body;
  const saved = attrs.map((a) => body.getAttribute(a));
  CHROME.remove();
  for (const n of assets) n.remove();
  for (const a of attrs) body.removeAttribute(a);
  let html;
  try {
    // Strip the ZWSP caret anchors: they are editor state, never file content.
    html = '<!doctype html>\n' + document.documentElement.outerHTML.split(ZERO).join('');
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
  for (const n of [...document.head.children]) if (!EDITOR_HEAD.has(n)) n.remove();
  const adoptable = (head ? head.children : []).filter((c) => c.type === 'element' && headPolicy(c) === 'adopt');
  document.head.append(...adoptable.map(treeToDom).filter(Boolean), ...EDITOR_HEAD);
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

/**
 * Remember the document as it is *now*, so Ctrl+Z can come back to it.
 *
 * The browser's own undo history cannot be used: a command replaces the whole body,
 * which leaves that history pointing at detached nodes, and the browser then undoes
 * the wrong thing — measured: type, Enter, Ctrl+Z twice removed two characters from a
 * different block instead of undoing the Enter.
 */
function snapshot(text) {
  const current = text === undefined ? documentText() : text;
  lastSnapshotAt = Date.now();
  if (state.undo[state.undo.length - 1] === current) return;
  state.undo.push(current);
  let bytes = state.undo.reduce((n, t) => n + t.length, 0);
  while (state.undo.length > 1 && bytes > UNDO_BYTES) bytes -= state.undo.shift().length;
}

/** A typing snapshot, coalesced: serializing the document per keystroke is too much
 *  for a large one, so a pause is what lands in the history (see TYPING_PAUSE). */
function snapshotTyping() {
  if (Date.now() - lastSnapshotAt < TYPING_PAUSE) return;
  snapshot();
}

/** Step the document back one snapshot, keeping the caret in its block. */
function undo() {
  const here = documentText();
  let text = state.undo.pop();
  // A handler that took a snapshot and then changed nothing is not a step: skip it
  // rather than answer Ctrl+Z with a keystroke that shows no difference.
  while (text !== undefined && text === here) text = state.undo.pop();
  if (text === undefined) { status('nothing to undo'); return; }
  const keep = caretMark();
  const { text: canonical } = format(text, { style: modeOfText(text) });
  applyDocument(canonical);
  // Undoing back to what was saved is not "unsaved".
  state.dirty = canonical !== state.savedText;
  refresh();
  restoreCaret(keep);
  status(`undone — ${state.undo.length ? `${state.undo.length} more step(s)` : `dirty: ${state.dirty}`}`);
}

/**
 * The live document as text: the editor's own nodes and its caret anchors left out,
 * nothing parsed and nothing formatted.
 *
 * `canonicalText()` runs `format()` over the whole document, which costs 18–177 ms per
 * keystroke on a large one (measured, Chromium); a snapshot has to be cheaper than the
 * edit it guards. It is run through `format()` when it is restored instead.
 */
function documentText() {
  const one = (n) => (n.nodeType === 1 ? n.outerHTML : n.nodeType === 8 ? `<!--${n.textContent}-->` : n.textContent);
  const head = [...document.head.children].flatMap((n) => (EDITOR_HEAD.has(n) ? [] : [one(n)])).join('\n');
  const body = [...document.body.childNodes].flatMap((n) => (n === CHROME ? [] : [one(n)])).join('\n');
  // `cloneNode(false).outerHTML` is the open tag, escaped the way the serializer would
  // it: interpolating `a.value` by hand truncated `data-x="a&quot;b"` to `a` and
  // invented an attribute out of the quote.
  const open = document.documentElement.cloneNode(false).outerHTML;
  return `<!doctype html>\n${open}\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>`
    .split(ZERO).join('');
}

/**
 * Where the caret is: the canonical selector of the block it sits in plus the number
 * of characters into that block. `applyDocument` rebuilds the whole body, so a
 * command that changed something has to put the caret back itself — without this,
 * clicking Accept left the selection at (body, 0) and the next keystroke went
 * nowhere.
 */
/** Every block a caret can live in, in document order (the same set `blockOf` uses). */
function leafBlocks() {
  const sel = [...LEAF].join(',');
  return [...document.body.querySelectorAll(sel)].filter((n) => !CHROME.contains(n));
}

function caretMark() {
  const range = caretRange();
  const block = range && blockOf(range.startContainer);
  if (!block) return null;
  const mark = { selector: liveSelector(block), order: leafBlocks().indexOf(block), offset: 0 };
  if (range.startContainer.nodeType !== 3) {
    // An element position — the caret after a `<pre>` line break, say. The offset is
    // the text before it, so an undo does not put the caret at the start of the block.
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(range.startContainer, range.startOffset);
    mark.offset = before.toString().split(ZERO).join('').length;
    return mark;
  }
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let n = walk.nextNode(); n && n !== range.startContainer; n = walk.nextNode()) offset += n.length;
  if (walk.currentNode !== range.startContainer) return mark;
  mark.offset = offset + range.startOffset;
  return mark;
}

/** Put the caret back at `mark`, if the block it named is still in the document. */
function restoreCaret(mark) {
  if (!mark) return;
  let block = null;
  try { block = document.querySelector(mark.selector); } catch { /* an id with a quote in it */ }
  if (block && CHROME.contains(block)) block = null;
  // The block may be gone (the change we are undoing removed it) or have moved: fall
  // back to the block that is in its place, then to the last one. Never leave the
  // caret loose in <body>, where a keystroke goes nowhere.
  const blocks = leafBlocks();
  if (!block) {
    // The block is gone (the change being undone removed it) or it moved. The old
    // character offset means nothing in a different block, so the caret goes to the
    // end of the one that took its place — never loose in <body>, never mid-word.
    const took = blocks[mark.order] ?? blocks[blocks.length - 1] ?? blocks[0] ?? null;
    if (took) caretEndOf(took);
    return;
  }
  // The block may have lost text (the change being undone added it, like a `<pre>` line
  // break): an offset past the end means "the end", not an empty caret position.
  let left = Math.min(mark.offset, textOnly(block.textContent || '').length);
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (left <= n.length) { setCaret(n, left); return; }
    left -= n.length;
  }
  caretInto(block); // the block shrank under the caret: go to its start
}

/** Mutate the document tree and show the result. `fn(tree)` gets the #root. */
function mutate(fn) {
  const keep = caretMark();
  const before = documentText();
  const { text: src } = canonicalText();
  const tree = parse(src).root;
  const result = fn(tree);
  const next = serialize(tree);
  // A command that changed nothing (Accept with nothing to fold) is not an edit: no
  // history entry, no re-render, and the document does not become unsaved.
  if (next !== src) {
    snapshot(before);
    applyDocument(next);
    state.dirty = true;
    refresh();
    restoreCaret(keep);
  }
  return result;
}

async function openText(name, src, handle = null) {
  const { text: canonical, warnings } = format(src, { style: modeOfText(src) });
  const root = parse(canonical).root;
  const unsafe = [
    ...unsafeBodyElements(root).map((n) => `<${n}> in the body`),
    ...unsafeHeadElements(root).map((n) => `<${n}> in the head`),
  ];
  if (unsafe.length) {
    status(`refused ${name}: ${unsafe.join(', ')} can run, fetch or retarget in this page — remove it with another tool, then open it here`);
    console.warn('neodoc: refused to open', name, '—', unsafe);
    return false;
  }
  state.name = name || state.name;
  state.handle = handle;
  state.dirty = false;
  state.undo.length = 0;
  state.savedText = canonical;
  applyDocument(canonical);
  const note = canonical === src ? 'already canonical' : 'rewritten to canonical form';
  status(`opened ${state.name} (${note}, ${warnings.length} warning(s))`);
  if (warnings.length) console.info('neodoc: format warnings', warnings);
}

async function loadServed() {
  // A file:// page has no server: probing would only log a network error.
  if (location.protocol === 'file:') return false;
  try {
    const res = await fetch('/doc');
    if (!res.ok) {
      // The server refuses a document it cannot hand over intact (see serve.js). The
      // reason is the status line, so the boot must not replace it with "no file open".
      const why = res.headers.get('content-type')?.includes('json') ? (await res.json()).error : null;
      if (!why) return false;
      status(why);
      return why;
    }
    const doc = await res.json();
    state.mode = doc.mode === 'none' ? 'none' : 'inline';
    await openText(doc.name, doc.text);
    return true;
  } catch { return false; }
}

function download(src) {
  const url = URL.createObjectURL(new Blob([src], { type: 'text/html;charset=utf-8' }));
  const a = h('a', { href: url, download: state.name });
  // The click target must not be a child of <body>: that is the document.
  CHROME.append(a);
  // Chrome (measured, file:// and http) silently drops a download whose click runs
  // in the same task as the DOM churn canonicalText() does, so click in a new task.
  setTimeout(() => a.click(), 0);
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 10_000);
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
    } else if (location.protocol === 'file:') {
      throw new Error('no server on a file:// page'); // straight to the download
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
  state.savedText = src;
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
    // Same rule as src/tree.js `pathOf`: a tag that occurs once among its element
    // siblings needs no positional suffix, so the hint matches `neodoc get --json`.
    if (n.id) seg += `#${n.id}`;
    else if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(n) + 1})`;
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
  caretInto(caretTarget);
  return true;
}

/**
 * Put the caret just past `node`, seeding it with a ZWSP anchor (see ZERO above):
 * the next keystroke must start new content, not extend the element we just made.
 * `setCaretAfter` alone is not enough — a browser resolves the block-final
 * position to the inside of the trailing element.
 */
function anchorPast(node) {
  const t = text(ZERO);
  node.after(t);
  setCaret(t, 1);
}
/**
 * Put the caret at the start of a block. An empty block needs a ZWSP anchor: the
 * browser resolves a plain (block, 0) position out of an empty block (measured —
 * it lands at the body level), which loses where the next keystroke should go.
 */
function caretInto(block) {
  if (blockEmpty(block)) {
    block.replaceChildren(text(ZERO)); // also drops the browser's placeholder <br>
    setCaret(block.firstChild, 1);
    return;
  }
  setCaret(block, 0);
}
/** Put the caret at the end of a block's content (after moving it in the tree). */
function caretEndOf(block) {
  if (blockEmpty(block)) return caretInto(block);
  const r = document.createRange();
  r.selectNodeContents(block);
  r.collapse(false);
  focusRange(r);
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
  if (textOnly(post.toString()) !== '') return false;
  // Browsers type a trailing space as U+00A0; the markdown marker is " ".
  const s = textOnly(pre.toString()).replace(/\u00a0/g, ' ');
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
    caretInto(after);
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
    anchorPast(el);
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
  if (block.nodeName === 'LI' && p.nodeName.toLowerCase() === type) {
    // Leaving a list: with siblings, leave the item; as the only item, leave the list.
    const nu = h('p');
    while (block.firstChild) nu.append(block.firstChild);
    if (p.children.length === 1) p.replaceWith(nu); else block.replaceWith(nu);
    selectContents(nu);
    return nu;
  }
  if (block.nodeName === 'LI') {
    // An item of the other list type: retype the whole list, never nest one in the other.
    const nu = h(type);
    while (p.firstChild) nu.append(p.firstChild);
    p.replaceWith(nu);
    selectContents(block);
    return block;
  }
  const li = h('li');
  while (block.firstChild) li.append(block.firstChild);
  block.replaceWith(h(type, {}, li));
  caretInto(li);
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
    caretInto(nu);
    return nu;
  }
  const pre = h('pre');
  while (block.firstChild) pre.append(block.firstChild);
  block.replaceWith(pre);
  caretInto(pre);
  return pre;
}
function insertHrHere() {
  snapshot();
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  const hr = h('hr');
  if (!block) { document.body.insertBefore(hr, CHROME); return; }
  block.after(hr);
  const p = h('p');
  hr.after(p);
  caretInto(p);
}

function toggleInline(name, attrs = {}) {
  const r = caretRange();
  if (!r) return;
  snapshot();
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
    // Typing must land inside the new element, and an empty element has no caret
    // position of its own, so seed it with the ZWSP anchor.
    const z = text(ZERO);
    el.append(z);
    setCaret(z, 1);
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
  snapshot();
  const r = caretRange();
  if (!r) return;
  e.preventDefault();
  const block = blockOf(r.startContainer);
  if (!block) {
    // The caret can sit at an element position inside a list or table; ensureBlock
    // puts the paragraph where a block is actually allowed.
    ensureBlock(r);
    return edited();
  }
  const name = block.nodeName.toLowerCase();
  if (name === 'pre') { insertNewline(); return edited(); }
  if (name === 'td' || name === 'th') return insertBreak();
  if (name === 'li') {
    if (blockEmpty(block)) {
      // Empty item: leave the list — the paragraph belongs outside it (inside the
      // enclosing <li> when the list is nested, otherwise after the whole list).
      const list = block.parentNode;
      const left = h('p');
      list.after(left);
      block.remove();
      if (!list.children.length) list.remove();
      caretInto(left);
    } else {
      const li = h('li');
      li.append(takeTail(block, r));
      block.after(li);
      caretInto(li);
    }
    return edited();
  }
  if (name === 'p' && block.parentNode.nodeName === 'BLOCKQUOTE'
      && block.parentNode.children.length === 1 && blockEmpty(block)) {
    const q = block.parentNode;
    const after = h('p');
    q.after(after);
    q.remove();
    caretInto(after);
    return edited();
  }
  const next = h('p');
  next.append(takeTail(block, r));
  block.after(next);
  if (!block.hasChildNodes()) block.remove();
  caretInto(next);
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
  if (!blockOf(r.startContainer)) ensureBlock(r);
  const at = caretRange();
  at.deleteContents();
  const br = h('br');
  at.insertNode(br);
  anchorPast(br);
  edited();
}
/** `pre` keeps newlines verbatim, so a line break there is a "\n", not a `<br>`. */
function insertNewline() {
  const r = caretRange();
  if (!r) return edited();
  if (!blockOf(r.startContainer)) ensureBlock(r);
  const at = caretRange();
  at.deleteContents();
  const nl = text('\n');
  at.insertNode(nl);
  anchorPast(nl);
  edited();
}

function onShiftEnter(e) {
  snapshot();
  e.preventDefault();
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  if (block && block.nodeName === 'PRE') insertNewline(); else insertBreak();
}

function onBackspace(e) {
  snapshot();
  const r = caretRange();
  if (!r || !r.collapsed || state.suggest) return;
  const block = blockOf(r.startContainer);
  if (!block || !atBlockStart(r, block)) return;
  const name = block.nodeName.toLowerCase();
  if (name.startsWith('h') || name === 'li' || name === 'p') {
    if (!blockEmpty(block)) return;
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
    caretInto(left);
    return edited();
  }
  if (name !== 'p' || !blockEmpty(block)) return;
  const prev = block.previousElementSibling;
  if (!prev || !LEAF.has(prev.nodeName.toLowerCase())) return;
  e.preventDefault();
  while (prev.firstChild) block.prepend(prev.lastChild);
  prev.remove();
  caretInto(block);
  return edited();
}

function onTab(e) {
  snapshot();
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  if (!block || block.nodeName !== 'LI') return;
  e.preventDefault();
  const list = block.parentNode;
  if (e.shiftKey) {
    const outer = list.parentNode;
    if (outer.nodeName === 'LI') {
      // A nested list lives in an <li> of the outer list: the item moves up into
      // that outer list, right after the <li> that held the nested list.
      outer.after(block);
      if (!list.children.length) list.remove();
      // Moving a node makes the browser re-resolve the selection to an element
      // position (ul@1), so put it back on text inside the item.
      caretEndOf(block);
      return edited();
    }
    // Top-level item: leave the list entirely.
    const left = h('p');
    while (block.firstChild) left.append(block.firstChild);
    block.replaceWith(left);
    if (!list.children.length) list.remove();
    caretInto(left);
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
  caretEndOf(block); // see onTab outdent: an element position is not a caret
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
  if (!textOnly(r.toString())) { r.deleteContents(); return true; } // a caret anchor is not content
  const del = ancestorNamed(r.commonAncestorContainer, 'del');
  const ins = ancestorNamed(r.commonAncestorContainer, 'ins');
  if (del) {
    r.deleteContents();
    if (!del.textContent) del.remove(); // an empty <del> is not a change anymore
    return true;
  }
  const removed = r.toString();
  const node = h('del', { 'data-author': AUTHOR, 'data-at': now() });
  node.append(r.extractContents());
  r.insertNode(node);
  if (ins) { /* the caret sat in our own <ins>: the deletion is still tracked */ }
  anchorPast(node);
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
    if (del.textContent) {
      r.insertNode(del);
      setCaretAfter(del);
    }
  }
  const at = caretRange();
  if (!at) return false;
  if (!blockOf(at.startContainer)) ensureBlock(at); // a block, never inline content in <body>
  const caret = caretRange();
  const node = text(data);
  if (currentIns(caret.startContainer)) {
    caret.insertNode(node); // merge into the <ins> we are already typing in
  } else {
    caret.insertNode(h('ins', { 'data-author': AUTHOR, 'data-at': now() }, node));
  }
  // insertNode on a *live* selection range leaves that range selecting the inserted
  // node, so the next keystroke would think it is replacing a selection.
  setCaretAfter(node);
  return true;
}
/**
 * Put a caret inside a block, creating a <p> when the caret sits between blocks.
 * A <p> is not allowed everywhere a caret can be (ul/ol/table containers), so the
 * new paragraph goes after the nearest ancestor that cannot hold one.
 */
function ensureBlock(range) {
  if (blockOf(range.startContainer)) return;
  const p = h('p');
  let outer = range.startContainer;
  while (outer && outer !== document.body && !['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TR'].includes(outer.nodeName)) {
    outer = outer.parentNode;
  }
  if (outer && outer !== document.body) {
    outer.after(p);
  } else {
    range.deleteContents();
    range.insertNode(p);
  }
  caretInto(p);
}
/** Reuse the <ins> the caret is already inside (same author) so runs stay merged. */
function currentIns(node) {
  const el = ancestorNamed(node, 'ins');
  return el && el.getAttribute('data-author') === AUTHOR ? el : null;
}

function onBeforeInput(e) {
  const t = e.inputType || '';
  // A text insertion has not happened yet, which is exactly the state Ctrl+Z has to
  // come back to. Coalesced into one entry per typing pause (see TYPING_PAUSE);
  // suggest mode edits the tree on every one of these events.
  if (state.suggest || /^insert(Text|CompositionText|FromComposition)$/.test(t)) snapshotTyping();
  if (!state.suggest) return;
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
      // The HTML parser removes tab/LF/CR from a URL before resolving it, so the
      // check has to see `java\tscript:` as `javascript:`.
      if (!ok || executableUrl(href)) delete attrs.href;
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
  snapshot();
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
    anchorPast(nodes[nodes.length - 1]);
    return edited();
  }
  r.deleteContents();
  const frag = document.createDocumentFragment();
  frag.append(...nodes);
  r.insertNode(frag);
  anchorPast(nodes[nodes.length - 1]);
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
  if (textOnly(tailEl.textContent) !== '') {
    if (insideLi) block.append(tailEl); else parent.insertBefore(tailEl, anchor);
  }
  if (blockEmpty(block) && !insideLi) block.remove();
  if (textOnly(tailEl.textContent) !== '') caretInto(tailEl);
  else anchorPast(nodes[nodes.length - 1]);
  edited();
}

// ---------------------------------------------------------------------- images

/** File names the CLI accepts: report.nd.html, report.ndoc.html, report.ndoc. */
const DOC_NAME = /\.(?:nd\.html|ndoc\.html|ndoc|html|htm)$/i;

const readAsDataURL = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(file);
});
async function insertImage(file) {
  snapshot();
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
  const quote = r.collapsed ? '' : textOnly(r.toString());
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
    // editor.css dims a resolved thread through this attribute.
    if (t.state === 'resolved') li.setAttribute('data-resolved', '');
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
  'copy-cli': () => {
    const cmd = $('#st-cli').textContent;
    const pending = navigator.clipboard && navigator.clipboard.writeText(cmd);
    if (pending && pending.then) {
      pending.then(() => status('CLI command copied'),
        () => { selectContents($('#st-cli')); status('clipboard blocked — the command is selected, copy it manually'); });
    } else {
      // No clipboard API (non-secure origin, file:// in Firefox, hardened builds).
      selectContents($('#st-cli'));
      status('clipboard blocked — the command is selected, copy it manually');
    }
  },
};
function blockCommand(fn) {
  const r = caretRange();
  const block = r && blockOf(r.startContainer);
  if (!block) { status('put the caret in a block first'); return; }
  snapshot();
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
        types: [{
          description: 'Neodoc document',
          accept: { 'text/html': ['.nd.html', '.ndoc.html', '.ndoc', '.html', '.htm'] },
        }],
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
  const key = e.key.toLowerCase();
  if (key === 'z' || key === 'y') {
    // A comment box (inside the chrome) keeps the browser's own undo, which is the
    // right one for a text field; the document's history is ours.
    if (CHROME.contains(document.getSelection() && document.getSelection().anchorNode)) return;
    e.preventDefault();
    if (key === 'z' && !e.shiftKey) undo();
    else status('redo is not available — the editor keeps undo only');
    return;
  }
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
  const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
  if (types.includes('Files') || types.includes('text/html') || types.includes('text/plain')) e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
  if (!files.length) {
    // A dropped fragment is pasted content, so it goes through the paste
    // sanitizer: the browser would otherwise insert its markup verbatim.
    const html = e.dataTransfer?.getData('text/html');
    const plain = e.dataTransfer?.getData('text/plain');
    if (!html && !plain) return;
    e.preventDefault();
    snapshot(); // a dropped fragment is an edit like any other
    if (html) return insertNodes(sanitizedNodes(html));
    return insertInline(plain.split('\n').flatMap((line, i) => (i ? [h('br'), text(line)] : [text(line)])));
  }
  e.preventDefault();
  const image = files.find((f) => f.type.startsWith('image/'));
  if (image) return insertImage(image);
  const doc = files.find((f) => DOC_NAME.test(f.name));
  if (doc) await openText(doc.name, await doc.text());
});

// ------------------------------------------------------------------------ boot

sweepEditorNodes();
if ((await loadServed()) === false) {
  status('no file open — Open a .nd.html (or drop one in); Save writes through the browser file handle when available, else downloads it');
}
if (!blocksInBody().length) document.body.prepend(h('p'));
refresh();
// A document's links are content, but an executable scheme navigates or runs in
// this page rather than opening somewhere else.
document.addEventListener('click', (e) => {
  const hit = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (hit && executableUrl(hit.getAttribute('href') || '')) {
    e.preventDefault();
    status('refused a link with an executable URL');
  }
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

// Exposed for the CLI/e2e driver: no behaviour depends on it.
window.neodocEditor = { canonicalText, save, openText, applyDocument, state, liveSelector };
