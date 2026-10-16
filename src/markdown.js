// Markdown ⇄ Neodoc body (docs/SPEC.md §8).
//
// `toMarkdown(bodyNode, { comments })` projects a body element onto GFM markdown.
// `fromMarkdown(text)` parses that subset back into a canonical-candidate HTML
// fragment for `formatFragment()`, reporting anything it could not read as a
// warning — never dropping the text.
//
// Decisions (and why):
// - Anything markdown cannot express — an `id` on a heading, `ol[start]`, a cell
//   `colspan`, a table without `<thead>`, `<u>`, … — is emitted as canonical raw
//   HTML. GFM passes raw HTML through, and `fromMarkdown` hands vocabulary tags
//   back unchanged, so those nodes survive instead of being guessed at. That is
//   why `format.js` is imported here: the fallback *is* the canonical serializer.
// - The same rule applies at attribute level: `<a>` and `<img>` print as markdown
//   only when every attribute they carry is one markdown can hold (`href`/`src`/
//   `alt`/`title`, `alt` required), a `figure` only when it holds nothing but its
//   image and a plain caption, and a fence only when its info string is a single
//   word. Otherwise the reader would hand back something subtly different.
// - `<br>` prints as GFM's hard break (two trailing spaces), never literal `<br>`:
//   one encoding per node, and the reader turns it back into `<br>`.
// - List continuation uses the marker width (2 for `- `, 3 for `1. `) so GFM still
//   nests them; for bullets that is the spec's "2 spaces per level".
// - `section` is inlined and headings are never renumbered: markdown headings are
//   already absolute (h1..h6 carry the level), so shifting a nested section would
//   destroy the original level on the way back.
// - Setext headings are not read. `---` is our `<hr>`, and "was this line an
//   underline?" is exactly the ambiguity that keeps markdown parsers incompatible.
// - `comments: 'html'` writes literal `<mark data-c>`/`<aside data-thread>` HTML.
//   An HTML comment block would come back as an untyped comment node, losing the
//   id/author/state; raw HTML re-parses to the same elements, so it survives.
// - CriticMarkup has no slot for a change author, so `del[data-author]` prints as
//   `{--x--}` only under `comments: 'critic'`; the html path keeps the author.
// - A lone block-level `img` prints as a markdown image line and therefore reads
//   back as `<p><img></p>` — markdown cannot tell an image from an image
//   paragraph. Use `figure` when the distinction matters.
// - A list item's leading paragraph goes out as bare text, not `<p>`: markdown
//   cannot tell `<li>a<ul>…` from `<li><p>a</p><ul>…`, and the bare form is the
//   idiomatic one, so reading it back always yields the bare form.
// - Markdown tables always have a header row, so a table without a single-row
//   `<thead>` (or with ragged rows, or `colspan`/`rowspan`/`scope`) goes out as
//   raw HTML instead; that keeps `fromMarkdown(toMarkdown(x))` exact for tables.

import { BLOCK, HEADINGS, VOCAB, VOID, isEl, textOf } from './tree.js';
import { decodeEntities, escapeAttr, escapeText } from './entities.js';
import { emitBlock, emitInline } from './format.js';

// --------------------------------------------------------------- toMarkdown

const NOTE_TO_ALERT = { info: 'NOTE', tip: 'TIP', warn: 'WARNING', danger: 'CAUTION' };
const ALERT_TO_NOTE = { NOTE: 'info', TIP: 'tip', IMPORTANT: 'info', WARNING: 'warn', CAUTION: 'danger' };

