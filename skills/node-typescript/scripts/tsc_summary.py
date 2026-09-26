#!/usr/bin/env python3
"""Run the TypeScript compiler (or read its log) and print errors grouped by
file and by error code, with a one-line hint for the common codes.

Usage:
  tsc_summary.py [DIR]                 # runs: npx --no-install tsc --noEmit -p DIR
  tsc_summary.py -- CMD ...            # runs CMD (e.g. npm run typecheck)
  tsc_summary.py --log FILE            # parses a saved tsc log
Options: --files N (files shown, default 12), --per-file N (errors per file, default 3)
Exit 0 whenever the script itself worked.
"""
import os
import re
import subprocess
import sys

MAX_LINES = 40
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# tsc classic: src/a.ts(12,5): error TS2322: ...   pretty: src/a.ts:12:5 - error TS2322: ...
ERR = re.compile(r"^(?P<file>[^\s(][^(:]*?)(?:\((?P<l1>\d+),(?P<c1>\d+)\)|:(?P<l2>\d+):(?P<c2>\d+))"
                 r"\s*(?::|-)\s*error\s+(?P<code>TS\d+):\s*(?P<msg>.*)$")
GLOBAL = re.compile(r"^error\s+(TS\d+):\s*(.*)$")
HINTS = {
    "TS2322": "value type not assignable: fix the value or widen the declared type (not `as any`)",
    "TS2345": "argument type mismatch: check the callee signature",
    "TS2339": "property missing on type: typo, narrow a union, or extend the interface",
    "TS2307": "module not found: path/alias (tsconfig paths) or missing @types / not installed",
    "TS2304": "name not found: missing import or global type (lib / types in tsconfig)",
    "TS2554": "wrong number of arguments",
    "TS2741": "required property missing in object literal",
    "TS2532": "object possibly undefined: narrow with a check or `?.`",
    "TS18048": "value possibly undefined: narrow before use",
    "TS18047": "value possibly null: narrow before use",
    "TS2531": "object possibly null",
    "TS7006": "implicit any parameter (noImplicitAny): annotate it",
    "TS7016": "no type declarations for module: add @types or a `declare module` d.ts",
    "TS2769": "no overload matches: read the first overload error below it",
    "TS1259": "default import needs esModuleInterop / allowSyntheticDefaultImports",
    "TS1192": "module has no default export: use `import * as` or a named import",
    "TS2305": "module has no exported member with that name",
    "TS2352": "type assertion between unrelated types: fix the types, not the cast",
    "TS2366": "function lacks ending return statement",
    "TS2551": "property does not exist; did you mean the suggested name?",
    "TS1005": "syntax error: a token is missing",
    "TS2564": "class property not initialized in constructor (strictPropertyInitialization)",
    "TS2835": "relative import needs an explicit .js extension (node16/nodenext resolution)",
    "TS1479": "CJS file importing ESM: check package.json type / module settings",
    "TS5023": "unknown compiler option in tsconfig",
    "TS6133": "declared but never used (noUnusedLocals)",
}


def get_opt(argv, name, default):
    if name in argv:
        i = argv.index(name)
        val = argv[i + 1]
        del argv[i:i + 2]
        return val
    return default


def main():
    argv = sys.argv[1:]
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    cmd = None
    if "--" in argv:
        cmd = argv[argv.index("--") + 1:]
        argv = argv[:argv.index("--")]
    nfiles = int(get_opt(argv, "--files", 12))
    per = int(get_opt(argv, "--per-file", 3))
    log = get_opt(argv, "--log", None)
    rc = None
    if log:
        with open(log, encoding="utf-8", errors="replace") as f:
            text = f.read()
        src = log
    else:
        if cmd is None:
            d = argv[0] if argv else "."
            cmd = ["npx", "--no-install", "tsc", "--noEmit", "--pretty", "false", "-p", d]
        try:
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900,
                               env=dict(os.environ, NO_COLOR="1", FORCE_COLOR="0"))
            text, rc = p.stdout.decode("utf-8", "replace"), p.returncode
        except FileNotFoundError:
            print("cannot run %s: not found" % cmd[0])
            return 0
        except subprocess.TimeoutExpired:
            print("TIMEOUT: " + " ".join(cmd))
            return 0
        src = "$ " + " ".join(cmd)
    lines = [ANSI.sub("", ln).rstrip() for ln in text.splitlines()]
    by_file, by_code, glob = {}, {}, []
    order = []
    last = None
    for ln in lines:
        m = ERR.match(ln.strip())
        if m:
            f = m.group("file").strip()
            line = m.group("l1") or m.group("l2")
            code = m.group("code")
            msg = m.group("msg").strip()
            if f not in by_file:
                by_file[f] = []
                order.append(f)
            last = [int(line), code, msg]
            by_file[f].append(last)
            by_code[code] = by_code.get(code, 0) + 1
            continue
        g = GLOBAL.match(ln.strip())
        if g:
            glob.append("%s %s" % (g.group(1), g.group(2)[:150]))
            by_code[g.group(1)] = by_code.get(g.group(1), 0) + 1
            continue
        # first continuation line of a multi-line message (indented detail)
        if last is not None and ln.startswith("  ") and len(last) == 3 and ln.strip():
            last.append(ln.strip()[:120])
    total = sum(len(v) for v in by_file.values()) + len(glob)
    out = [src + ("" if rc is None else "  (exit %d)" % rc)]
    if total == 0:
        if rc not in (None, 0):
            out.append("no TS errors parsed but command failed; last lines:")
            out += ["  " + x[:160] for x in [x for x in lines if x.strip()][-10:]]
        else:
            out.append("OK: 0 type errors")
        print("\n".join(out[:MAX_LINES]))
        return 0
    out.append("%d error(s) in %d file(s)" % (total, len(by_file)))
    codes = sorted(by_code.items(), key=lambda kv: (-kv[1], kv[0]))
    out.append("by code: " + ", ".join("%s×%d" % kv for kv in codes[:8]))
    for code, _ in codes[:4]:
        if code in HINTS:
            out.append("  %s: %s" % (code, HINTS[code]))
    for g in glob[:3]:
        out.append("global: " + g)
    ranked = sorted(order, key=lambda f: (-len(by_file[f]), order.index(f)))
    for f in ranked[:nfiles]:
        errs = sorted(by_file[f], key=lambda e: e[0])
        out.append("%s (%d)" % (f, len(errs)))
        for e in errs[:per]:
            out.append("  L%d %s %s" % (e[0], e[1], e[2][:130]))
            if len(e) > 3:
                out.append("        " + e[3])
        if len(errs) > per:
            out.append("  (+%d more in this file)" % (len(errs) - per))
    if len(ranked) > nfiles:
        out.append("(+%d more files)" % (len(ranked) - nfiles))
    for x in out[:MAX_LINES]:
        print(x)
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
