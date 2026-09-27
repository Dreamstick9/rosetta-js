#!/usr/bin/env python3
"""Summarize AddressSanitizer / LeakSanitizer / UBSan / TSan / MSan / valgrind
reports: the bug kind, the access, and only the project frames of the access,
free and allocation stacks (libc, sanitizer runtime and unknown frames dropped).

usage:
  san_summary.py FILE | -          parse a saved report
  san_summary.py --run "CMD"       run CMD (a binary built with -fsanitize=...)
                                   with ASAN/UBSAN options that print full stacks
options:
  --max N      max output lines (default 40)
build flags: -g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined
"""
import argparse
import os
import re
import subprocess
import sys

ERR = re.compile(r"==\d+==\s*ERROR: (\w+Sanitizer): (.+?)(?: on (?:unknown )?address.*)?$")
ACCESS = re.compile(r"^(READ|WRITE) of size (\d+) at \S+ thread (\S+)")
FRAME = re.compile(r"^\s*#(\d+) 0x[0-9a-f]+ in (.+?) (\S+?:\d+(?::\d+)?)\s*$")
FRAME_NOLOC = re.compile(r"^\s*#(\d+) 0x[0-9a-f]+ (?:in )?(.*)$")
SECTION = re.compile(r"^(freed by thread \S+ here|previously allocated by thread \S+ here|allocated by thread \S+ here"
                     r"|(?:Direct|Indirect) leak of \d+ byte\(s\) in \d+ object\(s\) allocated from"
                     r"|Previous (?:read|write)[^:]*|(?:Read|Write|Atomic \w+) of size \d+[^:]*|"
                     r"Location is .*|Thread T\d+ .*created by .*)[:]?$")
UB = re.compile(r"^(\S+?:\d+:\d+): runtime error: (.+)$")
TSAN = re.compile(r"WARNING: ThreadSanitizer: (.+?) \(pid=\d+\)")
SUMMARY = re.compile(r"^SUMMARY: (\w+Sanitizer): (.+)$")
VG_HEAD = re.compile(r"^==\d+== (Invalid (?:read|write|free).*|Conditional jump.*|Use of uninitialised.*|"
                     r"Mismatched free.*|Source and destination overlap.*|Syscall param.*)$")
VG_FRAME = re.compile(r"^==\d+==\s+(?:at|by) 0x[0-9A-F]+: (.+?) \((.+?)\)$")
VG_ADDR = re.compile(r"^==\d+==\s+(Address .+|Block was alloc'd at|Uninitialised value was created.*)$")
VG_SUM = re.compile(r"^==\d+== (ERROR SUMMARY: .+|\s*definitely lost: .+|\s*indirectly lost: .+)$")
NOISE = ("libc_start", "_start", "asan_", "__interceptor", "libsanitizer", "compiler-rt", "libclang_rt",
         "<unknown module>", "libc.so", "libstdc++", "libc++", "ld-linux", "__sanitizer", "vgpreload",
         "/usr/include/", "/usr/lib/", "operator new", "operator delete", "malloc", "calloc", "realloc",
         "free", "sysdeps/", "csu/")


def project(fn, loc):
    blob = fn + " " + loc
    if any(n in blob for n in NOISE):
        return False
    return not fn.startswith(("std::", "__gnu_cxx", "__cxa", "_Unwind"))


def short(loc):
    parts = loc.split("/")
    return "/".join(parts[-2:]) if len(parts) > 2 else loc


