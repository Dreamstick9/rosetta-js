#!/usr/bin/env python3
"""Collapse Java/Kotlin stack traces from logs or test output: each exception
in the chain (including every "Caused by:") with its message, the project
frames only, and a count of the framework frames folded away. The root cause
(the last "Caused by") is marked; that is usually where to look.

usage:
  jvm_stack.py FILE | -             parse a log / trace
  jvm_stack.py FILE --pkg com.acme  treat frames under this package as project code
                                    (default: packages found under src/*/java|kotlin, else non-framework)
options:
  --max N      max output lines (default 40)
"""
import argparse
import os
import re
import sys

EXC = re.compile(r"^(?:Exception in thread \"[^\"]*\" |Caused by: |Suppressed: |\s*)?"
                 r"((?:[a-z_][\w]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable|Failure|Failed)[\w$]*)(?::\s?(.*))?$")
FRAME = re.compile(r"^\s*at (?:[\w.$-]+(?:@[\w.]+)?/)?([\w.$<>]+)\.([\w$<>\-]+)\(([^)]*)\)")
MORE = re.compile(r"^\s*\.\.\. (\d+) (?:more|common frames omitted)")
FRAMEWORK = ("java.", "javax.", "jdk.", "sun.", "com.sun.", "org.junit", "junit.", "org.opentest4j",
             "org.gradle", "org.apache.maven", "kotlin.", "kotlinx.", "org.springframework", "org.apache.catalina",
             "org.apache.tomcat", "jakarta.", "io.netty", "reactor.", "org.hibernate", "com.fasterxml",
             "net.bytebuddy", "org.mockito", "org.assertj", "groovy.", "org.codehaus", "io.micronaut",
             "io.quarkus", "org.eclipse.jetty", "com.google.common", "okhttp3.", "retrofit2.")


def project_pkgs(root="."):
    pk = set()
    for lang in ("java", "kotlin"):
        for top in ("src/main/" + lang, "src/test/" + lang):
            for base, dirs, files in os.walk(os.path.join(root, top)):
                if any(f.endswith((".java", ".kt")) for f in files):
                    rel = os.path.relpath(base, os.path.join(root, top))
                    if rel != ".":
                        pk.add(".".join(rel.split(os.sep)[:2]))
                    dirs[:] = []
    return sorted(pk)


def is_project(cls, pkgs):
    if pkgs:
        return any(cls.startswith(p + ".") or cls == p for p in pkgs)
    return not cls.startswith(FRAMEWORK)


def main(argv):
    if "-h" in argv or "--help" in argv or not argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("file")
    ap.add_argument("--pkg", action="append", default=[])
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    src = sys.stdin if a.file == "-" else open(a.file, errors="replace")
    lines = src.read().splitlines()
    pkgs = a.pkg or project_pkgs()
    chains, cur = [], None
    for ln in lines:
        m = FRAME.match(ln)
        if m and cur is not None:
            cls, meth, loc = m.groups()
            if is_project(cls, pkgs):
                if len(cur["frames"]) < 4:
                    cur["frames"].append("%s.%s(%s)" % (cls.rsplit(".", 1)[-1], meth, loc))
            else:
                cur["folded"] += 1
            continue
        m = MORE.match(ln)
        if m and cur is not None:
            cur["folded"] += int(m.group(1))
            continue
        m = EXC.match(ln.strip()) if not ln.startswith("\tat") else None
        if m and ("Caused by:" in ln or "Exception in thread" in ln or ln.strip().startswith(m.group(1))):
            caused = ln.strip().startswith("Caused by:")
            if not caused or not chains:
                chains.append([])
            cur = {"exc": m.group(1), "msg": (m.group(2) or "").strip(), "frames": [], "folded": 0,
                   "caused": caused}
            chains[-1].append(cur)
    out = []
    seen = set()
    for ch in chains:
        key = tuple((e["exc"], e["msg"]) for e in ch)
        if key in seen:
            continue
        seen.add(key)
        out.append("trace %d:" % (len(seen)))
        for k, e in enumerate(ch):
            root = k == len(ch) - 1 and len(ch) > 1
            out.append("  %s%s%s: %s" % ("caused by " if e["caused"] else "",
                                         e["exc"].rsplit(".", 1)[-1], "  <== ROOT CAUSE" if root else "",
                                         e["msg"][:170]))
            if e["frames"]:
                out.append("     at " + " <- ".join(e["frames"]))
            else:
                out.append("     (no project frames)")
            if e["folded"]:
                out[-1] += "  [+%d frames folded]" % e["folded"]
    if not out:
        out = ["no Java/Kotlin stack trace found"]
    elif len(seen) < len(chains):
        out.append("(%d duplicate traces skipped)" % (len(chains) - len(seen)))
    if pkgs and len(out) > 1:
        out.append("project packages: " + ", ".join(pkgs[:5]))
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
