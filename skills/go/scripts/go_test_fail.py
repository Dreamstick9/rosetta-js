#!/usr/bin/env python3
"""Run `go test` (or read its saved text or -json output) and print only what
failed: failing (sub)tests with their t.Error lines, panics with the first
frame in project code, data races as one line per access, timeouts, build
failures, and the exact command to rerun one test.

usage:
  go_test_fail.py                     run `go test -json ./...` here
  go_test_fail.py -- -race ./pkg/...  extra args replace ./... (go test -json ARGS)
  go_test_fail.py FILE | -            parse saved `go test` text or -json output
options:
  --max N      max output lines (default 40)
"""
import argparse
import json
import re
import subprocess
import sys

FAIL = re.compile(r"^(\s*)--- FAIL: (\S+) \(([\d.]+s)\)")
PKG_FAIL = re.compile(r"^FAIL\s+(\S+)\s+(?:[\d.]+s|\[(build failed|setup failed)\]|\(cached\))")
PKG_OK = re.compile(r"^ok\s+(\S+)")
MSG = re.compile(r"^\s+(\S+\.go:\d+: .*)$")
FRAME_FN = re.compile(r"^(\S+?)\(.*\)$")
FRAME_LOC = re.compile(r"^\s+(\S+\.go):(\d+)")
BUILD = re.compile(r"^(\S+\.go):(\d+)(?::\d+)?: (.*)$")
RACE_ACC = re.compile(r"^(Read|Write|Previous read|Previous write|Atomic \w+)(?: of size \d+)? at \S+ by (goroutine \d+|main goroutine):")


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, errors="replace")
    return p.returncode, p.stdout.splitlines()


def json_to_text(lines):
    """Rebuild the plain text stream from `go test -json` events."""
    out, per_test = [], {}
    buf = ""
    for ln in lines:
        if not ln.startswith("{"):
            out.append(ln)
            continue
        try:
            ev = json.loads(ln)
        except ValueError:
            continue
        o = ev.get("Output")
        if o and ev.get("Test") and MSG.match(o.rstrip("\n")):
            per_test.setdefault(ev["Test"], []).append(o.strip())
        if o:
            buf += o
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                out.append(line)
    if buf:
        out.append(buf)
    return out, per_test


def module_path():
    try:
        m = re.search(r"^module\s+(\S+)", open("go.mod").read(), re.M)
        return m.group(1) if m else ""
    except OSError:
        return ""


def pkg_arg(pkg):
    mod = module_path()
    if mod and pkg == mod:
        return "."
    if mod and pkg.startswith(mod + "/"):
        return "./" + pkg[len(mod) + 1:]
    return pkg or "./..."


def short(path):
    parts = path.replace("\\", "/").split("/")
    return "/".join(parts[-2:]) if len(parts) > 2 else path


def project_frame(lines, i, gopaths=("/go/src/", "/libexec/src/", "/usr/local/go/", "/pkg/mod/")):
    """First stack frame after line i that is not runtime/testing/stdlib."""
    j = i
    while j + 1 < len(lines) and j - i < 80:
        fn = lines[j].strip()
        m = FRAME_LOC.match(lines[j + 1]) if j + 1 < len(lines) else None
        if m and FRAME_FN.match(fn):
            name = FRAME_FN.match(fn).group(1)
            if not name.startswith(("runtime.", "testing.", "panic(", "sync.", "reflect.")) and \
                    not any(g in m.group(1) for g in gopaths):
                return "%s at %s:%s" % (name.rsplit("/", 1)[-1], short(m.group(1)), m.group(2))
        if lines[j].startswith(("FAIL", "ok ", "exit status")):
            break
        j += 1
    return ""


