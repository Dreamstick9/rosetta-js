#!/usr/bin/env python3
"""Collapse gcc/clang/make/cmake build output: first error per file with the
enclosing function, code line, caret fix-it and candidate notes; linker errors
grouped by symbol with a likely cause (demangled with c++filt when present).

usage:
  cc_errors.py FILE | -          parse saved build output
  cc_errors.py --run "CMD"       run a build command (e.g. "cmake --build build -j4")
  cc_errors.py                   run the detected build (cmake --build build, or make -k)
options:
  --warnings   include warnings (counted only by default)
  --max N      max output lines (default 40)
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

DIAG = re.compile(r"^(.+?):(\d+):(?:(\d+):)? (fatal error|error|warning|note): (.*)$")
CODE = re.compile(r"^\s*(\d+)\s*\|\s?(.*)$")
CARET = re.compile(r"^\s*\|\s*(.*)$")
INFUNC = re.compile(r"^(.+?): In (?:member )?(?:function|constructor|destructor|instantiation of) (.+):$")
UNDEF_GNU = re.compile(r"undefined reference to [`'](.+)'")
UNDEF_MAC = re.compile(r'^\s+"(.+)", referenced from:')
MULTI = re.compile(r"multiple definition of [`'](.+?)'")
NOLIB = re.compile(r"cannot find -l(\S+)|library not found for -l(\S+)")
MAKEERR = re.compile(r"^(?:g?make|ninja).*?(?:\*\*\* \[(.+?)\]|FAILED: (.+))")


def run(cmd, shell=True):
    p = subprocess.run(cmd, shell=shell, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, errors="replace")
    return p.returncode, p.stdout.splitlines()


def default_build():
    if os.path.exists("build/CMakeCache.txt"):
        return "cmake --build build -j4 -- -k 2>&1 || cmake --build build"
    if os.path.exists("CMakeLists.txt"):
        return "cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug >/dev/null && cmake --build build -j4"
    if os.path.exists("Makefile") or os.path.exists("makefile"):
        return "make -k -j4"
    if os.path.exists("build.ninja"):
        return "ninja -k 0"
    return None


def demangle(names):
    """Map raw symbol -> readable name. Mach-O symbols carry an extra leading '_'."""
    raw = {n: (n[1:] if n.startswith("__Z") else n) for n in names}
    res = {n: raw[n] for n in names}
    mangled = [n for n in names if raw[n].startswith("_Z")]
    if mangled and shutil.which("c++filt"):
        try:
            p = subprocess.run(["c++filt", "-n"], input="\n".join(raw[n] for n in mangled),
                               stdout=subprocess.PIPE, universal_newlines=True, timeout=10)
            outs = p.stdout.splitlines()
            if len(outs) == len(mangled):
                res.update(zip(mangled, outs))
        except (OSError, subprocess.SubprocessError):
            pass
    return {n: tidy(v) for n, v in res.items()}


STL = [(r"std::__cxx11::", "std::"), (r"std::__1::", "std::"),
       (r"std::basic_string<char, std::char_traits<char>, std::allocator<char> ?>", "std::string"),
       (r"std::basic_string_view<char, std::char_traits<char> ?>", "std::string_view"),
       (r", std::allocator<[^<>]*(?:<[^<>]*>)?> ?>", ">")]


def tidy(s):
    for a, b in STL:
        s = re.sub(a, b, s)
    return s


def link_hint(sym):
    s = sym.lstrip("_")
    if re.match(r"^(sqrt|pow|sin|cos|floor|ceil|log|exp|fabs)f?\b", s):
        return "math: add -lm (target_link_libraries(... m))"
    if s.startswith("pthread_"):
        return "add -pthread / Threads::Threads"
    if "vtable for" in sym or "typeinfo for" in sym:
        return "a virtual function (often the destructor) is declared but never defined"
    if "::" in sym:
        return "declared but not defined, its .cpp not in the target's sources, or a template defined in a .cpp"
    return "not defined anywhere linked: missing source in the target, missing library, or C/C++ name mangling (extern \"C\")"


def parse(lines):
    diags, cur, func = [], None, {}
    link_undef, link_multi, nolib, make_fail = {}, [], [], []
    for ln in lines:
        m = INFUNC.match(ln)
        if m:
            func[m.group(1)] = m.group(2).strip("'‘’")
            continue
        m = DIAG.match(ln)
        if m and not ln.startswith(" "):
            f, line, col, lvl, msg = m.groups()
            if lvl == "note":
                if cur is not None and len(cur["notes"]) < 3:
                    cur["notes"].append("%s:%s: %s" % (os.path.basename(f), line, msg))
                continue
            cur = {"file": f, "line": int(line), "col": col or "", "level": lvl.replace("fatal ", ""),
                   "fatal": lvl.startswith("fatal"), "msg": msg, "code": "", "fix": "",
                   "func": func.get(f, ""), "notes": []}
            diags.append(cur)
            continue
        c = CODE.match(ln)
        if c and cur is not None and not cur["code"]:
            cur["code"] = c.group(2).strip()
            continue
        c = CARET.match(ln)
        if c and cur is not None and cur["code"]:
            t = c.group(1).strip()
            if t and re.search(r"[A-Za-z_;)(]", t) and not set(t) <= set("^~ "):
                cur["fix"] = t
            continue
        m = UNDEF_GNU.search(ln) or UNDEF_MAC.match(ln)
        if m:
            where = re.match(r"^(?:/usr/bin/ld: )?(.+?):\(", ln)
            sym = m.group(1)
            if UNDEF_MAC.match(ln) and sym.startswith("_") and not sym.startswith("__Z"):
                sym = sym[1:]
            link_undef.setdefault(sym, set())
            if where:
                link_undef[sym].add(os.path.basename(where.group(1)))
            continue
        m = MULTI.search(ln)
        if m:
            link_multi.append(m.group(1))
            continue
        m = NOLIB.search(ln)
        if m:
            nolib.append(m.group(1) or m.group(2))
            continue
        m = MAKEERR.match(ln)
        if m:
            make_fail.append(m.group(1) or m.group(2))
    return diags, link_undef, link_multi, nolib, make_fail


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("file", nargs="?")
    ap.add_argument("--run")
    ap.add_argument("--warnings", action="store_true")
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    rc = None
    if a.file:
        src = sys.stdin if a.file == "-" else open(a.file, errors="replace")
        lines = src.read().splitlines()
    else:
        cmd = a.run or default_build()
        if not cmd:
            print("no build system found here; pass --run \"CMD\" (see cc_build_detect.py)")
            return 0
        rc, lines = run(cmd)
    diags, undef, multi, nolib, make_fail = parse(lines)
    seen, uniq = set(), []
    for d in diags:
        k = (d["file"], d["line"], d["msg"])
        if k not in seen:
            seen.add(k)
            uniq.append(d)
    errs = [d for d in uniq if d["level"] == "error"]
    warns = [d for d in uniq if d["level"] == "warning"]
    shown = errs + (warns if a.warnings else [])
    out = ["%d compile error(s) in %d file(s), %d warning(s)%s; %d undefined symbol(s)%s" % (
        len(errs), len({d["file"] for d in errs}), len(warns),
        "" if a.warnings or not warns else " (hidden; --warnings)", len(undef),
        "" if rc is None else "; exit %d" % rc)]
    files = []
    for d in shown:
        if d["file"] not in files:
            files.append(d["file"])
    for f in files:
        grp = [d for d in shown if d["file"] == f]
        d = grp[0]
        out.append("== %s:%d%s: %s%s: %s" % (f, d["line"], ":" + d["col"] if d["col"] else "",
                                            "fatal " if d["fatal"] else "", d["level"], tidy(d["msg"])[:170]))
        if d["func"]:
            out.append("   in %s" % d["func"][:100])
        if d["code"]:
            out.append("   %4d| %s" % (d["line"], d["code"][:120]))
        if d["fix"]:
            out.append("   fix-it: %s" % d["fix"][:100])
        for n in d["notes"][:2]:
            out.append("   note %s" % tidy(n)[:150])
        for d2 in grp[1:5]:
            out.append("   also %d: %s: %s" % (d2["line"], d2["level"], tidy(d2["msg"])[:130]))
            if d2["notes"]:
                out.append("        note %s" % tidy(d2["notes"][-1])[:140])
        if len(grp) > 5:
            out.append("   (+%d more in this file)" % (len(grp) - 5))
    if undef:
        dm = demangle(sorted(undef))
        out.append("LINK: undefined symbols")
        for s in sorted(undef)[:8]:
            name = dm.get(s, s)
            refs = ", ".join(sorted(undef[s])[:3])
            out.append("   %s%s\n      cause: %s" % (name[:140], (" (from " + refs + ")") if refs else "",
                                                     link_hint(name)))
    for s in sorted(set(multi))[:4]:
        out.append("LINK: multiple definition of %s -> define once in a .c/.cpp; headers get `inline`/`extern`" % s)
    for lib in sorted(set(nolib))[:4]:
        out.append("LINK: library -l%s not found (not installed; no network to add it)" % lib)
    if make_fail and not (errs or undef or multi or nolib):
        out.append("build step failed: %s (no compiler diagnostics parsed)" % make_fail[0])
        tail = [ln for ln in lines if ln.strip()][-8:]
        out += ["  " + t[:160] for t in tail]
    elif not (errs or undef or multi or nolib) and rc:
        out.append("no diagnostics parsed; last lines:")
        out += ["  " + t[:160] for t in [ln for ln in lines if ln.strip()][-8:]]
    text = "\n".join(out).splitlines()
    if len(text) > a.max:
        text = text[:a.max - 1] + ["(+%d more lines)" % (len(text) - a.max + 1)]
    print("\n".join(text))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
