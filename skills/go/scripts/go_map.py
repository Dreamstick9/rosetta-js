#!/usr/bin/env python3
"""Map a Go module without the go tool: module path, go/toolchain version,
vendoring, workspaces, packages with their Test/Benchmark/Fuzz counts, build
tags, and cgo use. With --for FILE: its package and the tests that call the
file's functions, as an exact `go test -run` command.

usage:
  go_map.py [DIR]               map the module (default: .)
  go_map.py [DIR] --for FILE    package of FILE and the tests that exercise it
"""
import argparse
import os
import re
import sys

SKIP = {"vendor", "testdata", "node_modules", ".git", "third_party"}
FUNC = re.compile(r"^func (?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[\[(]", re.M)
TEST = re.compile(r"^func ((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(", re.M)
TAG = re.compile(r"^//go:build (.+)$", re.M)
PKG = re.compile(r"^package (\w+)", re.M)


def read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def find_root(d):
    d = os.path.abspath(d)
    while True:
        if os.path.exists(os.path.join(d, "go.mod")):
            return d
        if os.path.dirname(d) == d:
            return None
        d = os.path.dirname(d)


def packages(root):
    pk = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith((".", "_")))
        if base != root and os.path.exists(os.path.join(base, "go.mod")):
            dirs[:] = []
            continue
        gos = sorted(f for f in files if f.endswith(".go"))
        if gos:
            pk[os.path.relpath(base, root)] = gos
    return pk


def rel_pkg(rel):
    return "." if rel == "." else "./" + rel.replace(os.sep, "/")


def for_file(root, mod, path):
    path = os.path.abspath(path)
    d = os.path.dirname(path)
    rel = os.path.relpath(d, root)
    src = read(path)
    if path.endswith("_test.go"):
        tests = [t for t in TEST.findall(src) if t.startswith("Test")]
        funcs = []
    else:
        funcs = sorted(set(FUNC.findall(src)))
        tests = []
        for f in sorted(os.listdir(d)):
            if f.endswith("_test.go"):
                body = read(os.path.join(d, f))
                # split into test functions and keep those that call one of our funcs
                parts = re.split(r"(?m)^func ", body)
                for part in parts[1:]:
                    m = re.match(r"(Test\w*)\s*\(", part)
                    if m and any(re.search(r"\b%s\s*[\[(]" % re.escape(fn), part) for fn in funcs):
                        tests.append(m.group(1))
    pkgname = (PKG.search(src) or [None, "?"])[1]
    out = ["package %s (%s/%s), dir %s" % (pkgname, mod, rel.replace(os.sep, "/") if rel != "." else "",
                                          rel_pkg(rel))]
    if funcs:
        out.append("funcs in file: " + ", ".join(funcs[:15]) + (" (+%d)" % (len(funcs) - 15) if len(funcs) > 15 else ""))
    if tests:
        out.append("tests touching it: " + ", ".join(tests[:12]) + (" (+%d)" % (len(tests) - 12) if len(tests) > 12 else ""))
        out.append("run: go test %s -run '^(%s)$' -count=1 -v" % (rel_pkg(rel), "|".join(tests[:12])))
    else:
        out.append("no test calls these funcs directly; write one in %s_test.go" %
                   os.path.splitext(os.path.basename(path))[0].replace("_test", ""))
        out.append("run: go test %s -count=1" % rel_pkg(rel))
    return out


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("dir", nargs="?", default=".")
    ap.add_argument("--for", dest="for_file")
    a = ap.parse_args(argv)
    root = find_root(os.path.dirname(os.path.abspath(a.for_file)) if a.for_file else a.dir)
    if not root:
        print("no go.mod at or above %s" % os.path.abspath(a.dir))
        return 0
    gomod = read(os.path.join(root, "go.mod"))
    mod = (re.search(r"^module\s+(\S+)", gomod, re.M) or [None, "?"])[1]
    if a.for_file:
        print("\n".join(for_file(root, mod, a.for_file)))
        return 0
    gov = (re.search(r"^go\s+(\S+)", gomod, re.M) or [None, "?"])[1]
    tc = re.search(r"^toolchain\s+(\S+)", gomod, re.M)
    reqs = len(re.findall(r"^\s+\S+ v\S+", gomod, re.M)) + len(re.findall(r"^require \S+ v", gomod, re.M))
    replaces = re.findall(r"^replace\s+(.+)$", gomod, re.M)
    out = ["module %s, go %s%s, %d requirement(s)%s" % (mod, gov, ", " + tc.group(1) if tc else "", reqs,
                                                         ", replace: " + "; ".join(replaces[:2]) if replaces else "")]
    notes = []
    if os.path.isdir(os.path.join(root, "vendor")):
        notes.append("vendor/ present: builds use -mod=vendor automatically")
    if os.path.exists(os.path.join(root, "go.work")):
        notes.append("go.work present: multi-module workspace")
    if not os.path.exists(os.path.join(root, "go.sum")) and reqs:
        notes.append("go.sum MISSING")
    notes.append("offline: GOPROXY=off" + ("" if os.path.isdir(os.path.join(root, "vendor"))
                                          else " (fails fast instead of downloading)"))
    out.append("; ".join(notes))
    pk = packages(root)
    tags, cgo = set(), []
    rows = []
    for rel in sorted(pk):
        files = pk[rel]
        nt = nb = nf = 0
        name = "?"
        for f in files:
            src = read(os.path.join(root, rel, f))
            for t in TAG.findall(src):
                tags.add(t.strip())
            if 'import "C"' in src:
                cgo.append(os.path.join(rel, f))
            if f.endswith("_test.go"):
                for t in TEST.findall(src):
                    nt += t.startswith("Test")
                    nb += t.startswith("Benchmark")
                    nf += t.startswith("Fuzz")
            elif name == "?":
                name = (PKG.search(src) or [None, "?"])[1]
        srcs = sum(1 for f in files if not f.endswith("_test.go"))
        rows.append("- %s (%s) files:%d tests:%d%s%s" % (
            rel_pkg(rel), name, srcs, nt, " bench:%d" % nb if nb else "", " fuzz:%d" % nf if nf else ""))
    out.append("%d package(s):" % len(rows))
    out += rows[:28]
    if len(rows) > 28:
        out.append("(+%d more packages)" % (len(rows) - 28))
    if tags:
        out.append("build tags: " + "; ".join(sorted(tags)[:6]) + "  (go test -tags X to include)")
    if cgo:
        out.append("cgo in: " + ", ".join(cgo[:4]) + "  (-race needs cgo; CGO_ENABLED=1 and a C compiler)")
    out.append("test: go test ./... | one: go test ./pkg -run '^TestX$' -count=1 -v | owner: go_map.py --for FILE")
    print("\n".join(out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
