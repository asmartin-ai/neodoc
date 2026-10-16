// Comments and tracked changes over the parse tree (docs/SPEC.md §5).
// Every function mutates the tree in place and returns plain data.
//
// `tree` is the document root from `parse()` (the `#root` pseudo-element), so id
// scans and `pathOf` see the whole document; `body` (addComment only) is the
// element the comment *selector* is resolved against.
//
// ponytail: a quote must sit inside a single text node — matching does not span
// inline markup; upgrade when someone quotes across `<strong>` boundaries.

import { descendants, el, isEl, pathOf, textOf, txt, walk } from './tree.js';
import { query, queryAll } from './select.js';

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

function parentsOf(root) {
  const map = new Map();
  walk(root, (node) => {
    for (const child of node.children || []) map.set(child, node);
  });
  return map;
}

/** Smallest `c<n>` not used by any `data-c` or `data-thread` in the document. */
export function newId(tree) {
  const used = new Set();
  walk(tree, (node) => {
    if (!isEl(node)) return;
    if (has(node.attrs, 'data-c')) used.add(node.attrs['data-c']);
    if (has(node.attrs, 'data-thread')) used.add(node.attrs['data-thread']);
  });
  for (let n = 1; ; n++) if (!used.has(`c${n}`)) return `c${n}`;
}

function findThread(tree, id) {
  for (const node of descendants(tree)) {
    if (isEl(node, 'aside') && node.attrs['data-thread'] === id) return node;
  }
  return null;
}

function findMark(tree, id) {
  for (const node of descendants(tree)) {
    if (isEl(node, 'mark') && node.attrs['data-c'] === id) return node;
  }
  return null;
}

function replyP(text, author, at) {
  const attrs = {};
  if (author !== undefined) attrs['data-author'] = author;
  if (at !== undefined) attrs['data-at'] = at;
  return el('p', attrs, [txt(text === undefined ? '' : String(text))]);
}

/** First text node under `node` that contains `quote`, with its parent. */
function findTextHolder(node, quote) {
  for (const child of node.children || []) {
    if (child.type === 'text') {
      if (child.text.includes(quote)) return { parent: node, node: child };
    } else if (child.children) {
      const hit = findTextHolder(child, quote);
      if (hit) return hit;
    }
  }
  return null;
}

/** Wrap exactly `quote` inside the block, splitting its text node in three. */
function wrapQuote(block, quote, id) {
  const holder = findTextHolder(block, quote);
  if (!holder) return null;
  const { parent, node } = holder;
  const at = node.text.indexOf(quote);
  const mark = el('mark', { 'data-c': id }, [txt(quote)]);
  const replacement = [];
  const before = node.text.slice(0, at);
  const after = node.text.slice(at + quote.length);
  if (before) replacement.push(txt(before));
  replacement.push(mark);
  if (after) replacement.push(txt(after));
  parent.children.splice(parent.children.indexOf(node), 1, ...replacement);
  return mark;
}

/** Where the thread goes: after the block, or after its enclosing section/aside. */
function threadSlot(block, parents) {
  let node = block;
  let parent = parents.get(node);
  while (parent && (isEl(parent, 'section') || isEl(parent, 'aside'))) {
    node = parent;
    parent = parents.get(node);
  }
  if (!parent || !parent.children) {
    throw new Error('cannot place comment thread: selected block has no parent');
  }
  return { parent, node };
}

/**
 * Anchor a comment to the element matched by `selector` within `body`, then
 * insert its thread `<aside>` right after the block (never inside a
 * section/aside). With `quote`, only that substring is wrapped; without it, all
 * inline children of the block are wrapped.
 * Returns `{ id, anchor, threadPath }` — `anchor` is the `<mark data-c>` element.
 */
export function addComment(tree, { body, selector, quote, text, author, at } = {}) {
  if (!body || !selector) throw new Error('addComment needs { body, selector }');
  const parents = parentsOf(tree);
  const found = query(body, selector);
  if (!found || !isEl(found.node)) throw new Error(`selector matched no element: ${selector}`);
  const block = found.node;
  for (let node = block; node; node = parents.get(node)) {
    if (isEl(node, 'head')) throw new Error(`cannot anchor a comment inside <head>: ${selector}`);
  }
  const id = newId(tree);
  let mark;
  if (quote) {
    mark = wrapQuote(block, quote, id);
    if (!mark) throw new Error(`quote not found in the block matched by "${selector}": ${quote}`);
  } else {
    mark = el('mark', { 'data-c': id }, block.children || []);
    block.children = [mark];
  }
  const { parent: slotParent, node: slotNode } = threadSlot(block, parents);
  const thread = el('aside', { 'data-thread': id, 'data-state': 'open' }, [replyP(text, author, at)]);
  slotParent.children.splice(slotParent.children.indexOf(slotNode) + 1, 0, thread);
  return { id, anchor: mark, threadPath: pathOf(tree, thread) };
}

