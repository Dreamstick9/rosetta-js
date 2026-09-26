#!/usr/bin/env python3
"""Diff lockfiles: what an upgrade really changed (added / removed / bumped / duplicated packages).

usage: lock_diff.py OLD NEW                     two lockfiles of the same kind (name or content sniffed)
       lock_diff.py [--git REF] [LOCKFILE...]   working tree vs `git show REF:./path` (default REF=HEAD)
       lock_diff.py --git A..B [LOCKFILE...]    between two commits
  Without LOCKFILE, every lockfile under . (depth ≤3; skips node_modules/vendor/target) is compared,
  plus requirements*.txt files that contain == pins.
  → per file: summary, then changed packages ordered downgrade, major, minor, patch, prerelease
    (with 0.x caret notes), then added, removed, and packages locked at several versions (dup).
Kinds: package-lock v1/v2/v3, npm-shrinkwrap, yarn.lock v1/berry, pnpm-lock.yaml, Cargo.lock, poetry.lock,
pdm.lock, uv.lock, Pipfile.lock, go.sum, go.mod, Gemfile.lock, requirements with ==.
Read-only (git show only). Exit 0 unless usage is wrong."""
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pins_list as pl  # noqa: E402
import semver_check as sv  # noqa: E402

RANK = {"downgrade": 0, "major": 1, "minor": 2, "patch": 3, "prerelease": 4, "post": 5, "local": 5, "unknown": 6, "same": 7}
SKIP = {".git", "node_modules", "vendor", "target", ".venv", "venv", "__pycache__", "dist", "build", "third_party"}


def sniff(text):
    """Lockfile basename for content whose file name is not a standard one."""
    t = text.lstrip()
    if t.startswith("{"):
        if '"lockfileVersion"' in t[:2000]:
            return "package-lock.json"
        if '"_meta"' in t[:2000]:
            return "Pipfile.lock"
    if re.search(r"^lockfileVersion:", text, re.M):
        return "pnpm-lock.yaml"
    if "# yarn lockfile" in text[:500] or re.search(r"^__metadata:", text, re.M):
        return "yarn.lock"
    if re.search(r"^\[\[package\]\]", text, re.M):
        if "registry+https://github.com/rust-lang" in text or re.search(r"^version = [34]$", text, re.M):
            return "Cargo.lock"
        if re.search(r"^requires-python\s*=", text, re.M) and re.search(r"^revision\s*=", text, re.M):
            return "uv.lock"
        return "poetry.lock"
    if re.search(r"^\S+ v\S+(/go\.mod)? h1:", text, re.M):
        return "go.sum"
    if re.search(r"^module \S+", text, re.M):
        return "go.mod"
    if re.search(r"^GEM$", text, re.M) or re.search(r"^\s+specs:$", text, re.M):
        return "Gemfile.lock"
    return "requirements.txt"


def load(path_label, text, name):
    base = os.path.basename(name)
    if pl.lock_kind(base)[0] is None or base.endswith((".txt", ".in")) and not re.match(r".*requirements.*|constraints.*", base):
        base = sniff(text)
    if pl.lock_kind(base)[0] is None:
        base = sniff(text)
    return pl.parse_lock(path_label, text, base)


def eco_of(lock):
    return {"python": "pep440", "gem": "pep440", "go": "go"}.get(lock.eco, "npm")


def vkey(v, eco):
    p = sv.parse_version(v, eco)
    if p is None and eco != "pep440":
        p2 = sv.parse_pep(v)
        return (1, sv.version_key(p2, "pep440")) if p2 is not None else (0, v)
    return (2, sv.version_key(p, eco)) if p is not None else (0, v)


def classify(a, b, eco):
    kind, note = sv.bump_kind(a, b, eco)
    if kind == "unknown" and eco != "pep440":
        kind, note = sv.bump_kind(a, b, "pep440")
    return kind, note


def diff(old, new, eco):
    changed, added, removed, dups = [], [], [], []
    for n in sorted(set(old.pkgs) | set(new.pkgs)):
        a, b = old.pkgs.get(n, set()), new.pkgs.get(n, set())
        if len(b) > 1:
            dups.append((0 if len(a) <= 1 else 1, n, sorted(b, key=lambda v: vkey(v, eco)), len(a) <= 1))
        if a == b:
            continue
        if not a:
            added.append((n, sorted(b, key=lambda v: vkey(v, eco))))
            continue
        if not b:
            removed.append((n, sorted(a, key=lambda v: vkey(v, eco))))
            continue
        sa, sb = sorted(a, key=lambda v: vkey(v, eco)), sorted(b, key=lambda v: vkey(v, eco))
        gone, came = [v for v in sa if v not in b], [v for v in sb if v not in a]
        fa, fb = (gone or sa)[-1], (came or sb)[-1]
        kind, note = classify(fa, fb, eco)
        if len(sa) == 1 and len(sb) == 1:
            text = "%s %s → %s" % (n, fa, fb)
        else:
            text = "%s %s → %s" % (n, ", ".join(sa), ", ".join(sb))
        changed.append((RANK.get(kind, 6), kind, n, text, note))
    changed.sort(key=lambda c: (c[0], c[2]))
    dups.sort()
    return changed, added, removed, dups