def parse(lines):
    out = []
    i = 0
    cur_frames, cur_label = [], None

    def flush():
        if cur_label is not None:
            proj = [f for f in cur_frames if project(*f)]
            show = proj[:3] if proj else cur_frames[:1]
            txt = " <- ".join("%s (%s)" % (fn.split("(")[0][:50], short(loc)) for fn, loc in show)
            out.append("   %s: %s" % (cur_label, txt or "?"))

    while i < len(lines):
        ln = lines[i].rstrip()
        m = ERR.search(ln)
        if m:
            flush()
            cur_label, cur_frames = None, []
            out.append("%s: %s" % (m.group(1), m.group(2).strip()))
            i += 1
            continue
        m = TSAN.search(ln)
        if m:
            flush()
            cur_label, cur_frames = None, []
            out.append("ThreadSanitizer: %s" % m.group(1))
            i += 1
            continue
        m = ACCESS.match(ln)
        if m:
            flush()
            cur_label, cur_frames = "%s %s bytes" % (m.group(1).lower(), m.group(2)), []
            i += 1
            continue
        m = SECTION.match(ln.strip())
        if m and not ln.startswith(" "):
            flush()
            label = m.group(1)
            label = re.sub(r" by thread \S+ here", "", label)
            label = re.sub(r" allocated from$", "", label)
            cur_label, cur_frames = label.strip(), []
            i += 1
            continue
        m = FRAME.match(ln)
        if m:
            if cur_label is None:
                cur_label = "stack"
            cur_frames.append((m.group(2), m.group(3)))
            i += 1
            continue
        m = UB.match(ln)
        if m:
            flush()
            cur_label, cur_frames = None, []
            out.append("UBSan: %s at %s" % (m.group(2), m.group(1)))
            i += 1
            continue
        m = SUMMARY.match(ln)
        if m:
            flush()
            cur_label, cur_frames = None, []
            out.append("   SUMMARY: %s" % m.group(2)[:160])
            i += 1
            continue
        m = VG_HEAD.match(ln)
        if m:
            flush()
            cur_label, cur_frames = None, []
            out.append("valgrind: %s" % m.group(1))
            j, fr = i + 1, []
            label = "at"
            while j < len(lines) and lines[j].startswith("==") and lines[j].strip("=0123456789 "):
                v = VG_FRAME.match(lines[j])
                a = VG_ADDR.match(lines[j])
                if v:
                    fr.append((v.group(1), v.group(2)))
                elif a:
                    proj = [f for f in fr if project(*f)]
                    out.append("   %s: %s" % (label, " <- ".join("%s (%s)" % (f, l) for f, l in proj[:3]) or "?"))
                    label, fr = a.group(1)[:70], []
                elif VG_HEAD.match(lines[j]) or VG_SUM.match(lines[j]):
                    break
                j += 1
            proj = [f for f in fr if project(*f)]
            out.append("   %s: %s" % (label, " <- ".join("%s (%s)" % (f, l) for f, l in proj[:3]) or "?"))
            i = j
            continue
        m = VG_SUM.match(ln)
        if m:
            out.append("valgrind " + m.group(1).strip())
        i += 1
    flush()
    return out


HINTS = {
    "heap-use-after-free": "object used after free/delete: check ownership, iterator/pointer invalidation (vector growth, erase)",
    "heap-buffer-overflow": "index past the allocation: off-by-one (<= vs <), wrong size in malloc (n * sizeof)",
    "stack-buffer-overflow": "local array indexed out of bounds, or strcpy/sprintf into a small buffer",
    "stack-use-after-return": "returning a pointer/reference to a local",
    "global-buffer-overflow": "static array indexed out of bounds",
    "double-free": "freed twice: set pointer to NULL after free, or fix ownership (unique_ptr)",
    "detected memory leaks": "missing free/delete on some path (early return, error path)",
    "SEGV": "null or wild pointer dereference: check the top project frame's pointers",
    "signed integer overflow": "use a wider type or check before the arithmetic",
    "null pointer": "check for NULL before use",
    "data race": "guard the shared variable with a mutex/atomic",
    "Invalid read": "read outside a live block (overflow or use after free)",
    "Invalid write": "write outside a live block (overflow or use after free)",
    "Conditional jump": "variable used before initialization",
}


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("file", nargs="?")
    ap.add_argument("--run")
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    rc = None
    if a.run:
        env = dict(os.environ)
        # detect_leaks is Linux-only; asking for it elsewhere makes ASan refuse to start
        env.setdefault("ASAN_OPTIONS", "abort_on_error=0:symbolize=1:detect_stack_use_after_return=1" +
                       (":detect_leaks=1" if sys.platform.startswith("linux") else ""))
        env.setdefault("UBSAN_OPTIONS", "print_stacktrace=1:halt_on_error=0")
        env.setdefault("TSAN_OPTIONS", "halt_on_error=0")
        p = subprocess.run(a.run, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, errors="replace", env=env)
        rc, lines = p.returncode, p.stdout.splitlines()
    elif a.file:
        src = sys.stdin if a.file == "-" else open(a.file, errors="replace")
        lines = src.read().splitlines()
    else:
        print(__doc__.strip())
        return 2
    out = parse(lines)
    if not out:
        out = ["no sanitizer or valgrind report found%s" % ("" if rc is None else " (exit %d)" % rc)]
    else:
        heads = [o for o in out if not o.startswith(" ")]
        for h in heads[:1]:
            for k, v in HINTS.items():
                if k in h:
                    out.append("hint: " + v)
                    break
    if len(out) > a.max:
        out = out[:a.max - 1] + ["(+%d more lines)" % (len(out) - a.max + 1)]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