/** Markdown-escapable ASCII punctuation, plus `~`/`=` which start our `~~`/`==`. */
const ESC = /[\\`*_\[\]<>~=]/g;
const escMd = (s) => s.replace(ESC, '\\$&');
/** Only `|` is special inside a table cell; text escaping already happened. */
const escCell = (s) => s.replace(/\|/g, '\\|');

const rawHtml = (node) => {
  const out = [];
  emitBlock(node, 0, out);
  return out.join('\n');
};
const rawInline = (node) => emitInline(node);

/** What markdown can carry for these two elements; anything else → raw HTML. */
const LINK_ATTRS = new Set(['href', 'title']);
const IMG_ATTRS = new Set(['src', 'alt', 'title']);
const onlyAttrs = (node, allowed) => Object.keys(attrsOf(node)).every((k) => allowed.has(k));
/** Marks whose spelling carries nothing but the mark itself. */
const NO_ATTRS = new Set();
const PRE_ATTRS = new Set(['data-lang']);
const LI_ATTRS = new Set(['data-checked']);
const CELL_ATTRS = new Set(['data-align']);
const NOTE_ATTRS = new Set(['data-note']);

const attrsOf = (node) => node.attrs || {};
const hasAttrs = (node) => Object.keys(attrsOf(node)).length > 0;
const kidsOf = (node) => node.children || [];

/** `[t](url "title")` needs a pointy destination for urls containing spaces/parens. */
const dest = (url) => (/[\s()]/.test(url) ? `<${url}>` : url);

function codeSpan(text) {
  const runs = text.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function inlineMd(nodes, ctx) {
  const list = nodes || [];
  let broke = false;
  return list.map((n, i) => {
    if (isEl(n, 'br') && (ctx.solidBr || !twoSpaceBreak(list, i))) { broke = false; return '<br>'; }
    const md = nodeMd(n, ctx);
    if (broke && n.type === 'text') { broke = true; return paraMd(md); }
    broke = isEl(n, 'br');
    return md;
  }).join('');
}

/** The two-space hard break needs a line of its own text on both sides. */
function twoSpaceBreak(list, i) {
  return i > 0 && i + 1 < list.length && !isEl(list[i + 1], 'br');
}

function nodeMd(node, ctx) {
  if (node.type === 'text') return escMd(node.text);
  if (node.type === 'comment') return `<!--${node.text}-->`;
  const A = attrsOf(node);
  const inline = () => inlineMd(kidsOf(node), ctx);
  // `**x**` cannot carry an attribute, and the ones that ride here (`id`, `title`,
  // `data-*`) are exactly what the CLI addresses blocks by: without a gate they were
  // dropped on export, silently.
  const bare = onlyAttrs(node, NO_ATTRS);
  switch (node.name) {
    case 'strong': return bare ? `**${inline()}**` : rawInline(node);
    case 'em': return bare ? `*${inline()}*` : rawInline(node);
    case 'code': return bare ? codeSpan(textOf(node)) : rawInline(node);
    case 's': return bare ? `~~${inline()}~~` : rawInline(node);
    case 'del':
      // A tracked deletion must not be written as `~~`, which means *strikethrough*:
      // importing it back would turn a normal `<s>` into a deletion, and
      // \`neodoc accept\` would then delete text the author never proposed removing.
      if (ctx.comments === 'critic' && A['data-author']) return `{--${inline()}--}`;
      return rawInline(node);
    case 'ins': return ctx.comments === 'critic' ? `{++${inline()}++}` : rawInline(node);
    case 'mark':
      if (!A['data-c']) return bare ? `==${inline()}==` : rawInline(node);
      if (ctx.comments === 'drop') return inline();
      if (ctx.comments === 'critic') {
        ctx.used.push(A['data-c']);
        return `{==${inline()}==}`;
      }
      return rawInline(node);
    case 'a': return linkMd(node, ctx);
    case 'img': return imgMd(node);
    case 'br': return bare ? (ctx.solidBr ? '<br>' : '  \n') : rawInline(node);
    default: return rawInline(node); // sub/sup/u/… — HTML is their markdown form
  }
}

function linkMd(node, ctx) {
  const { href, title } = attrsOf(node);
  if (!href || /[<>]/.test(href) || !onlyAttrs(node, LINK_ATTRS)) return rawInline(node);
  const text = inlineMd(kidsOf(node), ctx);
  const t = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
  return `[${text}](${dest(href)}${t})`;
}

function imgMd(node) {
  const { src = '', alt, title } = attrsOf(node);
  // `alt` has to be *present*: markdown always reads one back (`![]` → `alt=""`),
  // and a round trip that grows an attribute is not a round trip.
  if (alt === undefined || /[<>]/.test(src) || !onlyAttrs(node, IMG_ATTRS)) return rawInline(node);
  const t = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
  return `![${escMd(alt)}](${dest(src)}${t})`;
}

/** Consecutive inline nodes become one paragraph; block elements stand alone. */
function groupBlocks(children) {
  const out = [];
  let para = null;
  for (const c of children || []) {
    const plainP = isEl(c, 'p') && !hasAttrs(c) && !(c.children || []).some((k) => k.type === 'element' && BLOCK.has(k.name));
    if (plainP) { para = null; out.push({ kind: 'para', children: kidsOf(c) }); continue; }
    if (c.type === 'comment' || (c.type === 'element' && BLOCK.has(c.name))) {
      para = null;
      out.push({ kind: 'block', node: c });
      continue;
    }
    if (!para) {
      // Whitespace between two blocks (a parsed canonical file is full of it) is
      // layout, not content; inside a paragraph it is significant and kept.
      if (c.type === 'text' && !c.text.trim()) continue;
      para = { kind: 'para', children: [] };
      out.push(para);
    }
    para.children.push(c);
  }
  return out;
}

/** Paragraph markdown: block-edge whitespace is trimmed, like the canonical form. */
function paraNodeMd(children, ctx) {
  const list = [...(children || [])];
  if (list.length && list[0].type === 'text') list[0] = { ...list[0], text: list[0].text.replace(/^\s+/, '') };
  const last = list.length - 1;
  if (last >= 0 && list[last].type === 'text') list[last] = { ...list[last], text: list[last].text.replace(/\s+$/, '') };
  return inlineMd(list, ctx);
}

/** A paragraph must not start with characters that would re-parse as a block. */
function paraMd(md) {
  if (/^[#>+-]/.test(md)) return '\\' + md;
  const d = /^(\d+)([.)])/.exec(md);
  if (d) return `${d[1]}\\${md.slice(d[1].length)}`;
  return md;
}

function fenceMd(node) {
  const lang = attrsOf(node)['data-lang'] || '';
  // The reader keeps the first word of the info string, and a backtick would end the
  // fence: either way the language would come back changed.
  // The reader keeps the first word of the info string and nothing else, and a
  // fence cannot hold an `id` at all.
  if (/[\s`]/.test(lang) || !onlyAttrs(node, PRE_ATTRS)) return rawHtml(node);
  const text = textOf(node);
  const runs = text.match(/`{3,}/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  const body = text.replace(/\n$/, '');
  return `${fence}${lang}\n${body}\n${fence}`;
}

function listMd(node, ctx) {
  const ordered = node.name === 'ol';
  const out = [];
  let n = 1;
  for (const li of kidsOf(node).filter((c) => isEl(c, 'li'))) {
    // `- [x]` is the only form markdown has for an item, and `data-checked` the only
    // attribute it can carry.
    if (!onlyAttrs(li, LI_ATTRS)) return rawHtml(node);
    const checked = attrsOf(li)['data-checked'];
    const box = checked === undefined ? '' : checked === 'true' ? '[x] ' : '[ ] ';
    const marker = `${ordered ? `${n++}. ` : '- '}${box}`;
    const pad = ' '.repeat(marker.length);
    const groups = groupBlocks(kidsOf(li));
    const lines = itemMd(ctx, groups).split('\n');
    if (groups[0] && groups[0].kind === 'para') out.push(marker + lines.shift());
    else out.push(marker.trimEnd());
    for (const l of lines) out.push(l === '' ? '' : pad + l);
  }
  return out.join('\n');
}

function itemMd(ctx, groups) {
  return groups.map((g) => (g.kind === 'para' ? paraMd(paraNodeMd(g.children, ctx)) : blockMd(g.node, ctx)))
    .filter((s) => s !== null && s !== '')
    .join('\n\n');
}

function quoteMd(md) {
  return md.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n');
}

function tableMd(node, ctx) {
  const thead = kidsOf(node).find((c) => isEl(c, 'thead'));
  const tbody = kidsOf(node).find((c) => isEl(c, 'tbody'));
  const headRows = thead ? kidsOf(thead).filter((c) => isEl(c, 'tr')) : [];
  const bodyRows = (tbody ? kidsOf(tbody) : kidsOf(node)).filter((c) => isEl(c, 'tr'));
  const all = [...headRows, ...bodyRows];
  // A pipe table is a header row plus a delimiter row plus body rows: anything
  // else (no `<thead>`, ragged rows, spanning cells) goes out as raw HTML.
  const cells = all.flatMap((r) => kidsOf(r));
  if (headRows.length !== 1 || cells.some((c) => attrsOf(c).colspan || attrsOf(c).rowspan || attrsOf(c).scope)) {
    return rawHtml(node);
  }
  // `data-align` becomes the delimiter row; any other attribute on the table, a row
  // or a cell has nowhere to go.
  if (!onlyAttrs(node, NO_ATTRS) || [...kidsOf(node), ...all].some((r) => !onlyAttrs(r, NO_ATTRS))
    || cells.some((c) => !onlyAttrs(c, CELL_ATTRS))) {
    return rawHtml(node);
  }
  const width = kidsOf(headRows[0]).length;
  if (all.some((r) => kidsOf(r).length !== width)) return rawHtml(node);
  // The delimiter row is one alignment per column, so a column is only expressible
  // when every cell in it says the same thing — a lone `data-align` on one cell would
  // come back on all of them.
  const column = (i) => all.map((r) => attrsOf(kidsOf(r)[i] || {})['data-align'] ?? null);
  const uniform = (i) => column(i).every((a) => a === column(i)[0]);
  const align = (i) => (uniform(i) ? column(i)[0] : null);
  if (Array.from({ length: width }, (_, i) => i).some((i) => !uniform(i))) return rawHtml(node);
  // A table cell is one line, so a break inside it must be the `<br>` form.
  const cellMd = (c) => {
    const prev = ctx.solidBr;
    ctx.solidBr = true;
    const md = inlineMd(kidsOf(c), ctx);
    ctx.solidBr = prev;
    return md;
  };
  const line = (r) => `| ${kidsOf(r).map((c) => escCell(cellMd(c))).join(' | ')} |`;
  const rule = Array.from({ length: width }, (_, i) => {
    const a = align(i);
    return a === 'center' ? ':--:' : a === 'right' ? '--:' : a === 'left' ? ':--' : '---';
  }).join(' | ');
  return [line(headRows[0]), `| ${rule} |`, ...bodyRows.map(line)].join('\n');
}

function figureMd(node, ctx) {
  const kids = kidsOf(node);
  const img = kids.find((c) => isEl(c, 'img'));
  const cap = kids.find((c) => isEl(c, 'figcaption'));
  // Layout whitespace is not a child to report; anything else the figure holds is.
  const extra = kids.some((c) => c !== img && c !== cap && !(c.type === 'text' && !c.text.trim()));
  // An attribute on the caption is as unexpressible as one on the figure, and
  // `![alt](src)` + caption can only read back in that order.
  const capBare = !!cap && onlyAttrs(cap, NO_ATTRS) && kids.indexOf(cap) > kids.indexOf(img);
  // A caption markdown cannot hold exactly — emphasised (it comes back as plain
  // text), carrying `*` or a line break (it would read as ordinary markdown), empty
  // — and a figure without one (`![…](…)` reads back as `<p><img></p>`) all go out
  // as raw HTML instead.
  const richCap = !!cap && kidsOf(cap).some((c) => c.type === 'element' && (c.name === 'em' || c.name === 'strong'));
  const capMd = cap ? inlineMd(kidsOf(cap), ctx) : '';
  const image = img ? imgMd(img) : '';
  if (!img || !cap || !capBare || !capMd || extra || richCap || /[*\n]/.test(capMd)
    || image.startsWith('<') || !onlyAttrs(node, NO_ATTRS)) return rawHtml(node);
  return `${image}\n\n*${capMd}*`;
}

function asideMd(node, ctx) {
  const note = attrsOf(node)['data-note'];
  if (note && NOTE_TO_ALERT[note] && onlyAttrs(node, NOTE_ATTRS)) {
    return quoteMd(`[!${NOTE_TO_ALERT[note]}]\n\n${sequenceMd(kidsOf(node), ctx)}`);
  }
  if (ctx.comments !== 'html') return null; // critic → anchored tail, drop → gone
  return rawHtml(node);
}

function blockMd(node, ctx) {
  if (node.type === 'text') return escMd(node.text);
  if (node.type === 'comment') return `<!--${node.text}-->`;
  const A = attrsOf(node);
  if (HEADINGS.has(node.name)) {
    if (hasAttrs(node)) return rawHtml(node);
    return `${'#'.repeat(+node.name[1])} ${inlineMd(kidsOf(node), ctx)}`;
  }
  switch (node.name) {
    case 'p': return hasAttrs(node) ? rawHtml(node) : paraMd(paraNodeMd(kidsOf(node), ctx));
    case 'ul':
    case 'ol': return hasAttrs(node) ? rawHtml(node) : listMd(node, ctx);
    case 'blockquote': return hasAttrs(node) ? rawHtml(node) : quoteMd(sequenceMd(kidsOf(node), ctx));
    case 'pre': return fenceMd(node);
    case 'hr': return hasAttrs(node) ? rawHtml(node) : '---';
    case 'table': return tableMd(node, ctx);
    case 'figure': return figureMd(node, ctx);
    case 'section': return hasAttrs(node) ? rawHtml(node) : sequenceMd(kidsOf(node), ctx);
    case 'aside': return asideMd(node, ctx);
    case 'img': return imgMd(node);
    default: return rawHtml(node);
  }
}

/** One markdown block per group, with critic comment threads right after their anchor. */
function sequenceMd(children, ctx) {
  const out = [];
  for (const g of groupBlocks(children)) {
    ctx.used = []; // comment anchors are collected per block
    const md = g.kind === 'para' ? paraMd(paraNodeMd(g.children, ctx)) : blockMd(g.node, ctx);
    if (md === null || md === '') continue;
    out.push(md + criticTail(ctx));
  }
  return out.join('\n\n');
}

function criticTail(ctx) {
  if (ctx.comments !== 'critic' || !ctx.used.length) return '';
  const lines = [];
  for (const id of new Set(ctx.used)) {
    const aside = ctx.threads.get(id);
    if (!aside || ctx.emitted.has(id)) continue;
    ctx.emitted.add(id);
    for (const p of kidsOf(aside).filter((c) => isEl(c, 'p'))) {
      const author = attrsOf(p)['data-author'];
      lines.push(`{>>${author ? `${author}: ` : ''}${inlineMd(kidsOf(p), ctx)}<<}`);
    }
  }
  return lines.length ? '\n\n' + lines.join('\n') : '';
}

function resolveBody(node) {
  if (!node) return { type: 'element', name: 'body', attrs: {}, children: [] };
  if (isEl(node, 'body')) return node;
  if (node.name === '#root' || isEl(node, 'html')) {
    const queue = [...(node.children || [])];
    while (queue.length) {
      const c = queue.shift();
      if (isEl(c, 'body')) return c;
      if (isEl(c, 'html')) queue.push(...(c.children || []));
    }
  }
  return node;
}

/**
 * GFM markdown for a body element.
 * `opts.comments`: `'html'` (default) | `'critic'` | `'drop'`.
 * Blocks are separated by a blank line; the text ends with one newline (`''` for
 * an empty body).
 */
export function toMarkdown(bodyNode, opts = {}) {
  const comments = opts.comments || 'html';
  if (!['html', 'critic', 'drop'].includes(comments)) throw new Error(`unknown comments mode: ${comments}`);
  const body = resolveBody(bodyNode);
  const ctx = { comments, used: [], emitted: new Set(), threads: new Map() };
  for (const n of walkAll(body)) {
    if (isEl(n, 'aside') && attrsOf(n)['data-thread'] && !ctx.threads.has(attrsOf(n)['data-thread'])) {
      ctx.threads.set(attrsOf(n)['data-thread'], n);
    }
  }
  let md = sequenceMd(kidsOf(body), ctx);
  if (comments === 'critic') {
    for (const [id, aside] of ctx.threads) {
      if (ctx.emitted.has(id)) continue;
      for (const p of kidsOf(aside).filter((c) => isEl(c, 'p'))) {
        const author = attrsOf(p)['data-author'];
        md += `${md ? '\n\n' : ''}{>>${author ? `${author}: ` : ''}${inlineMd(kidsOf(p), ctx)}<<}`;
      }
    }
  }
  return md ? md + '\n' : '';
}

function* walkAll(node) {
  yield node;
  for (const c of node.children || []) yield* walkAll(c);
}

// -------------------------------------------------------------- markdown → HTML

const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RE_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_QUOTE = /^ {0,3}> ?(.*)$/;
const RE_ITEM = /^( *)([-+*]|\d{1,9}[.)])( +|$)(.*)$/;
const RE_ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const RE_TAG = /^<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;
const RE_ESCAPABLE = /[!-\/:-@\[-`{-~]/;

const indentOf = (l) => /^ */.exec(l)[0].length;
const warn = (ctx, message) => { ctx.warnings.push(message); };

function itemAt(line) {
  const m = RE_ITEM.exec(line);
  if (!m) return null;
  const spaces = m[3].length;
  const short = spaces >= 5; // 5+ spaces means "content starts after one space"
  return {
    indent: m[1].length,
    marker: m[2],
    ordered: /\d/.test(m[2][0]),
    contentIndent: m[1].length + m[2].length + (short ? 1 : Math.max(1, spaces)),
    rest: (short ? m[3].slice(1) : '') + m[4],
  };
}

function rawBlockTag(line) {
  if (/^ {0,3}<!--/.test(line)) return '!--';
  const m = /^ {0,3}<([a-zA-Z][\w-]*)(?:[\s/>]|$)/.exec(line);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  return BLOCK.has(tag) ? tag : null;
}

function isBlockStart(line) {
  return RE_HEADING.test(line) || RE_FENCE.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)
    || RE_ITEM.test(line) || rawBlockTag(line) !== null || /^ {4}/.test(line);
}

