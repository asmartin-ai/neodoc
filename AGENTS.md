# Working on Neodoc (notes for humans and agents)

Read [docs/SPEC.md](docs/SPEC.md) before touching anything. It is normative; code
and spec must not disagree. If they do, fix both in the same change.

## Ground rules

- **Plain ESM JavaScript only.** No TypeScript, no build step, no bundler, no
  transpile, no `package.json` runtime dependencies. If a module must run in the
  browser (`src/*.js`, `editor/*`), use web-standard APIs only — no `node:` imports.
  `src/cli.js` and `src/serve.js` are the only Node-only modules.
- **Small files, minimal syntax.** Every file should be readable in one sitting.
  Prefer a function over a class, a branch over a config option, and no option at
  all until it has a caller. Deliberate shortcuts are labelled
  `ponytail: <ceiling>, <upgrade trigger>`.
- **Never destroy user content.** Unknown elements, unknown attributes and
  malformed input are preserved by `fmt` and reported by `lint`. Only the edits a
  command was asked to make are allowed to change bytes.
- **Two sources of truth**: `format()` in `src/format.js` (the canonical form) and
  `THEME_CSS` in `src/theme.js` (the stylesheet). Nothing else may define what a
  file looks like.

## Commands

```bash
npm test                              # all Node tests (node --test; no watch, no config)
node --test test/format.test.js       # one file
node bin/neodoc.js fmt -w doc.nd.html
node bin/neodoc.js lint doc.nd.html
node --test test/bench.test.js        # performance budget (SPEC §9)
node tools/bundle.js                  # regenerate editor/neodoc-editor.html
node tools/bundle.js --check          # fails if that generated page is stale
```

`editor/neodoc-editor.html` is generated from `editor/editor.js` + its `src/*.js`
import closure. Edit the modules, then rebuild; never edit the generated page. It
exists so the editor runs from a `file://` URL with no server and no network, which
is why it is one inline module script with no imports of its own.

Run the whole suite once at the end of a change, not in a loop. There is no
watch mode and no repo-wide formatter; `neodoc fmt` is the formatter.

## Lint

`npm run lint` runs oxlint with the vendored anti-slop plugin
(`tools/oxlint/anti-slop/`, provenance in its `UPSTREAM.md`). Every rule is an
error except `anti-slop/require-readable-spacing`, which is a **warning on
purpose**: it demands a blank line before every statement, which would add ~1,500
whitespace-only lines across this repo and directly fights the project's
"small files, minimal syntax, easy for agents to read in one sitting" rule. CI
fails on errors only. If you want the other style, run `npx oxlint --fix` — the
config is one word away.

## The invariants tests must protect

1. `format()` is idempotent: `format(format(x).text).text === format(x).text`.
2. The CLI and the browser editor produce identical bytes for the same document
   (both call `format()`).
3. A mutation changes only the lines it was asked to change — diff a doc before
   and after `neodoc set` on a canonical file.
4. `lint()` and `format()` never disagree: anything `lint` calls `format`-fixable
   is fixed by `fmt`, and a canonically formatted file lints clean.
5. Unknown/forbidden constructs survive `fmt` (content loss is a bug), and are
   reported by `lint`.
6. `fixtures/` stays lint-clean and idempotent; it is the cross-language
   conformance corpus (docs/PORTING.md).

## Adding to the vocabulary

Adding an element or attribute is a spec change, not a code change. Update, in
this order: `docs/SPEC.md` §3 → `src/tree.js` (`VOCAB`/`BLOCK`/`ATTRS`) →
`src/theme.js` if it needs styling → `src/markdown.js` (both directions) →
`src/docx.js` → `src/lint.js` if it needs a rule → a fixture + test.

## Adding a CLI command

1. Spec it in `docs/SPEC.md` §7 and `docs/CLI.md`.
2. Implement it in `src/cli.js`, reusing `openDoc`/`saveDoc`/`bodyHits` so
   canonicalization and `--json` shape stay uniform.
3. Keep the contract: exit `0` ok, `1` lint/check/no-match, `2` usage error; write
   atomically; print the byte count you wrote.

## Commit hygiene

- One concern per commit; format whitespace separately from behaviour.
- If you change canonical output, say so in the message — every stored file will
  diff on its next write.
