#!/usr/bin/env python3
"""Collapse cargo/rustc diagnostics to a short list: the first error per file
in full (location, code line, labels, help) and later ones as one line each.

usage:
  cargo_errors.py                      run `cargo check --all-targets` (JSON) here
  cargo_errors.py -- -p mycrate        extra args go to cargo check
  cargo_errors.py --run "cargo build"  run any command, parse its text output
  cargo_errors.py FILE | -             parse saved output (text or JSON lines)
options:
  --warnings   include warnings (hidden by default, counted only)
  --max N      max output lines (default 40)
"""
import argparse
import json
import re
import subprocess
import sys

HEAD = re.compile(r"^(error|warning)(?:\[(\w+)\])?: (.*)$")
LOC = re.compile(r"^\s*--> (.+?):(\d+):(\d+)")
CODE = re.compile(r"^\s*(\d+)\s*\|(?: (.*))?$")
LABEL = re.compile(r"^\s*\|\s*[|\s]*?[\^\-~]+\s+(\S.*)$")
BAR = re.compile(r"^\s*\|\s*(.*)$")
SUGG = re.compile(r"^\s*\d+\s*[+~]\s(.*)$")
NOISE = ("could not compile", "aborting due to", "generated ", "build failed",
         "test failed", "Some errors have", "For more information")


def diag(level, code, msg, file, line, col):
    return {"level": level, "code": code or "", "msg": msg, "file": file,
            "line": line, "col": col, "src": [], "help": []}


def from_json(lines):
    out = []
    for raw in lines:
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        m = obj.get("message") if obj.get("reason") == "compiler-message" else obj
        if not isinstance(m, dict) or m.get("level") not in ("error", "warning"):
            continue
        spans = m.get("spans") or []
        prim = next((s for s in spans if s.get("is_primary")), spans[0] if spans else None)
        if prim is None:
            if any(n in m.get("message", "") for n in NOISE):
                continue
            out.append(diag(m["level"], "", m.get("message", ""), "", 0, 0))
            continue
        d = diag(m["level"], (m.get("code") or {}).get("code"), m.get("message", ""),
                 prim["file_name"], prim["line_start"], prim["column_start"])
        seen = set()
        for s in sorted(spans, key=lambda s: s["line_start"]):
            if s["file_name"] != prim["file_name"]:
                continue
            text = (s.get("text") or [{}])[0].get("text", "").strip()
            lab = s.get("label") or ""
            key = (s["line_start"], lab)
            if key in seen:
                continue
            seen.add(key)
            d["src"].append((s["line_start"], text, lab))
        for c in m.get("children") or []:
            h = "%s: %s" % (c.get("level"), c.get("message", ""))
            reps = [s.get("suggested_replacement") for s in c.get("spans") or []
                    if s.get("suggested_replacement") is not None]
            if reps:
                h += " -> `%s`" % reps[0].strip()[:80]
            d["help"].append(h)
        out.append(d)
    return out


def from_text(lines):
    out, cur, mode = [], None, "src"
    for ln in lines:
        ln = ln.rstrip("\n")
        h = HEAD.match(ln)
        if h:
            if any(n in h.group(3) for n in NOISE):
                cur = None
                continue
            cur = diag(h.group(1), h.group(2), h.group(3), "", 0, 0)
            out.append(cur)
            mode = "src"
            continue
        if cur is None:
            continue
        m = LOC.match(ln)
        if m and not cur["file"]:
            cur["file"], cur["line"], cur["col"] = m.group(1), int(m.group(2)), int(m.group(3))
            continue
        if ln.startswith(("help:", "note:")) or ln.strip().startswith("= "):
            cur["help"].append(ln.strip().lstrip("= ").strip())
            mode = "help" if ln.startswith("help:") else "note"
            continue
        if mode == "help":
            s = SUGG.match(ln) or CODE.match(ln)
            if s and cur["help"] and "->" not in cur["help"][-1]:
                cur["help"][-1] += " -> `%s`" % (s.group(s.lastindex) or "").strip()[:80]
            continue
        if mode != "src":
            continue
        c = CODE.match(ln)
        if c:
            cur["src"].append([int(c.group(1)), (c.group(2) or "").strip(), ""])
            continue
        lab = LABEL.match(ln) or BAR.match(ln)
        if lab and cur["src"]:
            t = re.sub(r"^([\^\-~|]+\s*)+", "", lab.group(1).strip())
            if t and not set(t) <= set("^-~| "):
                prev = cur["src"][-1]
                prev[2] = (prev[2] + "; " + t) if prev[2] else t
    return [d for d in out if d["msg"]]


def run(cmd, shell):
    p = subprocess.run(cmd, shell=shell, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, errors="replace")
    return p.returncode, p.stdout.splitlines()


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    extra = []
    if "--" in argv:
        i = argv.index("--")
        argv, extra = argv[:i], argv[i + 1:]
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("file", nargs="?")
    ap.add_argument("--run")
    ap.add_argument("--warnings", action="store_true")
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    show_warn, maxl = a.warnings, a.max
    rc = None
    if a.run:
        rc, lines = run(a.run, True)
    else:
        if a.file:
            src = sys.stdin if a.file == "-" else open(a.file, errors="replace")
            lines = src.read().splitlines()
        else:
            rc, lines = run(["cargo", "check", "--all-targets", "--message-format=json"] + extra, False)
    is_json = sum(1 for ln in lines[:200] if ln.startswith('{"reason"')) > 0
    diags = from_json(lines) if is_json else from_text(lines)
    uniq, seen = [], set()
    for d in diags:
        k = (d["level"], d["code"], d["msg"], d["file"], d["line"])
        if k not in seen:
            seen.add(k)
            uniq.append(d)
    errs = [d for d in uniq if d["level"] == "error"]
    warns = [d for d in uniq if d["level"] == "warning"]
    shown = errs + (warns if show_warn else [])
    files = []
    for d in shown:
        if d["file"] not in files:
            files.append(d["file"])
    out = ["%d error(s) in %d file(s), %d warning(s)%s%s" % (
        len(errs), len({d["file"] for d in errs}), len(warns),
        "" if show_warn or not warns else " (hidden; --warnings)",
        "" if rc is None else "; exit %d" % rc)]
    if not shown:
        tail = [ln for ln in lines if ln.strip() and not ln.startswith("{")][-8:]
        if rc:
            out.append("no rustc diagnostics parsed; last output lines:")
            out += ["  " + ln[:160] for ln in tail]
    for f in files:
        group = [d for d in shown if d["file"] == f]
        first = group[0]
        tag = "%s[%s]" % (first["level"], first["code"]) if first["code"] else first["level"]
        out.append("== %s:%d:%d %s: %s" % (f or "?", first["line"], first["col"], tag, first["msg"]))
        for ln, text, lab in first["src"][:5]:
            out.append("   %4d| %s%s" % (ln, text[:110], ("   <- " + lab) if lab else ""))
        for h in first["help"][:3]:
            out.append("   " + h[:160])
        for d in group[1:]:
            tag = d["code"] or d["level"]
            out.append("   also %d:%d %s: %s" % (d["line"], d["col"], tag, d["msg"][:120]))
    if errs and errs[0]["code"]:
        out.append("tip: fix the first error first; `kit_run rust explain_code.py %s` for a fix recipe"
                   % errs[0]["code"])
    if len(out) > maxl:
        out = out[:maxl - 1] + ["... %d more lines (--max N)" % (len(out) - maxl + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
