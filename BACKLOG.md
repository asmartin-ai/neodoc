# Backlog

Findings from an adversarial review (2026-10-16) that are **not fixed yet**. Each
entry was reproduced by the reviewer or by me; line numbers are from that day's
tree and will drift. Fixed items are not repeated here — see `git log`. Where a
finding was refuted or judged not worth fixing, it says so.

Ordering is by what a user loses: data first, then security, then contract, then
maintenance.

## Data loss

- **`editor/editor.js` — no undo stack for structural edits.** Ctrl+Z undoes the
  browser's own input but not a toolbar command or a paste, and after a structural
  edit it deletes text instead of undoing: type `abc`, Enter, Ctrl+Z twice leaves
  `<p>a</p><p></p>`; `b` and `c` are gone. **Fix**: one structured undo stack
  (snapshot the canonical text before each mutation via `mutate()`), not a bespoke
  per-command undo.
- **`editor/editor.js` — accept/reject/comment rebuild the body and drop the
  caret.** After clicking Accept the selection is `(BODY,0)`, typing goes nowhere
  and Enter inserts *before* the paragraph. **Fix**: restore the caret to the same
  block after `applyDocument` (the block can be found by its pre-mutation path).
- **`editor/editor.js` — block/inline commands build structures the format
  forbids.** `<ul><li>x</li></ul>` + H1 → `<ul><h1>x</h1></ul>`; `B` over two
  paragraphs → `<strong><p>…</p><p>…</p></strong>`; Tab inside a pasted bare `<li>`
  creates a `<body>` inside a `<p>`. All pass `fmt --check`, and `neodoc md` of the
  first is **0 bytes**. **Fix**: command-level guard (never lift a block out of a
  list, never wrap a block-level selection in an inline element).
- **`src/markdown.js` — sibling content is dropped without a warning.**
  `<figure><img><p>caption</p></figure>` exports only `![c](c.png)`; the same shape
  in `docx` flattens `<td><p>a</p><p>b</p></td>` into `ab`. `--comments html` is
  documented as "nothing is lost". **Fix**: emit the extra children, or skip the
  shortcut and fall back to raw HTML.
- **`src/markdown.js` — `data-*` and `title` attributes are dropped on export**:
  `title` on `<a>`/`<img>`, `data-at`/`data-author` on `del`, `data-lang="c sharp"`
  truncates to `c` (split on whitespace). **Fix**: extend the attribute whitelist
  per element and keep the fence info string verbatim.
- **`src/markdown.js` — a `<figure>` on import swallows the following paragraph**:
  `<p><img></p><p><em>x</em></p>` re-imports as a figure with the second paragraph
  as its caption. **Fix**: only a short paragraph (or none) may become a caption.
- **`src/format.js` — `width="50%"`/`height` are deleted from `<img>` silently**
  (SPEC §3 allows `width`; only non-numeric values should go, with a warning).
- **`src/cli.js` — non-UTF-8 bytes are replaced on write.** `fmt -w` on a latin-1
  document writes U+FFFD and reports only "not canonical". **Fix**: read as bytes,
  detect invalid UTF-8, refuse (or report a `parse` finding) instead of mangling.

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
  reverts a concurrent edit in the served editor. **Fix**: `If-Unmodified-Since`
  style check, or a lock file.

## Contract

- **`src/cli.js` — `get --json` prints `{"ok": true, "count": 0}` and exits 1**;
  the plain-text form prints multi-line values for container blocks, so the
  tab-separated output is unparseable. **Fix**: `ok: false` on no match, and one
  line per hit (`--json` is the machine interface).
- **`src/cli.js` — `note rm FILE <unknown-id>` exits 0 silently** while
  `note done`/`reply` exit 2 for the same id.
- **`src/tree.js` — `pathOf`/`--json` `path` is not round-trippable when ids
  repeat**: two `<p id="z">` both report `body > p#z`, re-feeding it matches both
  and `set` edits the first. Duplicate ids are only a lint error. **Fix**: fall back
  to `:nth-of-type` when the id is not unique.
- **`src/cli.js` — the id-uniqueness probe interpolates `--as` unescaped**
  (`[id="${id}"]`), so an id containing `"` misparses.
- **`src/lint.js` — the "not canonical" message counts `|Δlines| + 1`**, so a
  50-line rewrite says "1 line(s) differ".
- **`src/cli.js` — `--md --x` is parsed as a bare flag** (only `--md=--x` works).
- **`src/cli.js` — `note add --on ''` silently means "no quote"** and wraps the
  whole block instead of failing.

## Robustness

- **Deep nesting is a crash, not an error.** 5,000 nested `<section>` (~90 KB) →
  `RangeError: Maximum call stack size exceeded`, exit **2** (a usage code for an
  input problem); `fromMarkdown('> '.repeat(25000))` likewise; in the editor the
  throw happens inside `openText` and the document silently shows as "no file open".
  **Fix**: a documented nesting cap reported as a `parse` finding, and an iterative
  `emitBlock`/`normalizeElement` (or a depth guard around them).
- **`src/parse.js` — `IMPLIED_END.p` lacks `figcaption`** (and
  `details`/`article`/`header`/`footer`/`nav`), so `<p>a<figcaption>b` nests where a
  browser splits.
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

- **Dead code**: `src/tree.js` `RAW`, `isText`, `isComment`, `childrenOf`,
  `findById`, `clone`; `src/format.js` `reindent`, `INDENT`; `src/docx.js`
  `o.spacing`; `editor/editor.js` `state.served` / `state.suggest`. Exported or
  stored, never read.
- **`tools/bundle.js` does not support `export { a as b }` or an aliased import**
  (`import { a as z }`): it would emit invalid JS, and `--check` cannot see it. No
  module uses `as` today, so it is latent — either support it or fail loudly.
- **`editor/editor.css` — `#sidebar li[data-resolved]` never matches** (the code
  writes `<em>resolved</em>`).
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
