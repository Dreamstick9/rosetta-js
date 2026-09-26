#!/usr/bin/env python3
"""Run a test command and print only what failed: test names and their assert
lines (unittest, pytest, jest/vitest, go test, cargo test, node --test).

usage: test_summary.py [--timeout S] [-- CMD ...]
  Without CMD: SDL_VIDEODRIVER=dummy python3 -m unittest discover -s tests (or pytest -q if present).
  Output: at most 40 lines ("PASS …" or the failures), exit 0 unless the arguments are wrong."""
import os
import re
import shutil
import subprocess
import sys

MAX = 40


def default_cmd():
    if os.path.isdir("tests") or os.path.isdir("test"):
        d = "tests" if os.path.isdir("tests") else "test"
        if shutil.which("pytest") or _has_module("pytest"):
            return [sys.executable, "-m", "pytest", "-q", "-x", "--no-header", "-rN"]
        return [sys.executable, "-m", "unittest", "discover", "-s", d]
    if os.path.exists("package.json"):
        return ["npm", "test", "--silent"]
    if os.path.exists("go.mod"):
        return ["go", "test", "./..."]
    if os.path.exists("Cargo.toml"):
        return ["cargo", "test", "--offline", "-q"]
    return [sys.executable, "-m", "unittest", "discover"]


def _has_module(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


PATTERNS = [
    # unittest / pytest headers
    (re.compile(r"^(FAIL|ERROR): (\S+) \((.+)\)"), lambda m: f"{m[1]} {m[3]}.{m[2]}"),
    (re.compile(r"^_{3,} (\S.*?) _{3,}$"), lambda m: f"FAIL {m[1]}"),
    (re.compile(r"^(FAILED|ERROR) (\S+)"), lambda m: f"{m[1]} {m[2]}"),
    # go, cargo, jest, node --test
    (re.compile(r"^--- FAIL: (\S+)"), lambda m: f"FAIL {m[1]}"),
    (re.compile(r"^test (\S+) \.\.\. FAILED"), lambda m: f"FAIL {m[1]}"),
    (re.compile(r"^\s*● (.+)$"), lambda m: f"FAIL {m[1]}"),
    (re.compile(r"^not ok \d+ - (.+)"), lambda m: f"FAIL {m[1]}"),
]
DETAIL = re.compile(
    r"(AssertionError|assert |Error:|Exception|expected|Expected|Received|panicked at|left:|right:|!=|==|Traceback|File \".*\", line \d+|\.py:\d+|_test\.go:\d+)"
)


def summarize(out, code):
    lines = out.splitlines()
    keep, seen = [], set()
    for i, line in enumerate(lines):
        for pat, fmt in PATTERNS:
            m = pat.match(line)
            if m:
                head = fmt(m)
                if head in seen:
                    break
                seen.add(head)
                keep.append(head)
                # the next few informative lines of this failure
                details = 0
                for nxt in lines[i + 1 : i + 30]:
                    if any(p.match(nxt) for p, _ in PATTERNS):
                        break
                    s = nxt.strip()
                    if s and DETAIL.search(s) and "site-packages" not in s and details < 4:
                        keep.append("    " + s[:160])
                        details += 1
                break
    tail = [l for l in lines[-6:] if l.strip()]
    summary = next((l.strip() for l in reversed(lines) if re.search(r"(Ran \d+ test|passed|failed|FAILED|OK\b|ok\s|test result:)", l)), "")
    if code == 0 and not keep:
        return [f"PASS (exit 0) {summary}".rstrip()]
    if not keep:
        keep = ["no recognizable failure headers; last lines:"] + ["    " + l[:160] for l in tail]
    keep.insert(0, f"FAILED (exit {code}) {summary}".rstrip())
    return keep


def main(argv):
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    timeout = 600
    if len(argv) >= 2 and argv[0] == "--timeout":
        timeout = int(argv[1])
        argv = argv[2:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    cmd = argv or default_cmd()
    env = dict(os.environ, SDL_VIDEODRIVER="dummy", SDL_AUDIODRIVER="dummy", CI="1", NO_COLOR="1")
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        out, code = p.stdout + "\n" + p.stderr, p.returncode
    except FileNotFoundError:
        print(f"cannot run {cmd[0]}: not found")
        return 0
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT after {timeout}s: {' '.join(cmd)}")
        return 0
    lines = summarize(out, code)
    print("$ " + " ".join(cmd))
    for l in lines[: MAX - 2]:
        print(l)
    if len(lines) > MAX - 2:
        print(f"(+{len(lines) - (MAX - 2)} more)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
