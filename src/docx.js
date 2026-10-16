// Neodoc body tree → .docx (docs/SPEC.md §8).
//
// Zero dependencies and no `node:` imports: the only non-ECMAScript APIs used are
// TextEncoder, Uint8Array, DataView and CompressionStream('deflate-raw'), so this
// module runs unchanged in Node, Bun and a browser. The zip container is written
// by hand (local headers + central directory, no data descriptors) with a fixed
// DOS timestamp, so the same input always produces identical bytes; entries use
// method 8 (deflate) where available and method 0 (stored) where it is not.
//
// ponytail: one reference style set, no `--reference` override; upgrade when a
// user needs corporate branding. Images are placed at their declared pixel size
// (or a 480×320 default) instead of reading the real pixel size, because we do
// not decode image headers; upgrade when layout of untagged images matters.

import { HEADINGS, isEl, textOf } from './tree.js';
import { normalizePre } from './format.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';

const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';

const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';

const DC = 'http://purl.org/dc/elements/1.1/';

const DCTERMS = 'http://purl.org/dc/terms/';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

// All package timestamps are pinned to 1980-01-01T00:00:00Z (the DOS epoch) so
// that two runs of the same input are byte-identical (SPEC §4 idempotence spirit).
const DOS_TIME = 0;

const DOS_DATE = 0x21;

const FIXED_DATE = '1980-01-01T00:00:00Z';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// --------------------------------------------------------------------- escaping

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escA = (s) => esc(s).replace(/"/g, '&quot;');

const collapse = (s) => String(s).replace(/[ \t\r\n\f\v]+/g, ' ');

// ---------------------------------------------------------------- inline → runs

// Run properties are emitted in CT_RPr schema order, not source order: Word is
// tolerant but strict validators are not, and `<em><strong>` would otherwise
// produce `<w:i/><w:b/>`.
const RP_ORDER = [
  (s) => (s.rs ? `<w:rStyle w:val="${s.rs}"/>` : ''),
  (s) => (s.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : ''),
  (s) => (s.b ? '<w:b/>' : ''),
  (s) => (s.i ? '<w:i/>' : ''),
  (s) => (s.strike ? '<w:strike/>' : ''),
  (s) => (s.hl ? '<w:highlight w:val="yellow"/>' : ''),
  (s) => (s.u ? '<w:u w:val="single"/>' : ''),
  (s) => (s.mono ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''),
  (s) => (s.vert ? `<w:vertAlign w:val="${s.vert}"/>` : ''),
];

const rpr = (st) => RP_ORDER.map((f) => f(st)).join('');

const ST = {
  strong: { b: 1 },
  em: { i: 1 },
  s: { strike: 1 },
  u: { u: 1 },
  mark: { hl: 1 },
  code: { mono: 1 },
  sub: { vert: 'subscript' },
  sup: { vert: 'superscript' },
};

/** One text run. `xml:space` is set exactly when the text has edge whitespace. */
function run(text, props = '', tag = 'w:t') {
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';

  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<${tag}${space}>${esc(text)}</${tag}></w:r>`;
}

/** Drop the block's leading/trailing whitespace (SPEC §4.4) without touching gaps. */
function trimInline(nodes) {
  const out = nodes.slice();

  while (out.length && out[0].type === 'text') {
    const t = out[0].text.replace(/^[ \t\r\n\f]+/, '');

    if (t) { out[0] = { ...out[0], text: t }; break; }

    out.shift();
  }

  while (out.length && out[out.length - 1].type === 'text') {
    const i = out.length - 1;
    const t = out[out.length - 1].text.replace(/[ \t\r\n\f]+$/, '');

    if (t) { out[i] = { ...out[i], text: t }; break; }

    out.pop();
  }

  return out;
}

// ---------------------------------------------------------------- inline nodes

function inlineNode(n, ctx, st) {
  if (n.type === 'text') return run(collapse(n.text), rpr(st), st.del ? 'w:delText' : 'w:t');

  if (n.type !== 'element') return '';
  const name = n.name;
  const kids = () => inlines(n.children || [], ctx, st);

  if (ST[name]) {
    // `mark` with a thread is a Word comment anchor; one without is a highlight.
    if (name === 'mark' && n.attrs['data-c'] && ctx.comments.has(n.attrs['data-c'])) {
      const id = ctx.commentId(n.attrs['data-c']);

      return `<w:commentRangeStart w:id="${id}"/>${kids()}` +
        `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
        `<w:commentReference w:id="${id}"/></w:r>`;
    }

    return inlines(n.children || [], ctx, { ...st, ...ST[name] });
  }

  if (name === 'br') return '<w:r><w:br/></w:r>';

  if (name === 'a') {
    const href = n.attrs.href;

    if (!href) return kids();
    const id = ctx.rel(`${R}/hyperlink`, href, 'External');

    return `<w:hyperlink r:id="${id}">${inlines(n.children || [], ctx, { ...st, rs: 'Hyperlink' })}</w:hyperlink>`;
  }

  if (name === 'img') return imageRun(n, ctx);

  if (name === 'ins' || name === 'del') {
    const del = name === 'del';
    const id = ++ctx.changes;
    const inner = inlines(n.children || [], ctx, del ? { ...st, del: true } : st);

    return `<w:${name} w:id="${id}" w:author="${escA(n.attrs['data-author'] || ctx.opts.author || 'Unknown')}"` +
      ` w:date="${n.attrs['data-at'] || FIXED_DATE}">${inner}</w:${name}>`;
  }

  ctx.warn(`unsupported inline <${name}> written as plain text`);

  return kids();
}