/** Net open-element depth of one line of a raw HTML block (we emit one tag per line). */
function depthOf(line) {
  let d = 0;
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[3].endsWith('/')) continue;
    if (m[1] === '/') d--;
    else if (!VOID.has(m[2].toLowerCase())) d++;
  }
  return d;
}

function readRawLines(lines, i, tag, ctx) {
  const start = i;
  if (tag === '!--') {
    while (i < lines.length && !lines[i].includes('-->')) i++;
    if (i < lines.length) i++;
    else warn(ctx, 'unterminated HTML comment');
    return { html: lines.slice(start, i).join('\n'), i };
  }
  if (tag === 'pre') {
    while (i < lines.length && !/<\/pre>/i.test(lines[i])) i++;
    if (i < lines.length) i++;
    else warn(ctx, 'unterminated <pre> block');
    return { html: lines.slice(start, i).join('\n'), i };
  }
  let depth = 0;
  let raw = false; // inside a nested `<pre>`: its content is not markup
  do {
    const line = lines[i];
    if (raw) {
      if (/<\/pre>/i.test(line)) { raw = false; depth--; }
    } else {
      const at = line.search(/<pre[\s>]/i);
      if (at === -1) depth += depthOf(line);
      else {
        depth += depthOf(line.slice(0, at)) + 1;
        if (/<\/pre>/i.test(line.slice(at))) depth--;
        else raw = true;
      }
    }
    i++;
  } while (i < lines.length && (depth > 0 || raw));
  if (depth > 0 || raw) warn(ctx, `unterminated <${tag}> block`);
  return { html: lines.slice(start, i).join('\n'), i };
}

