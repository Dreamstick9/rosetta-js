#!/usr/bin/env python3
"""Run ESLint (or read its output) and summarize: counts by rule and by file,
fixable count, and the first problems with file:line.

Usage:
  eslint_summary.py [PATH ...]          # runs: npx --no-install eslint -f json PATH (default .)
  eslint_summary.py --log FILE          # parses saved output (json or the default 'stylish' text)
Options: --errors-only (hide warnings), --show N (problems listed, default 15)
Exit 0 whenever the script itself worked.
"""
import json
import os
import re
import subprocess
import sys

MAX_LINES = 40
STYLISH_FILE = re.compile(r"^(/|\.{0,2}/|[A-Za-z]:\\|\w).*\.(?:[cm]?[jt]sx?|vue|svelte)$")
STYLISH_MSG = re.compile(r"^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$")


def parse_json(text):
    start = text.find("[")
    data = json.loads(text[start:])
    probs = []
    for f in data:
        for m in f.get("messages", []):
            probs.append({"file": f.get("filePath", "?"), "line": m.get("line", 0),
                          "sev": "error" if m.get("severity") == 2 else "warning",
                          "rule": m.get("ruleId") or "(parse)", "msg": m.get("message", ""),
                          "fix": "fix" in m})
    return probs


def parse_stylish(text):
    probs, cur = [], None
    for ln in text.splitlines():
        if STYLISH_FILE.match(ln.strip()) and not ln.startswith(" "):
            cur = ln.strip()
            continue
        m = STYLISH_MSG.match(ln)
        if m and cur:
            probs.append({"file": cur, "line": int(m.group(1)), "sev": m.group(3),
                          "rule": m.group(5), "msg": m.group(4), "fix": False})
    return probs


def main():
    argv = sys.argv[1:]
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    errors_only = "--errors-only" in argv
    argv = [a for a in argv if a != "--errors-only"]
    show = 15
    if "--show" in argv:
        i = argv.index("--show")
        show = int(argv[i + 1])
        del argv[i:i + 2]
    head = ""
    if "--log" in argv:
        path = argv[argv.index("--log") + 1]
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        head = path
    else:
        cmd = ["npx", "--no-install", "eslint", "-f", "json"] + (argv or ["."])
        try:
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900,
                               env=dict(os.environ, NO_COLOR="1"))
        except FileNotFoundError:
            print("cannot run npx: not found")
            return 0
        except subprocess.TimeoutExpired:
            print("TIMEOUT: " + " ".join(cmd))
            return 0
        text = p.stdout.decode("utf-8", "replace")
        head = "$ %s  (exit %d)" % (" ".join(cmd), p.returncode)
        if not text.strip():
            err = p.stderr.decode("utf-8", "replace").strip().splitlines()
            print(head)
            print("eslint produced no output; stderr:")
            for e in err[:12]:
                print("  " + e[:160])
            return 0
    try:
        probs = parse_json(text) if text.lstrip().startswith("[") else parse_stylish(text)
    except ValueError:
        probs = parse_stylish(text)
    cwd = os.getcwd() + os.sep
    for pr in probs:
        if pr["file"].startswith(cwd):
            pr["file"] = pr["file"][len(cwd):]
    if errors_only:
        probs = [p for p in probs if p["sev"] == "error"]
    out = [head]
    nerr = sum(1 for p in probs if p["sev"] == "error")
    out.append("%d problem(s): %d error, %d warning; %d auto-fixable (eslint --fix)"
               % (len(probs), nerr, len(probs) - nerr, sum(1 for p in probs if p["fix"])))
    if not probs:
        print("\n".join(out))
        return 0
    rules, files = {}, {}
    for p in probs:
        rules[p["rule"]] = rules.get(p["rule"], 0) + 1
        files[p["file"]] = files.get(p["file"], 0) + 1
    out.append("by rule: " + ", ".join("%s×%d" % kv for kv in sorted(rules.items(), key=lambda kv: (-kv[1], kv[0]))[:8]))
    out.append("by file: " + ", ".join("%s×%d" % kv for kv in sorted(files.items(), key=lambda kv: (-kv[1], kv[0]))[:6]))
    probs.sort(key=lambda p: (p["sev"] != "error", p["file"], p["line"]))
    for p in probs[:show]:
        out.append("%s:%d %s %s  %s" % (p["file"], p["line"], "E" if p["sev"] == "error" else "w",
                                        p["rule"], p["msg"][:110]))
    if len(probs) > show:
        out.append("(+%d more)" % (len(probs) - show))
    print("\n".join(out[:MAX_LINES]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