def parse(lines):
    tests, order = {}, []
    pending = []   # failing tests whose package line has not been seen yet
    builds, races, other = [], [], []
    last = None
    i = 0
    while i < len(lines):
        ln = lines[i]
        m = FAIL.match(ln)
        if m:
            name = m.group(2)
            t = tests.setdefault(name, {"pkg": "", "msgs": [], "panic": "", "sub": bool(m.group(1))})
            if name not in order:
                order.append(name)
                pending.append(name)
            last = name
            i += 1
            while i < len(lines) and MSG.match(lines[i]):
                t["msgs"].append(MSG.match(lines[i]).group(1).strip())
                i += 1
            continue
        if ln.startswith("panic: "):
            where = project_frame(lines, i + 1)
            msg = re.sub(r"\s*\[recovered[^\]]*\]", "", ln[7:])
            if "test timed out" in ln:
                running = [lines[k].strip() for k in range(i + 1, min(i + 6, len(lines)))
                           if lines[k].startswith("\t") and "(" in lines[k]]
                other.append("TIMEOUT %s; running: %s" % (msg, ", ".join(running[:3]) or "?"))
            elif last:
                tests[last]["panic"] = "panic: %s%s" % (msg, (" -> " + where) if where else "")
            else:
                other.append("panic: %s%s" % (msg, (" -> " + where) if where else ""))
        if ln.startswith("WARNING: DATA RACE"):
            accs = []
            j = i + 1
            while j < len(lines) and not lines[j].startswith("=================="):
                a = RACE_ACC.match(lines[j])
                if a:
                    where = project_frame(lines, j + 1)
                    accs.append("%s by %s in %s" % (a.group(1).lower(), a.group(2), where or "?"))
                j += 1
            races.append("; ".join(accs[:2]))
            i = j
        m = PKG_FAIL.match(ln)
        if m:
            for n in pending:
                tests[n]["pkg"] = m.group(1)
            pending = []
            if m.group(2):
                builds.append("%s [%s]" % (m.group(1), m.group(2)))
        elif PKG_OK.match(ln):
            pending = []
        b = BUILD.match(ln)
        if b and not ln.startswith((" ", "\t")):
            builds.append("  %s:%s: %s" % (b.group(1), b.group(2), b.group(3)))
        i += 1
    return tests, order, builds, races, other


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
        pk = [x for x in extra if not x.startswith("-")]
        rc, lines = run(["go", "test", "-json"] + extra + ([] if pk else ["./..."]))
    per_test = {}
    if any(ln.startswith('{"Time"') or ln.startswith('{"Action"') for ln in lines[:50]):
        lines, per_test = json_to_text(lines)
    tests, order, builds, races, other = parse(lines)
    for n, msgs in per_test.items():
        if n in tests and not tests[n]["msgs"]:
            tests[n]["msgs"] = msgs
    out = []
    # a parent test fails when a subtest fails: show the leaves only
    leaves = [n for n in order if not any(o != n and o.startswith(n + "/") for o in order)]
    if builds:
        out.append("BUILD/VET FAILED (run `kit_run go go_errors.py` for details):")
        out += [b[:160] for b in builds[:6]]
    if leaves:
        out.append("FAILED %d test(s)" % len(leaves))
    for n in leaves:
        t = tests[n]
        out.append("FAIL %s%s" % (n, "  (" + t["pkg"] + ")" if t["pkg"] else ""))
        for msg in t["msgs"][:3]:
            out.append("   " + msg[:160])
        if len(t["msgs"]) > 3:
            out.append("   (+%d more lines)" % (len(t["msgs"]) - 3))
        if t["panic"]:
            out.append("   " + t["panic"][:200])
    for r in races[:4]:
        out.append("DATA RACE: " + r[:220])
    out += other[:4]
    if leaves:
        n = leaves[0]
        pkg = tests[n]["pkg"]
        rx = "/".join("^%s$" % re.escape(p).replace("\\#", "#") for p in n.split("/"))
        out.append("rerun one: go test %s -run '%s' -count=1 -v%s" % (
            pkg_arg(pkg), rx,
            " -race" if races else ""))
    if not out:
        if rc not in (None, 0):
            out.append("no failure parsed, exit %d; last lines:" % rc)
            out += ["  " + ln[:150] for ln in lines if ln.strip()][-10:]
        else:
            oks = sum(1 for ln in lines if PKG_OK.match(ln))
            out.append("PASS (%d package(s) ok)" % oks)
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