function readFence(lines, i, m, ctx) {
  const char = m[1][0];
  const len = m[1].length;
  const info = m[2].trim();
  const body = [];
  i++;
  let closed = false;
  while (i < lines.length) {
    const cm = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
    if (cm && cm[1][0] === char && cm[1].length >= len) { i++; closed = true; break; }
    body.push(lines[i]);
    i++;
  }
  if (!closed) warn(ctx, 'unterminated fenced code block');
  const lang = info.split(/[\s{]/)[0];
  const attr = lang ? ` data-lang="${escapeAttr(lang)}"` : '';
  return { html: `<pre${attr}>${escapeText(body.join('\n'))}</pre>`, i };
}

function readIndentedCode(lines, i) {
  const body = [];
  let pending = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { pending++; i++; continue; }
    if (!/^ {4}/.test(lines[i])) break;
    while (pending) { body.push(''); pending--; }
    body.push(lines[i].slice(4));
    i++;
  }
  return { html: `<pre>${escapeText(body.join('\n'))}</pre>`, i };
}

function readQuote(lines, i, ctx) {
  const inner = [];
  while (i < lines.length) {
    const m = RE_QUOTE.exec(lines[i]);
    if (m) { inner.push(m[1]); i++; continue; }
    if (lines[i].trim() && !isBlockStart(lines[i])) { inner.push(lines[i].trim()); i++; continue; }
    break;
  }
  const alert = RE_ALERT.exec(inner[0] || '');
  if (alert) {
    const note = ALERT_TO_NOTE[alert[1].toUpperCase()];
    const body = parseBlocks(inner.slice(1), ctx);
    return { html: body ? `<aside data-note="${note}">\n${body}\n</aside>` : `<aside data-note="${note}"></aside>`, i };
  }
  const body = parseBlocks(inner, ctx);
  return { html: body ? `<blockquote>\n${body}\n</blockquote>` : '<blockquote></blockquote>', i };
}