const inlines = (nodes, ctx, st = {}) => nodes.map((n) => inlineNode(n, ctx, st)).join('');

// ---------------------------------------------------------------- images/media

const EMU_PER_PX = 9525;

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/svg+xml': 'svg',
};

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', svg: 'image/svg+xml',
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Hand-rolled base64 so we do not depend on `atob` (absent in old Node). */
function base64(str) {
  const s = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((s.length * 3) >> 2);
  let buf = 0, bits = 0, o = 0;

  for (let i = 0; i < s.length; i++) {
    buf = (buf << 6) | B64.indexOf(s[i]);
    bits += 6;

    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }

  return out.subarray(0, o);
}

function bytesOf(v) {
  if (v instanceof Uint8Array) return v;

  if (v instanceof ArrayBuffer) return new Uint8Array(v);

  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

  return null;
}

/** `data:` URI → `{mime, bytes}`, else null. Relative paths are the CLI's job. */
function dataUri(src) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(src);

  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';

  if (m[2]) return { mime, bytes: base64(m[3]) };
  let text = m[3];

  try { text = decodeURIComponent(text); } catch { /* keep raw on malformed escapes */ }

  return { mime, bytes: new TextEncoder().encode(text) };
}

const extOf = (src) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(src.split(/[?#]/)[0]);

  return m ? m[1].toLowerCase() : '';
};

function resolveImage(src, ctx) {
  if (ctx.opts.resolveImage) {
    const got = ctx.opts.resolveImage(src);
    const bytes = got && bytesOf(got.bytes);

    if (!bytes) return null;

    return { mime: got.mime || MIME_BY_EXT[extOf(src)] || 'image/png', bytes };
  }

  return dataUri(src);
}

function imageRun(node, ctx) {
  const src = node.attrs.src || '';
  const alt = node.attrs.alt || '';
  const img = src ? resolveImage(src, ctx) : null;

  if (!img) {
    ctx.warn(`image kept as text, could not resolve: ${src || '(no src)'}`);

    return run(alt || src ? `[image: ${alt || src}]` : '[image]');
  }

  const ext = EXT_BY_MIME[img.mime] || extOf(src) || 'png';
  let name = ctx.media.get(src);

  if (!name) {
    name = `image${ctx.media.size + 1}.${ext}`;
    ctx.media.set(src, name);
    ctx.mediaTypes.set(ext, img.mime);
    ctx.mediaBytes.push({ name, bytes: img.bytes });
  }

  const relId = ctx.rel(`${R}/image`, `media/${name}`, 'Internal');

  const w = Number.parseFloat(node.attrs.width);
  const h = Number.parseFloat(node.attrs.height);
  let wpx = Number.isFinite(w) && w > 0 ? w : 0;
  let hpx = Number.isFinite(h) && h > 0 ? h : 0;

  if (wpx && !hpx) hpx = wpx * (2 / 3);

  if (hpx && !wpx) wpx = hpx * (3 / 2);

  if (!wpx) { wpx = 480; hpx = 320; }

  const cx = Math.round(wpx * EMU_PER_PX);
  const cy = Math.round(hpx * EMU_PER_PX);
  const id = ++ctx.draws;

  const drawing =
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<a:graphic><a:graphicData uri="${PIC}"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${escA(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;

  return `<w:r>${drawing}</w:r>`;
}

// -------------------------------------------------------------------- blocks

const ALIGN = new Set(['left', 'center', 'right']);

const LI_BLOCKS = new Set(['p', 'pre', 'blockquote', 'table', 'hr', 'ul', 'ol']);

function para(o, runs) {
  const pPr = [
    o.style ? `<w:pStyle w:val="${o.style}"/>` : '',
    o.num ? `<w:numPr><w:ilvl w:val="${o.num.ilvl}"/><w:numId w:val="${o.num.numId}"/></w:numPr>` : '',
    o.hr ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>' : '',
    o.spacing ? `<w:spacing ${o.spacing}/>` : '',
    o.jc ? `<w:jc w:val="${o.jc}"/>` : '',
  ].join('');

  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

function heading(node, ctx, nodeName) {
  const level = HEADINGS.has(nodeName) ? Number(nodeName[1]) : 1;

  return para({ style: `Heading${level}` }, inlines(trimInline(node.children || []), ctx));
}

/** `pre` → one NeodocCode paragraph per line (Word has no block-of-code concept). */
function codeBlock(node) {
  const lines = normalizePre(textOf(node)).split('\n');

  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  return lines.map((l) => para({ style: 'NeodocCode' }, l === '' ? '' : run(l))).join('');
}

function list(node, ctx, ordered, ilvl, numId) {
  // Each ordered list gets its own `w:num` instance: Word continues the count of
  // any other list that shares a numId, so separate `<ol>`s must not share one.
  // numId 1 is always the bullet list, defined in numberingXml.
  if (!numId) numId = ordered ? ++ctx.numSeq : 1;
  let out = '';

  for (const li of (node.children || []).filter((c) => isEl(c, 'li'))) {
    const inlineKids = [];
    const blockKids = [];

    for (const c of li.children || []) {
      if (c.type === 'element' && LI_BLOCKS.has(c.name)) blockKids.push(c);
      else inlineKids.push(c);
    }

    let marker = '';
    const checked = li.attrs['data-checked'];

    if (checked === 'true') marker = run('\u2611 ');
    else if (checked === 'false') marker = run('\u2610 ');
    out += para({ num: { numId, ilvl } }, marker + inlines(trimInline(inlineKids), ctx));

    for (const b of blockKids) {
      if (b.name === 'ul' || b.name === 'ol') {
        // A nested ordered list continues its parent's count one level deeper;
        // any other nested list starts a fresh numbering instance.
        out += list(b, ctx, b.name === 'ol', ilvl + 1, ordered && b.name === 'ol' ? numId : 0);
      } else {
        out += blocks([b], ctx, null);
      }
    }
  }

  return out;
}

function tableRow(tr, ctx, cols) {
  let cells = '';

  for (const cell of (tr.children || []).filter((c) => isEl(c, 'td') || isEl(c, 'th'))) {
    const head = cell.name === 'th';
    const span = Math.max(1, Number.parseInt(cell.attrs.colspan || '1', 10) || 1);
    const align = ALIGN.has(cell.attrs['data-align']) ? cell.attrs['data-align'] : '';

    const tcPr =
      `<w:tcW w:w="${Math.floor(9360 / cols)}" w:type="dxa"/>` +
      (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '') +
      (head ? '<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"/>' : '') +
      '<w:vAlign w:val="top"/>';

    const runs = inlines(trimInline(cell.children || []), ctx, head ? { b: 1 } : {});
    cells += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${para(align ? { jc: align } : {}, runs)}</w:tc>`;
  }

  return `<w:tr>${cells}</w:tr>`;
}

function table(node, ctx) {
  const rows = [];

  for (const child of node.children || []) {
    if (isEl(child, 'tr')) rows.push(child);
    else if (isEl(child, 'thead') || isEl(child, 'tbody')) {
      rows.push(...(child.children || []).filter((c) => isEl(c, 'tr')));
    }
  }

  let cols = 1;

  if (rows[0]) {
    cols = (rows[0].children || []).reduce(
      (n, c) => (isEl(c, 'td') || isEl(c, 'th') ? n + Math.max(1, Number.parseInt(c.attrs.colspan || '1', 10) || 1) : n),
      0,
    ) || 1;
  }

  const borders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('')
    + '</w:tblBorders>';

  const grid = `<w:tblGrid>${'<w:gridCol/>'.repeat(cols)}</w:tblGrid>`;
  const body = rows.map((r) => tableRow(r, ctx, cols)).join('');

  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}${body}</w:tbl>`;
}

function figure(node, ctx) {
  const kids = node.children || [];
  const img = kids.find((c) => isEl(c, 'img'));
  const cap = kids.find((c) => isEl(c, 'figcaption'));
  let out = para({ jc: 'center' }, img ? imageRun(img, ctx) : '');

  if (cap) out += para({ jc: 'center' }, inlines(trimInline(cap.children || []), ctx, { i: 1 }));

  return out;
}

/** Blocks inside a paragraph context (li, blockquote) reuse the whole block walker. */
function blocks(nodes, ctx, style) {
  let out = '';

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];

    if (n.type === 'text') {
      const text = collapse(n.text).trim();

      if (text) out += para({ style: style || 'Normal' }, run(text));
      continue;
    }

    if (n.type !== 'element') continue; // HTML comments / doctype have no docx form
    const name = n.name;

    if (HEADINGS.has(name)) { out += heading(n, ctx, name); continue; }

    switch (name) {
      case 'p': out += para({ style: style || 'Normal' }, inlines(trimInline(n.children || []), ctx)); break;
      case 'blockquote': out += blocks(n.children || [], ctx, style || 'Quote'); break;
      case 'pre': out += codeBlock(n); break;
      case 'ul': case 'ol': out += list(n, ctx, name === 'ol', 0); break;
      case 'table': {
        out += table(n, ctx);
        // Two adjacent tables would merge without an empty paragraph between them.
        const next = nodes[i + 1];

        if (!next || isEl(next, 'table')) out += '<w:p/>';
        break;
      }

      case 'hr': out += para({ hr: true }, ''); break;
      case 'figure': out += figure(n, ctx); break;
      case 'figcaption':
        out += para({ jc: 'center' }, inlines(trimInline(n.children || []), ctx, { i: 1 }));
        break;
      case 'img': out += para({ jc: 'center' }, imageRun(n, ctx)); break;
      case 'section': case 'div': out += blocks(n.children || [], ctx, style); break;
      case 'aside':
        if (!ctx.consumedAsides.has(n)) out += blocks(n.children || [], ctx, 'Quote');
        break;
      default:
        ctx.warn(`unsupported block <${name}> written as its text`);
        out += blocks(n.children || [], ctx, style);
    }
  }

  return out;
}

// ------------------------------------------------------- comments and threads

const initialsOf = (author) => author.split(/[\s_-]+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3) || 'A';

/**
 * Word comments are flat: a thread reply cannot attach to the same range as a
 * separate comment, so all replies become extra paragraphs of the one comment.
 * Each reply keeps its author as an italic lead-in run so attribution survives.
 */
function commentXml(aside, id, ctx) {
  const paras = (aside.children || []).filter((c) => isEl(c, 'p'));
  const first = paras[0] || aside;
  const author = first.attrs['data-author'] || aside.attrs['data-author'] || ctx.opts.author || 'Unknown';
  const date = first.attrs['data-at'] || aside.attrs['data-at'] || FIXED_DATE;

  const bodies = (paras.length ? paras : [aside]).map((p, i) => {
    const replyAuthor = i > 0 ? p.attrs['data-author'] : '';
    const lead = replyAuthor ? run(`${replyAuthor}: `, '<w:i/>') : '';

    return para({ style: 'CommentText' }, lead + inlines(trimInline(p.children || []), ctx, { i: i > 0 }));
  }).join('');

  return { id, author, initials: initialsOf(author), date, xml: bodies };
}

// ----------------------------------------------------------------- zip writer

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }

  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;

  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Deflate, or `null` when the runtime cannot deflate. `CompressionStream` is
 * standard but `'deflate-raw'` is not universal (Node only got it in 20.12, some
 * embedded runtimes never do), so a missing/erroring stream is not an error.
 *
 * ponytail: no deflate support → every zip entry is *stored* (method 0). Larger
 * files but a valid, byte-identical-per-runtime package; upgrade to a hand-rolled
 * DEFLATE only if someone needs compressed output on such a runtime.
 */
async function deflateRaw(bytes) {
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const written = writer.write(bytes).then(() => writer.close());
    const reader = cs.readable.getReader();
    const chunks = [];
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      chunks.push(value);
      total += value.length;
    }

    await written;
    const out = new Uint8Array(total);
    let at = 0;

    for (const c of chunks) { out.set(c, at); at += c.length; }

    return out;
  } catch {
    return null;
  }
}

async function zip(parts) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const part of parts) {
    const name = enc.encode(part.name);
    const deflated = await deflateRaw(part.data);
    const method = deflated ? 8 : 0;
    const raw = deflated || part.data;
    const crc = crc32(part.data);
    const head = new Uint8Array(30 + name.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);      // version needed to extract
    hv.setUint16(6, 0, true);       // flags: none (sizes and crc are known up front)
    hv.setUint16(8, method, true);
    hv.setUint16(10, DOS_TIME, true);
    hv.setUint16(12, DOS_DATE, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, raw.length, true);
    hv.setUint32(22, part.data.length, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true);      // extra length
    head.set(name, 30);
    local.push(head, raw);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);      // version made by
    dv.setUint16(6, 20, true);      // version needed
    dv.setUint16(8, 0, true);
    dv.setUint16(10, method, true);
    dv.setUint16(12, DOS_TIME, true);
    dv.setUint16(14, DOS_DATE, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, raw.length, true);
    dv.setUint32(24, part.data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);      // comment length
    dv.setUint16(34, 0, true);      // disk number
    dv.setUint16(36, 0, true);      // internal attrs
    dv.setUint32(38, 0, true);      // external attrs
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);
    offset += head.length + raw.length;
  }

  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, parts.length, true);
  ev.setUint16(10, parts.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = [...local, ...central, end];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;

  for (const c of all) { out.set(c, at); at += c.length; }

  return out;
}

