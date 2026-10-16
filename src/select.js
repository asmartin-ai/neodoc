// CSS-subset selector engine over the Neodoc parse tree (docs/SPEC.md §7).
// There is no DOM: matching walks the tree structure only, never text.
//
// Root rule: a selector matches *descendants* of `root`, never `root` itself.
// One documented exception: the bare selector `body` returns the body element,
// so the CLI can address the document root that all body-scoped selectors hang
// off. `body > section` needs no exception — the sections are descendants.
//
// ponytail: every query is a linear scan of the subtree (one parent map, built
// once per call), not an index; upgrade when a big document makes repeated
// queries visible in `neodoc bench`. No `an+b`, `:nth-last-child`, `:has` —
// the vocabulary does not need them.

import { descendants, isEl, pathOf } from './tree.js';

const WS = /\s/;
const IDENT_CH = /[A-Za-z0-9_-]/;

const isWs = (ch) => WS.test(ch);

function skipWs(s, i) {
  let j = i;
  while (j < s.length && isWs(s[j])) j++;
  return j;
}

function readIdent(s, i) {
  let j = i;
  while (j < s.length && IDENT_CH.test(s[j])) j++;
  return s.slice(i, j);
}

// ------------------------------------------------------------------- parsing

/** `[attr]`, `[attr=val]`, `[attr^=val]`, `[attr$=val]`, `[attr*=val]`; `i` is at `[`. */
function parseAttr(s, i) {
  let j = skipWs(s, i + 1);
  const name = readIdent(s, j);
  if (!name) throw new Error('missing attribute name in [ ]');
  j = skipWs(s, j + name.length);
  if (j >= s.length) throw new Error(`unclosed [ in selector (attribute '${name}')`);
  if (s[j] === ']') return [{ name: name.toLowerCase(), op: null, value: null }, j + 1];
  const two = s.slice(j, j + 2);
  const op = two === '^=' || two === '$=' || two === '*=' ? two : s[j] === '=' ? '=' : null;
  if (!op) throw new Error(`unsupported attribute operator '${s[j]}' in [${name}...]`);
  j = skipWs(s, j + op.length);
  let value;
  const quote = s[j];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, j + 1);
    if (end === -1) throw new Error(`unclosed quoted value in [${name}${op}...]`);
    value = s.slice(j + 1, end);
    j = end + 1;
  } else {
    const start = j;
    while (j < s.length && !isWs(s[j]) && s[j] !== ']') j++;
    value = s.slice(start, j);
    if (!value) throw new Error(`missing value after '${op}' in [${name}${op}]`);
  }
  j = skipWs(s, j);
  if (s[j] !== ']') throw new Error(`unclosed [ in selector (attribute '${name}')`);
  return [{ name: name.toLowerCase(), op, value }, j + 1];
}

/** `:first-child`, `:last-child`, `:nth-child(n)`, `:nth-of-type(n)`, `:not(simple)`; `i` is at `:`. */
function parsePseudo(s, i) {
  const name = readIdent(s, i + 1).toLowerCase();
  if (!name) throw new Error(`empty pseudo-class after ':' at ${i}`);
  let j = i + 1 + name.length;
  if (s[j] !== '(') {
    if (name === 'first-child' || name === 'last-child') return [{ name }, j];
    throw new Error(`unsupported pseudo-class :${name}`);
  }
  let depth = 0;
  let k = j;
  for (; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')' && --depth === 0) break;
  }
  if (k >= s.length) throw new Error(`unclosed ( in :${name}(`);
  const arg = s.slice(j + 1, k).trim();
  j = k + 1;
  if (name === 'nth-child' || name === 'nth-of-type') {
    if (!/^\d+$/.test(arg)) {
      throw new Error(`unsupported :${name}(${arg}) — only a plain 1-based integer is allowed`);
    }
    if (+arg < 1) throw new Error(`:${name}() is 1-based, got ${arg}`);
    return [{ name, arg: +arg }, j];
  }
  if (name === 'not') {
    if (!arg) throw new Error(':not() needs a tag, #id or [attr]');
    const [inner, end] = parseCompound(arg, 0);
    if (skipWs(arg, end) !== arg.length || inner.tag === '*' || inner.pseudos.length) {
      throw new Error(`unsupported :not(${arg}) — only a single tag, #id or [attr] is allowed`);
    }
    return [{ name: 'not', arg: inner }, j];
  }
  throw new Error(`unsupported pseudo-class :${name}()`);
}

