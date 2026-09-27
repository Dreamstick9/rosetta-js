#!/usr/bin/env python3
"""Run a command N times and report how often it fails and the distinct error
signatures (last informative line of each failure). Finds flaky behavior fast.

usage: repro.py [-n N] [--timeout S] -- CMD ...
Output: at most 40 lines; exit 0 unless the arguments are wrong."""
import re
import subprocess
import sys


def signature(text):
    for line in reversed(text.splitlines()):
        s = line.strip()
        if s and re.search(r"(Error|Exception|FAIL|panic|assert|Traceback|error:|not ok)", s):
            return re.sub(r"0x[0-9a-f]+|\d{3,}", "#", s)[:160]
    tail = [l.strip() for l in text.splitlines() if l.strip()]
    return (tail[-1][:160] if tail else "(no output)")


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if argv else 2
    n, timeout = 5, 120
    while argv and argv[0] != "--":
        if argv[0] == "-n":
            n = int(argv[1]); argv = argv[2:]
        elif argv[0] == "--timeout":
            timeout = int(argv[1]); argv = argv[2:]
        else:
            print(f"unknown option {argv[0]}"); return 2
    cmd = argv[1:]
    if not cmd:
        print("missing CMD after --"); return 2
    fails, sigs = 0, {}
    for _ in range(n):
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            code, text = p.returncode, p.stdout + "\n" + p.stderr
        except subprocess.TimeoutExpired:
            code, text = -1, f"TIMEOUT after {timeout}s"
        if code != 0:
            fails += 1
            s = signature(text)
            sigs[s] = sigs.get(s, 0) + 1
    kind = "always fails" if fails == n else "never fails" if fails == 0 else "FLAKY"
    print(f"{' '.join(cmd)}: {fails}/{n} runs failed ({kind})")
    for s, c in sorted(sigs.items(), key=lambda kv: -kv[1])[:30]:
        print(f"  ×{c} {s}")
    if 0 < fails < n:
        print("hint: look for shared state, ordering, time, randomness or leftover files between runs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