function readList(lines, i, ctx) {
  const first = itemAt(lines[i]);
  const ordered = first.ordered;
  const start = parseInt(first.marker, 10);
  const items = [];
  while (i < lines.length) {
    const m = itemAt(lines[i]);
    if (!m || m.ordered !== ordered) break;
    let rest = m.rest;
    let contentIndent = m.contentIndent;
    let checked;
    const box = /^\[([ xX])\](?: |$)/.exec(rest);
    if (box) { checked = box[1] !== ' '; rest = rest.slice(box[0].length); contentIndent += box[0].length; }
    const body = [rest];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          while (i < j) { body.push(''); i++; }
          continue;
        }
        i = j;
        break;
      }
      if (indentOf(l) >= contentIndent) { body.push(l.slice(contentIndent)); i++; continue; }
      if (!isBlockStart(l)) { body.push(l.trim()); i++; continue; } // lazy continuation
      break;
    }
    items.push({ body, checked });
  }
  const tag = ordered ? 'ol' : 'ul';
  const attr = ordered && start !== 1 ? ` start="${start}"` : '';
  const html = items.map(({ body, checked }) => {
    const inner = parseBlocks(body, ctx);
    // A leading `<p>` in an item is written as bare text (that is how the
    // canonical form of `<li>a<ul>…` looks); later blocks stay as blocks.
    const lead = /^<p>((?:(?!<\/p>)[\s\S])*)<\/p>/.exec(inner);
    const head = lead ? lead[1] : '';
    const rest = lead ? inner.slice(lead[0].length) : inner;
    const liAttr = checked === undefined ? '' : ` data-checked="${checked ? 'true' : 'false'}"`;
    if (lead) return `<li${liAttr}>${head}${rest}</li>`;
    return `<li${liAttr}>\n${inner}\n</li>`;
  });
  return { html: `<${tag}${attr}>\n${html.join('\n')}\n</${tag}>`, i };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (/(^|[^\\])\|$/.test(s)) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function delimAligns(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = s.split('|').map((c) => c.trim());
  if (!cells.length || !cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center'
    : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}

function readTable(lines, i, aligns, ctx) {
  const head = splitRow(lines[i]);
  i += 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
  const pend = [];
  const row = (cells, tag) => `<tr>${cells.map((c, k) => {
    const a = aligns[k] || null;
    return `<${tag}${a ? ` data-align="${a}"` : ''}>${inline(c, ctx, pend)}</${tag}>`;
  }).join('')}</tr>`;
  const body = rows.length ? `<tbody>\n${rows.map((r) => row(r, 'td')).join('\n')}\n</tbody>\n` : '';
  return { html: finish(ctx, pend, `<table>\n<thead>\n${row(head, 'th')}\n</thead>\n${body}</table>`), i };
}

function readParagraph(lines, i, ctx) {
  const buf = [lines[i]];
  i++;
  while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++; }
  let text = buf.join('\n');
  // A `<br>` at the very end of a paragraph prints as two trailing spaces with no
  // newline after them to detect it, so check the block's tail as well.
  const tail = / {2,}$/.exec(text);
  if (tail) text = text.slice(0, -tail[0].length) + '<br>';
  const img = imageOnly(text);
  if (img) {
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const cap = /^\*([^*]+)\*$/.exec((lines[j] || '').trim());
    if (cap && (j + 1 >= lines.length || !lines[j + 1].trim())) {
      return { html: `<figure>\n${inlineBlock(text, ctx)}\n<figcaption>${inlineBlock(cap[1], ctx)}</figcaption>\n</figure>`, i: j + 1 };
    }
  }
  const html = inlineBlock(text, ctx);
  // A paragraph that was nothing but `{>>…<<}` is comment, not text: the aside
  // takes its place instead of being tucked inside an empty `<p>`.
  const cut = html.indexOf('\n<aside data-thread="');
  if (cut === 0) return { html: html.slice(1), i };
  if (html === '') return { html, i };
  if (cut === -1) return { html: `<p>${html}</p>`, i };
  return { html: `<p>${html.slice(0, cut)}</p>\n${html.slice(cut + 1)}`, i };
}

