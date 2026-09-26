#!/usr/bin/env python3
"""Collapse javac / kotlinc / Maven / Gradle build output: first error per file
with its source line, symbol/location detail and a fix hint; later errors one
line each; plus the failing module/task and offline dependency-resolution
problems (which cannot be fixed by downloading).

usage:
  jvm_errors.py FILE | -        parse saved build output
  jvm_errors.py --run "CMD"     run a build, e.g. "mvn -o -q -B compile" or "./gradlew --offline compileJava"
  jvm_errors.py                 run the detected build (mvnw/mvn test-compile, or gradlew testClasses)
options:
  --warnings   include warnings
  --max N      max output lines (default 40)
"""
import argparse
import os
import re
import subprocess
import sys

JAVAC = re.compile(r"^(?:\[(ERROR|WARNING)\] )?(\S+\.(?:java|kt|kts|groovy|scala)):(?:\[(\d+),(\d+)\]|(\d+):) ?(error: |warning: )?(.*)$")
KOTLIN = re.compile(r"^(e|w): (?:file://)?(\S+\.kts?):(\d+):(\d+) (.*)$")
KOTLIN_OLD = re.compile(r"^(e|w): (\S+\.kts?): \((\d+), (\d+)\): (.*)$")
DETAIL = re.compile(r"^(?:\[ERROR\])?\s+(symbol|location|required|found|reason)\s*:\s*(.*)$")
MODULE = re.compile(r"on project ([\w.\-]+)")
TASK = re.compile(r"^> Task (\S+) FAILED")
WHAT = re.compile(r"^\* What went wrong:")
RESOLVE = re.compile(r"(Could not resolve|could not be resolved|Cannot access \S+ in offline mode|"
                     r"has not been downloaded|Could not find artifact|Could not GET|No cached version)")
