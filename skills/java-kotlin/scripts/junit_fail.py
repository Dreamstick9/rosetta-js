#!/usr/bin/env python3
"""Print only the failing JVM tests: reads JUnit XML reports (Maven surefire/
failsafe, Gradle test-results) or Maven/Gradle console output. For each
failure: Class.method, exception and message, the first frames in project code
(framework frames dropped), captured stdout head, and the exact rerun command.

usage:
  junit_fail.py                  read reports under ./**/target/*-reports and ./**/build/test-results
  junit_fail.py DIR|FILE ...     read these report dirs / XML files / saved console logs ('-' = stdin)
  junit_fail.py --run "CMD"      run the tests first (e.g. "mvn -o -q -B test"), then read reports + output
options:
  --max N      max output lines (default 40)
"""
import argparse
import glob
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

FRAME = re.compile(r"^\s*at (?:[\w.$]+/)?([\w.$<>]+)\.([\w$<>\-]+)\(([^)]*)\)")
FRAMEWORK = ("java.", "javax.", "jdk.", "sun.", "org.junit", "junit.", "org.opentest4j", "org.assertj",
             "org.hamcrest", "org.mockito", "org.gradle", "org.apache.maven", "kotlin.", "kotlinx.",
             "org.testng", "io.kotest", "org.spockframework", "org.codehaus.groovy", "groovy.",
             "com.sun.", "worker.org.gradle", "org.springframework", "net.bytebuddy", "jakarta.")
MVN_FAIL = re.compile(r"^\[ERROR\] ([\w.$]+)\.([\w$\[\]()\-, ]+?)(?: -- | {2})Time elapsed: .*<<< (FAILURE|ERROR)!")
MVN_FAIL_OLD = re.compile(r"^\[ERROR\] ([\w$\[\]()\-]+)\(([\w.$]+)\)\s+Time elapsed: .*<<< (FAILURE|ERROR)!")
MVN_MODULE = re.compile(r"on project ([\w.\-]+): There (?:are|were) test failures")
GRADLE_FAIL = re.compile(r"^(\S+) > (.+) FAILED$")
GRADLE_EXC = re.compile(r"^\s{4}([\w.$]+(?:Exception|Error|Failure|Throwable)\w*)(?:: (.*?))?(?: at (\S+:\d+))?$")
GRADLE_TASK = re.compile(r"^> Task (\S+):test FAILED|Execution failed for task '(\S+):test'")


def project_frames(trace, n=2):
    out = []
    for ln in trace.splitlines():
        m = FRAME.match(ln)
        if m and not m.group(1).startswith(FRAMEWORK):
            out.append("%s.%s(%s)" % (m.group(1).rsplit(".", 1)[-1], m.group(2), m.group(3)))
            if len(out) >= n:
                break
    return out


def from_xml(path, fails):
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError):
        return 0
    total = 0
    suites = [root] if root.tag == "testsuite" else root.iter("testsuite")
    for s in suites:
        for tc in s.iter("testcase"):
            total += 1
            for kind in ("failure", "error"):
                el = tc.find(kind)
                if el is None:
                    continue
                cls = tc.get("classname") or s.get("name") or "?"
                trace = el.text or ""
                first = trace.strip().splitlines()[0] if trace.strip() else ""
                exc = el.get("type") or first.split(":")[0]
                msg = el.get("message") or (first.split(":", 1)[1].strip() if ":" in first else "")
                caused = [ln.strip() for ln in trace.splitlines() if ln.strip().startswith("Caused by:")]
                so = tc.find("system-out")
                stdout = (so.text or "").strip().splitlines()[:2] if so is not None else []
                fails.append({"cls": cls, "name": tc.get("name") or "?", "kind": kind, "exc": exc,
                              "msg": msg, "frames": project_frames(trace), "caused": caused[-1:] if caused else [],
                              "stdout": stdout, "module": module_of(path)})
    return total


def module_of(path):
    p = os.path.abspath(path).replace(os.sep, "/")
    for marker in ("/target/", "/build/test-results/"):
        if marker in p:
            mod = p.split(marker)[0]
            if os.path.abspath(mod) == os.path.abspath("."):
                return ""
            return os.path.relpath(mod).replace(os.sep, "/")
    return ""


