// Normalization + canonical serialization (docs/SPEC.md §4). `format` is the
// whole contract: parse → normalize → serialize, and it is idempotent.
//
// ponytail: whitespace model is collapse-runs + trim-block-edges, not CSS
// white-space emulation; upgrade when a user needs significant leading spaces
// in inline content. No HTML5 tree-construction (no foster parenting); upgrade
// when a real document hits table-misnesting cases.

import { parse } from './parse.js';
import { THEME_CSS } from './theme.js';
import { GENERATOR } from './version.js';
import { BLOCK, HEAD_MOVED, RENAMES, VOID, hasBlockChild, isDroppedAttr, isEmptyInline } from './tree.js';
import { escapeText, escapeAttr } from './entities.js';

const INDENT = '  ';

// The whitespace model of docs/SPEC.md §4.4 is exactly space, tab, LF, CR and FF.
// `\s` would also match U+00A0, U+2000-U+200A, U+3000 and U+FEFF, so a decoded
// `&nbsp;` would collapse to a space and lose its no-break meaning.
const WHITESPACE_RUN = /[ \t\n\r\f]+/g;
const TRIM_START = /^[ \t\n\r\f]+/;
const TRIM_END = /[ \t\n\r\f]+$/;
const needsCollapsing = /[ \t\n\r\f]/;

/** Strip the model whitespace a browser's `white-space: normal` would strip. */
function trimModel(text) {
  return text.replace(TRIM_START, '').replace(TRIM_END, '');
}

// ---------------------------------------------------------------- normalization

function cleanAttrs(name, attrs, warnings) {
  const out = {};
  for (const rawKey of Object.keys(attrs)) {
    const key = rawKey.toLowerCase();
    const value = attrs[rawKey];
    if (key === 'align' && (name === 'td' || name === 'th')) {
      out['data-align'] = value.toLowerCase();
      continue;
    }
    if (isDroppedAttr(key)) {
      warnings.push(`${name}: dropped attribute "${key}" (presentational or event handler)`);
      continue;
    }
    out[key] = value; // unknown attributes are kept: lint reports them
  }
  if (name === 'img' && out.alt === undefined) out.alt = '';
  // `width`/`height` are kept exactly as written: SPEC §3 allows them, and `50%` or
  // `12em` is as legitimate as `300`. A consumer that cannot read one ignores it
  // (docx falls back to its own size) rather than having it deleted here.
  if (name === 'a' && out.target === '_blank' && !out.rel) out.rel = 'noopener';
  return out;
}

/** Elements that hold inline flow, where a comment must not force a line break. */
const INLINE_FLOW = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'li', 'td', 'th']);

const INLINE_MERGEABLE = new Set(['strong', 'em', 's', 'u', 'del', 'ins', 'mark', 'code', 'sub', 'sup']);

function normalizeElement(node, warnings) {
  const name = RENAMES[node.name] || node.name;
  const out = {
    type: 'element',
    name,
    attrs: cleanAttrs(name, node.attrs, warnings),
    children: normalizeChildren(node.children || [], name, warnings),
  };
  // merge <strong><strong>x</strong></strong>
  while (out.children.length === 1 && INLINE_MERGEABLE.has(name)) {
    const only = out.children[0];
    if (only.type === 'element' && only.name === name && hasNoAttrs(only.attrs)) {
      out.children = only.children;
    } else break;
  }
  return out;
}

function hasNoAttrs(attrs) {
  for (const _ in attrs) return false;
  return true;
}

