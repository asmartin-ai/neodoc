// Entity encode/decode for the canonical escaping rules (docs/SPEC.md §4.3).
// Canonical output escapes exactly & < > in text and & < " in attributes.
// Input may contain any valid HTML character reference; we decode it to a
// literal character so the file converges on literal UTF-8.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', sect: '\u00a7', para: '\u00b6', bull: '\u2022',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', minus: '\u2212', times: '\u00d7',
  divide: '\u00f7', plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', sbquo: '\u201a',
  bdquo: '\u201e', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030', prime: '\u2032',
  Prime: '\u2033', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  curren: '\u00a4', larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  harr: '\u2194', ne: '\u2260', le: '\u2264', ge: '\u2265', infin: '\u221e',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', pi: '\u03c0',
  mu: '\u03bc', sigma: '\u03c3', Omega: '\u03a9', omega: '\u03c9', radic: '\u221a',
  part: '\u2202', sum: '\u2211', prod: '\u220f', int: '\u222b', asymp: '\u2248',
  equiv: '\u2261', nbsp2: '\u00a0', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwj: '\u200d', zwnj: '\u200c', check: '\u2713', cross: '\u2717',
  star: '\u2605', hearts: '\u2665', diams: '\u2666', clubs: '\u2663', spades: '\u2660',
};

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : m;
  });
}

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
