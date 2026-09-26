---
name: systematic-debugging
internal: true
description: "Evidence-first debugging of failures, crashes, wrong results, hangs and flaky tests: reproduce, isolate, root cause, then fix with a regression test."
triggers:
  keywords: [bug, debug, crash, traceback, exception, panic, segfault, flaky, intermittent, hang, deadlock, regression, wrong result, fails, failing, broken, error]
  files: []
tools:
  - script: scripts/repro.py
    usage: "repro.py [-n N] -- CMD → runs CMD N times: failure rate (flaky?) and the distinct error signatures"
  - script: scripts/test_summary.py
    usage: "test_summary.py [-- CMD] → runs the tests, prints only failing tests and their asserts"
  - script: scripts/recent_changes.py
    usage: "recent_changes.py PATH | -S TEXT → recent local commits touching a file or text (did a change cause it?)"
checks:
  - "python3 -m pytest -q || python3 -m unittest discover -s tests"
---
# Systematic debugging

## When it applies
- Something fails, crashes, hangs or returns a wrong value and the cause is not obvious at a glance.
- A test is flaky, or behavior changed after an edit.

## Workflow
1. **Reproduce.** Find the smallest command that shows the problem. `python3 skills/systematic-debugging/scripts/repro.py -n 5 -- <cmd>`
   tells you if it is deterministic or flaky, and the exact error signature.
2. **Read the evidence.** The exception type, message and the deepest frame in project code. Search the code for the message.
3. **Hypothesize one cause at a time**, and test it with a cheap experiment (an assertion, a print, a narrower input).
   Write each hypothesis and its result into the todo list.
4. **Isolate.** Halve the input, disable half the pipeline, or check history: `recent_changes.py <file>`.
5. **Root cause, then fix** the cause, not the symptom. Add a regression test that failed before the fix.
6. **Verify.** `test_summary.py` for the suite; for flaky bugs `repro.py -n 20` must show 0 failures.
7. Remove temporary prints.

## Checklist
- [ ] Reliable reproduction (or a measured failure rate)
- [ ] Root cause stated with evidence, not a guess
- [ ] Fix at the cause; no try/except or sleep masking it
- [ ] Regression test added
- [ ] Full suite green; flaky fixes re-run many times
- [ ] Debug output removed

## Pitfalls
- Editing code before reproducing: you cannot tell if a change helped.
- Several changes at once: you do not know which one mattered.
- Catching the exception or raising a timeout instead of fixing the cause.
- One green run of a flaky test taken as proof.
- Trusting the issue's guess about the cause without checking.

## Research
- Search the exact error message (quoted) with `web_search`; prefer the library's issue tracker and official docs.
  Never look up this repository's own upstream fix.
