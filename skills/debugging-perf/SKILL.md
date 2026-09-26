---
name: debugging-perf
internal: true
description: "Hard bugs and performance problems: flaky or failing tests, crashes, wrong results, hangs, memory growth and slow code, found with evidence rather than guesses."
triggers:
  keywords: [bug, debug, crash, error, exception, traceback, panic, segfault, flaky, intermittent, hang, deadlock, slow, performance, optimize, speed up, memory leak, profile, timeout, regression, race condition]
  files: []
tools: []
checks:
  - "for i in $(seq 20); do python3 -m pytest -q -x tests/test_x.py >/dev/null 2>&1 || echo fail; done | wc -l"
  - "python3 -m cProfile -s cumtime script.py 2>&1 | head -25"
---
# Debugging and performance

## When it applies
- Something fails, crashes, hangs, returns wrong results, or is too slow or memory-hungry, and the cause is not obvious.
- A test is flaky or a regression appeared after a change.

## Workflow
- Reproduce first and make it fast: the smallest command or test that shows the problem. If it is flaky, loop it (`for i in $(seq 20); do ...; done`) and count failures.
- Read the full error: exception type, message, the deepest frame in project code. Search the codebase for the message text.
- Form one hypothesis at a time and test it with evidence (a print, an assertion, a narrower input). Record hypotheses and results in the todo list for long hunts.
- Bisect the input or the code: halve the failing input, comment out halves of a pipeline, or use `git log -p` and `git bisect` on local history (never fetch newer history).
- Fix the root cause, then add a regression test that failed before the fix.
- Hangs: add timeouts to the reproduction; look for blocking IO, locks taken in different orders, waiting on a queue or channel that nothing writes, or infinite retry loops.
- Flaky tests: look for shared global state, test order dependence, real time or randomness, unordered collections, and leftover files between tests.
- Performance: measure before changing anything. Profile to find the hot spot, fix the algorithm or data structure there (quadratic loops, repeated IO or parsing, missing caching, N+1 queries), then measure again and report before/after numbers.
- Memory: look for caches without bounds, lists that only grow, references kept in globals or closures.
- Remove temporary debug output before finishing.

## Checklist
- [ ] Reliable, fast reproduction
- [ ] Root cause identified with evidence (not a guess)
- [ ] Fix at the root; no masking with try/except or sleeps
- [ ] Regression test added
- [ ] For performance: before/after measurements reported
- [ ] Debug prints and temporary files removed
- [ ] Full test suite passes

## Verify
```bash
# repeat a flaky test to measure the failure rate
for i in $(seq 20); do python3 -m pytest -q -x tests/test_x.py >/dev/null 2>&1 || echo fail; done | wc -l
# Python profile, top functions by cumulative time
python3 -m cProfile -s cumtime script.py 2>&1 | head -25
# time a command
/usr/bin/time -p python3 script.py
# Python hang: dump stacks after 10 s
python3 -X faulthandler -c "import faulthandler,sys; faulthandler.dump_traceback_later(10); exec(open(sys.argv[1]).read())" script.py
# history of a function (local history only)
git log -L :function_name:path/to/file.py | head -60
```

## Useful tools
- `python3 -m pdb`, `python3 -X faulthandler`, `tracemalloc` for Python
- `node --inspect` (not interactive here) or `console.time` for JS
- `go test -race`, `go test -cpuprofile` for Go
- `RUST_BACKTRACE=1`, `cargo test -- --nocapture` for Rust
- `git bisect run <test command>` on local commits

## Pitfalls
- Changing code before reproducing, then being unable to tell whether it helped.
- Treating the symptom (catching the exception, adding a sleep, bumping a timeout).
- Optimizing code that is not the hot spot.
- Declaring a flaky test fixed after one green run.
- Leaving print statements or profiling code in the diff.
- Assuming the newest change caused it without checking history.
