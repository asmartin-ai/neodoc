# Neodoc

[![CI](https://github.com/asmartin-ai/neodoc/actions/workflows/ci.yml/badge.svg)](https://github.com/asmartin-ai/neodoc/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A document format to replace `.docx`: **one plaintext HTML file** that you edit
WYSIWYG with markdown-native input, read in any browser with zero JavaScript, and
edit from the command line by CSS selector.

```html
<!doctype html>
<html data-neodoc="1" lang="en">
  <head>
    <meta charset="utf-8">
    <title>Quarterly report</title>
    <meta content="Ken" name="author">
    <meta content="2026-10-16" name="date">
    <meta content="neodoc 1.0.0" name="generator">
<style>…canonical stylesheet…</style>
  </head>
  <body>
    <h1 id="h-intro">Introduction</h1>
    <p>Revenue grew <strong>12%</strong>, but the <mark data-c="c1">churn figure</mark> is disputed.</p>
    <aside data-state="open" data-thread="c1">
      <p data-at="2026-10-16T09:12:00Z" data-author="ada">Source for this number?</p>
    </aside>
    <table>
      <tr>
        <th>Region</th>
        <td data-align="right">Q3</td>
      </tr>
    </table>
  </body>
</html>
```

## Quickstart

```bash
neodoc new report.nd.html --title "Quarterly report"   # create
open editor/neodoc-editor.html                         # WYSIWYG edit, no server
neodoc get report.nd.html 'body > p:nth-child(2)' --json
neodoc set report.nd.html 'h1' --md '# Introduction'
neodoc note add report.nd.html 'body > p' --on 'churn figure' --say 'Source?'
neodoc lint report.nd.html && neodoc md report.nd.html && neodoc docx report.nd.html
```

No dependencies, no build step: `node bin/neodoc.js …` (Node ≥ 20, Bun, or a
single compiled binary). Tests: `node --test test/`.

## Why it looks like this

The failure evidence is in [docs/PRIOR-ART.md](docs/PRIOR-ART.md); the format
contract is [docs/SPEC.md](docs/SPEC.md). The short version:

| Problem with `.docx` | Neodoc's answer |
|---|---|
| A zip of XML: git sees one binary blob per save, blame/merge are gone | One UTF-8 text file, one element per line, so diffs are semantic and word-level |
| Word stamps revision IDs and build timestamps, so identical content differs | Byte-deterministic serialization; `neodoc fmt --check` in CI; no timestamps |
| Comments and tracked changes are unreadable and often unreadable *by tools* | Plain `<mark data-c>`, `<aside data-thread>`, `<ins>`, `<del>` — selectable, greppable, convertible to real Word comments |
| Needs Office (or a 900-page spec) to open | Any browser, offline, no JavaScript, stylesheet inlined |
| Hostile to scripts and agents | `neodoc get/set/insert/rm` address blocks by CSS selector and speak JSON |
| WYSIWYG editors write browser HTML to disk, which is not a format | The editor edits the canonical DOM and saves through the same `format()` the CLI uses |

## Layout of the format (the invariants that matter)

- Name it `*.nd.html` (`report.nd.html`); `*.ndoc.html` and `*.ndoc` also work. The
  last extension stays `.html` so browsers and static hosts serve it as HTML with no
  MIME configuration — the identity is the `data-neodoc` marker, not the media type.
- One **element per line**, 2-space indent, no blank lines, no hard wrapping.
- A **closed vocabulary** and a closed attribute set (SPEC §3): no `class`, no
  `style=`, no `div`, no `span` — and `<script>` in a document is a lint error.
- Attribute order, escaping and whitespace are all normalized, so
  `fmt(fmt(x)) == fmt(x)` and any write leaves the file canonical.
- Comments and suggestions are **standard HTML elements**, not custom syntax.
- The document renders as-is: no renderer, no network, no JS.

## The three surfaces

| Surface | How |
|---|---|
| **Read** | Open the `.nd.html` file in any browser, or host it anywhere statically. Print it: the stylesheet has `@page`, `break-inside`, `orphans`/`widows` rules. |
| **Edit (human)** | Open `editor/neodoc-editor.html` from anywhere — no server, no network, works offline from `file://`. Inline WYSIWYG editing (`# `, `**bold**`, `- item`, tables, paste sanitized through the format), comment sidebar, suggest mode; `Cmd+S` writes canonical bytes through the browser's file handle, or downloads the file. Hosted or `neodoc serve FILE --open` (optional) adds in-place saving everywhere. |
| **Edit (agent/script)** | `neodoc get/set/insert/rm/comment/track` with CSS selectors and `--json`. Same selectors in every command; `get --json` hands back a round-trippable path. |

## Converting

```bash
neodoc import notes.md -o notes.nd.html   # markdown → neodoc
neodoc md report.nd.html -o report.md  # comments → HTML (default), critic markup, or dropped
neodoc docx report.nd.html             # real Word comments + tracked changes + embedded media
```

docx is **export-only** on purpose: importing docx is a lossy one-way door
(pandoc's own round-trip issues are cited in PRIOR-ART §5). Import markdown.

## Layout

```
bin/neodoc.js     CLI entry
src/parse.js      HTML subset parser (tolerant, records errors)
src/format.js     normalize + canonical serialize; the format contract
src/lint.js       rules + "not canonical" detection
src/select.js     CSS-subset selector engine over the tree
src/comments.js   comments, replies, tracked changes
src/markdown.js   HTML ↔ markdown
src/docx.js       OOXML writer (web-standard APIs only)
src/tree.js       node model, vocabulary, addressing helpers
src/theme.js      the canonical stylesheet
src/cli.js        command dispatch
src/serve.js      optional local server (in-place save, live reload)
editor/editor.js  the browser editor, as modules
editor/neodoc-editor.html  generated: the same editor, one self-contained page
tools/bundle.js   builds that page (node tools/bundle.js)
docs/SPEC.md      normative format spec
docs/CLI.md       command reference
docs/PRIOR-ART.md what was tried before and how it failed
docs/PORTING.md   how to write a Neodoc implementation in another language
```

## No server

Nothing in Neodoc requires a server:

- **Reading**: the document is valid HTML; open it, host it statically, or email it.
- **Editing**: `editor/neodoc-editor.html` is one self-contained page (the modules are
  bundled into an inline module script by `tools/bundle.js`), so it works from a
  `file://` URL with no network. It reads your document through the browser's file
  picker or a drag-and-drop, and writes it back through the File System Access API
  where the browser has it, otherwise as a download.
- **Agents and scripts**: `neodoc get/set/add/…` are a local process, not a service.

`neodoc serve FILE` is optional convenience — in-place saving in browsers without the
File System Access API, live reload while editing, and an HTTP `/doc` + `/save` pair
the editor auto-detects. It binds to `127.0.0.1` only.

## Platform support

The format is UTF-8, LF-only, plain HTML. The toolchain is dependency-free
JavaScript that runs on any modern Node (≥ 20), Bun, and every browser engine.

| | Covered |
|---|---|
| **OS** | Linux, macOS, Windows — CLI, conformance corpus and docx/markdown conversion run on all three in CI (Node 20/22/24 × 3 OSes = 9 jobs) |
| **Engines** | Blink (Chromium), Gecko (Firefox), WebKit — the editor's end-to-end suite runs on all three, on Linux and macOS, plus Android/iOS viewport profiles, plus the branded **Chrome** and **Edge** builds where the CI image ships them |
| **Browser brands** | Chrome, Edge, Brave, Opera, Vivaldi, Arc share Blink; LibreWolf, Waterfox, Tor Browser share Gecko; Safari, every iOS browser, GNOME Web share WebKit. Engine behaviour transfers; **API availability does not** |
| **Hardened / older builds** | The `fallbacks` spec deletes the optional APIs (`showOpenFilePicker`, `showSaveFilePicker`, `navigator.clipboard`, `CompressionStream`) before page load and asserts the degraded path works in every engine |
| **Not covered** | Real devices, OS input quirks, and vendor hardening beyond feature detection — those need a device farm (BrowserStack or similar), which this project does not require to build or test |

What actually differs between brands is *which optional APIs exist*: the File
System Access API is Chromium-only, so on Firefox and Safari the editor saves by
downloading the file (and `neodoc serve` gives in-place saving there instead).
`CompressionStream('deflate-raw')` is missing on older runtimes, so docx export
falls back to stored (uncompressed) zip entries. Both branches are tested.

## Testing

```bash
npm test                              # 100 Node tests: core, CLI, conformance, perf, bundle
npm run lint                          # oxlint with the vendored anti-slop rules
node tools/bundle.js --check          # the generated editor page is in sync
npx playwright install chromium firefox webkit
npm run test:e2e                      # editor end to end: chromium, firefox, webkit,
                                      #   mobile-chrome, mobile-safari, chrome, edge
npm run test:e2e -- --project=webkit  # one engine
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the Node matrix on
Linux/macOS/Windows, the boundary + bundle-sync checks, and the browser suite per
engine per OS. The `editor/neodoc-editor.html` page under test is generated by
`tools/bundle.js` from `editor/` + `src/`, so no test can pass against a stale build.

## Non-goals

- Not a web page builder (no scripts, no arbitrary CSS, no widgets).
- Not a collaboration server (git handles review; the format handles addressing).
- Not a markdown dialect (markdown is an import/export projection).
- Not a docx reader.
