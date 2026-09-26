# Evals

A hard benchmark for the harness, run the way the judges run it: headless
`node src/cli.js`, the task text on stdin, `REPO` set to a fresh checkout, no
prompts. Hidden tests are added only after the agent has finished.

```bash
export AI_API_KEY="$(cat ~/.rosetta-hc-key)"
make eval                      # all 12 tasks, 1 run, sequential (~20-40 min, well under $1)
make eval-quick                # 4 fast tasks
make eval-check                # no model: reference fix must pass, no change must fail
make eval EVAL_ARGS="--tasks pytest-7490,feature-tinydb-unique --runs 2"
node evals/run.js --ab "digest.enabled=true" "digest.enabled=false" --runs 2
```

Needs `git`, `uv` (Python tasks) and `npm` (JS tasks). Repos are cached in
`~/.cache/rosetta-js/evals/repos`; Python versions and wheels come from the
uv cache, so reruns only pay for the agent.

## Options

| Option | Meaning |
| --- | --- |
| `--tasks a,b` | only these task ids |
| `--quick` | only tasks with `"quick": true` |
| `--runs N` | repeat each task N times |
| `--parallel N` | N jobs at once (default 1; concurrency distorts latency) |
| `--env "K=v a.b=c"` | settings for every run: `UPPER_CASE` keys are env vars, dotted keys patch `config.json` of a private harness copy |
| `--ab "A" "B"` | run both settings arms (interleaved per task) and print per-task and total deltas |
| `--oracle gold\|none` | skip the agent: apply the reference fix, or change nothing |
| `--harness DIR` | evaluate another rosetta-js checkout (e.g. a sibling worktree) |
| `--timeout S` | per-task agent timeout in seconds |
| `--keep` | keep the work folders |

## Output

`evals/results/<timestamp>.md` (table plus totals, and the A/B table) and
`.json` (every record). Per-job logs go to `evals/results/<timestamp>/<job>/`:
`agent.log` (harness stdout), `trace.jsonl` (copied from the harness copy's
`runs/`) and `grade.log`. The log folders are gitignored.

Recorded per run: pass/fail, $, input, cached and output tokens, seconds,
model calls, tool calls by name, tool errors, big tool outputs (>= 8 KB),
compactions, skills, sub-agents, attempts (done-check runs) and blocked
commands. Skills, sub-agents and blocked commands are read from trace entries
of type `skill`, `subagent` and `blocked` (or tools whose names say so), so
they show up once the harness writes them.

## How a job runs

1. `git archive <commit>` from the cached clone into a temp folder, run the
   task's `setup` commands, then `git init` + one `base` commit (no upstream
   history, so the fix cannot be looked up).
2. Copy the harness (without `.git`, `runs`, `evals`) and apply `config.json`
   settings; run `node src/cli.js` with `REPO` set, the task's `.venv`
   activated, and the task text on stdin.
3. Grade: restore the task's `restore` paths from `base`, add the hidden tests
   (`hidden.patch`, or copy `hidden.files` over the repo), run `grade`.
   `EVAL_TASK_DIR`, `EVAL_REPO` and `EVAL_AGENT_OUTPUT` are set.

## Tasks

| id | category | what it stresses |
| --- | --- | --- |
| `pytest-7490` | issue (SWE-bench Verified) | dynamic xfail marker; 15 min-1 h fix in pytest internals |
| `pytest-10051` | issue (SWE-bench Verified) | caplog `get_records`/`clear` divergence |
| `pytest-8399` | issue (SWE-bench Verified) | fixture naming across two modules |
| `marshmallow-1343` | issue (SWE-bench Lite dev) | nested schema + `validates` crash, 2.x codebase |
| `requests-5414` | issue (SWE-bench Verified) | IDNA error mapping to `InvalidURL` |
| `pydicom-1694` | issue (SWE-bench Lite dev) | exception handling in `to_json_dict` |
| `refactor-tinydb-utils` | refactor, 6 files | split `utils.py` into modules, update imports and tests; structure check |
| `refactor-commander-utils` | refactor, 6 files (JS) | move helpers into `lib/utils.js`; structure check |
| `feature-tinydb-unique` | multi-step | unique indexes across errors/table/database/`__init__`, atomic writes, persistence |
| `feature-commander-deprecated` | multi-step (JS) | deprecated options across option/help/command/typings |
| `debug-marshmallow-errors` | long output | one-line root cause, 159 failing tests, ~150 KB of pytest output |
| `impossible-tinydb-str-ids` | impossible | contradictory request; must say so and leave the tests green |

Issue tasks are graded by applying the upstream test changes of the fix
commit and running the FAIL_TO_PASS tests plus a PASS_TO_PASS sample from the
same file. A task file holds `id`, `category`, `repo`, `commit`, `task`,
`setup`, `grade`, and optionally `hidden`, `restore`, `gold`, `goldOutput`,
`quick` and `timeoutSeconds`; supporting files live in `tasks/<id>/`.

DeepSeek run-to-run noise is about ±30% per task on $ and seconds: compare
totals, and use `--runs 2` or more before trusting a difference.
