import test from 'node:test';
import assert from 'node:assert/strict';
import { format, formatFragment } from '../src/format.js';
import { parse } from '../src/parse.js';
import { toMarkdown, fromMarkdown } from '../src/markdown.js';

const fmt = (s) => format(s, { style: 'none' }).text;

/** Body lines of the canonical document, as one string. */
function canon(html) {
  const lines = fmt(`<!doctype html><html><body>${html}</body></html>`).split('\n');
  const a = lines.findIndex((l) => l.trim() === '<body>');
  const b = lines.findIndex((l) => l.trim() === '</body>');
  return lines.slice(a + 1, b).join('\n');
}

function bodyNode(html) {
  const { root } = parse(`<!doctype html><html><body>${html}</body></html>`);
  const el = (n, name) => n.children.find((c) => c.type === 'element' && c.name === name);
  return el(el(root, 'html'), 'body');
}

const roundTrip = (html) => {
  const md = toMarkdown(bodyNode(html));
  const { html: back, warnings } = fromMarkdown(md);
  return { md, back, warnings, got: canon(back) };
};

// ------------------------------------------------------------------ round trip

const FIXTURES = {
  'headings and inline emphasis': '<h1>Intro</h1><h2>Details</h2><h3>Deeper</h3><h6>Deepest</h6>'
    + '<p>Plain, <strong>bold</strong>, <em>it</em>, <code>x = 1</code>, <del>gone</del>, '
    + 'and <a href="https://example.com/a?b=1">a link</a>.</p>',
  'lists, nesting and task items': '<ul><li>a<ul><li>b</li></ul></li>'
    + '<li data-checked="true">done</li><li data-checked="false">todo</li></ul>'
    + '<ol><li>one</li><li>two<ul><li>nested</li></ul></li></ol>',
  'nested list inside a blockquote': '<blockquote><p>Quote</p><ul><li>a<ul><li>b</li></ul></li></ul></blockquote>',
  'fenced code keeps its language': '<pre data-lang="js">const a = 1;\nconsole.log(a);</pre><p>After.</p>',
  'table with alignment and a pipe in a cell': '<table><thead><tr><th>Name</th>'
    + '<th data-align="right">Qty</th><th data-align="center">Note</th></tr></thead><tbody>'
    + '<tr><td>a | b</td><td data-align="right">2</td><td data-align="center">ok</td></tr>'
    + '<tr><td>c</td><td data-align="right">3</td><td data-align="center">fine</td></tr></tbody></table>',
  'images, links and hard breaks': '<p>See <img alt="diagram" src="d.png"> and '
    + '<a href="https://x.example/p?q=1&amp;r=2">x</a>.</p><p>line one<br>line two</p>',
  'hr and figures': '<h1>A</h1><hr><figure><img alt="plot" src="p.png">'
    + '<figcaption>Caption text</figcaption></figure><p>End.</p>',
};

for (const [name, html] of Object.entries(FIXTURES)) {
  test(`round trip: ${name}`, () => {
    const { md, back, warnings, got } = roundTrip(html);
    assert.equal(warnings.join('; '), '', `unexpected warnings for markdown:\n${md}`);
    assert.equal(got, canon(html), `fromMarkdown(toMarkdown(x)) is not canonical for:\n${md}\n→\n${back}`);
    assert.ok(md.length > 0);
  });
}

test('round trip drops nothing and survives a second pass', () => {
  for (const html of Object.values(FIXTURES)) {
    const once = toMarkdown(bodyNode(html));
    const twice = toMarkdown(bodyNode(fromMarkdown(once).html));
    assert.equal(twice, once);
  }
});

// -------------------------------------------------------- markdown → HTML shape

const lines = (md) => formatFragment(fromMarkdown(md).html).lines;

test('ATX headings, paragraphs and escapes', () => {
  assert.deepEqual(lines('# Title\n\nbody **bold** and \\*literal\\*'), [
    '<h1>Title</h1>',
    '<p>body <strong>bold</strong> and *literal*</p>',
  ]);
});

