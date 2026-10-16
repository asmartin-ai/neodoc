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
import { ATTRS, GLOBAL_ATTRS, RENAMES, VOID, hasBlockChild, isEmptyInline } from './tree.js';
import { escapeText, escapeAttr } from './entities.js';

export const INDENT = '  ';

const DROP_ATTRS = new Set(['align', 'border', 'cellpadding', 'cellspacing', 'bgcolor',
  'color', 'face', 'valign', 'style', 'class', 'onclick', 'onload', 'role']);

// ---------------------------------------------------------------- normalization

function cleanAttrs(node, warnings) {
  const out = {};
  for (const rawKey of Object.keys(node.attrs)) {
    const key = rawKey.toLowerCase();
    const value = node.attrs[rawKey];
    if (key === 'align' && (node.name === 'td' || node.name === 'th')) {
      out['data-align'] = value.toLowerCase();
      continue;
    }
    if (!isAllowed(node.name, key, warnings)) continue;
    out[key] = value;
  }
  if (node.name === 'img') {
    if (out.alt === undefined) out.alt = '';
    if (out.width && !/^\d+$/.test(out.width)) delete out.width;
    if (out.height && !/^\d+$/.test(out.height)) delete out.height;
  }
  if (node.name === 'a' && out.target === '_blank' && !out.rel) out.rel = 'noopener';
  return out;
}

function isAllowed(name, key, warnings) {
  if (DROP_ATTRS.has(key)) {
    warnings.push(`${name}: dropped attribute "${key}" (presentational)`);
    return false;
  }
  if (GLOBAL_ATTRS.has(key) || key.startsWith('data-')) return true;
  const set = ATTRS[name];
  if (set && set.has(key)) return true;
  warnings.push(`${name}: dropped unknown attribute "${key}"`);
  return false;
}

const INLINE_MERGEABLE = new Set(['strong', 'em', 's', 'u', 'del', 'ins', 'mark', 'code', 'sub', 'sup']);

function normalizeElement(node, warnings) {
  const name = RENAMES[node.name] || node.name;
  const out = {
    type: 'element',
    name,
    attrs: cleanAttrs({ ...node, name }, warnings),
    children: normalizeChildren(node.children || [], name, warnings),
  };
  // merge <strong><strong>x</strong></strong>
  while (out.children.length === 1 && INLINE_MERGEABLE.has(name)) {
    const only = out.children[0];
    if (only.type === 'element' && only.name === name && Object.keys(only.attrs).length === 0) {
      out.children = only.children;
    } else break;
  }
  return out;
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
        mapped.push({ type: 'text', text: stripTrailingBlank(child.text), mode: 'raw' });
      } else {
        mapped.push({ type: 'text', text: child.text });
      }
    } else {
      mapped.push({ ...child, text: String(child.text ?? '').replace(/--+/g, '-').trim() });
    }
  }
  return fixWhitespace(mapped);
}

function stripTrailingBlank(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n';
}

/** Whitespace model, docs/SPEC.md §4.4. */
function fixWhitespace(children) {
  const block = hasBlockChild(children);
  const kept = [];
  for (const child of children) {
    if (child.type !== 'text' || child.mode) { kept.push(child); continue; }
    const collapsed = child.text.replace(/\s+/g, ' ');
    if (block) {
      if (collapsed.trim() !== '') kept.push({ ...child, text: collapsed.trim() });
      continue;
    }
    if (collapsed === ' ') {
      const beforeSomething = kept.length > 0;
      kept.push({ ...child, text: ' ' });
      if (!beforeSomething) kept.pop();
      continue;
    }
    kept.push({ ...child, text: collapsed });
  }
  if (!block && kept.length > 0) {
    const first = kept[0];
    if (first.type === 'text') kept[0] = { ...first, text: first.text.replace(/^ +/, '') };
    const lastIdx = kept.length - 1;
    const last = kept[lastIdx];
    if (last.type === 'text') kept[lastIdx] = { ...last, text: last.text.replace(/ +$/, '') };
  }
  return kept.filter((c) => !(c.type === 'text' && c.text === ''));
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
  const head = normalizeHead(normalizeChildren(oldHead ? oldHead.children : [], 'head', warnings), warnings, opts);
  const body = {
    type: 'element',
    name: 'body',
    attrs: oldBody ? oldBody.attrs : {},
    children: normalizeChildren([...(oldBody ? oldBody.children : []), ...stray, ...rest], 'body', warnings),
  };
  if (html.attrs['data-neodoc'] !== '1') { html.attrs['data-neodoc'] = '1'; warnings.push('set data-neodoc="1"'); }
  if (!html.attrs.lang) { html.attrs.lang = 'en'; warnings.push('added lang="en"'); }
  html.children = [head, body];
  root.children = [{ type: 'doctype' }, html];
  return root;
}

const HEAD_ORDER = ['author', 'date', 'description', 'keywords'];
const metaRank = (name) => (name === 'generator' ? 2 : HEAD_ORDER.includes(name) ? 0 : 1);

function normalizeHead(children, warnings, opts) {
  const metas = [];
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
    } else {
      warnings.push(`dropped <${child.name}> from <head>`);
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
    const body = (node.children || []).map((c) => c.text ?? '').join('').replace(/\s+$/, '');
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
  if (hasBlockChild(kids)) {
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

/** Prefix canonical lines so they can be spliced at `depth`. */
export function reindent(lines, depth) {
  const pad = INDENT.repeat(depth);
  return lines.map((l) => (l === '' ? l : pad + l));
}