HINTS = [
    ("cannot find symbol", "typo, missing import, wrong type, or the symbol lives in a module this one does not depend on"),
    ("Unresolved reference", "typo, missing import, or an extension/function not visible from this module"),
    ("incompatible types", "convert explicitly or fix the declared type; check generics and boxing"),
    ("Type mismatch", "fix the declared type or convert (toInt(), toString()); nullable T? vs T needs ?: or !!"),
    ("cannot be applied to", "argument list does not match any overload: check count, order and types"),
    ("None of the following", "no overload matches the arguments: check types and named arguments"),
    ("does not override", "signature differs from the supertype method (parameters, generics)"),
    ("is not abstract and does not override", "implement every abstract/interface method"),
    ("unreported exception", "catch it or add `throws` to the method signature"),
    ("might not have been initialized", "assign on every path before use"),
    ("missing return statement", "every path of a non-void method must return"),
    ("has private access", "use a public accessor; do not widen visibility unless intended"),
    ("non-static", "call on an instance, or make the member static"),
    ("Only safe (?.) or non-null asserted", "value is nullable: use ?., ?: default, or check for null first"),
    ("does not exist", "import path wrong or the dependency is missing from this module's pom/build file"),
    ("class, interface, enum, or record expected", "brace imbalance or code outside a class: check the lines above"),
    ("reached end of file while parsing", "missing closing brace"),
    ("';' expected", "syntax error at or just before the caret"),
    ("release version", "JDK older than the project's release/target: use a matching JDK, do not lower the target"),
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


def default_cmd():
    if os.path.exists("mvnw"):
        return "./mvnw -o -q -B test-compile"
    if os.path.exists("pom.xml"):
        return "mvn -o -q -B test-compile"
    if os.path.exists("gradlew"):
        return "./gradlew --offline -q testClasses"
    if os.path.exists("build.gradle") or os.path.exists("build.gradle.kts"):
        return "gradle --offline -q testClasses"
    return None


def parse(lines):
    diags, seen, cur = [], set(), None
    modules, tasks, resolve, what = [], [], [], []
    i = 0
    while i < len(lines):
        ln = lines[i].rstrip()
        m = KOTLIN.match(ln) or KOTLIN_OLD.match(ln)
        if m:
            lvl = "error" if m.group(1) == "e" else "warning"
            d = {"file": m.group(2), "line": int(m.group(3)), "col": m.group(4), "level": lvl,
                 "msg": m.group(5), "code": "", "detail": []}
        else:
            m = JAVAC.match(ln)
            d = None
            if m:
                tag, f, l1, c1, l2, kind, msg = m.groups()
                lvl = "warning" if (tag == "WARNING" or (kind or "").startswith("warning")) else "error"
                d = {"file": f, "line": int(l1 or l2), "col": c1 or "", "level": lvl, "msg": msg.strip(),
                     "code": "", "detail": []}
                # javac echoes the source line and a caret on the next two lines
                if kind and i + 1 < len(lines) and not DETAIL.match(lines[i + 1]) and \
                        not JAVAC.match(lines[i + 1]):
                    d["code"] = lines[i + 1].strip()
        if d:
            k = (d["file"], d["line"], d["msg"])
            if k in seen:
                cur = None
            else:
                seen.add(k)
                diags.append(d)
                cur = d
            i += 1
            continue
        m = DETAIL.match(ln)
        if m and cur is not None and len(cur["detail"]) < 3:
            cur["detail"].append("%s: %s" % (m.group(1), m.group(2).strip()))
        m = MODULE.search(ln)
        if m and m.group(1) not in modules:
            modules.append(m.group(1))
        m = TASK.match(ln)
        if m:
            tasks.append(m.group(1))
        if RESOLVE.search(ln) and len(resolve) < 3:
            resolve.append(re.sub(r"^\[ERROR\]\s*", "", ln.strip())[:200])
        if WHAT.match(ln):
            j = i + 1
            while j < len(lines) and lines[j].strip() and not lines[j].startswith("* "):
                what.append(lines[j].strip())
                j += 1
        i += 1
    return diags, modules, tasks, resolve, what


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
        cmd = a.run or default_cmd()
        if not cmd:
            print("no pom.xml or build.gradle here; pass --run \"CMD\"")
            return 0
        p = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, errors="replace")
        rc, lines = p.returncode, p.stdout.splitlines()
    diags, modules, tasks, resolve, what = parse(lines)
    errs = [d for d in diags if d["level"] == "error"]
    warns = [d for d in diags if d["level"] == "warning"]
    shown = errs + (warns if a.warnings else [])
    where = ""
    if modules:
        where = "; failing module: " + ", ".join(modules[:3])
    if tasks:
        where += "; failing task: " + ", ".join(tasks[:3])
    out = ["%d error(s) in %d file(s), %d warning(s)%s%s" % (
        len(errs), len({d["file"] for d in errs}), len(warns), where, "" if rc is None else "; exit %d" % rc)]
    if resolve:
        out.append("DEPENDENCY RESOLUTION FAILED (offline: the artifact is not in the local cache; "
                   "do not add dependencies, use what is cached):")
        out += ["   " + r for r in resolve[:2]]
        if any("Plugin" in r for r in resolve):
            out.append("   a build plugin is missing: try without -o only if network is allowed; else type-check "
                       "directly: javac -d ${TMPDIR:-/tmp}/jv $(find src/main/java -name '*.java')")
    files = []
    for d in shown:
        if d["file"] not in files:
            files.append(d["file"])
    for f in files:
        grp = [d for d in shown if d["file"] == f]
        d = grp[0]
        out.append("== %s:%d%s: %s: %s" % (f, d["line"], ":" + d["col"] if d["col"] else "", d["level"], d["msg"][:160]))
        code = d["code"] or src_line(f, d["line"])
        if code:
            out.append("   %4d| %s" % (d["line"], code[:120]))
        for x in d["detail"]:
            out.append("   " + x[:120])
        h = hint(d["msg"])
        if h:
            out.append("   hint: " + h)
        for d2 in grp[1:5]:
            det = (" (" + d2["detail"][0] + ")") if d2["detail"] else ""
            out.append("   also %d: %s%s" % (d2["line"], d2["msg"][:120], det[:60]))
        if len(grp) > 5:
            out.append("   (+%d more in this file)" % (len(grp) - 5))
    if not shown and not resolve:
        if what:
            out.append("what went wrong: " + " | ".join(what[:4])[:300])
        elif rc:
            out.append("no compiler errors parsed; last lines:")
            out += ["  " + ln[:160] for ln in lines if ln.strip()][-10:]
    if modules:
        out.append("rerun only that module: mvn -o -q -pl :%s -am test-compile" % modules[0])
    elif tasks:
        out.append("rerun only that task: ./gradlew --offline %s" % tasks[0])
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