/** Every `<aside data-thread>` in document order. `data-state` missing = `open`. */
export function listComments(tree) {
  const out = [];
  walk(tree, (node) => {
    if (!isEl(node, 'aside') || !has(node.attrs, 'data-thread')) return;
    const id = node.attrs['data-thread'];
    const paragraphs = (node.children || []).filter((c) => isEl(c, 'p'));
    const first = paragraphs[0];
    const mark = findMark(tree, id);
    out.push({
      id,
      state: node.attrs['data-state'] || 'open',
      author: first ? first.attrs['data-author'] : undefined,
      at: first ? first.attrs['data-at'] : undefined,
      text: first ? textOf(first) : '',
      anchorText: mark ? textOf(mark) : '',
      path: pathOf(tree, node),
      replies: paragraphs.slice(1).map((p) => ({
        author: p.attrs['data-author'],
        at: p.attrs['data-at'],
        text: textOf(p),
      })),
    });
  });
  return out;
}

/** `resolveComment(tree, id, false)` reopens. Returns the thread `<aside>`. */
export function resolveComment(tree, id, resolved = true) {
  const thread = findThread(tree, id);
  if (!thread) throw new Error(`no comment thread ${id}`);
  thread.attrs['data-state'] = resolved ? 'resolved' : 'open';
  return thread;
}

/** Append a reply `<p data-author data-at>`; returns that `<p>`. */
export function replyToComment(tree, id, { text, author, at } = {}) {
  const thread = findThread(tree, id);
  if (!thread) throw new Error(`no comment thread ${id}`);
  const reply = replyP(text, author, at);
  thread.children.push(reply);
  return reply;
}

/** Drop every `<mark data-c=id>` (unwrapping its children) and the thread. */
export function removeComment(tree, id) {
  const parents = parentsOf(tree);
  const marks = [];
  const threads = [];
  walk(tree, (node) => {
    if (isEl(node, 'mark') && node.attrs['data-c'] === id) marks.push(node);
    else if (isEl(node, 'aside') && node.attrs['data-thread'] === id) threads.push(node);
  });
  for (const mark of marks) {
    const parent = parents.get(mark);
    if (!parent || !parent.children) continue;
    parent.children.splice(parent.children.indexOf(mark), 1, ...(mark.children || []));
  }
  for (const thread of threads) {
    const parent = parents.get(thread);
    if (parent && parent.children) parent.children.splice(parent.children.indexOf(thread), 1);
  }
  return { marks: marks.length, threads: threads.length };
}

/** Depth-first rebuild: `fn(element) -> children[]` unwraps, `[]` deletes, `null` keeps. */
function sweep(node, fn) {
  if (!node.children) return;
  const out = [];
  for (const child of node.children) {
    sweep(child, fn);
    const replacement = fn(child);
    if (replacement) out.push(...replacement);
    else out.push(child);
  }
  node.children = out;
}

/** The nodes inside each element matched by `selector` (the whole tree if omitted). */
function scopeOf(tree, selector) {
  if (!selector) return null;
  const scope = new Set();
  for (const found of queryAll(tree, selector)) {
    if (!isEl(found.node)) continue;
    scope.add(found.node);
    for (const node of descendants(found.node)) scope.add(node);
  }
  return scope;
}

/**
 * Accepting a change means **the deletion stands and the insertion stands**: the
 * `<ins>` text stays (element unwrapped) and the `<del>` text is gone (element
 * and subtree removed). That asymmetry is deliberate — `rejectChanges` is the
 * inverse. Returns `{ ins, del }` counts.
 */
export function acceptChanges(tree, selector) {
  return fold(tree, selector, 'ins', 'del');
}

/**
 * Rejecting a change undoes it: the `<ins>` text is gone, and the `<del>` is
 * dropped as an element so its text comes back. Returns `{ ins, del }` counts.
 */
export function rejectChanges(tree, selector) {
  return fold(tree, selector, 'del', 'ins');
}

/** `keep` is unwrapped (its text survives), `gone` is removed with its subtree. */
function fold(tree, selector, keep, gone) {
  const scope = scopeOf(tree, selector);
  const counts = { [keep]: 0, [gone]: 0 };
  sweep(tree, (node) => {
    if (!isEl(node)) return null;
    if (node.name !== keep && node.name !== gone) return null;
    if (scope && !scope.has(node)) return null;
    counts[node.name]++;
    return node.name === keep ? node.children || [] : [];
  });
  return counts;
}
