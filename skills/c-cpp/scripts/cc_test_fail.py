#!/usr/bin/env python3
"""Run C/C++ tests (or read saved output) and print only the failures:
ctest test names and crash kinds, GoogleTest / Catch2 / doctest / Unity
assertions with file:line and expected/actual, automake FAIL lines, and
assert() aborts, plus the exact command to rerun one test.

usage:
  cc_test_fail.py                  run ctest (build/ or build*/) or make test/check
  cc_test_fail.py -- CMD ...       run this test command instead
  cc_test_fail.py FILE | -         parse saved test output
options:
  --max N      max output lines (default 40)
"""
import argparse
import glob
import os
import re
import subprocess
import sys

CTEST = re.compile(r"^\s*\d+/\d+ Test\s+#\d+: (\S+) \.+\s*\**\s*(Failed|Exception: .+?|Timeout|Not Run|Passed)\b")
CTEST_LIST = re.compile(r"^\s+\d+ - (\S+) \((.+)\)$")
GT_RUN = re.compile(r"^\[ RUN      \] (\S+)")
GT_FAIL = re.compile(r"^\[  FAILED  \] (\S+) \(")
GT_WHERE = re.compile(r"^(\S+?):(\d+): (Failure|error)")
CATCH_FAIL = re.compile(r"^(\S+?):(\d+): FAILED:")
DOCTEST = re.compile(r"^(\S+?):(\d+): ERROR: (.+)$")
DOCTEST_CASE = re.compile(r"^TEST CASE:\s+(.+)$")
UNITY = re.compile(r"^(\S+?):(\d+):(\w+):FAIL:?\s*(.*)$")
AUTOMAKE = re.compile(r"^(FAIL|ERROR|XPASS): (\S+)")
ASSERT = re.compile(r"(Assertion [`'](.+)' failed\.|Assertion failed: .+)")
CRASH = re.compile(r"(Segmentation fault|Aborted|core dumped|SIGSEGV|SIGABRT|Illegal instruction)")


def default_cmd():
    for d in ["build"] + sorted(glob.glob("build*")) + sorted(glob.glob("cmake-build-*")):
        if os.path.exists(os.path.join(d, "CTestTestfile.cmake")):
            return ["ctest", "--test-dir", d, "--output-on-failure"], d
    for mk in ("GNUmakefile", "Makefile", "makefile"):
        if os.path.exists(mk):
            txt = open(mk, errors="replace").read()
            for t in ("check", "test"):
                if re.search(r"^%s\s*:" % t, txt, re.M):
                    return ["make", t], None
    return None, None


