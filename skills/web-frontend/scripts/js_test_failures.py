#!/usr/bin/env python3
"""Summarize JS test output (jest, vitest, mocha, playwright, node:test/TAP)
down to the failing tests, their assertion lines and source locations.

Usage:
  js_test_failures.py -- npx --no-install vitest run   # run a command, then summarize
  js_test_failures.py test-output.txt                  # summarize a saved log
  npm test 2>&1 | js_test_failures.py                  # summarize stdin
Options:
  --max N      max failures to show (default 8)
  --timeout S  seconds before a run is killed (default 600)

Prints at most 40 lines: runner summary line(s), then per failing test the
name, the error/Expected/Received lines and the first project stack frame.
Exit 0 whenever the script itself worked, even if tests failed.
"""
import os
import re
import subprocess
import sys

MAX_LINES = 40
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")

STARTS = [
    re.compile(r"^\s*● (?!Console)(.+?)\s*$"),                         # jest
    re.compile(r"^\s*(?:FAIL|×|✗|❯)\s+(\S+\.(?:[cm]?[jt]sx?|vue|svelte)\s+>\s+.+?)\s*$"),  # vitest
    re.compile(r"^\s*\d+\) (\[\w+\] › .+?)(?:\s+─+)?\s*$"),            # playwright
    re.compile(r"^\s*\d+\) (.+?):?\s*$"),                             # mocha (after 'N failing')
    re.compile(r"^not ok \d+ - (.+)$"),                               # TAP / node:test
]
KEY = re.compile(
    r"(Error\b|Error:|expect\(|Expected|Received|expected|received|assert|toBe|toEqual|"
    r"toHaveBeenCalled|toMatch|Timeout|timed out|Cannot find module|is not a function|"
    r"undefined|TypeError|ReferenceError|SyntaxError|^\s*[-+] |^\s*>\s*\d+\s*\|)")
FRAME = re.compile(r"(?:\(|❯ |at )((?!node_modules)[\w./@-]+\.(?:[cm]?[jt]sx?|vue|svelte):\d+(?::\d+)?)")
SUMMARY = re.compile(r"^\s*(Tests?:|Test Files|Test Suites:|Tests\s+\d|\d+ (passing|failing|pending)|"
                     r"# (pass|fail|tests)|\d+ (passed|failed|flaky)\b|Ran all test suites)")


def read_input(argv, timeout):
    if "--" in argv:
        cmd = argv[argv.index("--") + 1:]
        env = dict(os.environ, CI="true", FORCE_COLOR="0", NO_COLOR="1")
        try:
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               env=env, timeout=timeout)
            return p.stdout.decode("utf-8", "replace"), p.returncode, " ".join(cmd)
        except subprocess.TimeoutExpired as e:
            text = (e.output or b"").decode("utf-8", "replace")
            return text + "\n[killed after %ss]" % timeout, 124, " ".join(cmd)
        except FileNotFoundError:
            return "", 127, "command not found: " + cmd[0]
    files = [a for a in argv if not a.startswith("--")]
    if files:
        with open(files[0], encoding="utf-8", errors="replace") as f:
            return f.read(), None, files[0]
    return sys.stdin.read(), None, "stdin"


def parse(text):
    lines = [ANSI.sub("", ln).rstrip() for ln in text.splitlines()]
    summary, fails, seen = [], [], set()
    mocha_mode = any(re.match(r"^\s*\d+ failing", ln) for ln in lines)
    for ln in lines:
        if SUMMARY.search(ln) and ln.strip() not in summary:
            summary.append(ln.strip())
    i = 0
    while i < len(lines):
        ln = lines[i]
        name = None
        for n, rx in enumerate(STARTS):
            if n == 3 and not mocha_mode:
                continue
            m = rx.match(ln)
            if m:
                name = m.group(1)
                break
        if name is None:
            i += 1
            continue
        body, j = [], i + 1
        while j < len(lines) and j < i + 80:
            if any((k != 3 or mocha_mode) and rx.match(lines[j]) for k, rx in enumerate(STARTS)):
                break
            body.append(lines[j])
            j += 1
        key = name.strip()
        if key in seen:
            i = j
            continue
        seen.add(key)
        detail, loc = [], None
        for b in body:
            s = b.strip()
            if not s:
                continue
            if loc is None:
                fm = FRAME.search(b)
                if fm:
                    loc = fm.group(1)
            if KEY.search(b) and s not in detail and not s.startswith("at "):
                detail.append(s[:160])
        if not detail:
            detail = [b.strip()[:160] for b in body if b.strip()][:2]
        fails.append((key, detail[:6], loc))
        i = j
    return summary, fails


def main():
    argv = sys.argv[1:]
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    max_fail = 8
    timeout = 600
    pre = argv[:argv.index("--")] if "--" in argv else argv
    if "--max" in pre:
        max_fail = int(pre[pre.index("--max") + 1])
    if "--timeout" in pre:
        timeout = int(pre[pre.index("--timeout") + 1])
    cleaned = []
    skip = False
    for a in pre:
        if skip:
            skip = False
            continue
        if a in ("--max", "--timeout"):
            skip = True
            continue
        cleaned.append(a)
    argv = cleaned + (argv[argv.index("--"):] if "--" in argv else [])
    text, rc, src = read_input(argv, timeout)
    summary, fails = parse(text)
    out = ["source: %s%s" % (src, "" if rc is None else "  (exit %d)" % rc)]
    out += ["summary: " + s for s in summary[-4:]]
    if not fails:
        out.append("no failing tests recognised")
        tail = [ANSI.sub("", ln).rstrip() for ln in text.splitlines() if ln.strip()][-12:]
        if rc not in (None, 0) and tail:
            out.append("last output lines:")
            out += ["  " + t[:160] for t in tail]
    else:
        out.append("FAILED: %d test(s)" % len(fails))
        for name, detail, loc in fails[:max_fail]:
            out.append("✗ %s%s" % (name[:150], "  @ " + loc if loc else ""))
            out += ["    " + d for d in detail]
        if len(fails) > max_fail:
            out.append("(+%d more failing tests; use --max)" % (len(fails) - max_fail))
    for line in out[:MAX_LINES]:
        print(line)
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