/** Is this paragraph exactly one `![…](…)`? (The figure form.) */
function imageOnly(text) {
  const m = /^!\[((?:[^\]\\]|\\.)*)\]\(/.exec(text);
  if (!m) return false;
  const d = readDest(text, m[0].length - 1);
  return !!d && d.i === text.length;
}

function parseBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if (/^ {4}/.test(line)) { const r = readIndentedCode(lines, i); out.push(r.html); i = r.i; continue; }
    if ((m = RE_FENCE.exec(line))) { const r = readFence(lines, i, m, ctx); out.push(r.html); i = r.i; continue; }
    if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }
    if ((m = RE_HEADING.exec(line))) { out.push(`<h${m[1].length}>${inlineBlock(m[2] || '', ctx)}</h${m[1].length}>`); i++; continue; }
    if (RE_QUOTE.test(line)) { const r = readQuote(lines, i, ctx); out.push(r.html); i = r.i; continue; }
    if (itemAt(line)) { const r = readList(lines, i, ctx); out.push(r.html); i = r.i; continue; }
    // GFM wants the delimiter row to have exactly the header's cell count.
    const aligns = lines[i + 1] !== undefined && line.includes('|') ? delimAligns(lines[i + 1]) : null;
    if (aligns && splitRow(line).length === aligns.length) { const r = readTable(lines, i, aligns, ctx); out.push(r.html); i = r.i; continue; }
    const tag = rawBlockTag(line);
    if (tag && tag !== '!--' && VOCAB.has(tag)) { const r = readRawLines(lines, i, tag, ctx); out.push(r.html); i = r.i; continue; }
    if (tag === '!--') { const r = readRawLines(lines, i, tag, ctx); out.push(r.html); i = r.i; continue; }
    const r = readParagraph(lines, i, ctx);
    out.push(r.html);
    i = r.i;
  }
  return out.join('\n');
}

