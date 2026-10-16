// Neodoc CLI — the agent and scripting interface (docs/SPEC.md §7).
//
// Contract: opening a document canonicalizes it, commands mutate the tree, and
// writing serializes that tree. So every write leaves the file canonical, and a
// write to an already-canonical file changes only what the command touched.
// (If the file was not canonical, the write normalizes it; the CLI says so.)

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { format, normalizeFragment, emitBlock } from './format.js';
import { parse } from './parse.js';
import { INLINE, isEl, parentOf, pathOf, textOf } from './tree.js';
import { lint } from './lint.js';
import { THEME_CSS } from './theme.js';
import { queryAll } from './select.js';
import { addComment, acceptChanges, listComments, rejectChanges, removeComment, replyToComment, resolveComment } from './comments.js';
import { fromMarkdown, toMarkdown } from './markdown.js';
import { toDocx } from './docx.js';
import { serve } from './serve.js';
import { VERSION } from './version.js';

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const fail = (message) => { err(`neodoc: ${message}`); return 2; };
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export async function main(argv) {
  const [name, ...rest] = argv;
  const args = parseArgs(rest);
  try {
    const command = COMMANDS[name];
    if (!command) {
      if (name === undefined || name === 'help' || name === '--help' || name === '-h') { out(USAGE); return 0; }
      return fail(`unknown command "${name}" — run: neodoc help`);
    }
    return await command(args);
  } catch (e) {
    return fail(e?.message ?? String(e));
  }
}

// ------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (eq !== -1) { flags[key] = token.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
      continue;
    }
    if (token.startsWith('-') && token.length === 2) { flags[token.slice(1)] = true; continue; }
    positional.push(token);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------- doc IO

function hasStyle(text) {
  return /<style[\s>]/i.test(text);
}

/** Open a document: canonicalize it, then parse the canonical text. */
function openDoc(file) {
  const raw = readFileSync(file, 'utf8');
  const mode = hasStyle(raw) ? 'inline' : 'none';
  const text = format(raw, { style: mode }).text;
  const { root } = parse(text);
  const html = root.children.find((c) => isEl(c, 'html'));
  return {
    file,
    raw,
    text,
    root,
    html,
    head: html.children.find((c) => isEl(c, 'head')),
    body: html.children.find((c) => isEl(c, 'body')),
    mode,
    reformatted: text !== raw,
  };
}