function normalizeChildren(children, parentName, warnings) {
  const mapped = [];
  for (const child of children) {
    if (child.type === 'element') {
      const norm = normalizeElement(child, warnings);
      if (isEmptyInline(norm)) continue;
      mapped.push(norm);
    } else if (child.type === 'text') {
      if (child.mode === 'pre' && parentName === 'pre') {
        mapped.push({ type: 'text', text: normalizePre(child.text), mode: 'pre' });
      } else if (child.mode === 'raw') {
        mapped.push({ type: 'text', text: stripRawBlank(child.text), mode: 'raw' });
      } else {
        mapped.push({ type: 'text', text: child.text });
      }
    } else {
      mapped.push({ ...child, text: trimModel(String(child.text ?? '').replace(/--+/g, '-')) });
    }
  }
  return fixWhitespace(mapped);
}

/**
 * Raw text (style/script/textarea) is emitted one line per line at column 0, so
 * the blank lines that adds around it are not content: trimming both ends is what
 * makes a second pass a no-op. Without this the file grows a blank line per `fmt`.
 */
function stripRawBlank(text) {
  return trimModel(text.replace(/\r\n?/g, '\n')) + '\n';
}

/** Whitespace model, docs/SPEC.md §4.4. Mutates its own children in place: every
 *  node reaching this function was created by normalizeChildren, so no caller
 *  holds a reference to the text it replaces. */
function fixWhitespace(children) {
  const block = hasBlockChild(children);
  const kept = [];
  for (const child of children) {
    if (child.type !== 'text' || child.mode) { kept.push(child); continue; }
    const text = child.text;
    if (text !== '' && !needsCollapsing.test(text)) { kept.push(child); continue; }
    const collapsed = text.replace(WHITESPACE_RUN, ' ');
    if (block) {
      const trimmed = trimModel(collapsed);
      if (trimmed !== '') { child.text = trimmed; kept.push(child); }
      continue;
    }
    if (collapsed === '') continue;
    if (collapsed === ' ') {
      // Between two inline elements this is one space; at the edge of a block's
      // content it is layout, and the loop below drops it again.
      if (kept.length > 0) { child.text = ' '; kept.push(child); }
      continue;
    }
    child.text = collapsed;
    kept.push(child);
  }
  if (!block) {
    const first = kept[0];
    if (first && first.type === 'text' && !first.mode) first.text = first.text.replace(TRIM_START, '');
    // Trailing whitespace at the end of a block's content is removed. The layout
    // whitespace between `</body>` and `</html>` arrives as more than one node, so
    // drop every whitespace-only node at the end, not just the last one.
    while (kept.length > 0) {
      const last = kept[kept.length - 1];
      if (last.type !== 'text' || last.mode) break;
      if (trimModel(last.text) === '') { kept.pop(); continue; }
      last.text = last.text.replace(TRIM_END, '');
      break;
    }
  }
  return kept;
}

