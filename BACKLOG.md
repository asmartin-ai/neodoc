# Backlog

Findings from an adversarial review (2026-10-16) that are **not fixed yet**. Each
entry was reproduced by the reviewer or by me; line numbers are from that day's
tree and will drift. Fixed items are not repeated here — see `git log` (the two
review batches of that day: CLI/lint contract, markdown round trips, `img`
dimensions, non-UTF-8 input, paragraph closing).

Ordering is by what a user loses: data first, then security, then contract, then
maintenance.

## Data loss

- **`editor/editor.js` — no undo stack for structural edits.** Ctrl+Z undoes the
  browser's own input but not a toolbar command or a paste, and after a structural
  edit it deletes text instead of undoing: type `abc`, Enter, Ctrl+Z twice leaves
  `<p>a</p><p></p>`; `b` and `c` are gone. **Fix**: one structured undo stack
  (snapshot the canonical text before each mutation in `mutate()`), not a bespoke
  per-command undo.
- **`editor/editor.js` — accept/reject/comment rebuild the body and drop the
  caret.** After clicking Accept the selection is `(BODY,0)`, typing goes nowhere
  and Enter inserts *before* the paragraph. **Fix**: restore the caret to the same
  block after `applyDocument` (find it by its pre-mutation path).
- **`editor/editor.js` — block/inline commands build structures the format
  forbids.** `<ul><li>x</li></ul>` + H1 → `<ul><h1>x</h1></ul>`; `B` over two
  paragraphs → `<strong><p>…</p><p>…</p></strong>`; Tab inside a pasted bare `<li>`
  creates a `<body>` inside a `<p>`. All pass `fmt --check`, and `neodoc md` of the
  first is **0 bytes**. **Fix**: command-level guard (never lift a block out of a
  list, never wrap a block-level selection in an inline element).
- **`editor/editor.js` — a document that is not UTF-8 is silently repaired on
  save.** The CLI refuses such files (`readText`), but the editor's open path
  decodes with the browser's lossy UTF-8 decoder, so `Cmd+S` writes U+FFFD over the
  original bytes. **Fix**: `FileReader.readAsArrayBuffer` + the same byte
  round-trip check, then refuse or warn like the CLI does.
- **`src/docx.js` — block content inside a cell is flattened.**
  `<td><p>a</p><p>b</p></td>` becomes `ab` in the generated document, and
  `--comments html` (documented as "nothing is lost") is not the only lossy path.
  **Fix**: emit a paragraph per child block.

## Security

- **`src/editor` — a document's head `<style>` can restyle the editor chrome.**
  Editor CSS is appended after the document's, so equal specificity is fine, but a
  more specific rule (e.g. `#chrome button { display: none }`) hides the UI. Not a
  compromise (nothing executes), but a document can make the editor unusable.
  **Fix**: scope the editor's own rules or shadow the document's inside `#chrome`.
- **`src/parse.js` + `src/lint.js` — no URL-scheme policy on the document path.**
  `neodoc import evil.md` with `[x](javascript:alert(2))` survives `fmt` and lints
  clean; clicking it in the *standalone* document runs it (the editor refuses such
  a click). **Fix**: apply the paste URL policy in `cleanAttrs`/`fromMarkdown`, or
  add a lint rule so the file is at least reported.
- **`src/serve.js` — `/save` has no lock or mtime check.** A CLI write silently
  reverts a concurrent edit in the served editor. **Fix**:
  `If-Unmodified-Since`-style check, or a lock file.

## Contract

- **`src/tree.js` — `pathOf`/`--json` `path` is not round-trippable when ids
  repeat**: two `<p id="z">` both report `body > p#z`, re-feeding it matches both
  and `set` edits the first. Duplicate ids are only a lint error. **Fix**: fall back
  to `:nth-of-type` when the id is not unique.
- **`src/cli.js` — the id-uniqueness probe interpolates `--as` unescaped**
  (`[id="${id}"]`), so an id containing `"` misparses.

## Robustness

- **Deep nesting is a crash, not an error.** 5,000 nested `<section>` (~90 KB) →
  `RangeError: Maximum call stack size exceeded`, exit **2**; `fromMarkdown('>
  '.repeat(25000))` likewise; in the editor the throw happens inside `openText` and
  the document silently shows as "no file open". **Fix**: a documented nesting cap
  reported as a `parse` finding, and an iterative `emitBlock`/`normalizeElement`
  (or a depth guard around them).
- **`src/docx.js` — table/list fidelity**: `rowspan` is ignored (no `vMerge`, so
  cells shift columns), `<ol start>`/`reversed` are ignored, two separate `<ol>`s
  continue one numbering sequence in LibreOffice, and a huge `colspan` crashes the
  command with "Invalid string length" (unvalidated numeric attribute).
  `docs/SPEC.md` §8 also advertises a "reference styles doc … overridable" that does
  not exist in code.
- **`src/format.js` — a comment between two text runs becomes a line break**: the
  renderer then shows an extra space (`<p>foo<!--x-->bar</p>` → `foo bar`), and a
  multi-line comment survives unindented against the one-line discipline of §4.1.

## Maintenance

- **`tools/bundle.js` does not support `export { a as b }` or an aliased import**
  (`import { a as z }`): it would emit invalid JS, and `--check` cannot see it. No
  module uses `as` today, so it is latent — either support it or fail loudly.
- **`editor/editor.css` — `#sidebar li[data-resolved]` never matches** (the code
  writes `<em>resolved</em>`).
- **`src/lint.js` does not validate attribute *values*.** `data-align="middle"`,
  `data-state="maybe"`, `data-checked="yes"`, `data-note="hmm"` and `width="abc"`
  are all accepted silently, even though SPEC §3 fixes the first four as enums and
  `fmt` now keeps `width` as written. **Fix**: one value check per documented enum.
- **`src/lint.js` has no rule for a misplaced `<meta>`/`<style>` inside a block**,
  only `misplaced-head` for a head element outside the head.

## Refuted / accepted as-is

- **Path traversal and dot-segment tricks on `serve`** (`/%2e%2e/…`, `?path=..%2F`):
  WHATWG URL normalisation plus the lexical join hold; the escapes that did work
  (symlinks, `?path=` naming another file) are fixed.
- **Zip entry-name injection in docx**: entries are fixed names plus
  `media/imageN.<alnum>`; no `/`, `..` or NUL is reachable.
- **Billion-laughs / entity expansion**: no DTD or entity expansion exists.
- **Shell injection**: nothing reaches a shell (`spawn(cmd, argv)`, no `shell: true`).
- **`serve` binding beyond loopback**: `server.listen(port, '127.0.0.1')` with no
  flag to widen it.
- **CriticMarkup cannot carry change authors or timestamps**: `{--x--}` has no slot
  for them, which is why `--comments html` is the default and documented as
  lossless; `critic` is the lossy interchange format and says so.
- **A lone image followed by an all-emphasis paragraph reads back as a figure**:
  that is the documented figure form (`![alt](src)` + `*caption*`), and markdown
  cannot tell the two shapes apart. Use `figure` when the distinction matters.
- **`get`'s plain-text output is multi-line for a container** (a `<section>` is not
  a line): `--json` is the machine interface, and the plain form is for humans.
