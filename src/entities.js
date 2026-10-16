// Entity encode/decode for the canonical escaping rules (docs/SPEC.md §4.3).
// Canonical output escapes exactly & < > in text and & < " in attributes.
// Input may contain any HTML character reference; decoding it to a literal
// character is what makes the file converge on literal UTF-8.
//
// The named table is the whole HTML5 set (src/entities-data.js). A subset is not
// an option: a valid reference we fail to decode gets escaped back into text, so
// a browser would show `Jos&eacute;` where the file said `José`.

import { LEGACY_DATA, NAMED_DATA } from './entities-data.js';

// A reference is `&name;`, `&#123;`, `&#x1F600;` — or one of the legacy names
// HTML5 also accepts without the semicolon (`&nbsp`), which the callback filters.
const REFERENCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)(;?)/g;

const VALUE_ESCAPES = { n: '\n', r: '\r', t: '\t', '\\': '\\' };
const unescape = (value) => value.replace(/\\(.)/g, (all, ch) => VALUE_ESCAPES[ch] ?? ch);

/** `named` holds every reference we decode; `bare` only those HTML5 also accepts
 *  without a semicolon, so `&nbsp` is a reference but `&middot` is plain text. */
let named = null;
let bare = null;

function tables() {
  if (named) return;
  named = new Map();
  for (const line of NAMED_DATA.split('\n')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    named.set(line.slice(0, tab), unescape(line.slice(tab + 1)));
  }
  bare = new Map();
  for (const name of LEGACY_DATA.split(',')) bare.set(name, named.get(name));
}

function numeric(body) {
  const hex = body[1] === 'x' || body[1] === 'X';
  const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
  // HTML5 turns an out-of-range, zero or surrogate code point into U+FFFD. A lone
  // surrogate would also reach the file as invalid UTF-8, so there is no option
  // to keep it.
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(REFERENCE, (match, body, semi) => {
    if (body[0] === '#') return numeric(body);
    tables();
    const hit = semi ? named.get(body) : bare.get(body);
    return hit === undefined ? match : hit;
  });
}

// Most text carries nothing to escape. Probing once and returning the input is
// several times cheaper than three scans that find nothing.
const NEEDS_TEXT_ESCAPE = /[&<>]/;
const NEEDS_ATTR_ESCAPE = /["&<]/;

export function escapeText(s) {
  if (!NEEDS_TEXT_ESCAPE.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  if (!NEEDS_ATTR_ESCAPE.test(s)) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