test('emphasis forms, `_` inside words, and nested emphasis', () => {
  assert.deepEqual(lines('_em_ __strong__ and **a *b* c** but snake_case'), [
    '<p><em>em</em> <strong>strong</strong> and <strong>a <em>b</em> c</strong> but snake_case</p>',
  ]);
});

test('strike, highlight and CriticMarkup changes', () => {
  assert.deepEqual(lines('~~old~~ ==hot== {++new++} {--gone--}'), [
    '<p><del>old</del> <mark>hot</mark> <ins>new</ins> <del>gone</del></p>',
  ]);
});

test('email autolinks and inline raw HTML for sub/sup', () => {
  assert.deepEqual(lines('mail <ada@example.org> and H<sub>2</sub>O'), [
    '<p>mail <a href="mailto:ada@example.org">ada@example.org</a> and H<sub>2</sub>O</p>',
  ]);
});

test('empty and whitespace-only input produce nothing', () => {
  assert.deepEqual(fromMarkdown(''), { html: '', warnings: [] });
  assert.equal(lines('\n\n   \n').length, 0);
  assert.equal(toMarkdown(bodyNode('')), '');
});

test('toMarkdown works on a parsed canonical file, not just a fresh body', () => {
  const file = fmt(`<!doctype html><html><body>\n<h1>Title</h1>\n<p>Text <strong>b</strong>.</p>\n<ul>\n<li>item</li>\n</ul>\n</body></html>`);
  const { root } = parse(file);
  assert.equal(toMarkdown(root), '# Title\n\nText **b**.\n\n- item\n');
});

test('notes go out as GFM alerts and come back', () => {
  const body = bodyNode('<aside data-note="warn"><p>Careful.</p></aside>');
  assert.equal(toMarkdown(body), '> [!WARNING]\n>\n> Careful.\n');
  assert.equal(canon(fromMarkdown(toMarkdown(body)).html), canon('<aside data-note="warn"><p>Careful.</p></aside>'));
});

test('a fallback raw HTML block may contain a multi-line pre', () => {
  const html = '<section id="s"><h2>T</h2><pre data-lang="sh">if [ -f a ]; then\n\n  echo <b>\nfi</pre></section>';
  const { html: back, warnings } = fromMarkdown(toMarkdown(bodyNode(html)));
  assert.equal(warnings.join('; '), '');
  assert.equal(canon(back), canon(html));
});

test('hard breaks survive at paragraph edges and inside table cells', () => {
  for (const html of ['<p>a<br></p>', '<p><br></p>', '<p><br>b</p>', '<p>a<br><br>b</p>']) {
    assert.equal(canon(fromMarkdown(toMarkdown(bodyNode(html))).html), canon(html), html);
  }
  const cell = '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>x<br>y</td></tr></tbody></table>';
  const md = toMarkdown(bodyNode(cell));
  assert.match(md, /\| x<br>y \|/, md); // a cell is one line, so HTML `<br>` is the only form
  assert.equal(canon(fromMarkdown(md).html), canon(cell));
});

test('setext underlines are not headings, and a pipe does not make a table', () => {
  assert.deepEqual(lines('Title\n---'), ['<p>Title</p>', '<hr>']);
  assert.deepEqual(lines('a | b\n---'), ['<p>a | b</p>', '<hr>']);
});

test('lists nest by indentation and read task items', () => {
  assert.deepEqual(lines('- a\n  - b\n- [x] done\n- [ ] todo\n\n1. one\n2. two'), [
    '<ul>',
    '  <li>',
    '    a',
    '    <ul>',
    '      <li>b</li>',
    '    </ul>',
    '  </li>',
    '  <li data-checked="true">done</li>',
    '  <li data-checked="false">todo</li>',
    '</ul>',
    '<ol>',
    '  <li>one</li>',
    '  <li>two</li>',
    '</ol>',
  ]);
});

