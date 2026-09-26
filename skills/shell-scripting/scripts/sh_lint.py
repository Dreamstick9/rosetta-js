#!/usr/bin/env python3
"""Shellcheck-style lint for sh/bash scripts, summarized. Uses the real
shellcheck when installed (grouped by code); otherwise runs built-in checks for
the bugs that matter most: unquoted expansions, cd without a guard, `for` over
ls, read without -r, dangerous rm, masked return codes, bashisms in #!/bin/sh
scripts, missing shebang, CRLF line endings.

usage:
  sh_lint.py [PATH ...]      files or dirs (default: .); dirs are scanned for shell scripts
options:
  --builtin    use the built-in checks even if shellcheck exists
  --posix      also report bashisms in scripts without an sh shebang
  --style      include style notes (backticks, $? tests)
  --max N      max output lines (default 40)
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

SKIP = {".git", "node_modules", "vendor", "target", "build", "dist", ".venv", "venv", "__pycache__"}
SHEBANG = re.compile(r"^#!\s*(?:/usr/bin/env\s+(?:-S\s+)?)?(?:\S*/)?(\w+)")
SAFE_SPECIAL = set("?#$!-")
BASHISMS = [
    (re.compile(r"(^|[\s;&|(])\[\["), "B01", "[[ ]] is bash/ksh: use [ ] in sh"),
    (re.compile(r"(^|[\s;&|])\[ [^]]*[^=!<>]==[^=]"), "B02", "== inside [ ] is a bashism: use ="),
    (re.compile(r"^\s*function\s+\w+"), "B03", "`function name` is a bashism: use name() { ... }"),
    (re.compile(r"(^|[\s;])\w+=\((?!\))"), "B04", "arrays are bash-only"),
    (re.compile(r"\$\{\w+//?[^}]*/"), "B05", "${var/pat/rep} is bash-only: use sed or case"),
    (re.compile(r"\$\{\w+:(\d+|\s-\d+)(:\d+)?\}"), "B06", "${var:off:len} substring is bash-only"),
    (re.compile(r"<<<"), "B07", "here-strings (<<<) are bash-only: use printf ... |"),
    (re.compile(r"&>"), "B08", "&> is bash-only: use >file 2>&1"),
    (re.compile(r"(^|[\s;])source\s"), "B09", "`source` is bash-only: use ."),
    (re.compile(r"\$RANDOM|\$\{RANDOM\}"), "B10", "$RANDOM is not POSIX"),
    (re.compile(r"\{\d+\.\.\d+\}"), "B11", "{1..N} brace expansion is bash-only: use seq or a while loop"),
    (re.compile(r"\$'"), "B12", "$'...' quoting is not POSIX (dash): use printf"),
    (re.compile(r"(^|[\s;])(declare|typeset|shopt|mapfile|readarray|pushd|popd|let)\s"), "B13",
     "bash builtin not in POSIX sh"),
    (re.compile(r"(^|[\s;])echo\s+-[neE]+\s"), "B14", "echo -n/-e is not portable: use printf"),
    (re.compile(r"set -o pipefail"), "B15", "pipefail is missing in older dash/busybox sh"),
    (re.compile(r"\$\{!\w+"), "B16", "${!var} indirection is bash-only"),
    (re.compile(r"(^|[\s;])(select)\s+\w+\s+in"), "B17", "select is bash/ksh-only"),
]


def is_shell(path):
    if path.endswith((".sh", ".bash", ".ksh", ".bats", ".zsh")):
        return True
    if os.path.splitext(path)[1]:
        return False
    try:
        with open(path, "rb") as f:
            head = f.read(80)
        m = SHEBANG.match(head.decode("utf-8", "replace"))
        return bool(m) and m.group(1) in ("sh", "bash", "dash", "ksh", "ash", "zsh")
    except OSError:
        return False


def collect(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            for base, dirs, fs in os.walk(p):
                dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith("."))
                for f in sorted(fs):
                    fp = os.path.join(base, f)
                    if is_shell(fp):
                        files.append(fp)
        elif os.path.isfile(p):
            files.append(p)
    return files


def strip_line(line, state):
    """Return (code, mask): mask[i] is ' ' when char i is unquoted in its own command context,
    'Q' when quoted. A stack tracks "..." / '...' / $(...) nesting across lines; comments are cut."""
    st = state.setdefault("stack", [])
    out, mask = [], []
    i = 0
    while i < len(line):
        c = line[i]
        top = st[-1] if st else "C0"
        if top == "S":
            if c == "'":
                st.pop()
            out.append(c)
            mask.append("Q")
        elif top == "D":
            if c == "\\" and i + 1 < len(line):
                out.append(line[i:i + 2])
                mask.append("QQ")
                i += 2
                continue
            if c == '"':
                st.pop()
            elif line.startswith("$(", i) and not line.startswith("$((", i):
                st.append("C")
                out.append("$(")
                mask.append("QQ")      # the substitution's result is quoted
                i += 2
                continue
            out.append(c)
            mask.append("Q")
        else:
            if c == "\\" and i + 1 < len(line):
                out.append(line[i:i + 2])
                mask.append("QQ")
                i += 2
                continue
            if c == "#" and (i == 0 or line[i - 1] in " \t;&|("):
                break
            if c == "'":
                st.append("S")
                mask.append("Q")
            elif c == '"':
                st.append("D")
                mask.append("Q")
            elif line.startswith("$(", i) and not line.startswith("$((", i):
                st.append("C")
                out.append("$(")
                mask.append("  ")
                i += 2
                continue
            elif c == "(" and top == "C":
                st.append("P")
                mask.append(" ")
            elif c == ")" and top in ("C", "P"):
                st.pop()
                mask.append(" ")
            else:
                mask.append(" ")
            out.append(c)
        i += 1
    if len(st) > 50:
        del st[:]
    return "".join(out), "".join(mask)


def arith_spans(code):
    """Character ranges inside $(( )) / (( )) where expansions are not split."""
    spans = []
    for m in re.finditer(r"\$?\(\(", code):
        depth, j = 0, m.start()
        while j < len(code):
            if code[j] == "(":
                depth += 1
            elif code[j] == ")":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        spans.append((m.start(), j))
    return spans


def unquoted_expansions(code, mask):
    """(code, name) for $ expansions outside quotes that undergo word splitting."""
    words = [(m.start(), m.end(), m.group(0)) for m in re.finditer(r"\S+", code)]
    first = words[0][2] if words else ""
    if "[[" in code or first in ("let", "((") or (first == "case" and re.search(r"\sin\b", code)):
        return []
    arith = arith_spans(code)
    res = []
    for i, c in enumerate(code):
        if c != "$" or mask[i] != " " or any(a <= i <= b for a, b in arith):
            continue
        word = next((w for s, e, w in words if s <= i < e), "")
        if re.match(r"^[A-Za-z_]\w*(\[[^]]*\])?\+?=", word):
            continue            # assignment: no splitting
        rest = code[i + 1:]
        if rest.startswith("("):
            res.append(("SC2046", "$(...)"))
        elif rest.startswith("{"):
            if rest.startswith("{#"):
                continue        # length is a number
            m = re.match(r"\{!?(\w+|[@*])", rest)
            name = m.group(1) if m else "?"
            res.append(("SC2068" if name == "@" else "SC2048" if name == "*" else "SC2086", name))
        elif rest[:1] == "@":
            res.append(("SC2068", "@"))
        elif rest[:1] == "*":
            res.append(("SC2048", "*"))
        elif rest[:1] and rest[:1] not in SAFE_SPECIAL:
            m = re.match(r"(\w+)", rest)
            if m:
                res.append(("SC2086", m.group(1)))
    return res


MSG = {
    "SC2086": "unquoted $%s: word splitting and globbing; use \"$%s\"",
    "SC2046": "unquoted %s: result is word-split; quote it \"$(...)\"",
    "SC2068": "unquoted $@: use \"$@\" to keep arguments intact",
    "SC2048": "$* joins/splits arguments: use \"$@\"",
    "SC2164": "cd without `|| exit`: the script continues in the wrong directory if cd fails",
    "SC2045": "iterating over ls output breaks on spaces: use a glob (for f in dir/*)",
    "SC2162": "read without -r mangles backslashes: use read -r",
    "SC2115": "rm -rf on a variable path: if it is empty this deletes from /; use \"${VAR:?}\"",
    "SC2155": "declare and assign separately: local/export x=$(cmd) masks cmd's exit status",
    "SC2088": "tilde does not expand inside quotes: use \"$HOME\"",
    "SC2006": "legacy backticks: use $(...)",
    "SC2181": "check the command directly (if cmd; then) instead of $?",
    "SC2069": "2>&1 >file order sends stderr to the terminal: use >file 2>&1",
    "SC1017": "CRLF line endings: the script will fail with $'\\r' errors; convert to LF",
    "SC2148": "no shebang: the interpreter is unknown; add #!/bin/sh or #!/usr/bin/env bash",
    "SC2002": "",
    "E001": "no `set -e`/`set -u` and no explicit error checks: failures are silently ignored",
    "SC2034": "",
    "SC2030": "variables set inside `cmd | while read` are lost after the loop (subshell): use < file or < <(cmd)",
}


def lint_file(path, posix, style):
    try:
        raw = open(path, "rb").read()
    except OSError:
        return []
    text = raw.decode("utf-8", "replace")
    lines = text.split("\n")
    finds = []
    if b"\r\n" in raw:
        finds.append((1, "SC1017", MSG["SC1017"]))
    m = SHEBANG.match(lines[0]) if lines else None
    shell = m.group(1) if m else ""
    if not m and not path.endswith(".bats"):
        finds.append((1, "SC2148", MSG["SC2148"]))
    is_sh = shell in ("sh", "dash", "ash") or (posix and shell != "bash")
    has_set_e = re.search(r"^\s*set\s+-[a-z]*e|set -o errexit|^#!.*\s-e\b", text, re.M) is not None
    state, heredoc = {}, None
    for n, line in enumerate(lines, 1):
        if heredoc:
            if line.strip() == heredoc or (line.lstrip("\t") == heredoc):
                heredoc = None
            continue
        code, mask = strip_line(line.rstrip("\r"), state)
        h = re.search(r"<<-?\s*(['\"]?)(\w+)\1", code)
        if h and "<<<" not in code:
            heredoc = h.group(2)
        if not code.strip():
            continue
        # quoted text blanked out (quote chars kept) so keyword checks ignore strings
        bare = "".join(ch if (mk == " " or ch in "'\"") else "_" for ch, mk in zip(code, mask))
        seen = set()
        for kind, name in unquoted_expansions(code, mask):
            if kind in seen:
                continue
            seen.add(kind)
            msg = MSG[kind] % ((name, name) if kind == "SC2086" else (name,) if kind == "SC2046" else ())
            if re.match(r"^\s*for\s+\w+\s+in\s", code):
                msg += " (ok only if splitting is intended)"
            finds.append((n, kind, msg))
        if re.search(r"(^|[;&|]\s*|then\s+|do\s+)cd\s+[^;&|]*$", bare) and not has_set_e and \
                not re.search(r"\|\||&&", bare):
            finds.append((n, "SC2164", MSG["SC2164"]))
        if re.search(r"for\s+\w+\s+in\s+(\$\(|`)\s*ls\b", bare):
            finds.append((n, "SC2045", MSG["SC2045"]))
        if re.search(r"(^|[\s;|&])read\s+(?!.*-\w*r)", bare) and not re.search(r"read\s+-\w*r", bare):
            finds.append((n, "SC2162", MSG["SC2162"]))
        if re.search(r"\brm\s+-\w*[rR]\w*\s+(-\S+\s+)*\"?\$\{?\w+\}?\"?/?\*?(\s|;|$)", code) and ":?" not in code:
            finds.append((n, "SC2115", MSG["SC2115"]))
        if re.search(r"^\s*(local|export|readonly|declare)\s+\w+=\$\(", bare):
            finds.append((n, "SC2155", MSG["SC2155"]))
        if re.search(r"[\"']~/", code):
            finds.append((n, "SC2088", MSG["SC2088"]))
        if re.search(r"2>&1\s*>\s*\S", bare):
            finds.append((n, "SC2069", MSG["SC2069"]))
        if re.search(r"\|\s*while\s+(IFS=\S*\s+)?read\b", bare):
            finds.append((n, "SC2030", MSG["SC2030"]))
        if style:
            if "`" in code.replace("\\`", ""):
                finds.append((n, "SC2006", MSG["SC2006"]))
            if re.search(r"\[\s+\$\?\s+-(ne|eq)\s+0", code):
                finds.append((n, "SC2181", MSG["SC2181"]))
        if is_sh:
            for rx, code_id, msg in BASHISMS:
                if rx.search(bare):
                    finds.append((n, code_id, "bashism: " + msg))
                    break
    if not has_set_e and len(lines) > 15 and style:
        finds.append((1, "E001", MSG["E001"]))
    return [(path, n, c, msg) for n, c, msg in finds]


def run_shellcheck(files):
    p = subprocess.run(["shellcheck", "-f", "gcc", "-x"] + files, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, universal_newlines=True, errors="replace")
    out = []
    for ln in p.stdout.splitlines():
        m = re.match(r"^(.+?):(\d+):\d+: (\w+): (.*?) \[(SC\d+)\]$", ln)
        if m:
            if m.group(3) == "note" and m.group(5) in ("SC2006",):
                continue
            out.append((m.group(1), int(m.group(2)), m.group(5), m.group(4)))
    return out


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("paths", nargs="*", default=["."])
    ap.add_argument("--builtin", action="store_true")
    ap.add_argument("--posix", action="store_true")
    ap.add_argument("--style", action="store_true")
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args(argv)
    files = collect(a.paths or ["."])
    if not files:
        print("no shell scripts found in %s" % " ".join(a.paths))
        return 0
    engine = "shellcheck" if shutil.which("shellcheck") and not a.builtin else "built-in checks"
    finds = run_shellcheck(files) if engine == "shellcheck" else []
    if engine != "shellcheck":
        for f in files:
            finds += lint_file(f, a.posix, a.style)
    counts = {}
    for f in finds:
        counts[f[2]] = counts.get(f[2], 0) + 1
    out = ["%s: %d finding(s) in %d of %d script(s)" % (engine, len(finds), len({f[0] for f in finds}), len(files))]
    if counts:
        out.append("by code: " + ", ".join("%s x%d" % (k, v) for k, v in
                                           sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))))
    srcs = {}
    for path, n, code, msg in finds[: a.max * 2]:
        if len(out) >= a.max - 1:
            break
        if path not in srcs:
            try:
                srcs[path] = open(path, errors="replace").read().split("\n")
            except OSError:
                srcs[path] = []
        src = srcs[path][n - 1].strip() if n - 1 < len(srcs[path]) else ""
        out.append("%s:%d %s %s" % (path, n, code, msg[:120]))
        if src and code not in ("SC1017", "SC2148", "E001"):
            out.append("      %s" % src[:110])
    if len(finds) and len(out) >= a.max - 1:
        out = out[:a.max - 1] + ["(+more; lint one file at a time)"]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
