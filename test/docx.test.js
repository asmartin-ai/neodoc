import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { toDocx } from '../src/docx.js';
import { parse } from '../src/parse.js';

// ---------------------------------------------------------------- test helpers

/** The parsed `<body>` of a fragment, which is what `toDocx` consumes. */
function body(html) {
  const { root } = parse(`<!doctype html><html><head></head><body>${html}</body></html>`);
  let found = null;
  (function seek(n) {
    if (found || n.type !== 'element') return;
    if (n.name === 'body') { found = n; return; }
    for (const c of n.children || []) seek(c);
  })(root);
  return found;
}

const utf8 = new TextDecoder();
const text = (u8) => utf8.decode(u8);

/** Minimal zip reader: no data descriptors are written, so sizes and crc come from the headers. */
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'end of central directory found');
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50, 'central directory header');
    const method = dv.getUint16(at + 10, true);
    const crc = dv.getUint32(at + 16, true);
    const compSize = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const localAt = dv.getUint32(at + 42, true);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    assert.equal(dv.getUint32(localAt, true), 0x04034b50, 'local header signature');
    assert.equal(dv.getUint16(localAt + 6, true), 0, 'no data descriptor flag');
    assert.equal(dv.getUint16(localAt + 8, true), method, 'local and central methods agree');
    assert.equal(dv.getUint32(localAt + 14, true), crc, 'local and central crc agree');
    const start = localAt + 30 + dv.getUint16(localAt + 26, true) + dv.getUint16(localAt + 28, true);
    const data = bytes.subarray(start, start + compSize);
    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(data)) : new Uint8Array(data));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Tag-balance scanner: enough to prove our emitted XML is well formed. */
function assertWellFormed(xml, label = 'xml') {
  const stack = [];
  const errors = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let m;
  let last = 0;
  while ((m = re.exec(xml))) {
    const gap = xml.slice(last, m.index);
    if (gap.includes('<')) errors.push('stray <');
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(gap)) errors.push('unescaped &');
    last = m.index + m[0].length;
    if (m[2] === undefined) continue; // declaration or comment
    if (m[1] === '/') {
      if (stack.pop() !== m[2]) errors.push(`unbalanced </${m[2]}>`);
    } else if (!m[4]) {
      stack.push(m[2]);
    }
  }
  assert.equal(errors.length, 0, `${label}: ${errors.join(', ')}`);
  assert.equal(stack.length, 0, `${label}: unclosed ${stack.join(', ')}`);
}

const xmlParts = (files) => [...files].filter(([n]) => n.endsWith('.xml') || n.endsWith('.rels'));

// ---------------------------------------------------------------------- tests

test('the package holds a complete, well-formed OPC part set', async () => {
  const bytes = await toDocx(body('<h1>Hi</h1><p>Text</p>'));
  assert.ok(bytes instanceof Uint8Array);
  const files = unzip(bytes);
  assert.deepEqual([...files.keys()].sort(), [
    '[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml',
    'word/_rels/document.xml.rels', 'word/document.xml', 'word/numbering.xml',
    'word/settings.xml', 'word/styles.xml',
  ].sort());
  for (const [name, data] of xmlParts(files)) assertWellFormed(text(data), name);
  assert.match(text(files.get('word/settings.xml')), /<w:compat>/);
  assert.match(text(files.get('word/document.xml')), /<w:sectPr>/);
});

