// SPEC §9 performance budgets, measured on a ~2,400-block document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from '../src/format.js';
import { lint } from '../src/lint.js';
import { parse } from '../src/parse.js';
import { queryAll } from '../src/select.js';
import { toDocx } from '../src/docx.js';

function bigDocument(sections = 400) {
  let body = '<body>';
  for (let i = 0; i < sections; i++) {
    body += `<section id="s${i}"><h2>Section ${i}</h2>`
      + `<p>Paragraph <strong>${i}</strong> with <a href="https://example.test/${i}">link</a>.</p>`
      + '<ul><li>a</li><li>b</li><li>c</li></ul>'
      + `<table><tr><th>x</th><td data-align="right">${i}</td></tr></table></section>`;
  }
  return `${format(`${body}</body>`, { style: 'inline' }).text}`;
}

const median = (fn, rounds = 7) => {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(rounds / 2)];
};

test('SPEC §9 budgets on a large document', async () => {
  const doc = bigDocument();
  const blocks = queryAll(parse(doc).root, 'body > section').length;
  assert.equal(blocks, 400);
  assert.ok(doc.length > 100_000, `document is only ${doc.length} bytes`);

  const fmt = median(() => format(doc, { style: 'inline' }));
  const parsed = parse(doc);
  const body = parsed.root.children.find((c) => c.name === 'html').children.find((c) => c.name === 'body');
  const read = median(() => queryAll(body, 'p'));
  const checked = median(() => lint(doc));
  const t0 = performance.now();
  const docx = await toDocx(body, { title: 'bench', resolveImage: () => null });
  const docxMs = performance.now() - t0;

  process.stdout.write(`bench: ${doc.length} bytes, ${blocks} sections — fmt ${fmt.toFixed(1)}ms, lint ${checked.toFixed(1)}ms, get ${read.toFixed(1)}ms, docx ${docxMs.toFixed(0)}ms\n`);

  assert.equal(docx[0], 0x50); // "PK"
  assert.equal(docx[1], 0x4b);
  assert.ok(docx.length > 1_000, `docx is only ${docx.length} bytes`);
  assert.ok(fmt < 150, `fmt took ${fmt.toFixed(1)}ms (budget 150ms)`);
  assert.ok(checked < 200, `lint took ${checked.toFixed(1)}ms`);
  assert.ok(read < 150, `queryAll took ${read.toFixed(1)}ms (budget 150ms)`);
  assert.ok(docxMs < 500, `toDocx took ${docxMs.toFixed(0)}ms (budget 500ms)`);
});
