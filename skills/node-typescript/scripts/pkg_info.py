#!/usr/bin/env python3
"""Node package overview in one call: module system (ESM/CJS), entry points
(main/module/exports/types/bin), engines, scripts, the test/lint/typecheck
commands, and for named dependencies the declared range, the installed
version and where the code imports them.

Usage: pkg_info.py [DIR] [--dep NAME ...]
  --dep NAME   report declared vs installed version and import sites (repeatable)
"""
import json
import os
import re
import sys

MAX_LINES = 40
SRC_EXTS = (".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".jsx", ".tsx")
SKIP = {"node_modules", ".git", "dist", "build", "coverage", "out", "lib"}


def load(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def src_files(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        for f in sorted(files):
            if f.endswith(SRC_EXTS):
                yield os.path.join(d, f)


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    deps_q = []
    rest = []
    i = 0
    while i < len(args):
        if args[i] == "--dep" and i + 1 < len(args):
            deps_q.append(args[i + 1])
            i += 2
        else:
            rest.append(args[i])
            i += 1
    root = rest[0] if rest else "."
    pj = load(os.path.join(root, "package.json"))
    if pj is None:
        print("no readable package.json in %s" % root)
        return 0
    out = ["%s@%s  type=%s%s" % (pj.get("name", "?"), pj.get("version", "?"), pj.get("type", "commonjs (default)"),
                                 "  private" if pj.get("private") else "")]
    for k in ("main", "module", "types", "typings", "browser"):
        if k in pj:
            out.append("  %-8s %s" % (k, pj[k] if isinstance(pj[k], str) else json.dumps(pj[k])[:80]))
    if "exports" in pj:
        ex = pj["exports"]
        if isinstance(ex, dict):
            for k, v in list(ex.items())[:6]:
                out.append("  exports[%s] %s" % (k, json.dumps(v)[:90]))
        else:
            out.append("  exports  %s" % json.dumps(ex)[:90])
    if "bin" in pj:
        out.append("  bin      %s" % json.dumps(pj["bin"])[:90])
    if "engines" in pj:
        out.append("  engines  %s" % json.dumps(pj["engines"]))
    scripts = pj.get("scripts") or {}
    for k in sorted(scripts, key=lambda s: (s not in ("test", "build", "lint", "typecheck", "check"), s))[:8]:
        out.append("  script %-12s %s" % (k, scripts[k][:80]))
    bin_dir = os.path.join(root, "node_modules", ".bin")
    have = sorted(set(os.listdir(bin_dir)) & {"tsc", "eslint", "jest", "vitest", "mocha", "prettier", "ts-node", "tsx", "biome"}) if os.path.isdir(bin_dir) else []
    out.append("local tools: " + (" ".join(have) if have else "none (node_modules/.bin missing)"))
    # module-system mix
    files = list(src_files(root))
    esm = cjs = 0
    for f in files[:800]:
        try:
            t = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if re.search(r"^\s*(import\s.+from\s|export\s)", t, re.M):
            esm += 1
        if re.search(r"\brequire\(|module\.exports|exports\.\w+\s*=", t):
            cjs += 1
    out.append("sources: %d files; %d use import/export, %d use require/module.exports" % (len(files), esm, cjs))
    if pj.get("type") == "module" and cjs:
        out.append("  note: type=module, so require()/module.exports only work in .cjs files")
    alld = {}
    for sect in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        for k, v in (pj.get(sect) or {}).items():
            alld.setdefault(k, (v, sect))
    out.append("deps: %d runtime, %d dev" % (len(pj.get("dependencies") or {}), len(pj.get("devDependencies") or {})))
    for name in deps_q:
        decl = alld.get(name)
        inst = load(os.path.join(root, "node_modules", name, "package.json"))
        iv = inst.get("version") if inst else "not installed"
        out.append("dep %s: declared %s, installed %s" % (name, "%s (%s)" % decl if decl else "NO", iv))
        if inst:
            typ = inst.get("types") or inst.get("typings")
            at = load(os.path.join(root, "node_modules", "@types", name.lstrip("@").replace("/", "__"), "package.json"))
            out.append("  types: %s; module type %s" % (typ or ("@types " + at["version"] if at else "none"),
                                                         inst.get("type", "commonjs")))
        rx = re.compile(r"""(?:from\s+|require\(\s*|import\(\s*)['"]%s(?:/[^'"]*)?['"]""" % re.escape(name))
        sites = []
        for f in files:
            try:
                for n, line in enumerate(open(f, encoding="utf-8", errors="replace"), 1):
                    if rx.search(line):
                        sites.append("%s:%d" % (os.path.relpath(f, root), n))
            except OSError:
                pass
        out.append("  imported at (%d): %s" % (len(sites), " ".join(sites[:6]) or "-"))
    print("\n".join(out[:MAX_LINES]))
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
