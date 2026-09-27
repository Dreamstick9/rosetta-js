#!/usr/bin/env python3
"""Run a shell script with line-numbered tracing and summarize what happened:
exit code, every command that returned non-zero (bash: via an ERR trap, with
line and command), error messages the script printed, and the last traced
commands before it stopped. Replaces several rounds of `bash -x` + scrolling.

usage:
  sh_trace.py SCRIPT [ARGS ...]            run it (interpreter from the shebang)
  sh_trace.py --shell sh SCRIPT [ARGS...]  force the interpreter (bash, sh, dash)
  sh_trace.py --stdin FILE SCRIPT ...      feed FILE on stdin (default: empty stdin)
options:
  --timeout S   kill after S seconds (default 60)
  --tail N      traced lines to show before the end (default 12)
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HOOK = r"""
set -o errtrace 2>/dev/null
trap 'echo "__ROSETTA_ERR__ rc=$? line=${LINENO} src=${BASH_SOURCE[0]##*/} cmd=${BASH_COMMAND}" >&2' ERR
PS4='+[${BASH_SOURCE[0]##*/}:${LINENO}] '
set -x
"""
ERRLINE = re.compile(r"^__ROSETTA_ERR__ rc=(\d+) line=(\d+) src=(\S*) cmd=(.*)$")
TRACE = re.compile(r"^(\++)(?:\[([^\]]*):(\d+)\]|\s?(\d+):)?\s?(.*)$")
DIAG = re.compile(r"(line \d+:|: not found|command not found|No such file|Permission denied|syntax error|"
                  r"unbound variable|bad substitution|unexpected|parameter null|integer expression|"
                  r"too many arguments|ambiguous redirect|cannot|error|Error|ERROR|fatal|failed)")


def interpreter(script, forced):
    if forced:
        return forced
    try:
        first = open(script, errors="replace").readline()
    except OSError:
        return "bash"
    m = re.match(r"^#!\s*(?:/usr/bin/env\s+)?(?:\S*/)?(\w+)", first)
    return m.group(1) if m and m.group(1) in ("bash", "sh", "dash", "ksh", "zsh") else "bash"


def main(argv):
    if not argv or "-h" in argv[:1] or "--help" in argv[:1]:
        print(__doc__.strip())
        return 0
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--shell")
    ap.add_argument("--stdin")
    ap.add_argument("--timeout", type=float, default=60)
    ap.add_argument("--tail", type=int, default=12)
    ap.add_argument("script")
    ap.add_argument("args", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    if not os.path.isfile(a.script):
        print("no such script: %s" % a.script)
        return 2
    sh = interpreter(a.script, a.shell)
    if not shutil.which(sh):
        sh = "bash" if shutil.which("bash") else "sh"
    env = dict(os.environ)
    hook = None
    if sh == "bash":
        fd, hook = tempfile.mkstemp(prefix="sh_trace_", suffix=".sh")
        with os.fdopen(fd, "w") as f:
            f.write(HOOK)
        env["BASH_ENV"] = hook
        cmd = ["bash", a.script] + a.args
    else:
        env["PS4"] = "+ ${LINENO:-?}: "
        cmd = [sh, "-x", a.script] + a.args
    stdin = open(a.stdin, "rb") if a.stdin else subprocess.DEVNULL
    timed_out = False
    try:
        p = subprocess.run(cmd, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env=env, timeout=a.timeout)
        rc, out_b, err_b = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        timed_out, rc = True, None
        out_b, err_b = e.stdout or b"", e.stderr or b""
    finally:
        if hook:
            os.unlink(hook)
    err = err_b.decode("utf-8", "replace").splitlines()
    stdout = out_b.decode("utf-8", "replace").splitlines()
    errs, traces, msgs = [], [], []
    for ln in err:
        m = ERRLINE.match(ln)
        if m:
            errs.append(m.groups())
            continue
        t = TRACE.match(ln)
        if t and ln.startswith("+"):
            if "__ROSETTA_ERR__" in ln or t.group(5).startswith("echo '__ROSETTA_ERR__") or \
                    t.group(5).startswith("echo \"__ROSETTA_ERR__"):
                continue
            src, lno = t.group(2), t.group(3) or t.group(4)
            traces.append("%s%s %s" % (("%s:" % src) if src else "", lno or "?", t.group(5)))
        elif ln.strip():
            msgs.append(ln.strip())
    out = ["%s %s -> %s  (stdout %d line(s), stderr %d message line(s))" % (
        sh, os.path.basename(a.script),
        "TIMEOUT after %gs" % a.timeout if timed_out else "exit %d" % rc, len(stdout), len(msgs))]
    if errs:
        out.append("non-zero commands (in order; `if`/`&&`/`||` conditions are not listed):")
        seen = set()
        for rc_, line, src, cmd_ in errs:
            k = (line, cmd_)
            if k in seen:
                continue
            seen.add(k)
            out.append("   %s:%s rc=%s  %s" % (src, line, rc_, cmd_[:120]))
            if len(seen) >= 8:
                break
    diag = [m for m in msgs if DIAG.search(m)] or msgs
    if diag:
        out.append("stderr:")
        out += ["   " + m[:160] for m in diag[:8]]
    if traces:
        out.append("last traced commands:")
        out += ["   " + t[:150] for t in traces[-a.tail:]]
    if stdout:
        out.append("stdout tail: " + " | ".join(s.strip() for s in stdout[-3:])[:200])
    print("\n".join(out[:40]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
