#!/usr/bin/env python3
"""Pre-finish gate in one call: runs the project's tests, then scans the working
diff for leftovers (debug prints, breakpoints, conflict markers, TODO/FIXME
added, skipped tests, files outside the request) and prints a PASS/FAIL checklist.

usage: verify.py [--test "CMD"] [--no-tests]
Output: at most 40 lines; exit 0."""
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LEFTOVERS = [
    (r"^\+.*\b(breakpoint\(\)|pdb\.set_trace|import pdb|debugger;|dbg!\()", "debugger left in"),
    (r"^\+\s*(print\(|console\.log\(|fmt\.Println\(\"DEBUG|eprintln!\(\"DEBUG)", "debug print added"),
    (r"^\+.*(<<<<<<<|>>>>>>>|^=======$)", "conflict marker"),
    (r"^\+.*\b(TODO|FIXME|XXX)\b", "TODO/FIXME added"),
    (r"^\+.*(@pytest\.mark\.skip|@unittest\.skip|\.skip\(|xit\(|t\.Skip\()", "test skipped"),
    (r"^\+.*\b(except\s*:|except Exception:\s*pass)", "bare/blanket except"),
]


def git(*a):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    return p.stdout if p.returncode == 0 else ""


def main(argv):
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    out = []
    ok = True
    if "--no-tests" not in argv:
        cmd = []
        if "--test" in argv:
            cmd = ["--", "sh", "-c", argv[argv.index("--test") + 1]]
        r = subprocess.run([sys.executable, os.path.join(HERE, "test_summary.py"), *cmd], capture_output=True, text=True).stdout
        lines = r.splitlines()
        passed = any(l.startswith("PASS") for l in lines[:3])
        ok &= passed
        out.append(f"[{'PASS' if passed else 'FAIL'}] tests: {lines[1] if len(lines) > 1 else r.strip()[:120]}")
        if not passed:
            out.extend("    " + l for l in lines[2:14])
    if git("rev-parse", "--git-dir"):
        diff = git("diff", "HEAD", "--unified=0")
        untracked = [f for f in git("ls-files", "--others", "--exclude-standard").splitlines() if f]
        files = sorted(set(re.findall(r"^\+\+\+ b/(.+)$", diff, re.M)) | set(untracked))
        out.append(f"[info] changed files ({len(files)}): " + ", ".join(files[:12]) + (" …" if len(files) > 12 else ""))
        for f in untracked:
            try:
                if os.path.getsize(f) < 200_000:
                    diff += "\n+++ b/" + f + "\n" + "\n".join("+" + l for l in open(f, errors="ignore").read().splitlines())
            except OSError:
                pass
        current = None
        hits = []
        for line in diff.splitlines():
            if line.startswith("+++ b/"):
                current = line[6:]
                continue
            for pat, what in LEFTOVERS:
                if re.search(pat, line) and not (what == "debug print added" and current and re.search(r"(cli|__main__|main)\.py$|/bin/|scripts?/", current)):
                    hits.append(f"    {current}: {what}: {line[1:].strip()[:90]}")
        junk = [f for f in files if re.search(r"(__pycache__|\.pyc$|\.pytest_cache|\.DS_Store|\.orig$|\.rej$|\.log$)", f)]
        out.append(f"[{'FAIL' if hits else 'PASS'}] no leftovers in the diff" + (f" ({len(hits)} found)" if hits else ""))
        out.extend(hits[:12])
        out.append(f"[{'FAIL' if junk else 'PASS'}] no junk files" + (": " + ", ".join(junk[:6]) if junk else ""))
        ok &= not hits and not junk
    else:
        out.append("[info] not a git repository: diff checks skipped")
    out.append("VERDICT: " + ("ready — re-read the request once more, then finish" if ok else "NOT ready — fix the FAIL items first"))
    for l in out[:40]:
        print(l)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
