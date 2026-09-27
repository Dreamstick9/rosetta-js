#!/usr/bin/env python3
"""Resolve a tsconfig.json through its `extends` chain (JSONC: comments and
trailing commas allowed) and print the effective settings that matter, plus
warnings about common misconfigurations (module vs package.json type, jsx,
paths without baseUrl, node16 imports without .js, ...).

Usage: tsconfig_resolve.py [TSCONFIG_OR_DIR]   (default ./tsconfig.json)
"""
import json
import os
import re
import sys

MAX_LINES = 40
KEYS = ["target", "module", "moduleResolution", "lib", "jsx", "strict", "noImplicitAny",
        "strictNullChecks", "esModuleInterop", "allowSyntheticDefaultImports", "allowJs",
        "checkJs", "isolatedModules", "verbatimModuleSyntax", "skipLibCheck", "resolveJsonModule",
        "declaration", "noEmit", "outDir", "rootDir", "baseUrl", "types", "typeRoots",
        "experimentalDecorators", "useDefineForClassFields", "noUncheckedIndexedAccess",
        "exactOptionalPropertyTypes", "composite", "incremental"]


def strip_jsonc(text):
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        else:
            out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.loads(strip_jsonc(f.read()))


def resolve_extends(ext, base_dir):
    cands = []
    if ext.startswith("."):
        p = os.path.normpath(os.path.join(base_dir, ext))
        cands = [p, p + ".json", os.path.join(p, "tsconfig.json")]
    else:
        d = base_dir
        while True:
            nm = os.path.join(d, "node_modules", ext)
            cands += [nm, nm + ".json", os.path.join(nm, "tsconfig.json")]
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
    for c in cands:
        if os.path.isfile(c):
            return c
    return None


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    path = args[0] if args else "tsconfig.json"
    if os.path.isdir(path):
        path = os.path.join(path, "tsconfig.json")
    if not os.path.isfile(path):
        print("no tsconfig at %s" % path)
        return 0
    chain, opts, top = [], {}, {}
    cur, seen = path, set()
    configs = []
    warnings = []
    while cur and cur not in seen:
        seen.add(cur)
        try:
            cfg = load(cur)
        except (ValueError, OSError) as e:
            warnings.append("cannot parse %s: %s" % (cur, e))
            break
        configs.append((cur, cfg))
        chain.append(cur)
        ext = cfg.get("extends")
        if isinstance(ext, list):
            ext = ext[-1] if ext else None
            warnings.append("array extends: only last entry followed")
        if not ext:
            break
        nxt = resolve_extends(ext, os.path.dirname(cur))
        if not nxt:
            warnings.append("extends %r not found (node_modules missing?)" % ext)
        cur = nxt
    source = {}
    for cfg_path, cfg in reversed(configs):  # base first, child overrides
        for k, v in (cfg.get("compilerOptions") or {}).items():
            opts[k] = v
            source[k] = cfg_path
        for k in ("include", "exclude", "files", "references"):
            if k in cfg:
                top[k] = cfg[k]
    root = os.path.dirname(os.path.abspath(path))
    out = ["chain: " + " -> ".join(os.path.relpath(c) for c in chain)]
    strict = opts.get("strict", False)
    for k in KEYS:
        if k in opts:
            v = opts[k]
            note = "" if source.get(k) == chain[0] else "  (from %s)" % os.path.basename(source[k])
            out.append("  %-26s %s%s" % (k, json.dumps(v)[:70], note))
    if strict:
        out.append("  (strict=true implies noImplicitAny, strictNullChecks, strictPropertyInitialization, ...)")
    if "paths" in opts:
        items = list(opts["paths"].items())
        out.append("  paths: " + ", ".join("%s→%s" % (k, v[0] if v else "?") for k, v in items[:6]))
    for k in ("include", "exclude", "files"):
        if k in top:
            out.append("%s: %s" % (k, json.dumps(top[k])[:120]))
    if "references" in top:
        out.append("references (project build: tsc -b): " + ", ".join(r.get("path", "?") for r in top["references"]))
    # warnings
    mod = str(opts.get("module", "")).lower()
    res = str(opts.get("moduleResolution", "")).lower()
    pkg = {}
    pj = os.path.join(root, "package.json")
    if os.path.isfile(pj):
        try:
            pkg = load(pj)
        except ValueError:
            pass
    if pkg.get("type") == "module" and mod in ("commonjs",):
        warnings.append('package.json "type":"module" but module=commonjs: emitted .js will be treated as ESM')
    if mod in ("node16", "nodenext") or res in ("node16", "nodenext"):
        warnings.append("node16/nodenext: relative imports in ESM files need explicit .js extensions")
    if res == "bundler" and mod in ("commonjs",):
        warnings.append("moduleResolution=bundler requires module esnext/es2015+/preserve")
    if "paths" in opts and "baseUrl" not in opts:
        warnings.append("paths without baseUrl: resolved relative to the tsconfig (TS>=4.1); runtime/jest need matching aliases")
    if "paths" in opts:
        warnings.append("paths are type-only: jest moduleNameMapper / vite resolve.alias must mirror them")
    has_tsx = False
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in ("node_modules", ".git", "dist", "build")]
        if any(f.endswith(".tsx") for f in files):
            has_tsx = True
            break
    if has_tsx and "jsx" not in opts:
        warnings.append(".tsx files exist but compilerOptions.jsx is unset (TS17004)")
    if opts.get("isolatedModules") or opts.get("verbatimModuleSyntax"):
        warnings.append("isolatedModules/verbatimModuleSyntax: re-exported types need `export type`")
    if not opts.get("skipLibCheck"):
        warnings.append("skipLibCheck off: errors inside node_modules/@types count too")
    for w in warnings:
        out.append("warn: " + w)
    print("\n".join(out[:MAX_LINES]))
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
