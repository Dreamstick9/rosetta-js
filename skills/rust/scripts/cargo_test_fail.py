#!/usr/bin/env python3
"""Run `cargo test` (or read its saved output) and print only the failures:
test name, panic location and message, assert left/right, and the exact
command to rerun one test.

usage:
  cargo_test_fail.py                    run `cargo test --no-fail-fast` here
  cargo_test_fail.py -- -p mycrate foo  extra args go to cargo test
  cargo_test_fail.py FILE | -           parse saved `cargo test` output
options:
  --max N      max output lines (default 40)
"""
import argparse
import re
import subprocess
import sys

RUNNING = re.compile(r"^\s*Running (?:unittests )?(\S+)")
DOCTESTS = re.compile(r"^\s*Doc-tests (\S+)")
BLOCK = re.compile(r"^---- (.+?) stdout ----$")
RESULT = re.compile(r"^test result: (\w+)\. (\d+) passed; (\d+) failed")
FAILED_LINE = re.compile(r"^test (\S+) \.\.\. FAILED")
RERUN = re.compile(r"to rerun pass `([^`]+)`")
PANIC_NEW = re.compile(r"panicked at (\S+?:\d+:\d+):\s*$")
PANIC_OLD = re.compile(r"panicked at '(.*)', (\S+?:\d+:\d+)")
PANIC_MID = re.compile(r"panicked at (\S+?:\d+:\d+):\s*(.+)$")
LR = re.compile(r"^\s*(left|right)(?: val)?\s*[:=]\s*(.*)$")
SLOW = re.compile(r"^test (\S+) has been running for over")


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, errors="replace")
    return p.returncode, p.stdout.splitlines()


def parse(lines):
    fails, order, target = {}, [], ""
    totals = [0, 0]
    compile_err = []
    slow = []
    pending = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        m = RUNNING.match(ln) or DOCTESTS.match(ln)
        if m:
            target = m.group(1)
        m = FAILED_LINE.match(ln)
        if m and m.group(1) not in fails:
            fails[m.group(1)] = {"target": target, "where": "", "msg": [], "rerun": ""}
            order.append(m.group(1))
            pending.append(m.group(1))
        m = SLOW.match(ln)
        if m:
            slow.append(m.group(1))
        m = RESULT.match(ln)
        if m:
            totals[0] += int(m.group(2))
            totals[1] += int(m.group(3))
        m = RERUN.search(ln)
        if m:
            for n in pending:
                fails[n]["rerun"] = m.group(1)
            pending = []
        if re.match(r"^error(\[E\d+\])?: ", ln) and "test failed" not in ln and \
                "could not compile" not in ln:
            compile_err.append(ln.strip())
        m = BLOCK.match(ln)
        if m:
            name = m.group(1)
            f = fails.setdefault(name, {"target": target, "where": "", "msg": [], "rerun": ""})
            if name not in order:
                order.append(name)
            i += 1
            while i < len(lines) and not BLOCK.match(lines[i]) and \
                    lines[i].strip() not in ("failures:", "successes:"):
                b = lines[i]
                if "panicked at '" in b and not PANIC_OLD.search(b):
                    # old multi-line form: panicked at 'msg...\n ...', src/x.rs:1:2
                    j = i
                    while j + 1 < len(lines) and j - i < 12 and \
                            not re.search(r"',\s*\S+:\d+:\d+", lines[j]):
                        j += 1
                    b = " ".join(x.strip() for x in lines[i:j + 1])
                    i = j
                p = PANIC_OLD.search(b)
                if p:
                    f["where"] = p.group(2)
                    f["msg"].append(p.group(1))
                elif PANIC_MID.search(b):
                    p = PANIC_MID.search(b)
                    f["where"] = p.group(1)
                    f["msg"].append(p.group(2))
                elif PANIC_NEW.search(b):
                    f["where"] = PANIC_NEW.search(b).group(1)
                    if i + 1 < len(lines):
                        i += 1
                        f["msg"].append(lines[i].strip())
                elif LR.match(b):
                    f["msg"].append(b.strip())
                elif b.strip() and not b.startswith("note: run with") and not f["where"]:
                    f["msg"].append("out: " + b.strip())
                i += 1
            continue
        i += 1
    return fails, order, totals, compile_err, slow


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    extra = []
    if "--" in argv:
        k = argv.index("--")
        argv, extra = argv[:k], argv[k + 1:]
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("file", nargs="?")
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    rc = None
    if a.file:
        src = sys.stdin if a.file == "-" else open(a.file, errors="replace")
        lines = src.read().splitlines()
    else:
        rc, lines = run(["cargo", "test", "--no-fail-fast"] + extra)
    fails, order, totals, compile_err, slow = parse(lines)
    out = []
    if compile_err and not order:
        out.append("tests did not compile (%d error line(s)); run `kit_run rust cargo_errors.py`"
                   % len(compile_err))
        out += ["  " + e[:150] for e in compile_err[:5]]
    elif not order:
        if rc not in (None, 0):
            out.append("no failing test parsed, exit %d; last lines:" % rc)
            out += ["  " + ln[:150] for ln in lines if ln.strip()][-10:]
        else:
            out.append("PASS: %d passed, 0 failed" % totals[0])
    else:
        out.append("FAILED %d test(s); %d passed" % (len(order), totals[0]))
        for n in order:
            f = fails[n]
            tgt = " [%s]" % f["rerun"] if f["rerun"] else ""
            out.append("FAIL %s%s" % (n, tgt))
            if f["where"]:
                out.append("   at %s" % f["where"])
            msgs = f["msg"][:4]
            lr = [m for m in msgs if LR.match(m)]
            other = [m for m in msgs if not LR.match(m)]
            for m in other[:2]:
                out.append("   " + m[:160])
            if lr:
                out.append("   " + " | ".join(x[:70] for x in lr))
        first = order[0]
        tgt = fails[first]["rerun"] + " " if fails[first]["rerun"] else ""
        name = first.split(" - ")[0] if " - " in first else first
        out.append("rerun one: cargo test %s%s -- --exact --nocapture" % (tgt, name))
    for s in slow[:3]:
        out.append("SLOW (>60s, maybe hung): %s" % s)
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
