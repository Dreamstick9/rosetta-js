---
name: shell-scripting
internal: true
description: "Bash and POSIX sh scripts: quoting and word-splitting bugs, failing scripts, set -euo pipefail, portability to dash, bats tests, shellcheck-style fixes."
triggers:
  keywords: [bash, shell, shell script, sh script, posix sh, dash, shellcheck, bats, quoting, word splitting, set -e, pipefail, heredoc, subshell, command substitution, getopts, sed, awk, xargs, cron, entrypoint]
  files: ["*.sh", "*.bash", "*.bats", .shellcheckrc]
tools:
  - script: scripts/sh_map.py
    usage: "sh_map.py [DIR] [--func NAME] → every script with interpreter, strict flags, functions, sourced files; test suites + commands; shells/tools present; --func: def and callers"
  - script: scripts/sh_lint.py
    usage: "sh_lint.py [PATH ...] [--posix] [--style] → shellcheck (grouped) or built-in checks: unquoted vars, cd guard, ls loops, read -r, rm -rf $x/*, bashisms in sh"
  - script: scripts/sh_trace.py
    usage: "sh_trace.py [--shell sh] [--stdin FILE] SCRIPT [ARGS] → runs traced; exit code, each non-zero command with line, stderr errors, last traced lines"
checks:
  - "git ls-files -z '*.sh' '*.bash' | xargs -0 -n1 bash -n"
  - bats test
---
# Shell scripting

## When it applies
- The task changes or fixes `.sh`/`.bash` scripts, a Makefile recipe's shell, a Docker entrypoint, a CI
  step or a cron job, or its tests are bats/shunit2/plain shell scripts.
- Symptoms: breaks on filenames with spaces, "command not found", "unbound variable", works in bash
  but not in `sh`/dash, exits 0 despite a failure, or a variable is empty after a loop.

## Workflow
1. `python3 skills/shell-scripting/scripts/sh_map.py`: which interpreter each script really uses (the shebang decides:
   `#!/bin/sh` is dash on Debian/Ubuntu, not bash), strict-mode flags, functions and test commands.
   `sh_map.py --func NAME` finds a function's definition and every caller.
2. Reproduce: `python3 skills/shell-scripting/scripts/sh_trace.py path/script.sh ARGS` shows the exact failing command
   and line, the error text, and the traced commands before it. Use `--stdin FILE` for scripts that read input.
3. Lint what you touch: `python3 skills/shell-scripting/scripts/sh_lint.py path/script.sh` (add `--posix` if the script
   must run under `sh`). Fix real findings in the changed lines; do not reformat the whole file.
4. Test with the project's harness (bats: `bats test/` or `bats -f 'name' test/x.bats`). Add a case
   for the bug, e.g. a filename with a space or an empty argument.
5. Re-run under the target shell: `sh script.sh` / `dash script.sh` if the shebang is `/bin/sh`.

## Rules that fix most bugs
- Quote every expansion: `"$var"`, `"$(cmd)"`, `"$@"`. Unquoted only where splitting is intended and commented.
- Strict mode for bash: `set -euo pipefail`; for sh: `set -eu`. Know its holes: `set -e` is ignored
  inside `if`/`&&`/`||` conditions and in functions called from them; `local x=$(cmd)` hides cmd's failure.
- `cd dir || exit 1`; `rm -rf "${dir:?}/"*`; temp files via `mktemp` plus `trap 'rm -rf "$tmp"' EXIT`.
- Iterate files with globs (`for f in dir/*`), or `find ... -print0 | xargs -0` / `while IFS= read -r -d ''`,
  never `for f in $(ls)` or `$(find)`.
- Read lines with `while IFS= read -r line; do ...; done < file`; a `cmd | while` loop runs in a subshell
  and its variables vanish (bash: `done < <(cmd)`; sh: a temp file).
- `printf '%s\n' "$x"` instead of `echo` for arbitrary data (`echo -e`/`-n` and backslashes differ between shells).
- `[ "$a" = "$b" ]` in sh (`==` is a bashism); `[ -n "$x" ]`, not `[ $x ]`; numbers: `-eq`/`-lt`.
- Arithmetic: `$((a + 1))` (POSIX); no `let`, no `((...))` in sh.
- Errors to stderr (`>&2`) and a non-zero `exit` on failure; usage text on bad arguments.
- Argument parsing: `getopts` (POSIX, short options) or a `while [ $# -gt 0 ]; do case "$1" in ... esac; shift; done` loop.

## Checklist
- [ ] The failure reproduced with `sh_trace.py` (or a bats test) before the fix
- [ ] All expansions in changed lines quoted; `"$@"` for argument forwarding
- [ ] Works under the shebang's shell (`sh`/dash for `#!/bin/sh`)
- [ ] Exit codes: failures return non-zero; no errors swallowed by pipes (pipefail) or `|| true`
- [ ] Paths with spaces and empty variables handled
- [ ] `sh_lint.py` clean for the changed lines; tests pass

## Pitfalls
- `#!/bin/sh` with bash features: works on macOS (sh is bash) and fails on Ubuntu (sh is dash).
- `[[ ]]`, arrays, `${var//a/b}`, `<<<`, `&>`, `source`, `{1..5}`, `function f` in sh scripts.
- `grep` in a pipeline under `pipefail` returns 1 when nothing matches: handle it (`|| true` where intended).
- CRLF line endings (`$'\r': command not found`): convert with `sed -i 's/\r$//' FILE`.
- `2>&1 >file` sends stderr to the terminal; the order is `>file 2>&1`.
- Unset variables in `rm -rf "$DIR/"` or `cd "$DIR"` acting on `/` or `$HOME`: use `${DIR:?}`.
- `trap ... EXIT` overwritten by a later trap; one cleanup function instead.
- `sed -i` differs: GNU `sed -i 's/a/b/'` vs BSD/macOS `sed -i '' 's/a/b/'`; portable: write to a temp file and `mv`.
- Relying on `which` (not POSIX): use `command -v`.
- Scripts run from another directory: resolve paths from `"$(dirname "$0")"`, not the caller's cwd.

## Research (web_search / web_fetch)
- ShellCheck rule explanations: `https://www.shellcheck.net/wiki/SC2086` (replace the code).
- POSIX shell command language: `https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html`.
- Bash reference manual: `https://www.gnu.org/software/bash/manual/bash.html`.
- Bashisms and dash differences: `https://mywiki.wooledge.org/Bashism`; pitfalls: `https://mywiki.wooledge.org/BashPitfalls`.
- bats-core usage: `https://bats-core.readthedocs.io/`.
