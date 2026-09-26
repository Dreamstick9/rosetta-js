#!/usr/bin/env python3
"""Map the shell scripts of a repo in one call: each script's interpreter,
strict-mode flags (set -e/-u/pipefail), functions defined, files it sources,
whether it is executable; test suites (bats, shunit2, shellspec, plain
test_*.sh) with the command to run them; and which shells/tools exist here.
With --func NAME: where a function is defined and every call site.

usage:
  sh_map.py [DIR]               map scripts under DIR (default: .)
  sh_map.py [DIR] --func NAME   definition and callers of a shell function
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

SKIP = {".git", "node_modules", "vendor", "target", "build", "dist", ".venv", "venv", "__pycache__"}
SHEBANG = re.compile(r"^#!\s*(?:/usr/bin/env\s+(?:-S\s+)?)?(?:\S*/)?(\w+)(.*)$")
FUNC = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\)\s*\{?|^\s*function\s+([A-Za-z_][\w:.-]*)\s*\{?")
SOURCE = re.compile(r"^\s*(?:\.|source)\s+([^\s;&|]+)")


def is_shell(path):
    if path.endswith((".sh", ".bash", ".ksh", ".bats", ".zsh")):
        return True
    if os.path.splitext(path)[1]:
        return False
    try:
        with open(path, "rb") as f:
            m = SHEBANG.match(f.read(80).decode("utf-8", "replace"))
        return bool(m) and m.group(1) in ("sh", "bash", "dash", "ksh", "ash", "zsh")
    except OSError:
        return False


def scripts(root):
    out = []
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith("."))
        for f in sorted(files):
            p = os.path.join(base, f)
            if is_shell(p):
                out.append(p)
    return out


def code_lines(text):
    """Lines outside heredoc bodies."""
    out, delim = [], None
    for ln in text.splitlines():
        if delim:
            if ln.strip() == delim:
                delim = None
            continue
        m = re.search(r"<<-?\s*(['\"]?)(\w+)\1", ln)
        if m and "<<<" not in ln:
            delim = m.group(2)
        out.append(ln)
    return out


def version(cmd):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, timeout=10)
        m = re.search(r"(\d+\.\d+(?:\.\d+)?)", p.stdout)
        return m.group(1) if m else "yes"
    except (OSError, subprocess.SubprocessError):
        return ""


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("dir", nargs="?", default=".")
    ap.add_argument("--func")
    a = ap.parse_args(argv)
    root = os.path.abspath(a.dir)
    files = scripts(root)
    rel = lambda p: os.path.relpath(p, root)
    if a.func:
        out = []
        rx_def = re.compile(r"^\s*(?:function\s+)?%s\s*(\(\))?\s*\{?\s*$|^\s*(?:function\s+)?%s\s*\(\)" %
                            (re.escape(a.func), re.escape(a.func)))
        rx_call = re.compile(r"(^|[\s;&|(`$]|\$\()%s(\s|;|$|\))" % re.escape(a.func))
        extra = [os.path.join(root, f) for f in ("Makefile", "makefile") if os.path.exists(os.path.join(root, f))]
        for p in files + extra:
            for n, ln in enumerate(open(p, errors="replace"), 1):
                s = ln.rstrip()
                if rx_def.search(s):
                    out.insert(0, "def  %s:%d  %s" % (rel(p), n, s.strip()[:100]))
                elif rx_call.search(re.sub(r'"[^"$`]*"', '""', re.sub(r"'[^']*'", "''", s))) and \
                        not s.lstrip().startswith("#"):
                    out.append("call %s:%d  %s" % (rel(p), n, s.strip()[:100]))
        print("\n".join(out[:40]) if out else "function %s not found" % a.func)
        return 0
    out = ["%d shell script(s) under %s" % (len(files), root)]
    tests = []
    for p in files[:30]:
        try:
            text = open(p, errors="replace").read()
        except OSError:
            continue
        first = text.split("\n", 1)[0]
        m = SHEBANG.match(first)
        interp = m.group(1) + (m.group(2).strip() and " " + m.group(2).strip() or "") if m else \
            ("bats" if p.endswith(".bats") else "NO SHEBANG")
        flags = []
        if re.search(r"^\s*set\s+-[a-z]*e|set -o errexit", text, re.M) or re.search(r"\s-\w*e", m.group(2) if m else ""):
            flags.append("-e")
        if re.search(r"^\s*set\s+-[a-z]*u|set -o nounset", text, re.M):
            flags.append("-u")
        if "pipefail" in text:
            flags.append("pipefail")
        funcs = []
        for ln in code_lines(text):
            f = FUNC.match(ln)
            if f:
                name = f.group(1) or f.group(2)
                if name not in ("if", "for", "while", "case") and name not in funcs:
                    funcs.append(name)
        srcs = [s.group(1) for s in (SOURCE.match(ln) for ln in text.splitlines()) if s]
        x = "" if os.access(p, os.X_OK) else " (not executable)"
        line = "- %s [%s%s]%s %d lines" % (rel(p), interp, (" " + " ".join(flags)) if flags else " no strict mode",
                                          x, text.count("\n"))
        if funcs:
            line += "; funcs: " + ", ".join(funcs[:6]) + (" (+%d)" % (len(funcs) - 6) if len(funcs) > 6 else "")
        if srcs:
            line += "; sources: " + ", ".join(srcs[:3])
        out.append(line)
        if p.endswith(".bats") or "shunit2" in text or re.match(r"test_|.*_test\.sh$|.*_spec\.sh$", os.path.basename(p)):
            tests.append(p)
    if len(files) > 30:
        out.append("(+%d more scripts)" % (len(files) - 30))
    if tests:
        bats = [t for t in tests if t.endswith(".bats")]
        if bats:
            d = os.path.dirname(rel(bats[0])) or "."
            out.append("tests: bats (%d file(s)) -> bats %s   (one test: bats -f 'name' FILE)" % (len(bats), d))
        sh2 = [t for t in tests if "shunit2" in open(t, errors="replace").read()]
        if sh2:
            out.append("tests: shunit2 -> run each file: %s" % ", ".join(rel(t) for t in sh2[:3]))
        spec = [t for t in tests if t.endswith("_spec.sh")]
        if spec:
            out.append("tests: shellspec -> shellspec")
        plain = [t for t in tests if t not in bats + sh2 + spec]
        if plain:
            out.append("tests: plain scripts -> " + ", ".join("sh " + rel(t) for t in plain[:4]))
    mk = os.path.join(root, "Makefile")
    if os.path.exists(mk):
        tt = re.findall(r"^(test|check|lint|shellcheck)\s*:", open(mk, errors="replace").read(), re.M)
        if tt:
            out.append("Makefile targets: " + ", ".join(sorted(set(tt))))
    have = []
    for tool, cmd in (("bash", ["bash", "--version"]), ("dash", None), ("sh", None), ("shellcheck", ["shellcheck", "--version"]),
                      ("bats", ["bats", "--version"]), ("shfmt", ["shfmt", "--version"]), ("busybox", None)):
        if shutil.which(tool):
            v = version(cmd) if cmd else ""
            have.append(tool + (" " + v if v and v != "yes" else ""))
    out.append("available: " + (", ".join(have) or "no shells?!"))
    if not shutil.which("shellcheck"):
        out.append("no shellcheck: use kit_run shell-scripting sh_lint.py (built-in checks)")
    print("\n".join(out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
