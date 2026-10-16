# Vendored anti-slop Oxlint plugin

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), skill `skills/install-anti-slop`, commit `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.

Installed: 2026-10-16, fresh install via `skills/install-anti-slop/scripts/install.mjs` (no pre-existing copy in this repository).

Copied paths:

- `skills/install-anti-slop/assets/anti-slop/` → `tools/oxlint/anti-slop/`

Entry points:

- Generic plugin: `tools/oxlint/anti-slop/index.ts` (registered in `.oxlintrc.json` as `anti-slop`)
- Optional Effect plugin: `tools/oxlint/anti-slop/effect/index.ts` (present, **not** registered — this repository has no `effect` dependency)

## Identity of the copied bytes

Byte-identical to the upstream tree at the commit above; verified with `diff -r` against that commit. Digest of the copied files (sorted paths, `sha256sum | sha256sum`):

```
2cf66fa1be860828766b671ac50f7cadea0b5bff27359c1b27693586b4cb95aa
```

Upstream `main` has since moved to `13909c9e07590f5a85d93c62712259fe14a883f7`; the following files differ there and are **not** part of this installation:

- `rules/require-readable-spacing.ts`
- `vendor/eslint-stylistic/padding-line-between-statements.ts`
- `vendor/eslint-stylistic/UPSTREAM.md`

Picking those up is an update, not a reinstall: stage the new revision and merge it as described in `skill://install-anti-slop/references/update.md`, then refresh this record.

## Licenses

- `LICENSE` (this directory): MIT, Copyright (c) 2026 Dillon Mulroy — upstream repository root license, covers the anti-slop rules and helpers.
- `vendor/eslint-stylistic/LICENSE`: MIT, OpenJS Foundation and ESLint Stylistic notices — covers the vendored `padding-line-between-statements` implementation used by `require-readable-spacing`. See `vendor/eslint-stylistic/UPSTREAM.md` for that rule's own provenance and local adaptations.

## Dependencies

The plugin imports `@oxlint/plugins`. Both packages are pinned exactly in `package.json` and must move together:

- `oxlint`: `1.88.0`
- `@oxlint/plugins`: `1.88.0`

No formatter, TypeScript, or Stylistic runtime dependency is required; readability enforcement is self-contained.

## Local deviations

None. No file under `tools/oxlint/anti-slop/` has been edited after installation, beyond adding this record and `LICENSE`.

## Local deviations

- `anti-slop/require-readable-spacing` is configured at **`warn`**, not `error`
  (`.oxlintrc.json`). It demands a blank line before every statement, which would
  add ~1,500 whitespace-only lines across this repo and conflicts with the
  project's stated rule that files stay small and readable in one sitting for
  agents. Every other vendored rule, and `oxc/no-accumulating-spread`, stays at
  `error`. Run `npx oxlint --fix` to adopt the spacing style wholesale.
- Rules whose findings are legitimate I/O-boundary checks are annotated inline at
  the single boundary (`src/select.js:parseSelector`) rather than globally
  disabled.