def parse(lines):
    fails = []          # dicts: name, kind, detail[]
    by = {}
    ctest_cur = None

    def add(name, kind="", group=""):
        if name not in by:
            by[name] = {"name": name, "kind": kind, "detail": [], "group": group}
            fails.append(by[name])
        elif kind and not by[name]["kind"]:
            by[name]["kind"] = kind
        return by[name]

    gt_cur, catch_case, doc_case = None, None, None
    i = 0
    while i < len(lines):
        ln = lines[i].rstrip()
        m = CTEST.match(ln)
        if m:
            ctest_cur = m.group(1)
            if m.group(2) != "Passed":
                add(ctest_cur, m.group(2), "ctest")
            i += 1
            continue
        m = CTEST_LIST.match(ln)
        if m:
            add(m.group(1), m.group(2), "ctest")
        m = GT_RUN.match(ln)
        if m:
            gt_cur = m.group(1)
        m = GT_WHERE.match(ln)
        if m and gt_cur:
            f = add(gt_cur, "gtest", ctest_cur or "")
            block = [ln.strip()]
            j = i + 1
            while j < len(lines) and len(block) < 6 and not lines[j].startswith("[") and \
                    not GT_WHERE.match(lines[j]):
                if lines[j].strip():
                    block.append(lines[j].strip())
                j += 1
            f["detail"].append("%s:%s: %s" % (os.path.basename(m.group(1)), m.group(2),
                                              " | ".join(block[1:])[:200]))
            i = j
            continue
        if GT_FAIL.match(ln):
            add(GT_FAIL.match(ln).group(1), "gtest", ctest_cur or "")
        if re.match(r"^-{20,}$", ln) and i + 2 < len(lines) and lines[i + 1].strip() and \
                re.match(r"^-{20,}$", lines[i + 2]):
            catch_case = lines[i + 1].strip()
        m = CATCH_FAIL.match(ln)
        if m:
            f = add(catch_case or "catch2 case", "catch2", ctest_cur or "")
            block = []
            j = i + 1
            while j < len(lines) and len(block) < 5 and not re.match(r"^[-=.]{20,}", lines[j]):
                t = lines[j].strip()
                if t and t != "with expansion:":
                    block.append(t)
                j += 1
            f["detail"].append("%s:%s: %s" % (os.path.basename(m.group(1)), m.group(2), " => ".join(block)[:200]))
            i = j
            continue
        m = DOCTEST_CASE.match(ln)
        if m:
            doc_case = m.group(1).strip()
        m = DOCTEST.match(ln)
        if m:
            f = add(doc_case or "doctest case", "doctest", ctest_cur or "")
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            f["detail"].append("%s:%s: %s %s" % (os.path.basename(m.group(1)), m.group(2), m.group(3), nxt)[:200])
        m = UNITY.match(ln)
        if m:
            f = add(m.group(3), "unity", ctest_cur or "")
            f["detail"].append("%s:%s: %s" % (os.path.basename(m.group(1)), m.group(2), m.group(4)[:160]))
        m = AUTOMAKE.match(ln)
        if m:
            add(m.group(2), m.group(1), "automake")
        m = ASSERT.search(ln)
        if m:
            f = add(ctest_cur or "program", "assert", "")
            f["detail"].append(ln.strip()[:200])
        elif CRASH.search(ln) and ctest_cur:
            f = add(ctest_cur, "crash", "ctest")
            if not f["detail"]:
                f["detail"].append(ln.strip()[:160])
        i += 1
    return fails


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
    rc, bdir = None, None
    if a.file:
        src = sys.stdin if a.file == "-" else open(a.file, errors="replace")
        lines = src.read().splitlines()
        m = re.search(r"^Test project (\S+)", "\n".join(lines[:5]), re.M)
        bdir = m.group(1) if m else None
    else:
        cmd, bdir = (extra, None) if extra else default_cmd()
        if not cmd:
            print("no ctest build dir or make test/check target; build first (cc_build_detect.py) or pass -- CMD")
            return 0
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, errors="replace")
        rc, lines = p.returncode, p.stdout.splitlines()
    fails = parse(lines)
    summary = [ln.strip() for ln in lines if re.search(r"tests passed, \d+ tests? failed|^# (PASS|FAIL):|"
                                                         r"^test cases: |^\[  PASSED  \]", ln.strip())]
    out = []
    # drop ctest-level entries whose inner (gtest/catch2) failures are listed
    inner_groups = {f["group"] for f in fails if f["kind"] not in ("", "ctest") and f["group"]}
    shown = [f for f in fails if not (f["group"] == "ctest" and f["name"] in inner_groups and not f["detail"])]
    if not shown:
        if rc not in (None, 0):
            out.append("no failure parsed, exit %d; last lines:" % rc)
            out += ["  " + ln[:160] for ln in lines if ln.strip()][-10:]
        else:
            out.append("PASS" + (": " + summary[-1] if summary else ""))
    else:
        out.append("FAILED %d%s" % (len(shown), (" (" + summary[-1] + ")") if summary else ""))
        for f in shown:
            where = " [in %s]" % f["group"] if f["group"] and f["group"] not in ("ctest", "automake") else ""
            out.append("FAIL %s (%s)%s" % (f["name"], f["kind"] or "failed", where))
            for d in f["detail"][:3]:
                out.append("   " + d)
        f = shown[0]
        bd = bdir or "build"
        if f["kind"] == "gtest":
            exe = f["group"] or "TEST_BINARY"
            out.append("rerun one: %s/%s --gtest_filter='%s'   (or ctest --test-dir %s -R '^%s$' --output-on-failure)"
                       % (bd, exe, f["name"], bd, exe))
        elif f["kind"] == "catch2":
            out.append("rerun one: %s/%s \"%s\"" % (bd, f["group"] or "TEST_BINARY", f["name"]))
        elif f["kind"] in ("unity", "assert", "doctest"):
            out.append("rerun: rebuild, then run the test binary directly (doctest: -tc=\"name\")")
        elif f["group"] == "automake":
            out.append("details: cat %s.log (or test-suite.log); rerun: make check TESTS=%s" % (f["name"], f["name"]))
        else:
            out.append("rerun one: ctest --test-dir %s -R '^%s$' --output-on-failure" % (bd, f["name"]))
        if any(f["kind"] in ("crash", "assert") or "SegFault" in f["kind"] or "Exception" in f["kind"] for f in shown):
            out.append("crash: rebuild with -fsanitize=address,undefined and use san_summary.py --run")
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
