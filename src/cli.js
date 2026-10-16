// Neodoc CLI — the agent and scripting interface (docs/SPEC.md §7).
//
// Contract: opening a document canonicalizes it, commands mutate the tree, and
// writing serializes that tree. So every write leaves the file canonical, and a
// write to an already-canonical file changes only what the command touched.
// (If the file was not canonical, the write normalizes it; the CLI says so.)

import { chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { format, normalizeDocument, normalizeFragment, emitBlock, serialize } from './format.js';
import { parse } from './parse.js';
import { INLINE, isEl, parentOf, pathOf, textOf } from './tree.js';
import { lint } from './lint.js';
import { THEME_CSS } from './theme.js';
import { queryAll } from './select.js';
import { addComment, acceptChanges, listComments, rejectChanges, removeComment, replyToComment, resolveComment } from './comments.js';
import { fromMarkdown, toMarkdown } from './markdown.js';
import { VERSION } from './version.js';

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const fail = (message) => { err(`neodoc: ${message}`); return 2; };
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

export async function main(argv) {
  // `neodoc md x.nd.html -o - | head` closes the pipe; that is not an error.
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
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

const BOOLEAN_FLAGS = new Set(['check', 'write', 'w', 'json', 'text', 'stdin', 'fix', 'open', 'done', 'quiet', 'help']);

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
      // A value-taking flag may also be used as a bare modifier (`--file x --md`).
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------- doc IO

/** `report.nd.html`, `report.ndoc.html`, `report.ndoc` → `report`. */
const stripExt = (path) => path.replace(/\.(?:nd\.|ndoc\.)?html?$/i, '').replace(/\.ndoc$/i, '');

function hasStyle(text) {

  return /<style[\s>]/i.test(text);
}

/** Parse + normalize + serialize the text, yielding a canonical tree we can mutate. */
function docFrom(text, mode) {
  const { root } = parse(text);
  const warnings = [];
  normalizeDocument(root, warnings, { style: mode });
  return { root, warnings };
}

function openDoc(file) {
  const raw = readFileSync(file, 'utf8');
  const mode = hasStyle(raw) ? 'inline' : 'none';
  const doc = docFrom(raw, mode);
  const text = serialize(doc.root);
  const html = doc.root.children.find((c) => isEl(c, 'html'));
  return {
    file,
    raw,
    text,
    root: doc.root,
    warnings: doc.warnings,
    html,
    head: html.children.find((c) => isEl(c, 'head')),
    body: html.children.find((c) => isEl(c, 'body')),
    mode,
    reformatted: text !== raw,
  };
}

/** Temp file + rename. `wx` so a planted symlink cannot make us write through it,
 *  and the target's own mode is restored so `fmt -w` never widens permissions. */
function writeAtomic(file, text, bytes = null) {
  const tmp = `${file}.neodoc-${process.pid}.tmp`;
  let mode = 0o644;
  try { mode = statSync(file).mode & 0o777; } catch { /* new file */ }
  const data = bytes ?? text;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

function saveDoc(doc, target = doc.file) {
  // Re-normalize so the invariant holds for every mutation: what lands on disk
  // is canonical even when the edit itself produced a stray space or a wrapped
  // block (see docs/SPEC.md §4).
  normalizeDocument(doc.root, [], { style: doc.mode });
  const text = serialize(doc.root);
  if (target === '-') { process.stdout.write(text); return; }
  writeAtomic(target, text);
  for (const w of doc.warnings) err(`${target}: ${w}`);
  out(`${target}  ${text.length} bytes${doc.reformatted ? '  (was not canonical: reformatted)' : ''}`);
}

function fragmentDoc(nodes, title) {
  const skeleton = '<!doctype html><html data-neodoc="1" lang="en"><head><title></title></head><body></body></html>';
  const doc = docFrom(skeleton, 'inline');
  const html = doc.root.children.find((c) => isEl(c, 'html'));
  html.children.find((c) => isEl(c, 'head')).children.find((c) => isEl(c, 'title')).children = [{ type: 'text', text: title }];
  html.children.find((c) => isEl(c, 'body')).children = nodes;
  return doc;
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
  if (flags.file) {
    const text = flags.file === '-' ? readFileSync(0, 'utf8') : readFileSync(String(flags.file), 'utf8');
    return maybeMarkdown(text, flags.md === true);
  }
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
      else {
        // The most common cross-platform surprise: a CRLF checkout. Say so.
        err(`${file}: not canonical${raw.includes('\r\n') ? ' (CRLF line endings — the canonical form is LF)' : ''}`);
        bad++;
      }
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
  const fromStdin = args.flags.stdin || file === '-';
  const nodes = fromStdin
    ? markdown(readFileSync(0, 'utf8')).nodes
    : [
      { type: 'element', name: 'h1', attrs: {}, children: [{ type: 'text', text: 'Untitled' }] },
      { type: 'element', name: 'p', attrs: {}, children: [] },
    ];
  const fallbackTitle = (fromStdin ? firstHeadingText(nodes) : null)
    ?? (file && file !== '-' ? stripExt(basename(file)) : 'Untitled');
  const title = String(args.flags.title ?? fallbackTitle);
  const doc = { ...fragmentDoc(nodes, title), file: file ?? '-', reformatted: false };
  if (!file || file === '-') { process.stdout.write(serialize(doc.root)); return 0; }
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

function cmdAdd(args) {
  const [file] = args.positional;
  const mode = ['before', 'after', 'into'].find((k) => args.flags[k] !== undefined);
  if (!file || !mode) return fail('add: usage: neodoc add FILE (--before SEL | --after SEL | --into SEL) (--md S | --html S | --file F | --stdin)');
  const flagValue = args.flags[mode];
  const target = String(flagValue === true ? args.positional[1] : flagValue);
  if (target === 'undefined') throw new Error(`add: --${mode} needs a selector`);
  const doc = openDoc(file);
  const [hit] = bodyHits(doc, target);
  const { nodes } = fragmentSource(args.flags);
  if (mode === 'into') {
    if (INLINE.has(hit.node.name)) throw new Error(`add: <${hit.node.name}> cannot contain blocks`);
    // `--into 'ul' --md '- x'` means "add an item", not "nest a list": when the
    // fragment's tag matches the target's, splice in the fragment's children.
    const merged = nodes.flatMap((n) => (n.type === 'element' && n.name === hit.node.name ? n.children : [n]));
    hit.node.children.push(...merged);
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

function cmdNote(args) {
  const [sub, file, selector] = args.positional;
  if (!sub || !file) return fail('note: usage: neodoc note add|ls|reply|done|undo|rm FILE [...]');
  const doc = openDoc(file);
  const author = String(args.flags.by ?? process.env.USER ?? process.env.USERNAME ?? 'unknown');
  const at = String(args.flags.at ?? now());

  if (sub === 'ls') {
    const state = args.flags.open ? 'open' : args.flags.done ? 'resolved' : 'all';
    const items = listComments(doc.html).filter((c) => state === 'all' || c.state === state);
    if (args.flags.json) out(JSON.stringify({ ok: true, count: items.length, notes: items }, null, 2));
    else for (const c of items) out(`${c.id}  ${c.state}  ${c.path}\n    "${c.anchorText}"\n    ${c.author} ${c.at}: ${c.text}`);
    return 0;
  }
  if (sub === 'add') {
    if (args.flags.say === undefined) throw new Error('note add: needs --say "text"');
    const info = addComment(doc.html, {
      body: doc.html,
      selector,
      quote: args.flags.on === undefined ? undefined : String(args.flags.on),
      text: String(args.flags.say),
      author,
      at,
    });
    saveDoc(doc);
    out(`note ${info.id} ${info.anchor ? `on "${textOf(info.anchor)}"` : '(on the block, no anchor text)'}`);
    return 0;
  }
  const id = selector;
  if (sub === 'reply') replyToComment(doc.html, id, { text: String(args.flags.say ?? ''), author, at });
  else if (sub === 'done') resolveComment(doc.html, id, true);
  else if (sub === 'undo') resolveComment(doc.html, id, false);
  else if (sub === 'rm') removeComment(doc.html, id);
  else return fail(`note: unknown subcommand "${sub}"`);
  saveDoc(doc);
  return 0;
}

function cmdAccept(args) {
  return foldChanges(args, 'accept');
}

function cmdReject(args) {
  return foldChanges(args, 'reject');
}

function foldChanges(args, mode) {
  const [file, selector] = args.positional;
  if (!file) return fail(`${mode}: usage: neodoc ${mode} FILE [SELECTOR]`);
  const doc = openDoc(file);
  const apply = mode === 'accept' ? acceptChanges : rejectChanges;
  const counts = apply(doc.html, selector);
  const total = (counts.ins ?? 0) + (counts.del ?? 0);
  if (total === 0) {
    // Nothing to fold: do not rewrite (and reformat) the file, and say so with the
    // documented no-match exit code, so a typo in SELECTOR cannot look like success.
    out(`${mode}: no tracked changes matched${selector ? ` ${selector}` : ''}`);
    return 1;
  }
  saveDoc(doc);
  out(`${mode}ed ${counts.ins ?? 0} insertion(s) and ${counts.del ?? 0} deletion(s)`);
  return 0;
}

function cmdImport(args) {
  const [source] = args.positional;
  const text = source && source !== '-' ? readFileSync(source, 'utf8') : readFileSync(0, 'utf8');
  const { nodes, warnings } = markdown(text);
  for (const w of warnings) err(`import: ${w}`);
  const title = firstHeadingText(nodes) ?? (source ? stripExt(basename(source)) : 'Untitled');
  const doc = { ...fragmentDoc(nodes, title), file: outputPath(args.flags, '-'), reformatted: false };
  saveDoc(doc, doc.file);
  return 0;
}

function outputPath(flags, fallback) {
  if (flags.o === undefined) return fallback;
  if (flags.o === true) throw new Error('-o needs a path (use -o - for stdout)');
  return flags.o;
}

function firstHeadingText(nodes) {
  for (const node of nodes) {
    if (node.type === 'element' && /^h[1-6]$/.test(node.name)) return textOf(node);
  }
  return null;
}

async function cmdMd(args) {
  return convert(args, 'md');
}

async function cmdDocx(args) {
  return convert(args, 'docx');
}

async function convert(args, kind) {
  const [file] = args.positional;
  if (!file) return fail(`${kind}: usage: neodoc ${kind} FILE [-o OUT]`);
  const doc = openDoc(file);
  const target = outputPath(args.flags, kind === 'md'
    ? `${stripExt(file)}.md`
    : `${stripExt(file)}.docx`);
  if (kind === 'md') {
    const md = toMarkdown(doc.body, { comments: String(args.flags.comments ?? 'html') });
    if (target === '-') process.stdout.write(md);
    else { writeAtomic(target, md); out(`${target}  ${md.length} bytes`); }
    return 0;
  }
  // Loaded on demand so every other command skips docx.js and, more importantly,
  // serve.js — whose node:http import alone costs ~15ms of process startup.
  const { toDocx } = await import('./docx.js');
  const bytes = await toDocx(doc.body, {
    title: textOf(doc.head.children.find((c) => isEl(c, 'title')) ?? { children: [] }),
    author: metaOf(doc, 'author'),
    date: metaOf(doc, 'date'),
    lang: doc.html.attrs.lang,
    resolveImage: imageResolver(dirname(resolve(file))),
  });
  if (target === '-') process.stdout.write(Buffer.from(bytes));
  else { writeAtomic(target, null, bytes); out(`${target}  ${bytes.length} bytes`); }
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
/** A `data:` URI's media type is document input, so it must look like one. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function imageResolver(baseDir) {
  const root = resolve(baseDir);
  return (src) => {
    const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
    if (data) {
      const mime = MIME_TYPE.test(data[1]) ? data[1].toLowerCase() : 'application/octet-stream';
      try {
        const bytes = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]));
        return { mime, bytes };
      } catch {
        return null; // a malformed percent escape is a broken image, not a crash
      }
    }
    if (/^https?:/i.test(src)) return null;
    // Confined to the document's own directory (docs/CLI.md): a document received
    // from someone else must not be able to name /etc/hostname or ~/.ssh/id_rsa and
    // have it embedded in the file we hand back.
    const path = resolve(root, src.replace(/^[/\\]+/, ''));
    if (path !== root && !path.startsWith(root + sep)) return null;
    if (!existsSync(path)) return null;
    let real = path;
    try { real = realpathSync(path); } catch { return null; }
    const rootReal = realpathSync(root);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
    return { mime: MIME[extname(real).slice(1).toLowerCase()] ?? 'application/octet-stream', bytes: readFileSync(real) };
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
  const { toDocx } = await import('./docx.js');
  await measure('to md', () => toMarkdown(doc.body, {}));
  await measure('to docx', () => toDocx(doc.body, { title: 'bench', resolveImage: () => null }));
  out(`${file}: ${raw.length} bytes, ${queryAll(doc.html, 'body > *').length} top-level blocks`);
  for (const [label, ms] of rows) out(`${label.padEnd(10)} ${ms.toFixed(1)} ms  (median of ${rounds})`);
  return 0;
}

/** SPEC §10: canonical fixtures are byte-stable, non-canonical inputs converge. */
function cmdTest(args) {
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
  const { serve } = await import('./serve.js');
  await serve({ file: resolve(file), port: Number(args.flags.port ?? 8765), open: !!args.flags.open });
  return 0;
}

const COMMANDS = {
  new: cmdNew,
  fmt: cmdFmt,
  lint: cmdLint,
  test: cmdTest,
  get: cmdGet,
  set: cmdSet,
  add: cmdAdd,
  rm: cmdRm,
  id: cmdId,
  note: cmdNote,
  accept: cmdAccept,
  reject: cmdReject,
  import: cmdImport,
  md: cmdMd,
  docx: cmdDocx,
  css: cmdCss,
  bench: cmdBench,
  serve: cmdServe,
};

const USAGE = `neodoc ${VERSION} — plaintext HTML documents

  neodoc new [FILE] [--title T] [--stdin]     create (--stdin reads markdown)
  neodoc fmt [-w] [--check] [--style=inline|none] FILE...
  neodoc lint [--json] [--fix] FILE...
  neodoc test [DIR]                           conformance corpus

  neodoc get FILE SELECTOR [--json] [--text]
  neodoc set FILE SELECTOR (--md S | --html S | --file F | --stdin)
  neodoc add FILE (--before SEL | --after SEL | --into SEL) (--md S | --html S | --file F | --stdin)
  neodoc rm FILE SELECTOR
  neodoc id FILE --for SELECTOR --as NAME

  neodoc note add FILE SELECTOR --say T [--on QUOTE] [--by AUTHOR] [--at TS]
  neodoc note ls FILE [--json] [--open | --done]
  neodoc note reply FILE ID --say T
  neodoc note done|undo|rm FILE ID
  neodoc accept FILE [SELECTOR]               fold <ins>, drop <del>
  neodoc reject FILE [SELECTOR]

  neodoc import [FILE.md] [-o OUT]            markdown -> neodoc
  neodoc md FILE [-o OUT] [--comments html|critic|drop]
  neodoc docx FILE [-o OUT]

  neodoc serve FILE [--port N] [--open]
  neodoc bench FILE [--rounds N]
  neodoc css

Selectors are CSS (SPEC §7) matched against the whole document, so
\`body > section:nth-child(2) > p\` works. Writing commands save in place;
use -o - for stdout. Exit codes: 0 ok, 1 lint/--check violations, 2 usage error.`;
