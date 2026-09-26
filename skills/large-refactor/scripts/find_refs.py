#!/usr/bin/env python3
"""Every reference to a name (whole word) grouped by file, with counts and the
first lines — the blast radius of a rename/extract in one call. Skips vendored,
build and cache folders.

usage: find_refs.py NAME [NAME2 ...] [--path DIR]
Output: at most 40 lines; exit 0."""
import os
import re
import sys

SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", "target", "build", "dist", "vendor", ".mypy_cache", ".pytest_cache", ".tox"}
EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift",
       ".md", ".rst", ".txt", ".toml", ".yaml", ".yml", ".json", ".cfg", ".ini", ".html", ".vue", ".svelte", ".gd", ".sh"}


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if argv else 2
    root = "."
    if "--path" in argv:
        i = argv.index("--path"); root = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    pat = re.compile(r"\b(" + "|".join(re.escape(n) for n in argv) + r")\b")
    hits = {}
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP)
        for f in sorted(files):
            p = os.path.join(d, f)
            if os.path.splitext(f)[1] not in EXT:
                continue
            try:
                for i, line in enumerate(open(p, errors="ignore"), 1):
                    if pat.search(line):
                        hits.setdefault(os.path.relpath(p, root), []).append((i, line.strip()))
            except OSError:
                pass
    total = sum(len(v) for v in hits.values())
    out = [f"{total} references in {len(hits)} files to {', '.join(argv)}:"]
    defs = [(f, i, l) for f, v in hits.items() for i, l in v if re.match(r"(def|class|fn|func|function|const|let|var|pub|type|interface)\b", l)]
    for f, i, l in defs[:5]:
        out.append(f"  def {f}:{i}: {l[:90]}")
    for f, v in sorted(hits.items(), key=lambda kv: -len(kv[1])):
        out.append(f"  {f} ×{len(v)}: " + "; ".join(f"{i}" for i, _ in v[:12]) + (" …" if len(v) > 12 else ""))
        if len(out) >= 38:
            break
    if len(hits) > len(out) - 1 - len(defs[:5]):
        out.append(f"  (more files omitted)")
    for l in out[:40]:
        print(l)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