def report(label, old, new, budget):
    eco = eco_of(new)
    changed, added, removed, dups = diff(old, new, eco)
    kinds = {}
    for c in changed:
        kinds[c[1]] = kinds.get(c[1], 0) + 1
    summ = "== %s: %d changed%s, %d added, %d removed, %d duplicated (%d new) — %d → %d packages" % (
        label, len(changed),
        (" (" + ", ".join("%d %s" % (kinds[k], k) for k in sorted(kinds, key=lambda k: RANK.get(k, 6))) + ")") if kinds else "",
        len(added), len(removed), len(dups), sum(1 for d in dups if d[3]),
        sum(len(v) for v in old.pkgs.values()), sum(len(v) for v in new.pkgs.values()))
    lines = []
    for _, kind, n, text, note in changed:
        lines.append("  %-10s %s%s" % (kind, text, ("   (%s)" % note) if note else ""))
    for n, vs in added:
        lines.append("  %-10s %s %s" % ("added", n, ", ".join(vs)))
    for n, vs in removed:
        lines.append("  %-10s %s %s" % ("removed", n, ", ".join(vs)))
    for _, n, vs, is_new in dups:
        lines.append("  %-10s %s %s%s" % ("dup", n, ", ".join(vs), " (new)" if is_new else ""))
    out = [summ]
    if len(lines) > budget:
        out += lines[:budget - 1] + ["  (+%d more)" % (len(lines) - budget + 1)]
    else:
        out += lines
    if not lines and old.pkgs == new.pkgs:
        out[0] += "  (identical package set)"
    return out


def git(args):
    try:
        p = subprocess.run(["git"] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    if p.returncode != 0:
        return None, p.stderr.decode("utf-8", "replace").strip().split("\n")[0]
    return p.stdout.decode("utf-8", "replace"), ""


def find_locks(root="."):
    res = []
    for d, dirs, files in os.walk(root):
        depth = os.path.relpath(d, root).count(os.sep) + (0 if d == root else 1)
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith(".") and depth < 3)
        for f in sorted(files):
            p = os.path.relpath(os.path.join(d, f), root)
            if f in pl.LOCK_NAMES:
                res.append(p)
            elif f == "go.mod" and not os.path.exists(os.path.join(d, "go.sum")):
                res.append(p)
            elif re.match(r"^.*requirements.*\.txt$", f) and re.search(r"^[A-Za-z0-9][\w.\[\],-]*\s*==", pl.read(os.path.join(d, f)), re.M):
                res.append(p)
    return res


def usage(code):
    print(__doc__)
    sys.exit(code)


def main(argv):
    if "-h" in argv or "--help" in argv:
        usage(0)
    ref = None
    files = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--git":
            if i + 1 < len(argv) and not argv[i + 1].startswith("-") and not os.path.exists(argv[i + 1]):
                ref, i = argv[i + 1], i + 2
            else:
                ref, i = "HEAD", i + 1
            continue
        if a.startswith("-"):
            print("lock_diff: unknown option %s" % a, file=sys.stderr)
            return 2
        files.append(a)
        i += 1
    if ref is None and len(files) == 2 and all(os.path.isfile(f) for f in files):
        a, b = pl.read(files[0]), pl.read(files[1])
        old = load(files[0], a, files[0])
        new = load(files[1], b, files[1] if pl.lock_kind(files[1])[0] else files[0])
        if old is None or new is None:
            print("lock_diff: cannot tell the lockfile kind")
            return 0
        kind = os.path.basename(new.path) if new.kind in ("toml", "requirements") else new.kind
        if (old.eco, old.kind) != (new.eco, new.kind):
            print("warning: comparing different lockfile kinds (%s vs %s)" % (old.kind, new.kind))
        for line in report("%s → %s [%s]" % (files[0], files[1], kind), old, new, 38):
            print(line)
        return 0
    ref = ref or "HEAD"
    top, err = git(["rev-parse", "--show-toplevel"])
    if top is None:
        print("lock_diff: not a git repository (%s); pass OLD NEW files instead" % err)
        return 0
    if ".." in ref:
        r_old, r_new = ref.split("..", 1)
        r_new = r_new or "HEAD"
    else:
        r_old, r_new = ref, None
    targets = files or find_locks(".")
    if not targets:
        print("lock_diff: no lockfiles found under . (pass paths explicitly)")
        return 0
    budget = max(6, 38 // len(targets) - 1)
    total = 0
    for f in targets:
        old_text, e1 = git(["show", "%s:./%s" % (r_old, f)])
        if r_new:
            new_text, e2 = git(["show", "%s:./%s" % (r_new, f)])
        else:
            new_text, e2 = (pl.read(f), "") if os.path.isfile(f) else (None, "deleted in working tree")
        label = "%s (%s → %s)" % (f, r_old, r_new or "working tree")
        if old_text is None and new_text is None:
            print("== %s: missing on both sides" % label)
            continue
        old = load(f, old_text or "", f)
        new = load(f, new_text or "", f)
        if old is None or new is None:
            continue
        if old_text is None:
            label += " [new file]"
        if new_text is None:
            label += " [deleted]"
        lines = report(label, old, new, budget)
        for line in lines:
            if total >= 40:
                break
            print(line)
            total += 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
