// HTML subset parser (docs/SPEC.md §3). Tolerant: it records errors instead of
// throwing, so `neodoc lint` can report on files a browser would still render.
// Handles implied end tags (p/li/td/tr) so browser-pasted HTML and hand-written
// HTML both parse. Raw-text elements (style/script/pre/title) are not tokenized.

import { VOID } from './tree.js';
import { decodeEntities } from './entities.js';

const RAW_TEXT = new Set(['style', 'script', 'pre', 'textarea', 'title']);
const MODE = { pre: 'pre', style: 'raw', script: 'raw', textarea: 'raw' };

const IMPLIED_END = {
  p: new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table',
    'blockquote', 'pre', 'section', 'aside', 'figure', 'hr', 'head', 'body', 'dl', 'div']),
  li: new Set(['li']),
  td: new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']),
  th: new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']),
  tr: new Set(['tr', 'thead', 'tbody', 'tfoot']),
  option: new Set(['option']),
};

const NAME_CH = /[a-zA-Z0-9:_.-]/;

function readTag(src, i) {
  let j = i + 1;
  let name = '';
  while (j < src.length && NAME_CH.test(src[j])) name += src[j++];
  name = name.toLowerCase();
  const attrs = {};
  let selfClosing = false;
  while (j < src.length) {
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '>') { j++; break; }
    if (src[j] === '/' && src[j + 1] === '>') { selfClosing = true; j += 2; break; }
    if (j >= src.length) break;
    let an = '';
    while (j < src.length && !/[\s=>/]/.test(src[j])) an += src[j++];
    if (!an) { j++; continue; }
    let av = '';
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '=') {
      j++;
      while (j < src.length && /\s/.test(src[j])) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const endQ = src.indexOf(q, j + 1);
        av = src.slice(j + 1, endQ === -1 ? src.length : endQ);
        j = endQ === -1 ? src.length : endQ + 1;
      } else {
        const s = j;
        while (j < src.length && !/[\s>]/.test(src[j])) j++;
        av = src.slice(s, j);
      }
    }
    attrs[an.toLowerCase()] = decodeEntities(av);
  }
  return { name, attrs, selfClosing, end: j };
}

function findCloseTag(src, lower, name, from) {
  const needle = `</${name}`;
  let idx = lower.indexOf(needle, from);
  while (idx !== -1) {
    const after = src[idx + needle.length];
    if (after === undefined || after === '>' || /\s/.test(after)) return idx;
    idx = lower.indexOf(needle, idx + 1);
  }
  return -1;
}

/** Parse to `{ root, errors }`. `root` is a pseudo-element named `#root`. */
export function parse(src) {
  const errors = [];
  const root = { type: 'element', name: '#root', attrs: {}, children: [], pos: 0 };
  const stack = [root];
  const n = src.length;
  const lower = src.toLowerCase();
  let i = 0;

  const parent = () => stack[stack.length - 1];
  const err = (message, pos) => errors.push({ message, pos });

  const addText = (target, raw, pos, mode) => {
    if (!raw) return;
    const node = { type: 'text', text: decodeEntities(raw), pos };
    if (mode) node.mode = mode;
    target.children.push(node);
  };
  const pushText = (raw, pos) => {
    const p = parent();
    const mode = p.type === 'element' ? MODE[p.name] : undefined;
    addText(p, raw, pos, mode);
  };
  const closeImplied = (incoming) => {
    while (stack.length > 1) {
      const set = IMPLIED_END[parent().name];
      if (set && set.has(incoming)) stack.pop();
      else break;
    }
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { pushText(src.slice(i), i); break; }
    if (lt > i) pushText(src.slice(i, lt), i);
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const body = src.slice(i + 4, end === -1 ? n : end);
      parent().children.push({ type: 'comment', text: body, pos: i });
      if (end === -1) { err('unterminated comment', i); break; }
      i = end + 3;
      continue;
    }
    if (/^<!doctype/i.test(src.slice(i, i + 10))) {
      const end = src.indexOf('>', i);
      parent().children.push({ type: 'doctype', text: 'doctype html', pos: i });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      const end = src.indexOf('>', i);
      err('declaration dropped (only <!doctype html> is allowed)', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (src[i + 1] === '/') {
      const m = /^<\/([a-zA-Z][^\s>]*)\s*>/.exec(src.slice(i, i + 300));
      if (!m) { err('malformed end tag', i); pushText('<', i); i++; continue; }
      const name = m[1].toLowerCase();
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k--;
      if (k === 0) err(`stray end tag </${name}>`, i);
      else stack.length = k;
      i += m[0].length;
      continue;
    }

    const t = readTag(src, i);
    if (!t.name) { err('malformed tag', i); pushText('<', i); i++; continue; }
    closeImplied(t.name);
    const node = { type: 'element', name: t.name, attrs: t.attrs, children: [], pos: i };
    parent().children.push(node);
    i = t.end;

    if (RAW_TEXT.has(t.name) && !t.selfClosing) {
      const close = findCloseTag(src, lower, t.name, i);
      const stop = close === -1 ? n : close;
      addText(node, src.slice(i, stop), i, MODE[t.name]);
      if (close === -1) { err(`unterminated <${t.name}>`, node.pos); i = n; }
      else { i = src.indexOf('>', close); i = i === -1 ? n : i + 1; }
      continue;
    }
    if (!VOID.has(t.name) && !t.selfClosing) stack.push(node);
  }

  return { root, errors };
}

export function parseToTree(src) {
  return parse(src).root;
}
