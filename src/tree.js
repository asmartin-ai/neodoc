// Neodoc tree model — the in-memory document. Shared by CLI and browser.

export const VOID = new Set(['br', 'hr', 'img', 'meta']);
export const RAW = new Set(['style', 'script', 'pre', 'textarea', 'title']);

export const INLINE = new Set([
  'strong', 'em', 'code', 's', 'u', 'mark', 'sub', 'sup', 'ins', 'del', 'a', 'img', 'br',
]);

export const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Layout grouping: children of these go one per line. Also includes forbidden
 *  elements (div/script/link) so that a file we must not destroy still formats. */
export const BLOCK = new Set([
  'html', 'head', 'body', 'meta', 'title', 'style', 'script', 'link',
  ...HEADINGS,
  'p', 'blockquote', 'pre', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'hr', 'section',
  'aside', 'div',
]);

/** Elements allowed in a Neodoc document. Everything else is a lint error. */
export const VOCAB = new Set([
  'html', 'head', 'body', 'meta', 'title', 'style',
  ...HEADINGS,
  'p', 'blockquote', 'pre', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'hr', 'section',
  'aside',
  ...INLINE,
]);

export const GLOBAL_ATTRS = new Set(['id', 'title', 'lang', 'dir']);

export const ATTRS = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  ol: new Set(['start', 'reversed']),
  td: new Set(['colspan', 'rowspan', 'scope', 'data-align']),
  th: new Set(['colspan', 'rowspan', 'scope', 'data-align']),
  li: new Set(['data-checked']),
  pre: new Set(['data-lang']),
  section: new Set(['data-title']),
  mark: new Set(['data-c']),
  aside: new Set(['data-thread', 'data-state', 'data-note']),
  p: new Set(['data-author', 'data-at']),
  ins: new Set(['data-author', 'data-at']),
  del: new Set(['data-author', 'data-at']),
  meta: new Set(['name', 'content', 'charset']),
  html: new Set(['data-neodoc']),
};

export function isAttrAllowed(elName, name) {
  if (GLOBAL_ATTRS.has(name) || name.startsWith('data-')) return true;
  const set = ATTRS[elName];
  return !!set && set.has(name);
}

export const RENAMES = { b: 'strong', i: 'em', strike: 's' };

/** Does this child list require block layout (one child per line)? */
export function hasBlockChild(children) {
  return (children || []).some((c) => c.type === 'comment' || (c.type === 'element' && BLOCK.has(c.name)));
}

/** An inline element with nothing inside it is dropped by the normalizer. */
export function isEmptyInline(node) {
  return node.type === 'element' && INLINE.has(node.name) && !VOID.has(node.name)
    && (node.children || []).length === 0;
}

export function el(name, attrs = {}, children = []) {
  return { type: 'element', name, attrs, children };
}
export function txt(text) {
  return { type: 'text', text };
}
export function cmt(text) {
  return { type: 'comment', text };
}

export const isEl = (n, name) => n.type === 'element' && (name === undefined || n.name === name);
export const isText = (n) => n.type === 'text';
export const isComment = (n) => n.type === 'comment';

export function textOf(node) {
  let out = '';
  walk(node, (n) => {
    if (n.type === 'text') out += n.text;
    if (n.type === 'element' && n.name === 'br') out += '\n';
  });
  return out;
}

export function walk(node, fn) {
  fn(node);
  if (node.children) for (const c of node.children) walk(c, fn);
}

export function* descendants(node) {
  for (const c of node.children || []) {
    yield c;
    yield* descendants(c);
  }
}

export function childrenOf(node, name) {
  return (node.children || []).filter((c) => isEl(c, name));
}

export function findById(node, id) {
  for (const d of descendants(node)) if (isEl(d) && d.attrs.id === id) return d;
  return null;
}

export function clone(node) {
  const copy = { ...node };
  if (node.attrs) copy.attrs = { ...node.attrs };
  if (node.children) copy.children = node.children.map(clone);
  return copy;
}

/** Round-trippable selector for `node` under `root`, e.g. `body > p:nth-of-type(1)`. */
export function pathOf(root, target) {
  const parts = [];
  let node = target;
  while (node && node !== root) {
    const parent = (root.children || []).includes(node) ? root : parentOf(root, node);
    if (!parent) break;
    const sameTag = (parent.children || []).filter((c) => isEl(c) && c.name === node.name);
    let seg = node.name;
    // A tag that occurs once among its siblings needs no positional suffix, so
    // `body` stays `body`; only genuinely ambiguous siblings get indexed.
    if (node.attrs && node.attrs.id) seg += `#${node.attrs.id}`;
    else if (sameTag.length > 1) seg += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    parts.unshift(seg);
    node = parent;
  }
  return parts.join(' > ');
}

export function parentOf(root, target) {
  for (const d of descendants(root)) if ((d.children || []).includes(target)) return d;
  return null;
}
