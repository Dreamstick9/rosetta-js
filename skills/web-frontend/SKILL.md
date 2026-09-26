---
name: web-frontend
internal: true
description: "Browser UI in React, Vue, Svelte or Angular (vite/next/webpack): components, props, state, forms, styling, jest/vitest/playwright tests."
triggers:
  keywords: [frontend, react, vue, svelte, angular, nextjs, nuxt, component, jsx, tsx, css, dom, browser, vite, webpack, jest, vitest, playwright, testing library, render, hook, usestate, useeffect, state, props, ui, button, form, click]
  files: [vite.config.ts, vite.config.js, next.config.js, next.config.mjs, svelte.config.js, nuxt.config.ts, angular.json, "*.tsx", "*.jsx", "*.vue", "*.svelte"]
tools:
  - script: scripts/detect_frontend.py
    usage: "detect_frontend.py [DIR] → framework+version, bundler, test runner, pkg manager, scripts, entries, exact test command"
  - script: scripts/js_test_failures.py
    usage: "js_test_failures.py [--max N] [-- CMD…] | [LOGFILE] → runs jest/vitest/mocha/playwright, prints only failing tests, asserts, file:line"
  - script: scripts/component_info.py
    usage: "component_info.py NAME|FILE [DIR] → definition file:line, props/emits, hooks, imports, who renders it, which tests cover it"
checks:
  - "npx --no-install vitest run 2>/dev/null || npx --no-install jest --ci"
  - "npx --no-install tsc --noEmit -p ."
---
# Web frontend

## When it applies
- The issue mentions a component, page, hook, prop, rendering glitch, form, styling bug or a UI test failure.
- `package.json` lists react, vue, svelte, angular, solid, preact or lit; files are `.jsx/.tsx/.vue/.svelte`.
- A library ships DOM code (date pickers, markdown renderers, routers, form helpers, CSS-in-JS).

## Workflow
1. `python3 skills/web-frontend/scripts/detect_frontend.py` — one call gives framework version, runner and the test command.
   If it says `node_modules MISSING`, tests cannot run: reason from source and write the test anyway.
2. Locate the code: grep the visible string, CSS class or prop from the issue, then
   `python3 skills/web-frontend/scripts/component_info.py <Name>` for props, hooks, parents and existing tests in one call.
3. Reproduce with a failing unit test next to the component (Testing Library / vue-test-utils in jsdom).
   Visual bugs map to a wrong class, prop, conditional or computed value you can assert on.
4. Run tests through `python3 skills/web-frontend/scripts/js_test_failures.py -- npx --no-install vitest run src/x.test.tsx`
   (or `jest --ci path`). Only failing tests and Expected/Received lines come back.
5. Fix in the framework idiom already in the file (hooks vs classes, Options vs Composition API, CSS modules vs
   Tailwind). Do not introduce a new library.
6. Re-run the one test file, then the whole suite, then the typecheck (`tsc --noEmit`) if TS.

## Framework rules that fix most bugs
- React: hooks top-level and unconditional; every used value in effect/memo/callback deps; never mutate state
  (new arrays/objects); functional updates (`setN(n => n + 1)`) for stale closures; stable list `key`s (not index
  when items reorder); controlled inputs need `value` + `onChange`.
- Vue 3: never mutate props, emit events; `ref` needs `.value` in script, not in template; `reactive` loses
  reactivity when destructured (use `toRefs`); `v-model` on a component = `modelValue` + `update:modelValue`.
- Svelte: reassign to trigger reactivity (`arr = [...arr, x]`); `$:` statements run in order; Svelte 5 runes
  (`$state`, `$props`) do not mix with `export let` in the same component.
- Angular: change detection with OnPush needs new object references; unsubscribe observables.
- Next/Nuxt SSR: no `window`/`document` at module top level; guard with `typeof window !== 'undefined'` or an effect.
- Async UI in tests: `await screen.findBy…` / `waitFor`, not `getBy…`, after state updates or fetches; wrap timers
  with `vi.useFakeTimers()` / `jest.useFakeTimers()` and advance them.
- Accessibility is often the bug: `<label for>`/`htmlFor`, `aria-*`, `button` vs `div` with onClick, keyboard events.
  Queries by role (`getByRole('button', {name: /save/i})`) are the most robust.

## Checklist
- [ ] Reproduced with a failing test (or a node/jsdom script) before editing
- [ ] Ran the real test command from `detect_frontend.py`, one file first
- [ ] Test fails before and passes after the fix
- [ ] `tsc --noEmit` passes if the project is TypeScript; eslint clean on touched files
- [ ] Public component API kept: new props optional with old default; no renamed props/events
- [ ] No new dependencies, no lockfile edits, no reformatting of untouched files
- [ ] Snapshot updates reviewed and intended (never blanket `-u`)

## Pitfalls
- `npm install` / `npx <pkg>` without `--no-install` hangs offline. Only `node_modules/.bin` tools exist.
- Watch mode never exits: use `vitest run`, `jest --ci` (`CI=true` for react-scripts), never `npm start`/`vite`.
- Removing a hook dependency to "fix" a loop; instead memoize the value or use a functional update.
- Mutating state in place (`items.push(x); setItems(items)`) so nothing re-renders.
- Editing `dist/`, `build/`, `lib/` output instead of `src/`.
- jsdom has no layout: `getBoundingClientRect` is zeros, no `IntersectionObserver`/`matchMedia` unless mocked.
- Playwright/Cypress e2e need a browser and a running server: usually unavailable; test logic at unit level.
- Jest + ESM packages: "Cannot use import statement outside a module" is config (transformIgnorePatterns), not
  your code; do not rewrite imports to work around it.
- CSS: specificity and `:hover`/media queries are not testable in jsdom; assert on the class name instead.

## Research
- Check the installed version (`detect_frontend.py` prints it), then `web_fetch` that version's docs with a
  focused `prompt`: react.dev/reference, vuejs.org/api, svelte.dev/docs, angular.dev, nextjs.org/docs,
  vitest.dev/api, jestjs.io/docs/expect, testing-library.com/docs/queries/about.
- DOM/CSS behaviour: developer.mozilla.org. Unfamiliar runner/build errors: `web_search` the quoted message
  plus the tool name and major version.