/** Strip the indentation the serializer added to pre continuation lines. */
export function normalizePre(text) {
  const t = text.replace(/\r\n?/g, '\n');
  if (!t.includes('\n')) return t;
  const lines = t.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let min = Infinity;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const m = /^[ \t]*/.exec(lines[i])[0].length;
    if (m < min) min = m;
  }
  if (Number.isFinite(min) && min > 0) {
    for (let i = 1; i < lines.length; i++) lines[i] = lines[i].slice(min);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------- head/body

export function normalizeDocument(root, warnings = [], opts = {}) {
  const found = root.children.find((c) => c.type === 'element' && c.name === 'html');
  const loose = root.children.filter((c) => c !== found && c.type !== 'doctype');
  const looseHead = loose.find((c) => c.name === 'head');
  const looseBody = loose.find((c) => c.name === 'body');
  const rest = loose.filter((c) => c !== looseHead && c !== looseBody);
  const html = normalizeElement(
    found ?? { type: 'element', name: 'html', attrs: { lang: 'en' }, children: [] },
    warnings,
  );
  const oldHead = html.children.find((c) => c.name === 'head') ?? looseHead;
  const oldBody = html.children.find((c) => c.name === 'body') ?? looseBody;
  const stray = html.children.filter((c) => c.name !== 'head' && c.name !== 'body');
  // A `<title>` written outside `<head>` belongs in the head, not in the body where
  // it would silently become body text (and leave the document with no title).
  const outside = [...stray, ...rest];
  const bodyContent = [...(oldBody ? oldBody.children : []), ...outside];
  const displaced = bodyContent.filter(isHeadOnly);
  const remainder = bodyContent.filter((c) => !isHeadOnly(c));
  for (const c of displaced) warnings.push(`moved <${c.name}> into <head>`);
  const head = normalizeHead(
    normalizeChildren([...(oldHead ? oldHead.children : []), ...displaced], 'head', warnings), warnings, opts,
  );
  const body = {
    type: 'element',
    name: 'body',
    attrs: oldBody ? oldBody.attrs : {},
    children: normalizeChildren(remainder, 'body', warnings),
  };
  if (html.attrs['data-neodoc'] !== '1') { html.attrs['data-neodoc'] = '1'; warnings.push('set data-neodoc="1"'); }
  if (!html.attrs.lang) { html.attrs.lang = 'en'; warnings.push('added lang="en"'); }
  html.children = [head, body];
  root.children = [{ type: 'doctype' }, html];
  return root;
}

const isHeadOnly = (node) => node.type === 'element' && HEAD_MOVED.has(RENAMES[node.name] || node.name);

const HEAD_ORDER = ['author', 'date', 'description', 'keywords'];
const metaRank = (name) => (name === 'generator' ? 2 : HEAD_ORDER.includes(name) ? 0 : 1);

function normalizeHead(children, warnings, opts) {
  const metas = [];
  const extra = [];
  let title = null;
  for (const child of children) {
    if (child.name === 'title') {
      if (title) warnings.push('dropped duplicate <title>');
      else title = child;
    } else if (child.name === 'meta') {
      const { name, charset } = child.attrs;
      if (name === 'generator' || charset) continue; // canonical forms, re-emitted below
      if (name) metas.push(child);
      else warnings.push('dropped <meta> without a name or charset');
    } else if (child.name === 'style') {
      if (opts.style !== 'none' && String(child.children?.[0]?.text ?? '').trim() !== THEME_CSS.trim()) {
        warnings.push('replaced the <style> block with the canonical stylesheet');
      }
    } else if (child.type === 'element') {
      warnings.push(`kept <${child.name}> in <head>, which is not part of the vocabulary`);
      extra.push(child);
    } else {
      warnings.push('dropped non-element content from <head>');
    }
  }
  if (!title) { title = { type: 'element', name: 'title', attrs: {}, children: [] }; warnings.push('added missing <title>'); }
  // Code-unit order, not localeCompare: canonical bytes must not depend on the
  // machine's locale or ICU version (docs/SPEC.md §4.2).
  metas.sort((a, b) => metaRank(a.attrs.name) - metaRank(b.attrs.name)
    || (a.attrs.name < b.attrs.name ? -1 : a.attrs.name > b.attrs.name ? 1 : 0));
  metas.push({ type: 'element', name: 'meta', attrs: { content: GENERATOR, name: 'generator' }, children: [] });
  const headChildren = [
    { type: 'element', name: 'meta', attrs: { charset: 'utf-8' }, children: [] },
    title,
    ...metas,
  ];
  if (opts.style !== 'none') {
    headChildren.push({ type: 'element', name: 'style', attrs: {}, children: [{ type: 'text', text: THEME_CSS, mode: 'raw' }] });
  }
  headChildren.push(...extra);
  return { type: 'element', name: 'head', attrs: {}, children: headChildren };
}

// ----------------------------------------------------------------- serialization

function attrString(node) {
  const keys = Object.keys(node.attrs || {}).sort();
  let out = '';
  for (const k of keys) out += ` ${k}="${escapeAttr(String(node.attrs[k]))}"`;
  return out;
}

export function emitInline(node) {
  if (node.type === 'text') return escapeText(node.text);
  if (node.type === 'comment') return `<!--${node.text}-->`;
  if (node.type === 'doctype') return '<!doctype html>';
  const attrs = attrString(node);
  if (VOID.has(node.name)) return `<${node.name}${attrs}>`;
  return `<${node.name}${attrs}>${(node.children || []).map(emitInline).join('')}</${node.name}>`;
}

export function emitBlock(node, depth, out) {
  const pad = INDENT.repeat(depth);
  if (node.type === 'doctype') { out.push(`${pad}<!doctype html>`); return; }
  if (node.type === 'comment') { out.push(`${pad}<!--${node.text}-->`); return; }
  if (node.type === 'text') { out.push(pad + escapeText(node.text)); return; }
  const name = node.name;
  const open = `<${name}${attrString(node)}>`;
  if (name === 'style' || name === 'script') {
    // Emitted at column 0 so the canonical CSS is byte-comparable.
    out.push(`${pad}${open}`);
    const body = (node.children || []).map((c) => c.text ?? '').join('').replace(TRIM_END, '');
    for (const line of body.split('\n')) out.push(line);
    out.push(`</${name}>`);
    return;
  }
  if (name === 'pre') {
    const body = escapeText((node.children || []).map((c) => c.text ?? '').join(''));
    const lines = body.split('\n');
    let chunk = pad + open + lines[0];
    for (let i = 1; i < lines.length; i++) chunk += '\n' + (lines[i] === '' ? '' : pad + lines[i]);
    out.push(`${chunk}</${name}>`);
    return;
  }
  if (VOID.has(name)) { out.push(pad + open); return; }
  const kids = node.children || [];
  // A comment between two text runs is inline: putting it on its own line adds
  // whitespace the reader can see (`foo<!--x-->bar` rendering as `foo bar`). Anywhere
  // else — between two blocks — a comment is a line of its own.
  const blocky = kids.some((c) => (c.type === 'comment'
    ? !INLINE_FLOW.has(name)
    : c.type === 'element' && BLOCK.has(c.name)));
  if (blocky) {
    out.push(pad + open);
    for (const c of kids) emitBlock(c, depth + 1, out);
    out.push(`${pad}</${name}>`);
    return;
  }
  out.push(pad + open + kids.map(emitInline).join('') + `</${name}>`);
}

export function serialize(root) {
  const out = [];
  for (const child of root.children) emitBlock(child, 0, out);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------- public

/** Canonicalize a tree that is already parsed; mutates it. `lint` uses this to
 *  reuse its own parse instead of parsing the document a second time. */
export function formatTree(root, opts = {}) {
  const warnings = [];
  normalizeDocument(root, warnings, opts);
  return { text: serialize(root), warnings };
}

/** Canonicalize a whole document. Returns `{ text, warnings }`. */
export function format(html, opts = {}) {
  const { root, errors } = parse(html);
  const parseWarnings = errors.map((e) => `${e.message} (offset ${e.pos})`);
  const { text, warnings } = formatTree(root, opts);
  return { text, warnings: [...parseWarnings, ...warnings] };
}

/** Canonicalize a fragment (headless HTML) into normalized nodes at depth 0. */
export function normalizeFragment(html) {
  const { root, errors } = parse(html);
  const warnings = errors.map((e) => `${e.message} (offset ${e.pos})`);
  const top = root.children.filter((c) => c.type !== 'doctype');
  const container = top.length === 1 && (top[0].name === 'html' || top[0].name === 'body') ? top[0] : null;
  const nodes = container
    ? (container.children.find((c) => c.name === 'body')?.children ?? container.children)
    : top;
  return { nodes: normalizeChildren(nodes, 'body', warnings), warnings };
}

/** Canonicalize a fragment into block lines at depth 0 (for showing/splicing). */
export function formatFragment(html) {
  const { nodes, warnings } = normalizeFragment(html);
  const lines = [];
  for (const node of nodes) emitBlock(node, 0, lines);
  return { lines, warnings };
}