function writeAtomic(file, text) {
  const tmp = `${file}.neodoc-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function saveDoc(doc, target = doc.file) {
  const text = serializeDoc(doc);
  if (target === '-') { process.stdout.write(text); return; }
  writeAtomic(target, text);
  out(`${target}  ${text.length} bytes${doc.reformatted ? '  (was not canonical: reformatted)' : ''}`);
}

function serializeDoc(doc) {
  const lines = [];
  for (const child of doc.root.children) emitBlock(child, 0, lines);
  return `${lines.join('\n')}\n`;
}

function inBody(doc, node) {
  for (let p = node; p; p = parentOf(doc.root, p)) if (p === doc.head) return false;
  return true;
}

function bodyHits(doc, selector) {
  const hits = queryAll(doc.html, selector);
  if (!hits.length) throw new Error(`no element matches selector: ${selector}`);
  const outside = hits.filter((h) => !inBody(doc, h.node));
  if (outside.length) throw new Error(`selector matched outside <body>: ${selector}`);
  return hits;
}

function linesOf(node) {
  const lines = [];
  emitBlock(node, 0, lines);
  return lines.join('\n');
}

/** Text of the fragment given by --md/--html/--file/--stdin. */
function fragmentSource(flags) {
  if (flags.md !== undefined && flags.md !== true) return markdown(flags.md);
  if (flags.html !== undefined) return normalizeFragment(String(flags.html));
  if (flags.file) return maybeMarkdown(readFileSync(flags.file, 'utf8'), flags.md === true);
  if (flags.stdin) return maybeMarkdown(readFileSync(0, 'utf8'), flags.md === true);
  throw new Error('needs one of --md, --html, --file, --stdin');
}

function markdown(text) {
  const { html } = fromMarkdown(text);
  return normalizeFragment(html);
}

function maybeMarkdown(text, asMarkdown) {
  if (!asMarkdown) return normalizeFragment(text);
  return markdown(text);
}

// -------------------------------------------------------------------- commands

function cmdFmt(args) {
  if (!args.positional.length) return fail('fmt: expected at least one FILE');
  let bad = 0;
  for (const file of args.positional) {
    const raw = readFileSync(file, 'utf8');
    const { text, warnings } = format(raw, { style: args.flags.style ?? (hasStyle(raw) ? 'inline' : 'none') });
    for (const w of warnings) err(`${file}: ${w}`);
    if (args.flags.check) {
      if (text === raw) out(`${file}: ok`);
      else { err(`${file}: not canonical`); bad++; }
      continue;
    }
    if (args.flags.w || args.flags.write) {
      writeAtomic(file, text);
      out(`${file}  ${text.length} bytes${text === raw ? '  (unchanged)' : ''}`);
    } else process.stdout.write(text);
  }
  return bad ? 1 : 0;
}

function cmdLint(args) {
  if (!args.positional.length) return fail('lint: expected at least one FILE');
  const report = [];
  let bad = 0;
  for (const file of args.positional) {
    if (args.flags.fix) {
      const raw = readFileSync(file, 'utf8');
      const fixed = format(raw, { style: hasStyle(raw) ? 'inline' : 'none' }).text;
      if (fixed !== raw) writeAtomic(file, fixed);
    }
    const findings = lint(readFileSync(file, 'utf8')).map((f) => ({ file, ...f }));
    report.push(...findings);
    if (findings.some((f) => f.severity === 'error')) bad = 1;
  }
  if (args.flags.json) out(JSON.stringify({ ok: bad === 0, findings: report }, null, 2));
  else for (const f of report) out(`${f.file}:${f.line}: ${f.severity} ${f.rule}: ${f.message}`);
  return bad;
}

function cmdNew(args) {
  const file = args.positional[0];
  const title = String(args.flags.title ?? (file ? basename(file).replace(/\.(nd\.)?html?$/i, '') : 'Untitled'));
  const skeleton = format(
    '<!doctype html><html lang="en"><head><title></title></head><body></body></html>',
    { style: 'inline' },
  ).text;
  const { root } = parse(skeleton);
  const html = root.children.find((c) => isEl(c, 'html'));
  const head = html.children.find((c) => isEl(c, 'head'));
  const body = html.children.find((c) => isEl(c, 'body'));
  head.children.find((c) => isEl(c, 'title')).children = [{ type: 'text', text: title }];
  body.children = args.flags.stdin
    ? markdown(readFileSync(0, 'utf8')).nodes
    : [
      { type: 'element', name: 'h1', attrs: {}, children: [{ type: 'text', text: title }] },
      { type: 'element', name: 'p', attrs: {}, children: [] },
    ];
  const doc = { file: file ?? '-', root, reformatted: false };
  if (!file) { process.stdout.write(serializeDoc(doc)); return 0; }
  saveDoc(doc);
  return 0;
}

function cmdGet(args) {
  const [file, selector] = args.positional;
  if (!file || !selector) return fail('get: usage: neodoc get FILE SELECTOR');
  const doc = openDoc(file);
  const hits = queryAll(doc.html, selector);
  if (args.flags.json) {
    out(JSON.stringify({
      ok: true,
      file,
      count: hits.length,
      matches: hits.map((h) => ({
        path: pathOf(doc.html, h.node),
        tag: h.node.name,
        id: h.node.attrs.id ?? null,
        attrs: h.node.attrs,
        text: textOf(h.node),
        html: linesOf(h.node),
      })),
    }, null, 2));
  } else {
    for (const h of hits) out(`${pathOf(doc.html, h.node)}\t${args.flags.text ? textOf(h.node) : linesOf(h.node)}`);
  }
  return hits.length ? 0 : 1;
}

function cmdSet(args) {
  const [file, selector] = args.positional;
  if (!file || !selector) return fail('set: usage: neodoc set FILE SELECTOR (--md S | --html S | --file F)');
  const doc = openDoc(file);
  const [hit] = bodyHits(doc, selector);
  const { nodes } = fragmentSource(args.flags);
  if (!nodes.length) throw new Error('set: the replacement is empty (use rm to delete)');
  if (INLINE.has(hit.node.name) && nodes.some((n) => n.type === 'element' && !INLINE.has(n.name))) {
    throw new Error(`set: cannot put block content into inline <${hit.node.name}>`);
  }
  hit.parent.children.splice(hit.index, 1, ...nodes);
  saveDoc(doc);
  return 0;
}

function cmdInsert(args) {
  const [file, selector] = args.positional;
  const mode = ['before', 'after', 'append-to'].find((k) => args.flags[k] !== undefined);
  if (!file || !mode) return fail('insert: usage: neodoc insert FILE (--before|--after|--append-to) SELECTOR (--md S | --html S | --file F)');
  const target = mode === 'append-to' ? String(args.flags[mode]) : selector;
  const doc = openDoc(file);
  const [hit] = bodyHits(doc, target);
  const { nodes } = fragmentSource(args.flags);
  if (mode === 'append-to') {
    if (INLINE.has(hit.node.name)) throw new Error(`insert: <${hit.node.name}> cannot contain blocks`);
    hit.node.children.push(...nodes);
  } else hit.parent.children.splice(mode === 'before' ? hit.index : hit.index + 1, 0, ...nodes);
  saveDoc(doc);
  return 0;
}

function cmdRm(args) {
  const [file, selector] = args.positional;
  if (!file || !selector) return fail('rm: usage: neodoc rm FILE SELECTOR');
  const doc = openDoc(file);
  const hits = bodyHits(doc, selector);
  const byParent = new Map();
  for (const h of hits) {
    if (!byParent.has(h.parent)) byParent.set(h.parent, []);
    byParent.get(h.parent).push(h.index);
  }
  for (const [parent, indexes] of byParent) {
    for (const index of indexes.sort((a, b) => b - a)) parent.children.splice(index, 1);
  }
  saveDoc(doc);
  out(`removed ${hits.length} block(s)`);
  return 0;
}

function cmdId(args) {
  const [file] = args.positional;
  const selector = args.flags.for;
  const id = args.flags.as;
  if (!file || !selector || !id) return fail('id: usage: neodoc id FILE --for SELECTOR --as NAME');
  const doc = openDoc(file);
  const [hit] = bodyHits(doc, selector);
  const taken = queryAll(doc.html, `[id="${id}"]`).length > 0;
  if (taken) throw new Error(`id "${id}" is already used`);
  hit.node.attrs.id = String(id);
  saveDoc(doc);
  return 0;
}

function cmdComment(args) {
  const [sub, file, selector] = args.positional;
  if (!sub || !file) return fail('comment: usage: neodoc comment add|list|reply|resolve|reopen|rm FILE [...]');
  const doc = openDoc(file);
  const author = String(args.flags.author ?? process.env.USER ?? 'unknown');
  const at = String(args.flags.at ?? now());

  if (sub === 'list') {
    const state = String(args.flags.state ?? 'all');
    const items = listComments(doc.html).filter((c) => state === 'all' || c.state === state);
    if (args.flags.json) out(JSON.stringify({ ok: true, count: items.length, comments: items }, null, 2));
    else for (const c of items) out(`${c.id}  ${c.state}  ${c.path}\n    "${c.anchorText}"\n    ${c.author} ${c.at}: ${c.text}`);
    return 0;
  }
  if (sub === 'add') {
    if (args.flags.body === undefined) throw new Error('comment add: needs --body "text"');
    const info = addComment(doc.html, {
      selector,
      quote: args.flags.quote === undefined ? undefined : String(args.flags.quote),
      text: String(args.flags.body),
      author,
      at,
    });
    saveDoc(doc);
    out(`comment ${info.id} anchored at ${info.anchor}`);
    return 0;
  }
  const id = selector;
  if (sub === 'reply') {
    replyToComment(doc.html, id, { text: String(args.flags.body ?? ''), author, at });
  } else if (sub === 'resolve') resolveComment(doc.html, id, true);
  else if (sub === 'reopen') resolveComment(doc.html, id, false);
  else if (sub === 'rm') removeComment(doc.html, id);
  else return fail(`comment: unknown subcommand "${sub}"`);
  saveDoc(doc);
  return 0;
}

function cmdTrack(args) {
  const [mode, file, selector] = args.positional;
  if (mode !== 'accept' && mode !== 'reject') return fail('track: usage: neodoc track accept|reject FILE [SELECTOR]');
  const doc = openDoc(file);
  const apply = mode === 'accept' ? acceptChanges : rejectChanges;
  const count = selector ? apply(doc.html, selector) : apply(doc.html);
  saveDoc(doc);
  out(`${mode}ed ${count} change(s)`);
  return 0;
}

function cmdImport(args) {
  const [source] = args.positional;
  const text = source && source !== '-' ? readFileSync(source, 'utf8') : readFileSync(0, 'utf8');
  const { nodes, warnings } = markdown(text);
  for (const w of warnings) err(`import: ${w}`);
  const title = firstHeadingText(nodes) ?? (source ? basename(source).replace(/\.(md|markdown|txt)$/i, '') : 'Untitled');
  const skeleton = format('<!doctype html><html lang="en"><head><title></title></head><body></body></html>', { style: 'inline' }).text;
  const { root } = parse(skeleton);
  const html = root.children.find((c) => isEl(c, 'html'));
  html.children.find((c) => isEl(c, 'head')).children.find((c) => isEl(c, 'title')).children = [{ type: 'text', text: title }];
  html.children.find((c) => isEl(c, 'body')).children = nodes;
  const doc = { file: String(args.flags.o ?? '-'), root, reformatted: false };
  saveDoc(doc, doc.file);
  return 0;
}

function firstHeadingText(nodes) {
  for (const node of nodes) {
    if (node.type === 'element' && /^h[1-6]$/.test(node.name)) return textOf(node);
  }
  return null;
}

async function cmdTo(args) {
  const [kind, file] = args.positional;
  if (kind !== 'md' && kind !== 'docx') return fail('to: usage: neodoc to md|docx FILE [-o OUT]');
  const doc = openDoc(file);
  const target = args.flags.o ?? (kind === 'md'
    ? file.replace(/\.(nd\.)?html?$/i, '.md')
    : file.replace(/\.(nd\.)?html?$/i, '.docx'));
  if (kind === 'md') {
    const md = toMarkdown(doc.body, { comments: String(args.flags.comments ?? 'html') });
    if (target === '-') process.stdout.write(md);
    else { writeAtomic(target, md); out(`${target}  ${md.length} bytes`); }
    return 0;
  }
  const bytes = await toDocx(doc.body, {
    title: textOf(doc.head.children.find((c) => isEl(c, 'title')) ?? { children: [] }),
    author: metaOf(doc, 'author'),
    date: metaOf(doc, 'date'),
    lang: doc.html.attrs.lang,
    resolveImage: imageResolver(dirname(resolve(file))),
  });
  if (target === '-') process.stdout.write(Buffer.from(bytes));
  else { writeFileSync(target, bytes); out(`${target}  ${bytes.length} bytes`); }
  return 0;
}

function metaOf(doc, name) {
  const meta = doc.head.children.find((c) => isEl(c, 'meta') && c.attrs.name === name);
  return meta ? meta.attrs.content : undefined;
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
};

function imageResolver(baseDir) {
  return (src) => {
    const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
    if (data) {
      return {
        mime: data[1],
        bytes: data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3])),
      };
    }
    if (/^https?:/i.test(src)) return null;
    const path = resolve(baseDir, src);
    if (!existsSync(path)) return null;
    return { mime: MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream', bytes: readFileSync(path) };
  };
}

function cmdCss() {
  process.stdout.write(THEME_CSS);
  return 0;
}

async function cmdBench(args) {
  const [file] = args.positional;
  if (!file) return fail('bench: usage: neodoc bench FILE [--rounds N]');
  const rounds = Number(args.flags.rounds ?? 15);
  const raw = readFileSync(file, 'utf8');
  const rows = [];
  const measure = async (label, fn) => {
    await fn();
    const times = [];
    for (let i = 0; i < rounds; i++) {
      const t0 = performance.now();
      await fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    rows.push([label, times[Math.floor(times.length / 2)]]);
  };
  await measure('fmt', () => format(raw, { style: 'none' }));
  await measure('lint', () => lint(raw));
  const doc = openDoc(file);
  await measure('parse', () => parse(doc.text));
  await measure('get p', () => queryAll(doc.html, 'p'));
  await measure('to md', () => toMarkdown(doc.body, {}));
  await measure('to docx', () => toDocx(doc.body, { title: 'bench', resolveImage: () => null }));
  out(`${file}: ${raw.length} bytes, ${queryAll(doc.html, 'body > *').length} top-level blocks`);
  for (const [label, ms] of rows) out(`${label.padEnd(10)} ${ms.toFixed(1)} ms  (median of ${rounds})`);
  return 0;
}

/** SPEC §10: canonical fixtures are byte-stable, non-canonical inputs converge. */
function cmdConformance(args) {
  const dir = args.positional[0] ?? 'fixtures';
  let bad = 0;
  const check = (label, ok, detail) => {
    if (!ok) bad++;
    out(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    if (!ok && detail) out(`     ${detail}`);
  };
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.nd.html')).sort()) {
    const file = join(dir, name);
    const text = readFileSync(file, 'utf8');
    const mode = hasStyle(text) ? 'inline' : 'none';
    const findings = lint(text);
    check(`${file} canonical`, format(text, { style: mode }).text === text, 'fmt would change this file');
    check(`${file} lint`, findings.length === 0, findings.map((f) => `line ${f.line}: ${f.rule}: ${f.message}`).join('; '));
  }
  const ncDir = join(dir, 'noncanonical');
  if (existsSync(ncDir)) {
    for (const name of readdirSync(ncDir).sort()) {
      const expected = join(dir, `${name.replace(/\.html?$/, '')}.nd.html`);
      if (!existsSync(expected)) { check(`${ncDir}/${name}`, false, `no ${expected} to compare against`); continue; }
      const want = readFileSync(expected, 'utf8');
      const got = format(readFileSync(join(ncDir, name), 'utf8'), { style: hasStyle(want) ? 'inline' : 'none' }).text;
      const firstDiff = got.split('\n').findIndex((l, i) => l !== want.split('\n')[i]);
      check(`${ncDir}/${name} → ${expected}`, got === want, `first differing line ${firstDiff + 1}`);
    }
  }
  out(bad ? `${bad} check(s) failed` : 'all checks passed');
  return bad ? 1 : 0;
}

async function cmdServe(args) {
  const file = args.positional[0];
  if (!file) return fail('serve: usage: neodoc serve FILE [--port N] [--open]');
  await serve({ file: resolve(file), port: Number(args.flags.port ?? 8765), open: !!args.flags.open });
  return 0;
}

const COMMANDS = {
  fmt: cmdFmt,
  lint: cmdLint,
  new: cmdNew,
  get: cmdGet,
  set: cmdSet,
  insert: cmdInsert,
  rm: cmdRm,
  id: cmdId,
  comment: cmdComment,
  track: cmdTrack,
  import: cmdImport,
  to: cmdTo,
  css: cmdCss,
  bench: cmdBench,
  conformance: cmdConformance,
  serve: cmdServe,
};

const USAGE = `neodoc ${VERSION} — plaintext HTML documents

  neodoc fmt [-w] [--check] [--style=inline|none] FILE...
  neodoc lint [--json] [--fix] FILE...
  neodoc new [FILE] [--title T] [--stdin]        # --stdin reads markdown
  neodoc get FILE SELECTOR [--json] [--text]
  neodoc set FILE SELECTOR (--md S | --html S | --file F | --stdin)
  neodoc insert FILE (--before|--after|--append-to) SELECTOR (--md S | --html S | --file F)
  neodoc rm FILE SELECTOR
  neodoc id FILE --for SELECTOR --as NAME
  neodoc comment add FILE SELECTOR --body T [--quote S] [--author A] [--at TS]
  neodoc comment list FILE [--json] [--state open|resolved|all]
  neodoc comment reply FILE ID --body T
  neodoc comment resolve|reopen|rm FILE ID
  neodoc track accept|reject FILE [SELECTOR]
  neodoc import [FILE.md] [-o OUT]
  neodoc to md FILE [-o OUT] [--comments html|critic|drop]
  neodoc to docx FILE [-o OUT]
  neodoc serve FILE [--port N] [--open]
  neodoc bench FILE [--rounds N]
  neodoc conformance [DIR]
  neodoc css

Selectors are CSS (SPEC §7) matched against the whole document, so
\`body > section:nth-child(2) > p\` works. Mutating commands write in place;
use -o - for stdout. Exit codes: 0 ok, 1 lint/--check violations, 2 usage error.`;