// ------------------------------------------------------------- fixed OOXML parts

// `basedOn: null` means "no parent" (Normal itself, and character styles, which
// cannot inherit from a paragraph style).
const styleDef = (id, name, opts = {}) =>
  `<w:style w:type="${opts.type || 'paragraph'}"${opts.default ? ' w:default="1"' : ''} w:styleId="${id}">`
  + `<w:name w:val="${name}"/>`
  + (opts.basedOn === null ? '' : `<w:basedOn w:val="${opts.basedOn || 'Normal'}"/>`)
  + (opts.next ? `<w:next w:val="${opts.next}"/>` : '')
  + '<w:qFormat/>' + (opts.pPr || '') + (opts.rPr ? `<w:rPr>${opts.rPr}</w:rPr>` : '')
  + '</w:style>';

function stylesXml(lang) {
  const heading = (lvl) => {
    const sz = [32, 28, 26, 24, 22, 22][lvl - 1];

    return styleDef(`Heading${lvl}`, `heading ${lvl}`, {
      next: 'Normal',
      pPr: '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="120"/>'
        + `<w:outlineLvl w:val="${lvl - 1}"/></w:pPr>`,
      rPr: `<w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`,
    });
  };

  return XML_DECL + `<w:styles xmlns:w="${W}">`
    + '<w:docDefaults>'
    + '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'
    + `<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${escA(lang)}"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + styleDef('Normal', 'Normal', { default: true, basedOn: null })
    + [1, 2, 3, 4, 5, 6].map(heading).join('')
    + styleDef('Quote', 'Quote', {
      next: 'Normal',
      pPr: '<w:pPr><w:ind w:left="720"/><w:spacing w:after="120"/></w:pPr>',
      rPr: '<w:i/><w:color w:val="404040"/>',
    })
    + styleDef('NeodocCode', 'Neodoc Code', {
      next: 'NeodocCode',
      pPr: '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>',
      rPr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
    })
    + styleDef('CommentText', 'annotation text', { rPr: '<w:sz w:val="20"/><w:szCs w:val="20"/>' })
    + styleDef('CommentReference', 'annotation reference', {
      type: 'character', basedOn: null, rPr: '<w:sz w:val="16"/><w:szCs w:val="16"/><w:vertAlign w:val="superscript"/>',
    })
    + styleDef('Hyperlink', 'Hyperlink', {
      type: 'character', basedOn: null, rPr: '<w:color w:val="0563C1"/><w:u w:val="single"/>',
    })
    + '</w:styles>';
}

function numberingXml(count) {
  const lvl = (ilvl, numFmt, text) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>`
    + `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;

  const abstract = (id, fmt, texts) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>`
    + texts.map((t, i) => lvl(i, fmt, t)).join('') + '</w:abstractNum>';

  // `w:num` instances are per list, so that two separate lists do not share a
  // counting sequence: numId 1 is the bullet list, 2..count are ordered lists.
  const nums = Array.from({ length: count }, (_, i) =>
    `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i === 0 ? 0 : 1}"/></w:num>`).join('');

  return XML_DECL + `<w:numbering xmlns:w="${W}">`
    + abstract(0, 'bullet', ['\u2022', '\u25cb', '\u25aa'])
    + abstract(1, 'decimal', ['%1.', '%2.', '%3.'])
    + nums
    + '</w:numbering>';
}