test('fenced and indented code', () => {
  assert.deepEqual(lines('```py\nx = 1\n```\n\n    indented\n    code'), [
    '<pre data-lang="py">x = 1</pre>',
    '<pre>indented\ncode</pre>',
  ]);
});

test('blockquotes nest, and GFM alerts become note asides', () => {
  assert.deepEqual(lines('> outer\n> > inner'), [
    '<blockquote>',
    '  <p>outer</p>',
    '  <blockquote>',
    '    <p>inner</p>',
    '  </blockquote>',
    '</blockquote>',
  ]);
  assert.deepEqual(lines('> [!WARNING]\n>\n> Careful.'), [
    '<aside data-note="warn">',
    '  <p>Careful.</p>',
    '</aside>',
  ]);
});

test('tables: alignment, escaped pipes, autolinks, data URIs, sub/sup', () => {
  assert.deepEqual(lines('| a | b |\n| :-- | --: |\n| x \\| y | <https://e.example> |'), [
    '<table>',
    '  <thead>',
    '    <tr>',
    '      <th data-align="left">a</th>',
    '      <th data-align="right">b</th>',
    '    </tr>',
    '  </thead>',
    '  <tbody>',
    '    <tr>',
    '      <td data-align="left">x | y</td>',
    '      <td data-align="right"><a href="https://e.example">https://e.example</a></td>',
    '    </tr>',
    '  </tbody>',
    '</table>',
  ]);
  assert.deepEqual(lines('<sub>2</sub> and ![i](data:image/png;base64,AAA)'), [
    '<p><sub>2</sub> and <img alt="i" src="data:image/png;base64,AAA"></p>',
  ]);
});

test('indented code and hard breaks', () => {
  assert.deepEqual(lines('one  \ntwo\\\nthree'), ['<p>one<br>two<br>three</p>']);
});

test('reference links warn and keep their text', () => {
  const { warnings } = fromMarkdown('see [docs][1] here');
  assert.match(warnings.join('; '), /reference links/);
  assert.deepEqual(lines('see [docs][1] here'), ['<p>see [docs][1] here</p>']);
});

// ------------------------------------------------------------------ escaping

test('raw script/iframe HTML never reaches the output', () => {
  const { html, warnings } = fromMarkdown('<script>alert(1)</script>\n\n<iframe src="x"></iframe>');
  assert.ok(!html.includes('<script'), html);
  assert.ok(!html.includes('<iframe'), html);
  assert.equal(warnings.length, 2);
  assert.deepEqual(formatFragment(html).lines, [
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    '<p>&lt;iframe src="x"&gt;&lt;/iframe&gt;</p>',
  ]);
  assert.ok(!fmt(`<!doctype html><html><body>${html}</body></html>`).includes('<script'));
});

test('vocabulary HTML passes through, other inline HTML is escaped', () => {
  assert.deepEqual(lines('<mark data-c="c1">x</mark> and <span>y</span>'), [
    '<p><mark data-c="c1">x</mark> and &lt;span&gt;y&lt;/span&gt;</p>',
  ]);
});

// ------------------------------------------------------------------- comments

const COMMENTED = '<p>Claim <mark data-c="c1">x</mark>.</p>'
  + '<aside data-thread="c1" data-state="open"><p data-author="ada" data-at="2026-10-16T09:12:00Z">Source?</p></aside>';

test('comments=html keeps anchors and threads as raw HTML', () => {
  const md = toMarkdown(bodyNode(COMMENTED));
  assert.equal(md, 'Claim <mark data-c="c1">x</mark>.\n\n'
    + '<aside data-state="open" data-thread="c1">\n  <p data-at="2026-10-16T09:12:00Z" data-author="ada">Source?</p>\n</aside>\n');
  assert.equal(canon(fromMarkdown(md).html), canon(COMMENTED));
});

