#!/usr/bin/env python3
"""Check one step of the red → green cycle: run the tests and say whether the
state matches what you expect, listing failing tests (compact).

usage: red_green.py red|green [-- CMD ...]
  red   : you just wrote a test for new behavior; it MUST fail (for the right reason).
  green : you just wrote the code; everything MUST pass.
  CMD defaults to pytest (if importable) or unittest discover on tests/.
Output: at most 40 lines; exit 0 unless the arguments are wrong."""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if argv else 2
    want = argv[0]
    if want not in ("red", "green"):
        print("first argument must be red or green")
        return 2
    rest = argv[1:]
    out = subprocess.run([sys.executable, os.path.join(HERE, "test_summary.py")] + rest, capture_output=True, text=True).stdout
    lines = out.splitlines()
    failed = any(l.startswith(("FAILED", "TIMEOUT")) for l in lines[:3])
    if want == "red":
        verdict = "OK: RED as expected — check the failure is the missing behavior, not a typo/import error." if failed else "NOT RED: the new test passes already — it does not test the new behavior (or the behavior exists). Fix the test first."
    else:
        verdict = "OK: GREEN — refactor now if needed, then re-run green." if not failed else "NOT GREEN: still failing — fix the code (not the test) until it passes."
    print(verdict)
    for l in lines[:38]:
        print(l)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
