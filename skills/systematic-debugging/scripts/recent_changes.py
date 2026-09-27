#!/usr/bin/env python3
"""Local git history for a file or symbol: the last commits that touched it,
with changed-line counts — to see whether a recent change caused a regression.
Uses local history only (never fetches).

usage: recent_changes.py PATH [-n N]          commits touching PATH
       recent_changes.py -S TEXT [-n N]       commits that added/removed TEXT
Output: at most 40 lines; exit 0 unless the arguments are wrong."""
import subprocess
import sys


def git(*args):
    p = subprocess.run(["git", *args], capture_output=True, text=True)
    return p.stdout if p.returncode == 0 else ""


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if argv else 2
    n = 10
    if "-n" in argv:
        i = argv.index("-n"); n = int(argv[i + 1]); argv = argv[:i] + argv[i + 2:]
    if not git("rev-parse", "--git-dir"):
        print("not a git repository")
        return 0
    if argv[0] == "-S":
        log = git("log", f"-n{n}", "--format=%h %ad %s", "--date=short", "-S", argv[1])
        what = f"text {argv[1]!r}"
    else:
        log = git("log", f"-n{n}", "--format=%h %ad %s", "--date=short", "--numstat", "--", argv[0])
        what = argv[0]
    lines = [l for l in log.splitlines() if l.strip()]
    if not lines:
        print(f"no commits touch {what} (it may be new or uncommitted)")
        return 0
    print(f"recent commits touching {what}:")
    for l in lines[:38]:
        print("  " + l[:150])
    status = git("status", "--short", "--", argv[0]) if argv[0] != "-S" else ""
    if status.strip():
        print("uncommitted: " + status.strip()[:120])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
