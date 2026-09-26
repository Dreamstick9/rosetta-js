---
name: node-typescript
internal: true
description: "Node.js / TypeScript code: tsc type errors, tsconfig and module (ESM/CJS) problems, eslint failures, package.json exports and deps."
triggers:
  keywords: [typescript, tsc, tsconfig, type error, ts2322, ts2339, ts2307, eslint, lint, node, nodejs, npm, esm, commonjs, require, import, export, module resolution, exports, types, declaration, generics, interface, strict, ts-node, prettier]
  files: [tsconfig.json, package.json, .eslintrc.json, .eslintrc.js, .eslintrc.cjs, eslint.config.js, eslint.config.mjs, "*.ts", "*.mts", "*.cts"]
tools:
  - script: scripts/tsc_summary.py
    usage: "tsc_summary.py [DIR] | --log FILE | -- CMD… → tsc errors grouped by file and code, with a fix hint per common code"
  - script: scripts/eslint_summary.py
    usage: "eslint_summary.py [PATH…] [--errors-only] | --log FILE → eslint counts by rule/file, fixable count, first problems file:line"
  - script: scripts/tsconfig_resolve.py
    usage: "tsconfig_resolve.py [TSCONFIG|DIR] → effective options through the extends chain + misconfiguration warnings"
  - script: scripts/pkg_info.py
    usage: "pkg_info.py [DIR] [--dep NAME…] → ESM/CJS, main/exports/types/bin, scripts, local tools; dep declared vs installed + import sites"
checks:
  - "npx --no-install tsc --noEmit -p ."
  - "npx --no-install eslint ."
---
# Node.js and TypeScript

## When it applies
- The task mentions a type error (`TS2322`, "is not assignable", "possibly undefined"), tsconfig, eslint,
  ESM/CommonJS ("require is not defined", "Cannot use import statement"), or package `exports`/types.
- The repo is a Node library/CLI/service in TS or JS (not primarily UI: that is `web-frontend`).

## Workflow
1. `python3 skills/node-typescript/scripts/pkg_info.py` — module system, entry points, scripts, which tools are installed.
2. Types: `python3 skills/node-typescript/scripts/tsc_summary.py` (or `-- npm run typecheck`). Fix the file with the most
   errors first; one root cause (a changed interface, a missing export) often explains many errors downstream.
3. Config errors (TS5023, TS2307 on aliases, TS1259, TS2835, TS17004): `python3 skills/node-typescript/scripts/tsconfig_resolve.py`
   shows the effective options through `extends` and flags the usual mismatches.
4. Lint: `python3 skills/node-typescript/scripts/eslint_summary.py src/changed.ts --errors-only` on touched files only.
5. Tests: use the runner from `package.json` scripts (`npx --no-install vitest run`, `jest --ci`, `node --test`).
   For a one-off check of a helper: `node -e` / `npx --no-install tsx -e` if installed.
6. Re-run `tsc_summary.py` until `OK: 0 type errors`, then the tests.

## Fixing type errors properly
- Narrow, don't cast: `if (x === undefined) return`, `?.`, `??`, `in` checks, discriminated unions with a `kind`.
- `as any`, `@ts-ignore`, `!` non-null assertions hide bugs; use them only when the issue explicitly allows.
- Change the declared type when the value is right (e.g. `string | undefined` param with a default).
- Generic constraint errors: add `extends` constraints rather than widening to `unknown` everywhere.
- Public API types are contract: add optional fields/overloads; don't narrow a parameter or widen a return.
- `.d.ts`/`types` in package.json must match what `exports` ships; `types` condition goes first in `exports`.

## ESM vs CommonJS
- `package.json` `"type": "module"` → `.js` is ESM: no `require`, `__dirname` (use `import.meta.url` +
  `fileURLToPath`), JSON via `createRequire` or import attributes. `.cjs` stays CommonJS.
- `module`/`moduleResolution` `NodeNext` → relative imports need the `.js` extension even in `.ts` source.
- Default import of a CJS module needs `esModuleInterop` (or `import * as x`).
- Jest runs CJS by default; ESM-only deps fail with "Cannot use import statement outside a module" — a jest
  `transform`/`transformIgnorePatterns` issue, not a reason to rewrite source imports.

## Checklist
- [ ] `tsc_summary.py` reports 0 errors (or no new ones versus before your change)
- [ ] No new `any`, `@ts-ignore`, or non-null `!` added to silence errors
- [ ] eslint clean on touched files; no mass reformat (no `eslint --fix .`, no prettier on untouched files)
- [ ] Exports/types in `package.json` still point at real files
- [ ] Tests pass with the project's runner; no dependency or lockfile changes

## Pitfalls
- `npx tsc` without `--no-install` tries to download a random `tsc` package. Only use installed tools.
- Running `tsc` without `--noEmit` writes `.js` files next to sources or into `dist/`.
- `tsc file.ts` ignores tsconfig.json entirely; always use `-p`.
- Editing `dist/` or `.d.ts` output instead of `src/`.
- `paths` aliases compile but fail at runtime/jest unless the bundler/jest mapper has the same aliases.
- `skipLibCheck: false` surfaces errors inside `node_modules/@types`: don't "fix" them in node_modules.
- Monorepos: run tsc in the right package (`-p packages/x`), and `tsc -b` for project references.
- `import type` vs value import: with `isolatedModules`/`verbatimModuleSyntax`, re-exporting a type needs `export type`.

## Research
- Error codes: `web_search "TS2345" <short message>`; the TS handbook (typescriptlang.org/docs/handbook) and
  tsconfig reference (typescriptlang.org/tsconfig#<option>) via `web_fetch` with a focused `prompt`.
- Node module rules: nodejs.org/api/packages.html (exports, type, conditions), nodejs.org/api/esm.html.
- ESLint rules: eslint.org/docs/latest/rules/<rule>; typescript-eslint.io/rules/<rule>.