test('blocks map to heading, normal, quote and fixed-spacing code paragraphs', async () => {
  const files = unzip(await toDocx(body(
    '<h2>Title</h2><p>plain</p><blockquote><p>quoted</p></blockquote>'
    + '<pre>if (x) {\n    y();\n}</pre>',
  )));
  const doc = text(files.get('word/document.xml'));
  assert.match(doc, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(doc, /<w:pStyle w:val="Normal"\/>/);
  assert.match(doc, /<w:pStyle w:val="Quote"\/>/);
  assert.equal((doc.match(/<w:pStyle w:val="NeodocCode"\/>/g) || []).length, 3);
  assert.match(doc, /<w:t>if \(x\) \{<\/w:t>/);
  // Relative indentation inside a code block survives as leading spaces.
  assert.match(doc, /<w:t xml:space="preserve">    y\(\);<\/w:t>/);
  assert.match(text(files.get('word/styles.xml')), /w:styleId="NeodocCode"/);
  assert.match(text(files.get('word/styles.xml')), /ascii="Consolas"/);
});

test('inline elements map to the documented run properties', async () => {
  const doc = text(unzip(await toDocx(body(
    '<p>a <strong>b</strong> <em>c</em> <code>d</code> <s>e</s> <u>f</u> <mark>g</mark> '
    + '<sub>h</sub><sup>i</sup><br>end</p>',
  ))).get('word/document.xml'));
  assert.match(doc, /<w:rPr><w:b\/><\/w:rPr>/);
  assert.match(doc, /<w:rPr><w:i\/><\/w:rPr>/);
  assert.match(doc, /<w:rFonts w:ascii="Consolas"[^/]*\/><w:shd w:val="clear"[^/]*\/>/);
  assert.match(doc, /<w:strike\/>/);
  assert.match(doc, /<w:u w:val="single"\/>/);
  assert.match(doc, /<w:highlight w:val="yellow"\/>/);
  assert.match(doc, /<w:vertAlign w:val="subscript"\/>/);
  assert.match(doc, /<w:vertAlign w:val="superscript"\/>/);
  assert.match(doc, /<w:br\/>/);
});

test('a 2×2 table produces four bounded cells with an aligned, shaded header', async () => {
  const doc = text(unzip(await toDocx(body(
    '<table><thead><tr><th>a</th><th data-align="right">b</th></tr></thead>'
    + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
  ))).get('word/document.xml'));
  assert.equal((doc.match(/<w:tc>/g) || []).length, 4);
  assert.equal((doc.match(/<w:tcPr>/g) || []).length, 4);
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:tblBorders>/);
  assert.match(doc, /<w:tblGrid><w:gridCol\/><w:gridCol\/><\/w:tblGrid>/);
  assert.match(doc, /<w:shd w:val="clear" w:color="auto" w:fill="D9D9D9"\/>/);
  assert.match(doc, /<w:jc w:val="right"\/>/);
  assert.match(doc, /<w:rPr><w:b\/><\/w:rPr>/);
});

test('lists use real numbering, with the item text kept', async () => {
  const doc = text(unzip(await toDocx(body(
    '<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>',
  ))).get('word/document.xml'));
  assert.equal((doc.match(/<w:numId w:val="1"\/>/g) || []).length, 2);
  assert.equal((doc.match(/<w:numId w:val="2"\/>/g) || []).length, 1);
  assert.match(doc, /<w:ilvl w:val="0"\/>/);
  assert.match(doc, /<w:t>one<\/w:t>/);
  assert.match(doc, /<w:t>first<\/w:t>/);
});

test('a mark with a thread becomes a real comment; replies stay in its body', async () => {
  const files = unzip(await toDocx(body(
    '<p>a <mark data-c="c1">b</mark> c</p>'
    + '<aside data-thread="c1" data-state="open">'
    + '<p data-author="ada" data-at="2026-10-16T09:12:00Z">Source?</p>'
    + '<p data-author="ken" data-at="2026-10-16T10:00:00Z">Yes.</p></aside>',
  )));
  assert.ok(files.has('word/comments.xml'));
  const doc = text(files.get('word/document.xml'));
  assert.match(doc, /<w:commentRangeStart w:id="1"\/>/);
  assert.match(doc, /<w:commentRangeEnd w:id="1"\/>/);
  assert.match(doc, /<w:commentReference w:id="1"\/>/);
  assert.match(doc, /<w:t>b<\/w:t>/);
  assert.ok(!doc.includes('Source?'), 'the anchored aside moves out of the body flow');
  const comments = text(files.get('word/comments.xml'));
  assert.match(comments, /<w:comment w:id="1" w:author="ada" w:date="2026-10-16T09:12:00Z" w:initials="A">/);
  assert.match(comments, /<w:t>Source\?<\/w:t>/);
  assert.match(comments, /<w:t xml:space="preserve">ken: <\/w:t>/);
  assert.match(comments, /<w:t>Yes\.<\/w:t>/);
  assert.match(text(files.get('[Content_Types].xml')), /PartName="\/word\/comments.xml"/);
  assert.match(text(files.get('word/_rels/document.xml.rels')), /Type="[^"]*\/comments" Target="comments.xml"/);
  for (const [name, data] of xmlParts(files)) assertWellFormed(text(data), name);
});

test('a document-level aside (no mark) keeps its text as quoted blocks', async () => {
  const files = unzip(await toDocx(body('<aside data-thread="orphan"><p>Note</p></aside>')));
  assert.ok(!files.has('word/comments.xml'));
  const doc = text(files.get('word/document.xml'));
  assert.match(doc, /<w:pStyle w:val="Quote"\/>/);
  assert.match(doc, /<w:t>Note<\/w:t>/);
});

test('ins and del become tracked changes with author, date and delText', async () => {
  const doc = text(unzip(await toDocx(body(
    '<p>x <ins data-author="ada" data-at="2026-10-16T09:12:00Z">added</ins> '
    + '<del data-author="ken" data-at="2026-10-16T10:00:00Z">gone</del></p>',
  ))).get('word/document.xml'));
  assert.match(doc, /<w:ins w:id="1" w:author="ada" w:date="2026-10-16T09:12:00Z"><w:r><w:t>added<\/w:t><\/w:r><\/w:ins>/);
  assert.match(doc, /<w:del w:id="2" w:author="ken" w:date="2026-10-16T10:00:00Z"><w:r><w:delText>gone<\/w:delText><\/w:r><\/w:del>/);
  assert.ok(!doc.includes('<w:t>gone</w:t>'), 'deleted runs never use w:t');
});

test('links become hyperlink runs backed by an external relationship', async () => {
  const files = unzip(await toDocx(body('<p>see <a href="https://example.com/a?b=1&amp;c=2">docs</a></p>')));
  const doc = text(files.get('word/document.xml'));
  assert.match(doc, /<w:hyperlink r:id="rId4"><w:r><w:t>docs<\/w:t><\/w:r><\/w:hyperlink>/);
  assert.match(text(files.get('word/_rels/document.xml.rels')),
    /Id="rId4" Type="[^"]*\/hyperlink" Target="https:\/\/example\.com\/a\?b=1&amp;c=2" TargetMode="External"/);
});

test('images become media parts with a drawing, and unresolved ones warn', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const src = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  const files = unzip(await toDocx(body(
    `<figure><img alt="chart" src="${src}" width="200"><figcaption>The caption</figcaption></figure>`,
  )));
  assert.ok(files.has('word/media/image1.png'));
  assert.deepEqual([...files.get('word/media/image1.png')], [...png]);
  const doc = text(files.get('word/document.xml'));
  assert.match(doc, /<w:drawing>/);
  assert.match(doc, /r:embed="rId4"/);
  assert.match(doc, /<a:ext cx="1905000" cy="1270000"\/>/, '200×133 px at 9525 EMU per px');
  assert.match(doc, /<w:jc w:val="center"\/>/);
  assert.match(doc, /<w:t>The caption<\/w:t>/);
  assert.match(text(files.get('[Content_Types].xml')), /Extension="png" ContentType="image\/png"/);
  assert.match(text(files.get('word/_rels/document.xml.rels')), /Type="[^"]*\/image" Target="media\/image1.png"/);

  const warnings = [];
  const missing = unzip(await toDocx(body('<p><img alt="gone" src="missing.png"></p>'), { warnings }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing\.png/);
  assert.match(text(missing.get('word/document.xml')), /<w:t>\[image: gone\]<\/w:t>/);
});

test('text is escaped and edge whitespace preserved', async () => {
  const doc = text(unzip(await toDocx(body('<p>a &amp; b &lt;c&gt; d</p>'))).get('word/document.xml'));
  assert.match(doc, /<w:t>a &amp; b &lt;c&gt; d<\/w:t>/);
  assertWellFormed(doc);
});

test('output is byte-deterministic and carries the requested metadata', async () => {
  const html = '<h1>Report</h1><p>a <mark data-c="c1">b</mark></p>'
    + '<ul><li>i</li></ul><table><tr><td>1</td><td>2</td></tr></table>'
    + '<aside data-thread="c1"><p data-author="ada" data-at="2026-10-16T09:12:00Z">Why?</p></aside>';
  const opts = { title: 'Report', author: 'Ken', date: '2026-10-16', lang: 'en-GB' };
  const first = await toDocx(body(html), { ...opts });
  const second = await toDocx(body(html), { ...opts });
  assert.deepEqual([...first], [...second]);
  const bare = [await toDocx(body(html)), await toDocx(body(html))];
  assert.deepEqual([...bare[0]], [...bare[1]]);
  const parts = unzip(first);
  // Fixed timestamps: two runs of the same input never differ by a clock tick.
  assert.equal(text(unzip(bare[0]).get('docProps/core.xml')).includes('1980-01-01T00:00:00Z'), true);
  const core = text(parts.get('docProps/core.xml'));
  assert.match(core, /<dc:title>Report<\/dc:title>/);
  assert.match(core, /<dc:creator>Ken<\/dc:creator>/);
  assert.match(core, /<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-16T00:00:00Z<\/dcterms:created>/);
  assert.match(text(unzip(first).get('word/styles.xml')), /<w:lang w:val="en-GB"\/>/);
});