// ------------------------------------------------------------------- inline

function readDest(src, i) {
  if (src[i] !== '(') return null;
  let j = i + 1;
  while (src[j] === ' ' || src[j] === '\n') j++;
  let url;
  if (src[j] === '<') {
    const end = src.indexOf('>', j + 1);
    if (end === -1) return null;
    url = src.slice(j + 1, end);
    j = end + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < src.length && (depth > 0 || (src[j] !== ')' && (depth > 0 || !/\s/.test(src[j]))))) {
      if (src[j] === '\\') j++;
      else if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    }
    if (j >= src.length) return null;
    url = src.slice(start, j);
  }
  const rest = src.slice(j);
  const t = /^[ \t\n]*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^()\\]|\\.)*)\))[ \t\n]*\)/.exec(rest);
  const after = /^[ \t\n]*\)/.exec(rest);
  if (t) return { url, title: (t[1] ?? t[2] ?? t[3]).replace(/\\(.)/g, '$1'), i: j + t[0].length };
  if (after) return { url, title: '', i: j + after[0].length };
  return null;
}

function matchBracket(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '[') depth++;
    else if (src[j] === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function readCodeSpan(src, i) {
  const m = /^(`+)([\s\S]*?)\1(?!`)/.exec(src.slice(i));
  if (!m) return null;
  let content = m[2].replace(/\n/g, ' ');
  if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ')) content = content.slice(1, -1);
  return { html: `<code>${escapeText(decodeEntities(content))}</code>`, i: i + m[0].length };
}

function readAngle(src, i, ctx) {
  const rest = src.slice(i);
  if (rest.startsWith('<!--')) {
    const end = rest.indexOf('-->');
    if (end === -1) { warn(ctx, 'unterminated HTML comment'); return { html: escapeText(rest), i: src.length }; }
    return { html: rest.slice(0, end + 3), i: i + end + 3 };
  }
  let m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(rest);
  if (m) return { html: `<a href="${escapeAttr(m[1])}">${escapeText(m[1])}</a>`, i: i + m[0].length };
  m = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(rest);
  if (m) return { html: `<a href="mailto:${escapeAttr(m[1])}">${escapeText(m[1])}</a>`, i: i + m[0].length };
  m = RE_TAG.exec(rest);
  if (m) {
    const tag = m[2].toLowerCase();
    if (VOCAB.has(tag)) return { html: m[0], i: i + m[0].length };
    warn(ctx, `unsupported HTML <${tag}> escaped as text`);
    return { html: escapeText(m[0]), i: i + m[0].length };
  }
  return null;
}

function readImage(src, i) {
  const close = matchBracket(src, i + 1);
  if (close === -1) return null;
  const alt = src.slice(i + 2, close).replace(/\\(.)/g, '$1');
  const d = readDest(src, close + 1);
  if (!d) return null;
  const t = d.title ? ` title="${escapeAttr(d.title)}"` : '';
  return { html: `<img alt="${escapeAttr(decodeEntities(alt))}" src="${escapeAttr(d.url)}"${t}>`, i: d.i };
}

function readLink(src, i, ctx, pend) {
  const close = matchBracket(src, i);
  if (close === -1) return null;
  const text = src.slice(i + 1, close);
  const d = readDest(src, close + 1);
  if (d) {
    const t = d.title ? ` title="${escapeAttr(d.title)}"` : '';
    return { html: `<a href="${escapeAttr(d.url)}"${t}>${inline(text, ctx, pend)}</a>`, i: d.i };
  }
  if (src[close + 1] === '[') {
    const end = src.indexOf(']', close + 2);
    warn(ctx, 'reference links are unsupported; kept as text');
    return { html: escapeText(src.slice(i, (end === -1 ? close : end) + 1)), i: (end === -1 ? close : end) + 1 };
  }
  return null;
}

function inline(src, ctx, pend) {
  let out = '';
  let run = '';
  let i = 0;
  const flush = () => { if (run) { out += escapeText(decodeEntities(run)); run = ''; } };
  const wrap = (tag, content) => {
    flush();
    out += `<${tag}>${inline(content, ctx, pend)}</${tag}>`;
  };
  const delim = (open, close, tag) => {
    const end = src.indexOf(close, i + open.length);
    if (end <= i + open.length) return false;
    const inner = src.slice(i + open.length, end);
    if (/^\s/.test(inner) || /\s$/.test(inner)) return false; // `* x*` is not emphasis
    wrap(tag, inner);
    i = end + close.length;
    return true;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && RE_ESCAPABLE.test(src[i + 1] || '')) { flush(); out += escapeText(src[i + 1]); i += 2; continue; }
    if (c === '\n') {
      flush();
      let k = i;
      while (k > 0 && src[k - 1] === '\\') k--;
      const slashes = i - k;
      const spaces = (/( +)$/.exec(src.slice(0, i - slashes)) || ['', ''])[1].length;
      if (slashes % 2 === 1) { out = out.replace(/\\$/, '') + '<br>'; }
      else if (spaces >= 2) { out = out.replace(/ +$/, '') + '<br>'; }
      else out += ' ';
      i++;
      continue;
    }
    if (c === '`') { const r = readCodeSpan(src, i); if (r) { flush(); out += r.html; i = r.i; continue; } }
    if (c === '<') { const r = readAngle(src, i, ctx); if (r) { flush(); out += r.html; i = r.i; continue; } }
    if (c === '!' && src[i + 1] === '[') { const r = readImage(src, i); if (r) { flush(); out += r.html; i = r.i; continue; } }
    if (c === '[') { const r = readLink(src, i, ctx, pend); if (r) { flush(); out += r.html; i = r.i; continue; } }
    if (c === '*' || c === '_') {
      const wordBefore = /[A-Za-z0-9]/.test(src[i - 1] || '');
      if (src[i + 1] === c && !(c === '_' && wordBefore)) { if (delim(c + c, c + c, 'strong')) continue; }
      if (c === '*' || !wordBefore) { if (delim(c, c, 'em')) continue; }
    }
    if (src.startsWith('~~', i) && delim('~~', '~~', 's')) continue;
    if (src.startsWith('==', i) && delim('==', '==', 'mark')) continue;
    if (src.startsWith('{++', i) && delim('{++', '++}', 'ins')) continue;
    if (src.startsWith('{--', i) && delim('{--', '--}', 'del')) continue;
    if (src.startsWith('{==', i)) {
      const end = src.indexOf('==}', i + 3);
      if (end !== -1) {
        flush();
        // The id is only known once the block ends (a `{==x==}` without a thread
        // is a plain highlight), so the mark carries a NUL slot — a value no real
        // document can contain — until `finish` replaces it.
        const slot = `\u0000${++ctx.slots}`;
        pend.push({ id: null, slot, threads: [], marked: true });
        out += `<mark data-c="${slot}">${inline(src.slice(i + 3, end), ctx, pend)}</mark>`;
        i = end + 3;
        continue;
      }
    }
    if (src.startsWith('{>>', i)) {
      const end = src.indexOf('<<}', i + 3);
      if (end !== -1) {
        flush();
        let body = src.slice(i + 3, end);
        let author = '';
        const sep = body.indexOf(': ');
        if (sep !== -1) { author = body.slice(0, sep).trim(); body = body.slice(sep + 2); }
        if (!pend.length) pend.push({ id: null, slot: null, threads: [], marked: false });
        const entry = pend[pend.length - 1];
        entry.threads.push({ author, html: inline(body, ctx, pend) });
        i = end + 3;
        continue;
      }
    }
    run += c;
    i++;
  }
  flush();
  return out;
}

