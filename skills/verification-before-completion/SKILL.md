---
name: verification-before-completion
internal: true
description: "Before saying done: run the tests, scan the diff for leftovers (debug prints, TODOs, skips, junk files) and re-check the request, in one call."
triggers:
  keywords: [verify, verification, verify everything, double-check, double check, make sure it works, final check, sanity check]
  files: []
tools:
  - script: scripts/verify.py
    usage: "verify.py [--test \"CMD\"] → tests + diff leftovers + junk files as a PASS/FAIL checklist with a verdict"
  - script: scripts/test_summary.py
    usage: "test_summary.py [-- CMD] → runs the tests, prints only failing tests and their asserts"
checks:
  - "python3 -m pytest -q || python3 -m unittest discover -s tests"
---
# Verification before completion

## When it applies
- Always, right before you reply that the work is done. Claims of success need evidence.

## Workflow
1. `python3 skills/verification-before-completion/scripts/verify.py` (add `--test "<cmd>"` if the project's test command is special).
2. Fix every FAIL item: failing tests, debug prints, breakpoints, conflict markers, skipped tests, junk files.
3. Re-read the original request sentence by sentence; for each one point to the file or test that satisfies it.
4. Run the exact commands the request mentions (CLI usage, examples) and compare the output character by character.
5. Only then reply: what changed, how it was verified (commands and results), anything not done and why.

## Checklist
- [ ] verify.py verdict: ready
- [ ] Every requirement mapped to code or a test
- [ ] Commands from the request run and match
- [ ] The reply states the verification evidence, not just "done"

## Pitfalls
- "Should work" without running anything.
- Running only the new test, not the suite.
- Leaving print statements, `.orig` files, caches or scratch files in the diff.
- Reporting success when a requirement was skipped: say so instead.