/** A compound is `tag`? `#id`? `[attr]`* pseudo*; `i` is at its first character. */
function parseCompound(s, i) {
  const compound = { tag: null, id: null, attrs: [], pseudos: [] };
  let j = i;
  while (j < s.length && !isWs(s[j]) && s[j] !== '>' && s[j] !== ',') {
    const ch = s[j];
    if (ch === '*') {
      if (compound.tag) throw new Error(`unexpected '*' in selector at ${j}`);
      compound.tag = '*';
      j++;
    } else if (ch === '#') {
      const id = readIdent(s, j + 1);
      if (!id) throw new Error(`empty #id in selector at ${j}`);
      if (compound.id) throw new Error('two #id parts in one selector compound');
      compound.id = id;
      j += 1 + id.length;
    } else if (ch === '[') {
      const [attr, next] = parseAttr(s, j);
      compound.attrs.push(attr);
      j = next;
    } else if (ch === ':') {
      const [pseudo, next] = parsePseudo(s, j);
      compound.pseudos.push(pseudo);
      j = next;
    } else if (ch === '.') {
      throw new Error(`class selectors are not supported: .${readIdent(s, j + 1)}`);
    } else if (/[A-Za-z]/.test(ch)) {
      if (compound.tag) throw new Error(`unexpected tag '${readIdent(s, j)}' in selector at ${j}`);
      const name = readIdent(s, j);
      compound.tag = name.toLowerCase();
      j += name.length;
    } else {
      throw new Error(`unexpected '${ch}' in selector at ${j}`);
    }
  }
  if (!compound.tag && !compound.id && !compound.attrs.length && !compound.pseudos.length) {
    throw new Error(`empty selector part at position ${i}`);
  }
  return [compound, j];
}

/**
 * Parse a selector. Returns `{ text, groups }` where each group is a list of
 * `{ combinator, compound }` parts in source order (`combinator` is `'self'` for
 * the first part, then `'descendant'` or `'child'`). Throws `Error` on bad syntax.
 */
export function parseSelector(text) {
  // This is the selector I/O boundary: reject non-strings here rather than
  // letting a bad caller fail somewhere inside the matcher.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- I/O boundary check
  if (typeof text !== 'string') throw new Error('selector must be a string');
  const s = text.trim();
  if (!s) throw new Error('empty selector');
  const groups = [];
  let i = 0;
  for (;;) {
    i = skipWs(s, i);
    if (i >= s.length) throw new Error('empty selector part (stray or trailing comma)');
    const parts = [];
    const [first, afterFirst] = parseCompound(s, i);
    parts.push({ combinator: 'self', compound: first });
    i = afterFirst;
    for (;;) {
      const skipped = skipWs(s, i);
      const hadWs = skipped > i;
      i = skipped;
      if (i >= s.length || s[i] === ',') break;
      if (s[i] === '>') {
        i = skipWs(s, i + 1);
        if (i >= s.length) throw new Error("expected an element after '>'");
        const [compound, end] = parseCompound(s, i);
        parts.push({ combinator: 'child', compound });
        i = end;
      } else {
        if (s[i] === '+' || s[i] === '~' || s[i] === '|') {
          throw new Error(`unsupported combinator '${s[i]}' — use a space or '>'`);
        }
        if (!hadWs) throw new Error(`expected a combinator before '${s[i]}'`);
        const [compound, end] = parseCompound(s, i);
        parts.push({ combinator: 'descendant', compound });
        i = end;
      }
    }
    groups.push(parts);
    if (i >= s.length) break;
    i++; // the comma
  }
  return { text: s, groups };
}

// ------------------------------------------------------------------ matching

/**
 * Parent lookup for the whole tree (one map insert per node) plus a per-parent
 * cache of child positions, built the first time a selector asks about that
 * parent. Matching therefore stays linear: the old engine re-scanned a parent's
 * children — and ran `indexOf` — for every node, so `p:nth-child(1)` over 20,000
 * sibling paragraphs took 9.3s and `td:nth-of-type(3)` over 20,000 cells took 3.1s.
 */
function buildIndex(root) {
  const parent = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const child of node.children || []) {
      parent.set(child, node);
      stack.push(child);
    }
  }
  return { parent, siblings: new Map() };
}

const NO_SIBLINGS = { index: new Map(), elem: new Map(), count: -1, type: new Map() };