/** Inline content of one block, with any comment threads emitted right after it. */
function inlineBlock(src, ctx) {
  const pend = [];
  return finish(ctx, pend, inline(src, ctx, pend));
}

/** Hand out comment ids and turn `{==…==}`/`{>>…<<}` pairs into anchors + asides. */
function finish(ctx, pend, html) {
  const asides = [];
  for (const e of pend) {
    if (!e.threads.length) {
      // `==x==` with no thread is a plain highlight: drop the id, or `lint` would
      // report a `mark data-c` that has no `<aside data-thread>`.
      if (e.marked) html = html.replace(` data-c="${e.slot}"`, '');
      continue;
    }
    e.id = `c${++ctx.idCount}`;
    if (e.marked) html = html.replace(` data-c="${e.slot}"`, ` data-c="${e.id}"`);
    const ps = e.threads.map((t) => `<p${t.author ? ` data-author="${escapeAttr(t.author)}"` : ''}>${t.html}</p>`);
    asides.push(`<aside data-thread="${e.id}">\n${ps.join('\n')}\n</aside>`);
  }
  return asides.length ? `${html}\n${asides.join('\n')}` : html;
}

/**
 * Parse the markdown subset (SPEC §8) into a canonical-candidate HTML fragment.
 * Warnings name unsupported constructs once each, and never mean lost text: the
 * construct is kept as escaped text or as a paragraph.
 * @returns {{html: string, warnings: string[]}}
 */
export function fromMarkdown(text) {
  const ctx = { warnings: [], idCount: 0, slots: 0 };
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return { html: parseBlocks(lines, ctx), warnings: [...new Set(ctx.warnings)] };
}
