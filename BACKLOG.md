# Backlog

Nothing from the adversarial review (2026-10-16) is open. Every finding it produced was
either fixed in `git log` (CLI/lint contract, markdown round trips, the editor's refusal
policy and undo stack, docx fidelity, head placement, the nesting cap, the URL policy,
path addressing, save safety, typing cost) or is listed below as a deliberate choice.

The last round found three more, all fixed in the commits that follow it:

- **The mtime handshake refused the second save of every served session.** `POST /save`
  gave the writer no revision back, so save #2 compared the file against the mtime from
  *load* time, was refused 409, and turned into a download without touching the file —
  worse than the concurrent-write problem it was added for. A save now reports the
  revision it wrote, the page adopts it, and a download no longer marks the document
  saved. `e2e/served.spec.js` saves twice.
- **A `<title>` inside a `<head>` nested in the head never named the document**, so a
  browser showed an empty name. It is lifted out of the nested head now (the nested head
  itself stays, with a `structure` finding).
- **The iterator-helper guard scanned fewer directories than its comment claimed**, so a
  Node-22-only helper in `test/`, `e2e/`, `bin/` or `tools/` would have been invisible.
  It scans them now (verified by planting one).

## Accepted / by design

- **A `<template><script>` is refused, not ignored.** A template is inert only while its
  children are in `.content`, which is where the HTML *parser* puts them; the editor builds
  nodes with `createElement` + `append`, and a script appended to a created template is a
  connected node that runs (measured, four shapes). `e2e/untrusted.spec.js` pins it.
- **A head `<link>`/`<noscript>`/unknown element makes the editor refuse the document.**
  A head child the editor does not adopt is a head child the next save deletes, because
  `canonicalText()` serializes the live page, so refusing is the only honest alternative to
  losing it.
- **CriticMarkup cannot carry change authors or timestamps.** `{--x--}` has no slot for
  them, which is why `--comments html` is the default and documented as lossless.
- **A lone image followed by an all-emphasis paragraph reads back as a figure.** That is
  the documented figure form; markdown cannot tell the two shapes apart.
- **`get`'s plain-text output is multi-line for a container.** `--json` is the machine
  interface; the plain form is for people.
- **A multi-line comment is not re-indented.** Its text is its content; moving it would
  change it. `fmt` leaves it at column 0 and `lint` says nothing.
- **A document's head `<style>` cannot restyle the editor chrome** (measured): the
  editor's stylesheet is the canonical one, and a document's head `<style>` is replaced by
  it before anything is adopted.
- **`meta[http-equiv]` is reported as an unknown attribute, with no rule of its own.**
  That finding already fails `lint` (severity `error`), `fmt` keeps the bytes, and the
  editor refuses a document carrying one, so a second, louder rule would only duplicate it.
- **A half-written comment reply is not part of the document's undo history.** Ctrl+Z with
  the caret in the chrome is left to the browser, which is the right undo for a text box.
- **The editor's `#open-input` refuses a document that is not UTF-8** rather than opening
  it with replacement characters; the CLI and `serve` do the same, with the same wording.
- **A save is refused (409) when the file changed under the page** — including when
  another tool rewrote it to identical bytes. That is the protection working: the reason is
  shown, the edits are kept as a download, and the document stays marked unsaved. On a
  filesystem with coarse timestamps a write inside the same tick can still be missed.
- **The comment sidebar refreshes on open and on commands, not on every keystroke** (SPEC
  §9). A structural edit made by typing can therefore leave a thread's *path* in the
  status bar stale; its Resolve/Reply actions use the thread id and keep working.

## Refuted

- **Path traversal on `serve`** (`/%2e%2e/…`, `?path=..%2F`), **zip entry-name injection in
  docx**, **billion-laughs**, **shell injection**, **`serve` binding beyond loopback**: all
  attacked, all held.
- **`<template><script>` is harmless**: measured otherwise (above).
- **A head `<link>`/`noscript`/unknown element is a false-positive refusal**: same
  reasoning as under "Accepted".

## How to run the checks this backlog was written against

```bash
npm test                       # 158 tests
npx oxlint                     # errors only; one style rule is a deliberate warning
node tools/bundle.js --check   # the committed editor page must match its modules
npx playwright test            # 24 e2e cases in three engines
```
