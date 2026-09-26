---
name: tdd
internal: true
description: "Test-driven changes: write a failing test first, make it pass with the smallest change, then refactor. For new behavior and bug fixes."
triggers:
  keywords: [tdd, test-driven, test first, failing test, red green, regression test, write tests, add tests, unit test, add a test]
  files: []
tools:
  - script: scripts/red_green.py
    usage: "red_green.py red|green [-- CMD] → runs the tests and says whether the state is the expected RED or GREEN, with the failing asserts"
  - script: scripts/test_summary.py
    usage: "test_summary.py [-- CMD] → runs the tests, prints only failing tests and their asserts"
checks:
  - "python3 -m pytest -q || python3 -m unittest discover -s tests"
---
# Test-driven development

## When it applies
- New behavior with a clear expected outcome, or a bug with a reproduction.
- The request asks for tests, or the repo has a test suite that should cover the change.

## Workflow
1. **Baseline.** `python3 skills/tdd/scripts/test_summary.py` — know what already fails before you touch anything.
2. **Red.** Write ONE small test for the next piece of behavior, next to the existing tests, named after the behavior.
   `python3 skills/tdd/scripts/red_green.py red` must say RED, and the failure must be the missing behavior (an assert), not an
   import error or typo.
3. **Green.** Write the smallest code that makes it pass. No extra features. `python3 skills/tdd/scripts/red_green.py green`.
4. **Refactor.** Clean up names and duplication in code and test while staying green; re-run green.
5. Repeat for the next behavior (edge cases: empty input, boundaries, errors). Keep a todo item per behavior.
6. Finish with the whole suite green.

For a bug: the first test reproduces the report exactly (the input from the issue, the expected output from the issue).

## Checklist
- [ ] Baseline run recorded
- [ ] Each new test was seen failing for the right reason before the fix
- [ ] Minimal code to pass; no untested extras
- [ ] Edge cases covered (empty, boundary, error path)
- [ ] Whole suite green at the end
- [ ] Tests assert behavior, not implementation details

## Pitfalls
- Writing the code first and the test after: the test may never have been able to fail.
- A test that fails for the wrong reason (typo, wrong import) counted as RED.
- Changing the test to match buggy code instead of fixing the code.
- Huge tests covering many behaviors: a failure then says little.
- Mocking the thing under test.
- Leaving the suite red elsewhere and declaring done.

## Research
- Test runner docs for the project's runner (docs.pytest.org, docs.python.org/3/library/unittest.html, jestjs.io,
  pkg.go.dev/testing, doc.rust-lang.org/book/ch11-00-testing.html) via `web_fetch` with a `prompt`.