/** Child positions within `parent`, computed once per parent on demand. */
function siblingsOf(idx, parent) {
  if (!parent) return NO_SIBLINGS;
  const cached = idx.siblings.get(parent);
  if (cached) return cached;
  const index = new Map();
  const elem = new Map();
  const type = new Map();
  const seen = new Map();
  const kids = parent.children || [];
  let elements = 0;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    index.set(child, i);
    if (!isEl(child)) continue;
    elem.set(child, elements++);
    const before = seen.get(child.name) ?? 0;
    type.set(child, before);
    seen.set(child.name, before + 1);
  }
  const entry = { index, elem, count: elements, type };
  idx.siblings.set(parent, entry);
  return entry;
}

function matchCompound(node, compound, idx) {
  if (compound.tag && compound.tag !== '*' && node.name !== compound.tag) return false;
  const attrs = node.attrs || {};
  if (compound.id !== null && attrs.id !== compound.id) return false;
  for (const attr of compound.attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, attr.name)) return false;
    const value = attrs[attr.name];
    if (attr.op === '=' && value !== attr.value) return false;
    else if (attr.op === '^=' && !value.startsWith(attr.value)) return false;
    else if (attr.op === '$=' && !value.endsWith(attr.value)) return false;
    else if (attr.op === '*=' && !value.includes(attr.value)) return false;
  }
  if (!compound.pseudos.length) return true;
  const sib = siblingsOf(idx, idx.parent.get(node));
  for (const pseudo of compound.pseudos) {
    if (pseudo.name === 'not') {
      if (matchCompound(node, pseudo.arg, idx)) return false;
    } else if (pseudo.name === 'first-child') {
      if (sib.elem.get(node) !== 0) return false;
    } else if (pseudo.name === 'last-child') {
      if (sib.elem.get(node) !== sib.count - 1) return false;
    } else if (pseudo.name === 'nth-child') {
      if (sib.elem.get(node) !== pseudo.arg - 1) return false;
    } else if (pseudo.name === 'nth-of-type') {
      if (sib.type.get(node) !== pseudo.arg - 1) return false;
    }
  }
  return true;
}

/** Right-to-left: the rightmost compound must match `node`, then walk leftwards up. */
function matchesComplex(node, idx, parts, k) {
  if (!matchCompound(node, parts[k].compound, idx)) return false;
  if (k === 0) return true;
  let parent = idx.parent.get(node);
  if (parts[k].combinator === 'child') {
    return !!parent && isEl(parent) && matchesComplex(parent, idx, parts, k - 1);
  }
  while (parent && isEl(parent)) {
    if (matchesComplex(parent, idx, parts, k - 1)) return true;
    parent = idx.parent.get(parent);
  }
  return false;
}

const isBareBody = (sel) =>
  sel.groups.length === 1
  && sel.groups[0].length === 1
  && (() => {
    const c = sel.groups[0][0].compound;
    return c.tag === 'body' && c.id === null && !c.attrs.length && !c.pseudos.length;
  })();

function hit(node, idx) {
  const parent = idx.parent.get(node) ?? null;
  return { node, parent, index: parent ? siblingsOf(idx, parent).index.get(node) ?? -1 : -1 };
}

/**
 * All matches for `selectorText` (or a parsed selector), in document order, no
 * duplicates. Each result is `{ node, parent, index }`.
 */
export function queryAll(root, selectorText) {
  const sel = selectorText && selectorText.groups ? selectorText : parseSelector(selectorText);
  if (!sel || !sel.groups) throw new Error('selector must be a string or parseSelector() result');
  const idx = buildIndex(root);
  const out = [];
  if (isBareBody(sel)) {
    let body = isEl(root, 'body') ? root : null;
    if (!body) for (const node of descendants(root)) if (isEl(node, 'body')) { body = node; break; }
    if (body) out.push(hit(body, idx));
    return out;
  }
  for (const node of descendants(root)) {
    if (!isEl(node)) continue;
    for (const parts of sel.groups) {
      if (matchesComplex(node, idx, parts, parts.length - 1)) {
        out.push(hit(node, idx));
        break;
      }
    }
  }
  return out;
}

/** The first match in document order, or `null`. */
export function query(root, selectorText) {
  return queryAll(root, selectorText)[0] || null;
}

/** Round-trippable selector for `node` — the same string `pathOf` builds. */
export function selectorOf(root, node) {
  return pathOf(root, node);
}
