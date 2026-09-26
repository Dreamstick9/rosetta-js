---
name: large-refactor
internal: true
description: "Refactors that touch many files: extracting shared code, renaming APIs, restructuring modules, removing duplication, while keeping behavior identical."
triggers:
  keywords: [refactor, restructure, extract, rename, move, deduplicate, duplicate, duplication, clean up, cleanup, split, merge modules, reorganize, simplify, migrate, replace all, across the codebase]
  files: []
tools:
  - script: scripts/find_refs.py
    usage: "find_refs.py NAME [NAME2] → every whole-word reference grouped by file, definitions first (the blast radius)"
checks:
  - "python3 -m pytest -q 2>/dev/null || python3 -m unittest discover -s tests"
  - "grep -rnw \"old_name\" --include=*.py --include=*.ts --include=*.go --include=*.rs . | grep -v node_modules"
---
# Large refactors

## When it applies
- The request changes structure, not behavior: extract a helper, rename a symbol everywhere, split or merge modules, remove duplication, migrate from one API to another.
- More than two or three files are involved.

## Workflow
- Map the blast radius in one call: `python3 skills/large-refactor/scripts/find_refs.py <old_name>`.
- Establish a baseline first: run the full test suite and note which tests pass (and which already fail) before changing anything.
- Map the blast radius: search every definition and use (`search` with word boundaries, imports, string references, docs, config). Record the list.
- Plan with `todo_write`: one item per mechanical step (create the new module, switch callers group by group, delete the old code, update docs, run tests).
- Keep the tree working between steps: add the new code first, switch callers, then delete the old code. Run the tests after each step.
- For independent groups of files, delegate with `task` (write=true), each with complete instructions, the exact new API, and "keep behavior identical, run the tests". Several task calls in one reply run in parallel; review the merged diff and any conflicts afterwards.
- Preserve behavior exactly: same outputs, same exceptions, same formatting. When duplicates differ slightly, stop and decide which behavior is right; do not silently pick one.
- Keep public names working when others may import them: re-export or leave a thin alias if the project cares about compatibility.
- Do not mix in unrelated improvements; a refactor diff should be reviewable as "moved and renamed".
- Finish with a search for leftovers: old names, dead imports, now-unused helpers.

## Checklist
- [ ] Baseline test run recorded before changes
- [ ] Every use found (code, tests, docs, config, strings)
- [ ] Plan written with todo_write and kept current
- [ ] Tests pass after each step and at the end
- [ ] Old definitions removed; no duplicates left
- [ ] No behavior change (outputs, errors, formats)
- [ ] No unrelated edits in the diff
- [ ] Leftover search is clean

## Verify
```bash
# baseline and final test runs (use the project's command)
python3 -m pytest -q 2>/dev/null || python3 -m unittest discover -s tests
# find every remaining use of the old name (word boundary)
grep -rnw "old_name" --include=*.py --include=*.ts --include=*.go --include=*.rs . | grep -v node_modules
# review what changed
git diff --stat && git diff | head -200
```

## Useful tools
- `search` with `\bname\b` patterns; `grep -rnw` for whole words
- `git diff --stat` to confirm the scope
- `task` sub-agents for parallel, independent file groups
- Language tools when present: `python3 -m compileall`, `tsc --noEmit`, `go vet`, `cargo check`

## Pitfalls
- Changing behavior while "just moving" code (different rounding, formatting or error types).
- Missing dynamic references: string-based imports, reflection, config files, templates.
- Deleting the old code before all callers are switched, leaving the tree broken mid-way.
- Sub-agents given vague instructions producing inconsistent APIs; give them the exact signature.
- Circular imports after extracting a shared module; put shared code at the lowest layer.
- Reformatting whole files, which buries the real change in noise.
