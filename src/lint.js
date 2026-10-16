// Lint: rule violations plus "not canonical" (fixable by `neodoc fmt`).
// Runs the same parse/normalize path as `fmt` so the two can never disagree.

import { formatTree } from './format.js';
import { parse } from './parse.js';
import { descendants, HEAD_MOVED, HEAD_ONLY, isAttrAllowed, isDroppedAttr, isEl, RENAMES, VOCAB } from './tree.js';

const REQUIRED_ATTRS = { img: ['src', 'alt'] };

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** @returns {Array<{line:number,severity:string,rule:string,message:string,fixable:boolean}>} */
export function lint(text) {
  const findings = [];
  const { root, errors } = parse(text);
  const at = lineIndex(text);
  const add = (line, rule, message, fixable = false, severity = 'error') =>
    findings.push({ line, severity, rule, message, fixable });

  for (const e of errors) add(at(e.pos), 'parse', e.message);

  const ids = new Map();
  const marks = new Set();
  const threads = new Set();
  const anchors = new Set();
  let title = false;
  let body = null;
  let head = null;
  const headOnly = []; // checked after the walk, when <head> is known

  for (const node of [root, ...descendants(root)]) {
    if (node.type === 'comment' && /--/.test(node.text)) add(at(node.pos ?? 0), 'comment', 'HTML comment contains "--"');
    if (node.type === 'text' && /[\u200B\uFEFF]/.test(node.text)) {
      // Never legitimate in prose, and invisible in a diff. The editor's own caret
      // anchors are stripped before saving, so this means something else put them there.
      // \`fmt\` keeps it (it is content), so this is not something --fix can repair.
      add(at(node.pos ?? 0), 'invisible-char', 'invisible zero-width character (U+200B/U+FEFF)', false, 'warning');
    }
    if (node.type !== 'element') continue;
    const line = at(node.pos ?? 0);
    const name = RENAMES[node.name] || node.name;
    if (name === 'title') title = true;
    if (HEAD_ONLY.has(name)) headOnly.push([node, line]);
    if (name === 'body') body = node;
    if (name === 'head') head = node;
    if (name === '#root' || !VOCAB.has(name)) {
      if (name !== '#root') add(line, 'vocab', `<${name}> is not part of the Neodoc vocabulary`, true);
      continue;
    }
    for (const [key, value] of Object.entries(node.attrs)) {
      if (isDroppedAttr(key)) {
        add(line, 'attr', `attribute "${key}" on <${name}> is presentational or an event handler`, true);
      } else if (!isAttrAllowed(name, key)) {
        add(line, 'attr', `unknown attribute "${key}" on <${name}> (kept as written)`, false);
      }
      if (key === 'id') {
        if (ids.has(value)) add(line, 'id-duplicate', `duplicate id "${value}" (first at line ${ids.get(value)})`);
        else ids.set(value, line);
      }
      if (key === 'data-c') marks.add(value);
      if (key === 'data-thread') threads.add(value);
      if (key === 'data-at' && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
        add(line, 'timestamp', `data-at "${value}" is not ISO-8601`);
      }
      if (key === 'href' && value.startsWith('#')) anchors.add(value.slice(1));
    }
    for (const req of REQUIRED_ATTRS[name] ?? []) {
      if (node.attrs[req] === undefined) add(line, 'required-attr', `<${name}> is missing ${req}`);
    }
    if (name === 'section' && !node.children.some((c) => isEl(c, 'h1') || isEl(c, 'h2') || isEl(c, 'h3'))) {
      add(line, 'section-heading', '<section> has no heading', false, 'warning');
    }
  }

  // `title`/`meta`/`style`/`link`/`base` outside <head> are reported, and `fmt`
  // moves them into the head rather than leaving them as body text (SPEC §3).
  const inHead = new Set(head ? [head, ...descendants(head)] : []);
  for (const [node, line] of headOnly) {
    // Only a misplaced <title> is repaired by `fmt`; the rest are kept where they
    // are and reported, so they must not be advertised as fixable.
    if (!inHead.has(node)) add(line, 'misplaced-head', `<${node.name}> belongs in <head>`, HEAD_MOVED.has(node.name));
  }

  for (const id of anchors) if (!ids.has(id)) add(1, 'link-target', `href="#${id}" has no matching id`);
  for (const c of marks) if (!threads.has(c)) add(1, 'comment-anchor', `mark data-c="${c}" has no <aside data-thread="${c}">`);
  if (!title) add(1, 'title', 'document has no <title>');
  if (!body) add(1, 'body', 'document has no <body>');

  // Canonicalization check: one finding at the first differing line.
  const inlineStyle = !!head && head.children.some((c) => c.name === 'style');
  // Reuse the parse above: `formatTree` normalizes the same tree, so the two can
  // still never disagree, and lint costs one parse instead of two.
  const { text: canonical } = formatTree(root, { style: inlineStyle ? 'inline' : 'none' });
  if (canonical !== text) {
    const a = text.split('\n');
    const b = canonical.split('\n');
    const n = Math.max(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    const count = Math.abs(a.length - b.length) + 1;
    add(i + 1, 'format', `not canonical (${count} line(s) differ, first here) — run: neodoc fmt -w`, true);
  }
  return findings;
}
