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
Rules: `parse`, `vocab`, `attr`, `required-attr`, `id-duplicate`, `comment-anchor`,
`comment`, `link-target`, `section-heading`, `title`, `body`, `timestamp`, `format`.

## Reading and editing by selector

```bash
neodoc get report.nd.html 'h1'
neodoc get report.nd.html 'body > table td' --text
neodoc get report.nd.html 'section#s2 > p' --json
neodoc set report.nd.html 'h1' --md '# New title'
neodoc set report.nd.html 'body > p:nth-child(4)' --html '<p>Replaced</p>'
neodoc set report.nd.html 'aside[data-thread="c1"]' --file note.html
neodoc insert report.nd.html --after 'h1' --md 'Intro paragraph.'
neodoc insert report.nd.html --append-to 'section#s2' --md '- a
- b'
neodoc insert report.nd.html --before 'body > p' --file - --md < notes.md
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
`--file - --md` (markdown from stdin), `--stdin` (HTML from stdin).

## Comments and tracked changes

```bash
neodoc comment add report.nd.html 'body > p:nth-child(2)' \
    --quote 'churn figure' --body 'Source?' --author ada
neodoc comment add report.nd.html 'body > h2' --body 'Section-level note'   # no --quote: whole block
neodoc comment list report.nd.html --state open
neodoc comment list report.nd.html --json
neodoc comment reply report.nd.html c1 --body 'Appendix B.' --author ken
neodoc comment resolve report.nd.html c1
neodoc comment reopen  report.nd.html c1
neodoc comment rm      report.nd.html c1
neodoc track accept report.nd.html              # fold <ins> in, drop <del>
neodoc track reject report.nd.html 'body > p'   # drop <ins>, keep <del> content
```

Wrapped text stays in place: `<mark data-c="c1">churn figure</mark>`, with the
thread in a neighbouring `<aside data-thread="c1" data-state="open">`. See SPEC §5.

## Conversion

```bash
neodoc import notes.md -o notes.nd.html        # markdown (or `-`) → neodoc
neodoc to md report.nd.html                    # → report.md, GFM
neodoc to md report.nd.html --comments critic  # CriticMarkup comments
neodoc to md report.nd.html --comments drop    # strip comments
neodoc to md report.nd.html -o -
neodoc to docx report.nd.html                  # → report.docx (media embedded)
```

`--comments`: `html` (default — nothing is lost), `critic`, `drop`.
`to docx` writes real Word comments and real tracked changes, and inlines images
from `data:` URIs or paths relative to the document.

## Rendering

```bash
neodoc serve report.nd.html --open             # edit + save loop, http://127.0.0.1:8765
python3 -m http.server                         # or just host the file statically
```

The document itself needs no server: opening the file renders it. `serve` binds to
`127.0.0.1` only and adds `GET /doc` (the raw text + style mode) and
`POST /save?path=<name>` for the editor's save loop.

## Performance

```bash
neodoc bench report.nd.html --rounds 20
# report.nd.html: 250431 bytes, 2031 top-level blocks
# fmt        12.4 ms  (median of 20)
# lint       18.1 ms  (median of 20)
# ...
```

The budgets in SPEC §9 are asserted by `node --test test/bench.test.js`.
