# Porting Neodoc to another language

The format is defined by bytes, not by this implementation. A port is correct when
it agrees with the corpus in `fixtures/` and with the rules below.

## What a port must implement

| Piece | Requirement |
|---|---|
| **Parse** | HTML subset tokenizer (SPEC §3) plus implied end tags for `p`, `li`, `td`/`th`, `tr` (browsers omit them, and pasted HTML has them). Raw-text elements that are never tokenized: `style`, `script`, `pre`, `textarea`, `title`. |
| **Normalize** | SPEC §4.2, §4.4, §4.6: name renames, attribute filtering and sorting, whitespace collapse, `pre` indent normalization, empty-inline removal, head order, `data-neodoc`/`lang` defaults. |
| **Serialize** | SPEC §4.1–§4.3. One element per line; block children on their own indented lines, otherwise one line; attributes sorted and double-quoted; escape exactly `& < >` in text and `& < "` in attributes; `pre`/`style` content handling per §4.4. |
| **Lint** | SPEC §3 + the rule list in `docs/CLI.md`. `lint` must never flag a canonical file, and `lint` and `format` must not disagree. |
| **Selectors** | The subset in SPEC §7. This is the addressing contract; `docs/CLI.md` documents the `--json` shape a port must match. |
| **Comments/changes** | SPEC §5. |
| **Markdown** | SPEC §8, both directions, using the document vocabulary only. |

## The conformance protocol

Any implementation can be validated without reading our code:

```bash
neodoc test fixtures/      # one PASS/FAIL line per case, exit 1 on failure
```

1. Every `fixtures/*.nd.html` is already canonical: `format(text) === text`,
   byte for byte.
2. Every `fixtures/noncanonical/<name>.html` canonicalizes byte-exactly to
   `fixtures/<name>.nd.html`. Those inputs deliberately mix tag case, attribute
   order, CRLF, extra whitespace, omitted `</p>`/`</li>` end tags and character
   references, so passing them proves normalization is complete.
3. Every fixture lints with zero findings.

Because the output is deterministic text, a port can generate its own expected
files once and diff them from then on.

## Two traps

- **No locale-sensitive ordering.** `localeCompare`, `toLocaleString` and friends
  produce different bytes on different machines; sort and compare by code unit.
- **No timestamps or nonces in output.** `meta[name=generator]` carries the
  version only. A port that stamps a date makes every file diff on every write.
- **Do not use a general HTML serializer** (tidy, a DOM library's `innerHTML`, or
  a browser). They reorder attributes, inject `&nbsp;`, add self-closing slashes
  and reformat inline whitespace differently — the format's whole value is that
  the bytes are predictable. Parse, normalize, then emit lines yourself.

## Reference costs

The reference implementation is ~2,000 lines of dependency-free JavaScript; the
canonical serializer is about 120 of them. Nothing in the format requires a
library beyond a UTF-8 encoder, a deflate for docx export (`CompressionStream` or
your stdlib), and a CRC32.
