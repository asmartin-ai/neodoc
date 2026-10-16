# Backlog

Findings from an adversarial review (2026-10-16) that are **not fixed yet**. Everything
else it produced is in `git log` — the CLI/lint contract, markdown round trips, the
editor's refusal policy and undo stack, docx fidelity, the head placement rules, the
nesting cap and the URL policy. Each entry below was reproduced; line numbers are from
that day's tree and will drift.

## Open

- **`src/serve.js` — `/save` has no lock or mtime check.** A CLI write during a served
  edit is silently reverted by the editor's next save. **Fix**: an
  `If-Unmodified-Since`-style check, or a lock file.
- **`editor/editor.js` — the editor's own typing cost is `liveTree()` per mutation.**
  `edited()` → `refresh()` re-parses the whole body (cached by `domRev`), about 12 ms per
  character on a 493 KB document, which SPEC §9's "no re-parse and no re-render per
  keystroke" forbids. The undo stack is no longer the dominant cost (measured); this is
  pre-existing. **Fix**: invalidate incrementally, or render the status without parsing.
- **`editor/editor.js` — a document that is not UTF-8 is repaired on open, silently.**
  The CLI refuses such files (`readText`) and `serve` answers 415, but the editor's own
  `#open-input` path uses `file.text()`, so the browser's lossy decoder hands back U+FFFD
  and Save writes it over the original bytes. **Fix**: `readAsArrayBuffer` + the same
  round-trip check.
- **`src/tree.js` — `pathOf`/`--json` `path` is not round-trippable when ids repeat.**
  Two `<p id="z">` both report `body > p#z`; re-feeding it matches both and `set` edits
  the first. Duplicate ids are only a lint error. **Fix**: fall back to `:nth-of-type`
  when the id is not unique.
- **`src/cli.js` — the id-uniqueness probe interpolates `--as` unescaped**
  (`[id="${id}"]`), so an id containing `"` misparses.
- **`editor/editor.js` — a comment box's text is lost by a document undo.** Ctrl+Z while
  the selection is inside `#chrome` is left to the browser (correct), but Ctrl+Z with the
  caret in the document restores a snapshot that does not include a half-written reply.
- **`src/lint.js` has no rule for an unknown attribute on a head `<meta>`** beyond the
  generic `attr` finding, and `meta[http-equiv]` is reported only as an unknown attribute
  even though it can retarget a page that shows the document.

## Accepted / by design

- **A `<template><script>` is refused, not ignored.** A template is inert only while its
  children are in `.content`, which is where the HTML *parser* puts them; the editor
  builds nodes with `createElement` + `append`, and a script appended to a created
  template is connected and runs (measured). See `e2e/untrusted.spec.js`.
- **CriticMarkup cannot carry change authors or timestamps.** `{--x--}` has no slot for
  them, which is why `--comments html` is the default and documented as lossless.
- **A lone image followed by an all-emphasis paragraph reads back as a figure.** That is
  the documented figure form; markdown cannot tell the two shapes apart.
- **`get`'s plain-text output is multi-line for a container.** `--json` is the machine
  interface; the plain form is for people.
- **A multi-line comment is not re-indented.** Its text is its content; moving it would
  change it. `fmt` leaves it at column 0 and `lint` says nothing.
- **A document's head `<style>` cannot restyle the editor chrome** (measured) — the
  editor's stylesheet is the canonical one, and a document's head `<style>` is replaced by
  it before anything is adopted.

## Refuted

- **Path traversal on `serve`** (`/%2e%2e/…`, `?path=..%2F`), **zip entry-name
  injection in docx**, **billion-laughs**, **shell injection**, **`serve` binding beyond
  loopback**: all attacked, all held.
- **`<template><script>` is harmless**: measured otherwise (above).
- **A head `<link>`/`noscript`/unknown element is a false-positive refusal**: it is not
  adopted, and a head child that is not adopted is deleted on the next save, so refusing
  is the only alternative to losing it.