function settingsXml() {
  return XML_DECL + `<w:settings xmlns:w="${W}">`
    + '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>'
    + '<w:compat><w:compatSetting w:name="compatibilityMode" '
    + `w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>`
    + '</w:settings>';
}

function coreXml(opts) {
  const iso = opts.date ? `${opts.date}T00:00:00Z` : FIXED_DATE;

  return XML_DECL + `<cp:coreProperties xmlns:cp="${CP}" xmlns:dc="${DC}" xmlns:dcterms="${DCTERMS}" xmlns:xsi="${XSI}">`
    + (opts.title ? `<dc:title>${esc(opts.title)}</dc:title>` : '')
    + (opts.author ? `<dc:creator>${esc(opts.author)}</dc:creator>` : '')
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>`
    + (opts.author ? `<cp:lastModifiedBy>${esc(opts.author)}</cp:lastModifiedBy>` : '')
    + '</cp:coreProperties>';
}

const appXml = () => XML_DECL
  + `<Properties xmlns="${EP}" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">`
  + '<Application>Neodoc</Application></Properties>';

function contentTypesXml(exts, hasComments) {
  const override = (part, type) => `<Override PartName="${part}" ContentType="${type}"/>`;

  return XML_DECL + `<Types xmlns="${CT}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + [...exts].map(([e, mime]) => `<Default Extension="${e}" ContentType="${mime}"/>`).join('')
    + override('/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    + override('/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml')
    + override('/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml')
    + override('/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml')
    + (hasComments ? override('/word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml') : '')
    + override('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml')
    + override('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml')
    + '</Types>';
}

const relsXml = (rels) => XML_DECL + `<Relationships xmlns="${PR}">`
  + rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escA(r.target)}"`
    + (r.mode === 'External' ? ' TargetMode="External"' : '') + '/>').join('')
  + '</Relationships>';

const rootRelsXml = () => relsXml([
  { id: 'rId1', type: `${R}/officeDocument`, target: 'word/document.xml' },
  { id: 'rId2', type: `${PR}/metadata/core-properties`, target: 'docProps/core.xml' },
  { id: 'rId3', type: `${R}/extended-properties`, target: 'docProps/app.xml' },
]);

// ------------------------------------------------------------------- assembly

function makeContext(opts) {
  const ctx = {
    opts,
    // The three fixed document relationships come first so that body references
    // (hyperlinks, images) get stable ids regardless of how many there are.
    rels: [
      { id: 'rId1', key: 'styles', type: `${R}/styles`, target: 'styles.xml' },
      { id: 'rId2', key: 'numbering', type: `${R}/numbering`, target: 'numbering.xml' },
      { id: 'rId3', key: 'settings', type: `${R}/settings`, target: 'settings.xml' },
    ],
    rel(type, target, mode) {
      const key = `${type}|${target}`;
      const found = this.rels.find((r) => r.key === key);

      if (found) return found.id;
      const id = `rId${this.rels.length + 1}`;
      this.rels.push({ id, key, type, target, mode });

      return id;
    },
    media: new Map(),        // src → file name in word/media
    mediaTypes: new Map(),   // ext → mime
    mediaBytes: [],          // {name, bytes} in insertion order
    comments: new Map(),     // data-c id → aside node
    marks: new Set(),        // data-c ids that have an anchor in the body
    commentIds: new Map(),   // data-c id → numeric Word comment id
    commentBodies: new Map(),// numeric id → comment part body
    consumedAsides: new Set(),
    changes: 0,
    draws: 0,
    numSeq: 1,               // highest `w:num` instance allocated (1 = bullets)
    warn(message) { if (Array.isArray(opts.warnings)) opts.warnings.push(message); },
  };

  ctx.commentId = (cid) => {
    if (!ctx.commentIds.has(cid)) {
      const id = ctx.commentIds.size + 1;
      ctx.commentIds.set(cid, id);
      ctx.commentBodies.set(id, commentXml(ctx.comments.get(cid), id, ctx));
    }

    return ctx.commentIds.get(cid);
  };

  return ctx;
}

const bodyChildren = (node) => {
  if (!node) return [];

  if (isEl(node, 'body')) return node.children || [];

  if (isEl(node, 'html') || isEl(node, '#root') || !node.name) {
    let found = null;
    (function seek(n) {
      if (found) return;

      if (isEl(n, 'body')) { found = n;

 return; }

      for (const c of n.children || []) seek(c);
    })(node);

    if (found) return found.children || [];
  }

  return node.children || [];
};

function* walkAll(node) {
  yield node;

  for (const c of node.children || []) yield* walkAll(c);
}

/**
 * Body tree → .docx bytes. `bodyNode` is the parsed `<body>` (or a document root
 * containing one). `opts.warnings`, when an array, collects non-fatal losses.
 */
export async function toDocx(bodyNode, opts = {}) {
  const ctx = makeContext(opts);

  // Comments must be known before the body is walked (an `<aside>` may precede
  // the `<mark data-c>` it answers), and an anchored aside moves out of the flow
  // into comments.xml. One pass collects anchors and threads over the whole body.
  for (const node of walkAll(bodyNode || { children: [] })) {
    if (isEl(node, 'mark') && node.attrs['data-c']) ctx.marks.add(node.attrs['data-c']);
    else if (isEl(node, 'aside') && node.attrs['data-thread']) ctx.comments.set(node.attrs['data-thread'], node);
  }

  for (const [cid, aside] of ctx.comments) {
    if (ctx.marks.has(cid)) ctx.consumedAsides.add(aside);
  }

  const body = blocks(bodyChildren(bodyNode), ctx, null);

  const commentsXmlPart = [...ctx.commentBodies.values()]
    .sort((a, b) => a.id - b.id)
    .map((c) => `<w:comment w:id="${c.id}" w:author="${escA(c.author)}" w:date="${escA(c.date)}"`
      + ` w:initials="${escA(c.initials)}">${c.xml}</w:comment>`)
    .join('');

  const hasComments = commentsXmlPart.length > 0;

  const sectPr = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
    + 'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

  const ns = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}"`;

  const document =
    `${XML_DECL}<w:document ${ns}><w:body>${body}${sectPr}</w:body></w:document>`;

  // Relationship ids are handed out in a fixed order so the parts stay stable.
  // The document body already wrote ctx.rels ids into hyperlink/image runs, so
  // the comment relationship is appended last (nothing in the body points at it).
  const docRels = ctx.rels.slice();

  if (hasComments) {
    docRels.push({ id: `rId${docRels.length + 1}`, type: `${R}/comments`, target: 'comments.xml' });
  }

  const enc = new TextEncoder();

  const parts = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypesXml(ctx.mediaTypes, hasComments)) },
    { name: '_rels/.rels', data: enc.encode(rootRelsXml()) },
    { name: 'docProps/core.xml', data: enc.encode(coreXml(opts)) },
    { name: 'docProps/app.xml', data: enc.encode(appXml()) },
    { name: 'word/document.xml', data: enc.encode(document) },
    { name: 'word/styles.xml', data: enc.encode(stylesXml(opts.lang || 'en')) },
    { name: 'word/numbering.xml', data: enc.encode(numberingXml(ctx.numSeq)) },
    { name: 'word/settings.xml', data: enc.encode(settingsXml()) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(relsXml(docRels)) },
  ];

  if (hasComments) {
    parts.push({ name: 'word/comments.xml', data: enc.encode(`${XML_DECL}<w:comments xmlns:w="${W}">${commentsXmlPart}</w:comments>`) });
  }

  for (const m of ctx.mediaBytes) parts.push({ name: `word/media/${m.name}`, data: bytesOf(m.bytes) });

  return zip(parts);
}
