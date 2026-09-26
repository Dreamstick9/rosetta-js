#!/usr/bin/env python3
"""Run Python tests (pytest, Django manage.py test, or unittest) and print only
the failures: test id, the assertion / exception lines (pytest `E` lines or
the traceback tail) and the failing source location.

Usage:
  pytest_failures.py [DIR]              # auto: pytest if installed, manage.py test for Django, else unittest
  pytest_failures.py -- CMD ...         # run CMD, e.g. -- python3 -m pytest tests/test_api.py -k create
  pytest_failures.py --log FILE         # summarize a saved log
Options: --max N (failures shown, default 8), --timeout S (default 900)
Exit 0 whenever the script itself worked.
"""
import os
import re
import subprocess
import sys

MAX_LINES = 40
PYTEST_SEC = re.compile(r"^_{3,} (?:ERROR at \w+ of )?(.+?) _{3,}$")
PYTEST_SUM = re.compile(r"^(FAILED|ERROR) (\S+(?:\.py|::)\S*)(?: - (.*))?$")
EXC = re.compile(r"^[A-Za-z_][\w.]*(Error|Exception|Failure|Exit|Interrupt|Warning)\b")
UNIT_HDR = re.compile(r"^(FAIL|ERROR): (\w+) \(([\w.]+)\)")
LOC = re.compile(r"^(?:\s*File \"([^\"]+)\", line (\d+)|([\w./\\-]+\.py):(\d+):)")
FINAL = re.compile(r"(=+ .*(passed|failed|error|no tests ran).* =+$|^Ran \d+ tests? in|^(OK|FAILED)\b.*|^\d+ (passed|failed))")


def default_cmd(root):
    py = sys.executable or "python3"
    has_pytest = subprocess.run([py, "-c", "import pytest"], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL).returncode == 0
    if os.path.exists(os.path.join(root, "manage.py")) and not os.path.exists(os.path.join(root, "pytest.ini")) \
            and not os.path.exists(os.path.join(root, "conftest.py")):
        return [py, "manage.py", "test", "--noinput"]
    if has_pytest:
        return [py, "-m", "pytest", "-q", "--tb=short", "-rfE", "-p", "no:cacheprovider"]
    d = "tests" if os.path.isdir(os.path.join(root, "tests")) else "."
    return [py, "-m", "unittest", "discover", "-s", d, "-t", "."]


def keep_loc(path):
    return path and "site-packages" not in path and "/lib/python" not in path and not path.startswith("<")


def parse(text):
    lines = text.splitlines()
    fails = {}   # id -> {"loc":..., "detail":[...]}
    order = []
    final = [ln.strip("= ").strip() for ln in lines if FINAL.search(ln.strip()) and not PYTEST_SUM.match(ln.strip())]

    def add(tid):
        if tid not in fails:
            fails[tid] = {"loc": None, "detail": []}
            order.append(tid)
        return fails[tid]

    i = 0
    while i < len(lines):
        ln = lines[i]
        m = PYTEST_SEC.match(ln)
        u = UNIT_HDR.match(ln)
        if m and "test session starts" not in ln and "short test summary" not in ln:
            rec = add(m.group(1))
            j = i + 1
            while j < len(lines) and not PYTEST_SEC.match(lines[j]) and not lines[j].startswith("====="):
                s = lines[j]
                if s.startswith("E ") and len(rec["detail"]) < 5:
                    t = s[1:].strip()
                    if t and t not in rec["detail"]:
                        rec["detail"].append(t[:160])
                lm = LOC.match(s)
                if lm:
                    p, n = (lm.group(1), lm.group(2)) if lm.group(1) else (lm.group(3), lm.group(4))
                    if keep_loc(p):
                        rec["loc"] = "%s:%s" % (p, n)
                j += 1
            i = j
            continue
        if u:
            rec = add("%s.%s" % (u.group(3), u.group(2)) if not u.group(3).endswith(u.group(2)) else u.group(3))
            j = i + 1
            tb = []
            while j < len(lines) and not UNIT_HDR.match(lines[j]) and not lines[j].startswith("=" * 20) \
                    and not lines[j].startswith("Ran "):
                tb.append(lines[j])
                j += 1
            for s in tb:
                lm = LOC.match(s)
                if lm and keep_loc(lm.group(1) or lm.group(3)):
                    rec["loc"] = "%s:%s" % ((lm.group(1), lm.group(2)) if lm.group(1) else (lm.group(3), lm.group(4)))
            exc = [k for k, t in enumerate(tb) if EXC.match(t)]
            if exc:
                rest = [t.strip() for t in tb[exc[-1]:] if t.strip() and not re.match(r"^-{10,}$", t.strip())]
                rec["detail"] = [t[:160] for t in rest[:4]]
            else:
                rec["detail"] = [t.strip()[:160] for t in tb if t.strip() and not t.startswith(" ")][-3:]
            i = j
            continue
        i += 1
    # pytest short summary lines give ids + one-line reasons (and catch collection errors)
    for ln in lines:
        m = PYTEST_SUM.match(ln.strip())
        if m:
            tid = m.group(2)
            short = tid.split("::")[-1]
            match = next((k for k in order if k == short or k.endswith(short) or short.endswith(k.replace(".", "::"))), None)
            rec = fails.pop(match) if match else {"loc": None, "detail": []}
            if match:
                order[order.index(match)] = tid
            else:
                order.append(tid)
            if m.group(3) and not rec["detail"]:
                rec["detail"].append(m.group(3)[:160])
            fails[tid] = rec
    return final, order, fails


