# Neodoc

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
neodoc serve report.nd.html --open                     # edit in the browser
neodoc get report.nd.html 'body > p:nth-child(2)' --json
neodoc set report.nd.html 'h1' --md '# Introduction'
neodoc comment add report.nd.html 'body > p' --quote 'churn figure' --body 'Source?'
neodoc lint report.nd.html && neodoc to md report.nd.html && neodoc to docx report.nd.html
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
| **Edit (human)** | `neodoc serve FILE --open` → inline WYSIWYG editing (`# `, `**bold**`, `- item`, tables, paste sanitized through the format), comment sidebar, suggest mode, `Cmd+S` writes canonical bytes. `editor/index.html` also works opened directly, or hosted online. |
| **Edit (agent/script)** | `neodoc get/set/insert/rm/comment/track` with CSS selectors and `--json`. Same selectors in every command; `get --json` hands back a round-trippable path. |

## Converting

```bash
neodoc import notes.md -o notes.nd.html   # markdown → neodoc
neodoc to md report.nd.html -o report.md  # comments → HTML (default), critic markup, or dropped
neodoc to docx report.nd.html             # real Word comments + tracked changes + embedded media
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
src/serve.js      local server for the editor's save loop
editor/           the browser editor (no dependencies)
docs/SPEC.md      normative format spec
docs/CLI.md       command reference
docs/PRIOR-ART.md what was tried before and how it failed
docs/PORTING.md   how to write a Neodoc implementation in another language
```

## Non-goals

- Not a web page builder (no scripts, no arbitrary CSS, no widgets).
- Not a collaboration server (git handles review; the format handles addressing).
- Not a markdown dialect (markdown is an import/export projection).
- Not a docx reader.