def from_console(lines, fails):
    module = ""
    task = ""
    for ln in lines:
        m = MVN_MODULE.search(ln)
        if m:
            module = m.group(1)
        m = GRADLE_TASK.search(ln)
        if m:
            task = m.group(1) or m.group(2)
    i = 0
    while i < len(lines):
        ln = lines[i].rstrip()
        m = MVN_FAIL.match(ln) or MVN_FAIL_OLD.match(ln)
        if m:
            if MVN_FAIL.match(ln):
                cls, name, kind = m.group(1), m.group(2), m.group(3)
            else:
                name, cls, kind = m.group(1), m.group(2), m.group(3)
            j = i + 1
            trace = []
            while j < len(lines) and lines[j].strip() and not lines[j].startswith("[") and len(trace) < 200:
                trace.append(lines[j])
                j += 1
            first = trace[0].strip() if trace else ""
            exc, _, msg = first.partition(": ")
            caused = [t.strip() for t in trace if t.strip().startswith("Caused by:")]
            fails.append({"cls": cls, "name": name, "kind": kind.lower(), "exc": exc, "msg": msg,
                          "frames": project_frames("\n".join(trace)), "caused": caused[-1:],
                          "stdout": [], "module": ":" + module if module else ""})
            i = j
            continue
        m = GRADLE_FAIL.match(ln)
        if m and not ln.startswith(">"):
            e = GRADLE_EXC.match(lines[i + 1]) if i + 1 < len(lines) else None
            caused = []
            if i + 2 < len(lines) and "Caused by:" in lines[i + 2]:
                caused = [lines[i + 2].strip()]
            fails.append({"cls": m.group(1), "name": m.group(2), "kind": "failure",
                          "exc": e.group(1) if e else "", "msg": (e.group(2) or "") if e else "",
                          "frames": [e.group(3)] if e and e.group(3) else [], "caused": caused, "stdout": [],
                          "module": task, "gradle": True})
        i += 1


def rerun(f):
    cls, name = f["cls"], re.sub(r"[(\[].*$", "", f["name"])
    simple = cls.rsplit(".", 1)[-1]
    mod = f["module"]
    if f.get("gradle") or os.path.exists("gradlew") or os.path.exists("build.gradle") or \
            os.path.exists("build.gradle.kts"):
        g = "./gradlew" if os.path.exists("gradlew") else "gradle"
        task = (mod if mod.startswith(":") else (":" + mod.replace("/", ":") if mod else "")) + ":test"
        return "%s --offline %s --tests '%s.%s'" % (g, task if task != ":test" else "test",
                                                   cls if "." in cls else "*" + cls, name)
    mvn = "./mvnw" if os.path.exists("mvnw") else "mvn"
    pl = (" -pl " + mod + " -am") if mod else ""
    return "%s -o -q%s test -Dtest='%s#%s' -Dsurefire.failIfNoSpecifiedTests=false" % (mvn, pl, simple, name)


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--run")
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    fails, total, console = [], 0, []
    rc = None
    if a.run:
        p = subprocess.run(a.run, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, errors="replace")
        rc, console = p.returncode, p.stdout.splitlines()
    paths = a.paths or (["."] if a.run or not a.paths else [])
    xmls = []
    for p in paths:
        if p == "-":
            console += sys.stdin.read().splitlines()
        elif os.path.isdir(p):
            for pat in ("**/target/surefire-reports/*.xml", "**/target/failsafe-reports/*.xml",
                        "**/build/test-results/**/*.xml", "*.xml"):
                xmls += glob.glob(os.path.join(p, pat), recursive=True)
        elif p.endswith(".xml"):
            xmls.append(p)
        elif os.path.exists(p):
            console += open(p, errors="replace").read().splitlines()
    for x in sorted(set(xmls)):
        if os.path.basename(x).startswith("TEST-") or x.endswith(".xml"):
            total += from_xml(x, fails)
    if not fails and console:
        from_console(console, fails)
    uniq, seen = [], set()
    for f in fails:
        k = (f["cls"], f["name"])
        if k not in seen:
            seen.add(k)
            uniq.append(f)
    out = []
    if not uniq:
        if not xmls and not console:
            out.append("no reports found (target/surefire-reports, build/test-results); run with --run \"mvn -o -q test\"")
        elif rc not in (None, 0):
            out.append("no failing test parsed, exit %d; last lines:" % rc)
            out += ["  " + ln[:160] for ln in console if ln.strip()][-10:]
        else:
            out.append("PASS: %d test(s) in %d report(s), 0 failures" % (total, len(xmls)))
    else:
        out.append("FAILED %d test(s)%s" % (len(uniq), " of %d" % total if total else ""))
        for f in uniq[:12]:
            out.append("FAIL %s.%s (%s)" % (f["cls"].rsplit(".", 1)[-1], f["name"], f["kind"]))
            exc = f["exc"].rsplit(".", 1)[-1] if f["exc"] else ""
            msg = f["msg"].strip().replace("\n", " ")[:170]
            if exc or msg:
                out.append("   " + ": ".join(x for x in (exc, msg) if x))
            if f["caused"]:
                out.append("   " + f["caused"][0][:170])
            if f["frames"]:
                out.append("   at " + " <- ".join(f["frames"]))
            if f["stdout"]:
                out.append("   stdout: " + " | ".join(f["stdout"])[:120])
        if len(uniq) > 12:
            out.append("(+%d more failing tests)" % (len(uniq) - 12))
        out.append("rerun one: " + rerun(uniq[0]))
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