test('comments=critic emits CriticMarkup and reads it back', () => {
  const md = toMarkdown(bodyNode(COMMENTED), { comments: 'critic' });
  assert.equal(md, 'Claim {==x==}.\n\n{>>ada: Source?<<}\n');
  const back = fromMarkdown(md);
  assert.equal(back.warnings.join('; '), '');
  // A thread on its own line cannot be tied back to the anchor (CriticMarkup has
  // neither ids nor anchors), so it reads back as a document-level annotation.
  assert.equal(formatFragment(back.html).lines.join('\n'), [
    '<p>Claim <mark>x</mark>.</p>',
    '<aside data-thread="c1">',
    '  <p data-author="ada">Source?</p>',
    '</aside>',
  ].join('\n'));
  // Within one paragraph the anchor and its thread do pair up.
  assert.equal(formatFragment(fromMarkdown('Claim {==x==}{>>ada: Source?<<}.').html).lines.join('\n'), [
    '<p>Claim <mark data-c="c1">x</mark>.</p>',
    '<aside data-thread="c1">',
    '  <p data-author="ada">Source?</p>',
    '</aside>',
  ].join('\n'));
});

test('comments=critic reads unanchored threads, comments=drop strips anchors', () => {
  const md = toMarkdown(bodyNode(COMMENTED), { comments: 'drop' });
  assert.equal(md, 'Claim x.\n');
  assert.equal(fromMarkdown(md).warnings.length, 0);
  assert.equal(toMarkdown(bodyNode('<p>a <mark>b</mark></p>')), 'a ==b==\n');
});

test('each comment thread follows its own block; drop removes them all', () => {
  const html = '<p>one <mark data-c="c1">a</mark></p><aside data-thread="c1"><p data-author="ada">why a?</p></aside>'
    + '<p>two <mark data-c="c2">b</mark></p><aside data-thread="c2"><p data-author="ken">why b?</p>'
    + '<p data-author="ada">agreed</p></aside><aside data-thread="c3"><p data-author="sam">doc note</p></aside>';
  assert.equal(toMarkdown(bodyNode(html), { comments: 'critic' }),
    'one {==a==}\n\n{>>ada: why a?<<}\n\ntwo {==b==}\n\n{>>ken: why b?<<}\n{>>ada: agreed<<}\n\n{>>sam: doc note<<}\n');
  assert.equal(toMarkdown(bodyNode(html), { comments: 'drop' }), 'one a\n\ntwo b\n');
});

test('tracked changes: ins is HTML, del is ~~, critic uses braces', () => {
  const body = bodyNode('<p><ins data-author="ada">new</ins> <del data-author="ada">old</del></p>');
  assert.equal(toMarkdown(body), '<ins data-author="ada">new</ins> ~~old~~\n');
  assert.equal(toMarkdown(body, { comments: 'critic' }), '{++new++} {--old--}\n');
  assert.equal(toMarkdown(bodyNode('<p>{++new++} {--old--} {==hi==}</p>') && bodyNode('<p><ins>new</ins></p>')), '<ins>new</ins>\n');
});

test('unknown comment mode is rejected', () => {
  assert.throws(() => toMarkdown(bodyNode('<p>x</p>'), { comments: 'nope' }), /unknown comments mode/);
});

// --------------------------------------------------------------- one-way shape

test('block-level images, unordered lists and long fences', () => {
  const pre = bodyNode('<pre>a ``` b\n```</pre>');
  const md = toMarkdown(pre);
  const fence = /^`+/.exec(md)[0];
  assert.ok(fence.length > 3, md);
  assert.equal(fromMarkdown(md).warnings.length, 0);
  assert.equal(canon(fromMarkdown(md).html), canon('<pre>a ``` b\n```</pre>'));
});

test('elements markdown cannot express fall back to canonical HTML', () => {
  const html = '<section id="s"><h2 id="t">T</h2><p>a</p></section>'
    + '<ol start="3"><li>c</li></ol><p><u>under</u></p>';
  const md = toMarkdown(bodyNode(html));
  assert.match(md, /<section id="s">/);
  assert.match(md, /<ol start="3">/);
  assert.match(md, /<u>under<\/u>/);
  assert.equal(canon(fromMarkdown(md).html), canon(html));
});