def test_file(tid):
    return tid.split("::")[0] if "::" in tid else tid.rsplit(".", 1)[0]


def spread(order, mx):
    groups = {}
    for tid in order:
        groups.setdefault(test_file(tid), []).append(tid)
    picked = []
    while len(picked) < min(mx, len(order)):
        for tids in groups.values():
            if tids and len(picked) < mx:
                picked.append(tids.pop(0))
    return [tid for tid in order if tid in picked]


def main():
    argv = sys.argv[1:]
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    cmd = None
    if "--" in argv:
        cmd = argv[argv.index("--") + 1:]
        argv = argv[:argv.index("--")]
    mx, timeout, log = 8, 900, None
    for opt in ("--max", "--timeout", "--log"):
        if opt in argv:
            i = argv.index(opt)
            val = argv[i + 1]
            del argv[i:i + 2]
            if opt == "--max":
                mx = int(val)
            elif opt == "--timeout":
                timeout = int(val)
            else:
                log = val
    root = argv[0] if argv else "."
    rc = None
    if log:
        text = open(log, encoding="utf-8", errors="replace").read()
        head = log
    else:
        cmd = cmd or default_cmd(root)
        try:
            p = subprocess.run(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
                               env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1"))
            text, rc = p.stdout.decode("utf-8", "replace"), p.returncode
        except FileNotFoundError:
            print("cannot run %s: not found" % cmd[0])
            return 0
        except subprocess.TimeoutExpired:
            print("TIMEOUT after %ss: %s" % (timeout, " ".join(cmd)))
            return 0
        head = "$ " + " ".join(cmd)
    final, order, fails = parse(text)
    real = os.path.realpath(root) + os.sep
    for rec in fails.values():
        loc = rec["loc"]
        if loc and os.path.isabs(loc) and os.path.realpath(loc.rsplit(":", 1)[0]).startswith(real):
            rec["loc"] = os.path.relpath(os.path.realpath(loc.rsplit(":", 1)[0]), real) + ":" + loc.rsplit(":", 1)[1]
    out = [head + ("" if rc is None else "  (exit %d)" % rc)]
    if final:
        out.append("result: " + " | ".join(final[-2:]))
    if not order:
        if rc not in (None, 0) or not final:
            out.append("no failures parsed; last lines:")
            out += ["  " + x[:160] for x in [x for x in text.splitlines() if x.strip()][-12:]]
        else:
            out.append("PASS")
    else:
        out.append("%d failing" % len(order))
        counts = {}
        for tid in order:
            counts[test_file(tid)] = counts.get(test_file(tid), 0) + 1
        if len(counts) > 1:
            out.append("by file: " + ", ".join("%s %d" % item for item in sorted(counts.items(), key=lambda kv: -kv[1])))
        depth = 5 if len(order) <= 3 else 3
        for tid in spread(order, mx):
            rec = fails[tid]
            out.append("✗ %s%s" % (tid[:140], "  @ " + rec["loc"] if rec["loc"] else ""))
            out += ["    " + d for d in rec["detail"][:depth]]
        if len(order) > mx:
            out.append("(+%d more failing)" % (len(order) - mx))
    print("\n".join(out[:MAX_LINES]))
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
