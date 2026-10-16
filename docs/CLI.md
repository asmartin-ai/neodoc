# `neodoc` CLI reference

Every command takes a file, most take a CSS selector (SPEC §7). Selectors are
matched against the whole document, so `body > section:nth-child(2) > p:nth-child(3)`
works. Mutating commands write in place; add `-o -` (or use `to md -o -`) for stdout.

Exit codes: `0` ok · `1` lint/`--check` violations or nothing matched · `2` usage,
selector or I/O error.

## Creating and checking

```bash
neodoc new report.nd.html --title "Report"     # canonical skeleton + stylesheet
neodoc new - < notes.md > notes.nd.html        # --stdin (or `-`) reads markdown
neodoc fmt -w report.nd.html                   # canonicalize in place
neodoc fmt --check report.nd.html              # CI gate: exit 1 if not canonical
neodoc fmt --style=none report.nd.html         # drop the inline stylesheet
neodoc lint report.nd.html                     # problems incl. "not canonical"
neodoc lint --json report.nd.html              # machine-readable findings
neodoc lint --fix report.nd.html               # canonicalize what is fixable
neodoc css                                     # print the canonical stylesheet
```

`lint --json` → `{"ok":bool,"findings":[{"file","line","severity","rule","message","fixable"}]}`.
Rules: `parse`, `vocab`, `attr`, `required-attr`, `id-duplicate`, `misplaced-head`,
`comment-anchor`, `comment`, `link-target`, `section-heading`, `title`, `body`,
`timestamp`, `invisible-char`, `format`.

## Reading and editing by selector

```bash
neodoc get report.nd.html 'h1'
neodoc get report.nd.html 'body > table td' --text
neodoc get report.nd.html 'section#s2 > p' --json
neodoc set report.nd.html 'h1' --md '# New title'
neodoc set report.nd.html 'body > p:nth-child(4)' --html '<p>Replaced</p>'
neodoc set report.nd.html 'aside[data-thread="c1"]' --file note.html
neodoc add report.nd.html --after 'h1' --md 'Intro paragraph.'
neodoc add report.nd.html --into 'section#s2' --md '- a
- b'
neodoc add report.nd.html --before 'body > p' --file - --md < notes.md
neodoc rm report.nd.html 'body > aside[data-state="resolved"]'
neodoc id report.nd.html --for 'body > section:nth-child(2)' --as intro
```

`get --json` is the agent interface:

```json
{
  "ok": true, "file": "report.nd.html", "count": 1,
  "matches": [{
    "path": "body > section:nth-child(2) > p:nth-child(3)",
    "tag": "p", "id": null, "attrs": {},
    "text": "plain text",
    "html": "<p>plain <strong>text</strong></p>"
  }]
}
```

`path` is a valid selector for the same node, so `get --json` → edit → `get`
round-trips. `set`/`insert` replace or insert at the **first** match; `rm` removes
all matches. Content flags: `--md S`, `--html S`, `--file F` (HTML from a file),
`--file - --md` (markdown from stdin), `--stdin` (HTML from stdin). A value may
start with `-` (`--md '-- not a flag'`); use `=` before a value that is itself a
known flag name.

## Comments and tracked changes

```bash
neodoc note add report.nd.html 'body > p:nth-child(2)' \
    --on 'churn figure' --say 'Source?' --by ada
neodoc note add report.nd.html 'body > h2' --say 'Section-level note'   # no --on: whole block
neodoc note ls report.nd.html --open
neodoc note ls report.nd.html --json
neodoc note reply report.nd.html c1 --say 'Appendix B.' --by ken
neodoc note done report.nd.html c1
neodoc note undo report.nd.html c1
neodoc note rm   report.nd.html c1
neodoc accept report.nd.html              # fold <ins> in, drop <del>
neodoc reject report.nd.html 'body > p'   # drop <ins>, keep <del> content
```

Wrapped text stays in place: `<mark data-c="c1">churn figure</mark>`, with the
thread in a neighbouring `<aside data-thread="c1" data-state="open">`. See SPEC §5.

## Conversion

```bash
neodoc import notes.md -o notes.nd.html        # markdown (or `-`) → neodoc
neodoc md report.nd.html                    # → report.md, GFM
neodoc md report.nd.html --comments critic  # CriticMarkup comments
neodoc md report.nd.html --comments drop    # strip comments
neodoc md report.nd.html -o -
neodoc docx report.nd.html                  # → report.docx (media embedded)
```

`--comments`: `html` (default — nothing is lost), `critic`, `drop`.
`to docx` writes real Word comments and real tracked changes, and inlines images
from `data:` URIs or paths relative to the document.

## Rendering

```bash
open editor/neodoc-editor.html                 # edit WYSIWYG: no server, works offline
python3 -m http.server                         # or host the document statically
neodoc serve report.nd.html --open             # optional: in-place save + live reload
```

The document needs no server to render, and neither does the editor: the page keeps
`editor.js` and its `src/*.js` imports until you want a server; `tools/bundle.js`
inlines them so `editor/neodoc-editor.html` runs from `file://` offline. Use
`neodoc serve` only for the conveniences it adds — saving in place in browsers
without the File System Access API, and the `GET /doc` + `POST /save` pair the
editor auto-detects. It binds to `127.0.0.1` only, answers only to loopback `Host`
names, refuses writes that did not come from its own page, and ever edits exactly
the one file it was started with (`?path=` is accepted and ignored).

## Performance

```bash
neodoc bench report.nd.html --rounds 20
# report.nd.html: 250431 bytes, 2031 top-level blocks
# fmt        12.4 ms  (median of 20)
# lint       18.1 ms  (median of 20)
# ...
```

The budgets in SPEC §9 are asserted by `node --test test/bench.test.js`.
