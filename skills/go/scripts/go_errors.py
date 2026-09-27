#!/usr/bin/env python3
"""Collapse `go build` / `go vet` / gopls-style errors: first error per file
with its source line and a one-line fix hint, later ones as one line each.

usage:
  go_errors.py                     go build ./...; if clean, go vet ./... (tests included)
  go_errors.py -- ./internal/...   package patterns for build and vet
  go_errors.py --run "CMD"         run any command and parse its output
  go_errors.py FILE | -            parse saved output
options:
  --max N      max output lines (default 40)
"""
import argparse
import os
import re
import subprocess
import sys

ERR = re.compile(r"^(?:vet: )?(\.?/?\S+?\.go):(\d+)(?::(\d+))?: (.*)$")
HINTS = [
    ("imported and not used", "remove the import (or use it); goimports-style grouping"),
    ("declared and not used", "use the variable or delete it; `_ = x` only if truly intended"),
    ("undefined: ", "typo, unexported name from another package, missing import, or defined in a file excluded by //go:build tags"),
    ("cannot use ", "convert explicitly (T(x)), take the address (&x) or dereference (*p); check pointer vs value types"),
    ("missing return", "every path of a function with results must return"),
    ("not enough arguments", "match the signature; update every call site after a signature change"),
    ("too many arguments", "match the signature; update every call site after a signature change"),
    ("pointer receiver", "method is on *T: pass &value, or store pointers in the interface"),
    ("does not implement", "add the missing method with the exact signature (receiver kind matters)"),
    ("assignment mismatch", "the call returns a different number of values (often a missing `err`)"),
    ("mismatched types", "operands must have identical types: convert one side"),
    ("import cycle not allowed", "move shared types to a lower package or use an interface"),
    ("no required module provides package", "the module is not in go.mod and there is no network: use stdlib or existing deps"),
    ("missing go.sum entry", "dependency not downloaded; offline you cannot add it: avoid the import"),
    ("redeclared in this block", "two declarations with one name in the package (check other files)"),
    ("non-name", "`:=` needs a new identifier on the left; use `=` for fields/index"),
    ("no new variables on left side", "use `=` instead of `:=`"),
    ("invalid memory address", "nil pointer dereference: check for nil before use"),
    ("format %", "printf verb does not match the argument type (%d int, %s string, %v any, %w error in Errorf)"),
    ("passes lock by value", "copylocks: pass a pointer (*T) to structs containing sync.Mutex"),
    ("lostcancel", "call the cancel func returned by context.WithCancel/WithTimeout (defer cancel())"),
    ("unreachable code", "code after return/panic never runs"),
    ("unkeyed fields", "composite literal of another package's struct: use Field: value"),
    ("loopclosure", "loop variable captured by goroutine/closure (pre-Go 1.22): copy it (`v := v`)"),
    ("self-assignment", "x = x does nothing; probably a wrong field or receiver"),
    ("result of fmt.Errorf call not used", "return or assign the error"),
    ("struct field tag", "malformed tag: `json:\"name,omitempty\"` with backquotes and no spaces"),
    ("too many errors", "only the first errors are shown; fix these and rebuild"),
]


def hint(msg):
    for k, h in HINTS:
        if k in msg:
            return h
    return ""


def src_line(path, n):
    try:
        with open(path, errors="replace") as f:
            for i, ln in enumerate(f, 1):
                if i == n:
                    return ln.strip()
    except OSError:
        pass
    return ""


def run(cmd, shell=False):
    p = subprocess.run(cmd, shell=shell, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, errors="replace")
    return p.returncode, p.stdout.splitlines()


def parse(lines):
    errs, seen, other = [], set(), []
    for ln in lines:
        m = ERR.match(ln.strip())
        if m:
            k = (m.group(1), m.group(2), m.group(4))
            if k not in seen:
                seen.add(k)
                errs.append({"file": m.group(1), "line": int(m.group(2)), "col": m.group(3) or "",
                             "msg": m.group(4)})
        elif ln.strip() and not ln.startswith("#") and not ln.startswith(("FAIL", "ok ")):
            other.append(ln.strip())
    return errs, other


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
    ap.add_argument("--run")
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    step, rc = "", None
    if a.run:
        rc, lines = run(a.run, shell=True)
        step = a.run
    elif a.file:
        src = sys.stdin if a.file == "-" else open(a.file, errors="replace")
        lines = src.read().splitlines()
        step = os.path.basename(a.file)
    else:
        pk = extra or ["./..."]
        rc, lines = run(["go", "build"] + pk)
        step = "go build " + " ".join(pk)
        if rc == 0:
            rc, lines = run(["go", "vet"] + pk)
            step = "go build ok; go vet " + " ".join(pk)
    errs, other = parse(lines)
    out = ["%s: %d error(s) in %d file(s)%s" % (step, len(errs), len({e["file"] for e in errs}),
                                                "" if rc is None else ", exit %d" % rc)]
    if not errs and rc:
        out.append("no file:line errors parsed; output:")
        out += ["  " + ln[:160] for ln in other[-12:]]
    files = []
    for e in errs:
        if e["file"] not in files:
            files.append(e["file"])
    for f in files:
        grp = [e for e in errs if e["file"] == f]
        e = grp[0]
        out.append("== %s:%d%s: %s" % (f, e["line"], ":" + e["col"] if e["col"] else "", e["msg"][:160]))
        code = src_line(f, e["line"])
        if code:
            out.append("   %4d| %s" % (e["line"], code[:120]))
        h = hint(e["msg"])
        if h:
            out.append("   hint: " + h)
        for e2 in grp[1:6]:
            out.append("   also %d: %s" % (e2["line"], e2["msg"][:140]))
        if len(grp) > 6:
            out.append("   (+%d more in this file)" % (len(grp) - 6))
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
