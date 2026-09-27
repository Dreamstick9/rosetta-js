# rosetta-js

A small coding agent for the terminal, in plain JavaScript (Node.js 20.6+,
no npm dependencies). It talks to an OpenAI-compatible chat completions API,
takes a GitHub issue or a task as text, works on one repository, and never
stops to ask a human anything: the only input is the task.

It can clone the repo and read the issue itself, follow the project's
AGENTS.md and skills, plan multi-step work with checks the harness runs,
checkpoint every turn in a shadow git repo, retry failed attempts with
lessons written by code, and fan out to parallel sub-agents when the work
splits into independent pieces. A safety policy blocks dangerous tool calls
without ever prompting.

## Judge flow

```bash
export AI_API_KEY="<key>"     # the only credential; read only from the environment
make setup                    # checks Node >= 20.6, else installs a pinned Node into .tools/
make run                      # launches the agent (TUI in a terminal, headless on a pipe)
```

Then paste the GitHub issue (URL or text) and press Enter. A multi-line paste
is one message. The agent prints the model and the working folder at start,
works the task, prints a footer and a one-line JSON summary on stderr, and
exits. Nothing else is ever asked.

Script-driven runs work the same way through a pipe or a pseudo-terminal:

```bash
printf 'Fix the failing test in test_math.py\n' | make run REPO=/path/to/project
make run REPO=/path/to/project ISSUE=issue.txt               # issue text from a file
make run ISSUE="https://github.com/owner/repo/issues/12"     # clones the repo, reads the issue
script -q /dev/null make run REPO=/path/to/project            # TUI in a pseudo-terminal
```

Exit codes: `0` done, `1` error, gave up or tests still failing, `3` stopped
by `maxTurns` or `maxSessionUsd`. The last line on stderr is
`{"status":"done","cost":0.0002,"seconds":19.1,"filesChanged":1}`.

## Working folder

Resolved without asking, first match wins:

1. `REPO`, `TARGET_REPO` or `REPO_PATH` (an existing folder; `REPO_PATH` may
   also be the clone target).
2. A GitHub issue/repo URL or a `Repository: owner/repo` line in the task:
   intake clones it (shallow) or reuses and fetches an existing checkout, into
   `REPO_PATH`, else `WORK_DIR/<owner>-<repo>`, else `/tmp/rjs-work/<owner>-<repo>`.
3. The current folder, when it is not inside rosetta-js.
4. Otherwise `/tmp/rjs-work`.

The rosetta-js folder itself is never used as the working folder.

## Make targets

| Target       | What it does |
| ------------ | ------------ |
| `make setup` | checks for Node.js >= 20.6; if missing, downloads the pinned Node (v24.21.0) into `.tools/node`, verified against `SHASUMS256.txt` (no sudo). Safe to run again. |
| `make run`   | evaluation mode: one task, then exit. TUI in a terminal; headless when stdin is piped, `ISSUE` is set, or `-p` is given. |
| `make chat`  | the same TUI, but it keeps taking messages after each task. |
| `make test`  | syntax check, deterministic tests (policy probes, skills, intake parsing, workspaces, plan/checkpoints/lessons, orchestrator, tool-call repair, skill router and digests), then, with `AI_API_KEY` set, a live run that must fix a buggy fixture. |
| `make clean` | removes `runs/`, `.tools/` and the `/tmp/rjs-*` scratch folders. |
| `make eval` | hidden-test benchmark of 12 tasks with an A/B mode (see `evals/README.md`); `EVAL_ARGS` passes options. |
| `make eval-quick` | only the tasks marked quick. |
| `make eval-check` | checks the benchmark itself: gold patches must pass and no-op runs must fail. |

`make run` and `make test` put `.tools/node/bin` first on `PATH` and load
`.env` when present (see `.env.example`; exporting `AI_API_KEY` is the
primary path).

## Commands and flags

| Input | Effect |
| ----- | ------ |
| `-p "task"` / `ISSUE=...` / piped stdin | headless run of one task |
| `--chat` | keep the TUI open after a task |
| `--plain`, `ROSETTA_UI=line` | use the plain line interface instead of the TUI |
| `--resume`, `/resume` | continue the task saved in `<repo>/.rosetta/session.json` |
| `--best-of N`, `/best-of N <task>` | tournament: N workers on the task in private copies, the best one is merged |
| `/help` | list the commands |
| `/new` | clear the conversation |
| `/cost` | session cost, tokens and a per-role breakdown |
| `/check off`, `/check on` | turn the test check after changes off or on |
| `/diff` | what changed since the session started (shadow checkpoints) |
| `/undo` | restore the previous checkpoint |
| `/exit`, Ctrl-D | quit |
| Esc or Ctrl-C during a turn | stop the turn and every running sub-agent |

## Terminal UI

In a terminal, `make run` opens a full-screen-width TUI modelled on the Codex
CLI: finished output goes into the normal scrollback, and a live area at the
bottom holds the running work, a status line
(`• Working (12s • esc to interrupt)`), the input box and a footer with key
hints and how much context is left. `--plain` (or piped/headless input) keeps
the simple line interface.

What it shows:

- your message (`› …`), the agent's reply streamed as Markdown (`• …`)
- `• Explored` groups for `read_file`, `list_files` and `search`
- `• Ran <command>` with the first and last lines of output (red when the exit code is not 0)
- `• Edited <file> (+a -d)` / `• Added` / `• Deleted` with a line-numbered diff
- `• Blocked …` with the policy reason, `• Ran tests …` for the done-check,
  retries, compaction notices and a `─ Worked for 6s · $0.0002 · … ─` line per task
- the model's reasoning headline in the status line; the full reasoning in the transcript (Ctrl-T)

| Command       | Effect |
| ------------- | ------ |
| `/model`      | pick a model from `{baseUrl}/models` (cost reporting keeps `pricing.*` from `config.json`) |
| `/approvals`  | switch the safety policy between `standard` and full access (`off`) |
| `/new`        | clear the conversation |
| `/compact`    | compact the conversation now |
| `/diff`       | show `git diff` against HEAD, including untracked files |
| `/mention`    | insert `@` to pick a file |
| `/status`     | model, endpoint, folder, policy, test check, limits, trace, cost, tokens, context |
| `/cost`       | session cost, token totals and trace file |
| `/check [on\|off]` | toggle the test check after changes |
| `/help`       | commands and keys |
| `/quit`, `/exit` | quit |

Typing `/` opens the command list and `@` opens a fuzzy file search; ↑/↓ choose,
Tab completes, Enter runs or inserts, Esc closes. Model and policy changes are
recorded in the trace as `setting` lines.

| Key | Effect |
| --- | ------ |
| Enter | send; while a task runs the message is queued (`↳ …`) and sent afterwards |
| Shift-Enter, Ctrl-J | newline |
| Esc | interrupt the running task (queued messages return to the input) |
| Ctrl-C | interrupt, clear the input, or quit when pressed twice |
| Ctrl-D | quit when the input is empty |
| ↑ / ↓ | move between lines, then through earlier messages |
| Ctrl-T | transcript overlay (↑/↓, PgUp/PgDn, Home/End, q) |
| Ctrl-L | clear the screen |
| Ctrl-A/E, Ctrl-U/K, Ctrl-W, Alt-←/→ | line and word editing |

Pastes of 1000 characters or more show as `[Pasted Content N chars]` and are
sent in full. With `exitAfterTask: true` (the judge flow) the TUI exits after
the first task; `--chat` keeps it open. Lines that start with `/` are never
sent to the model.

The plain interface (`--plain`) keeps the original commands: `/help`, `/new`,
`/cost`, `/check on|off`, `/exit`.

## Safety policy (never prompts)

Every tool call is either allowed or blocked by code (`"policy": "standard"`;
`"off"` disables it). A blocked call returns
`Blocked by policy: <reason>. Choose another way.` to the model, runs
nothing, and is logged in the trace. Blocked:

- recursive delete of the working folder root, `$HOME`, or anything outside
  the working folder and `/tmp`;
- writing or deleting outside the working folder and `/tmp`;
- `git push` (and force-push), changing remotes, `gh auth` and GitHub-changing
  `gh` commands;
- reading credential files (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`,
  `~/.git-credentials`, `*.pem`/`*.key`/`.env` outside the repo);
- reading secret environment variables (`$AI_API_KEY`, `$..._TOKEN`, ...).

Everything else runs: builds, tests, installs in the repo, `rm` inside the
repo. Commands are parsed into shell words with quotes, redirects
(`2>&1`, `>&2`, `2>/dev/null` are not files), heredocs, `$(...)`, `bash -c`
and `cd` tracking. The shell never sees `AI_API_KEY`, `GITHUB_TOKEN`,
`GH_TOKEN` or other secret-named variables, and runs with no-prompt settings
(`GIT_TERMINAL_PROMPT=0`, `CI=true`, `PIP_NO_INPUT=1`, pager and editor off).
Explorer sub-agents are read-only.

## How it works

- **Intake** (no model calls): parses the issue/repo URL, fetches title, body
  and comments from the GitHub REST API, clones, and hands the model a clean
  task message. Private repos use `GITHUB_TOKEN`, `GH_TOKEN` or
  `gh auth token`; the token only goes into the API header and a per-command
  git environment, never into URLs, remotes, argv, logs, traces or messages.
- **Stable prefix**: one system message per session (base prompt, the first
  of `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` capped at
  ~4k tokens, a sorted catalog of at most 40 skills, the last 5 lessons) plus
  a constant tool list, checked on every request so prompt caching holds.
- **Skills**: folders with a `SKILL.md` in `<repo>/.agents/skills`,
  `<repo>/.claude/skills`, `<repo>/.rosetta/skills`, `~/.claude/skills`,
  `~/.agents/skills`, `~/.rosetta/skills` and `skills/` here (bug-fix,
  test-writing, code-review). The `skill` tool loads one on demand.
- **Tools**: `list_files`, `read_file`, `create_file`, `write_file`,
  `edit_file`, `delete_file`, `search`, `bash` (one persistent shell),
  `skill`, `todo`, `give_up`, `task`.
  With `web.enabled`, also `web_search` and `web_fetch`.
- **Done-check**: after a turn that changed files the project's tests run
  (`npm test`, pytest/unittest, `cargo test`, `go test`); failures go back to
  the model.
- **Plan ledger**: `todo` items may carry a check command; the harness ticks
  an item (☐ ◐ ☑ ✗) only when its check exits 0. Saved in `.rosetta/plan.json`.
- **Checkpoints**: a shadow repo in `<repo>/.rosetta/shadow.git` snapshots the
  files every turn and at every tick; the repo's own `.git` is never touched.
  `.rosetta/` is added to `.git/info/exclude`.
- **Stall and improve loop**: 6 turns without progress add a note asking for a
  new hypothesis; 12 end the attempt. A failed attempt gets a lesson written
  by code (goal, diff stat, failing tests, last errors, approaches) in
  `.rosetta/lessons.jsonl`, the files are restored and a fresh attempt starts
  with the lessons, up to `maxAttempts`. Attempts are scored and the best is
  kept. `give_up` is refused until 2 real attempts, then restores the best
  checkpoint.
- **Multi-agent**: the `task` tool starts explorers (read-only, parallel),
  workers (each in a private copy under `/tmp/rjs-agents/`, with
  `node_modules`, `.venv` and `target` symlinked) or a reviewer (off by
  default). Sub-agents get only their role prompt, the same tool list, their
  sub-task, plan items, files and relevant lessons, never the main history,
  and return at most 10 lines plus changed files. The harness builds a
  dependency graph (`depends_on` plus overlapping files), runs independent
  items in parallel (`maxParallelAgents`), makes dependents wait for their
  predecessors to merge, merges file by file (conflicts keep main and report a
  diff), and runs the done-check after each wave. Small fixes stay
  single-agent.
- **Cost and trace**: a footer after each task
  (`$0.0002 · 6.6s · cache 90% · in 12503 · out 443`) and one JSON line per
  model call, tool call, block, checkpoint, tick, lesson, attempt and agent in
  `runs/<timestamp>/trace.jsonl`, each with its agent id.
- **Web**: `web_search` returns at most 6 results; `web_fetch` returns a page
  as text, in at most `maxFetchParts` parts of about 4k tokens. It runs in the
  harness process, never through an LLM: HTML becomes markdown-like text, large
  JSON becomes a key outline plus the values whose keys match the `prompt`
  words, and PyPI, npm, crates.io and GitHub releases pages use their APIs.
  Private and loopback addresses are refused at every redirect hop, and the
  target repository's pull requests, commits and source views on GitHub
  (found from the git remote or the task's `Repository:` line and issue URLs)
  are refused so the upstream fix cannot be copied. Pages are cached for the
  session; each search and fetch is traced with bytes and milliseconds.
  Off by default: in September 2026 runs the web tools did not raise the pass
  rate (the model can `curl` from bash) and made some non-web tasks cost more.
  With `enabled: false` the prompt and tool list are unchanged.

## Model adapter

The harness adapts to whichever OpenAI-compatible model it is given
(`src/model/`):

- **Probe**: at start, one tiny tool-call request plus `GET /models` detect
  the model family, native tool calls, the field that carries reasoning
  (`reasoning`, `reasoning_content`, `reasoning_details` or `<think>` tags),
  where cached tokens are reported, whether `reasoning_effort` is accepted and
  the context window (which caps `maxContextTokens`). The result is printed as
  one dim `probe:` line and cached in `~/.cache/rosetta-js/probe.json` per URL
  and model, only when the probe ran cleanly.
- **Reasoning**: one reasoning field is kept per reply and sent back in that
  same field (the proxy sends the same text as both `reasoning` and
  `reasoning_details`; keeping both doubled the echoed tokens). It is dropped
  only at compaction. Effort is `low`, and `high` for the one call after
  failed tests, an empty reply, an unparseable call or two tool errors in a row.
- **Dialects**: `native` function calling; `xml`
  (`<tool_call>{"name":…,"arguments":…}</tool_call>`, for qwen and glm); or
  `json-block` (a fenced `{"tool":…,"args":…}` block, the fallback for other
  families). For the text dialects the tool schemas are part of the fixed
  system prompt and results come back in `<tool_result>` blocks.
- **Repair** (every dialect): tool-name aliases (`Read`, `grep`, `shell`…),
  argument aliases (`file_path`, `cmd`…), JSON repair (trailing commas, single
  quotes, raw newlines, missing braces, Python literals), calls written as
  text (`<tool_call>`, `<function=…>`, DeepSeek DSML `invoke`, GLM
  `arg_key`, fenced or bare JSON), calls inside `<think>`. Each repair prints a
  dim `repaired: …` line. `test/repair.js` runs the fixture table.
- **Stream**: a reply cut off at `max_tokens` is continued (up to twice), and
  quota errors (`daily`, `quota`, out of credits) stop at once with a clear
  message instead of being retried.

## Skills and output digests

`skills/` holds 16 skills copied from the Rosetta kits (see `skills/NOTICE`):
a `SKILL.md`, a `DIGEST.md` of at most 8 lines, and python3-stdlib scripts.
The harness applies them itself; the model is never asked to call them.

- **Output digests** (`src/digest/`, on): when a `bash` result or the
  done-check output of a noisy tool is longer than `digest.minLines`, the
  matching summarizer runs on the saved output and the model gets its digest
  (at most 40 lines) plus `[digest of N lines; full output: runs/<id>/out/N.txt (read_file if needed)]`.
  The terminal shows `✂ digest: pytest 812 → 23 lines`. Summarizers:
  pytest/unittest `pytest_failures.py`, `cargo test` `cargo_test_fail.py`,
  cargo build/check `cargo_errors.py`, `go test` `go_test_fail.py`,
  jest/vitest/mocha `js_test_failures.py`, tsc `tsc_summary.py`, gcc/clang
  `cc_errors.py`, mvn/gradle `junit_fail.py`. A digest is used only when it at
  least halves the output. Without python3, pytest and jest get a small
  built-in JS digest; other tools keep the normal output.
- **Skill router** (`src/skills-internal/`, off): scores skills by repo
  markers (`pyproject.toml`, `package.json`, `Cargo.toml`, `*.go`…), task
  keywords and task type (bug fix, refactor, performance, feature, upgrade),
  picks at most `skills.maxAuto`, and appends their digests to the first user
  message (never the cached prefix), printing `📖 skill: python-library, systematic-debugging`.
  With `skills.detect` it also runs that skill's scan script (`crate_map.py`,
  `go_map.py`, `detect_backend.py`, `jvm_detect.py`…, 10 s timeout, skipped
  without python3).

Measured on 4 tasks (Python bug with a 1,200-line pytest failure, a
TypeScript model migration with a noisy tsc, a multi-file Python refactor, a
Go test failure), 3 runs per arm, `deepseek/deepseek-v4.1-flash`, all 36 runs
passing the hidden tests:

| Arm | avg $ | avg input tokens | avg seconds |
| --- | ----- | ---------------- | ----------- |
| all off | 0.00200 | 130k | 38 |
| skill digests + scan | 0.00221 | 154k | 79 |
| scan only | 0.00248 | 131k | 40 |

The digests made the model do extra work (reproduction scripts, regression
tests) without better results, and the scan did not reduce exploration, so
both stay off. Output digests never triggered there (the model pipes tests
through `tail`), so they were measured where they do trigger: an
under-specified variant of the Python task where the done-check fails with
467+ lines. Digest on: $0.00167, 102k input, 80 s; off: $0.00263, 152k, 133 s
(3 runs each, all passing). A 1,200-line pytest result goes from about 4,000
to 500 tokens.

## Determinism and parameters

Every parameter that affects output lives in `config.json`; a missing or
mistyped field stops the agent with a message naming it, and there is no
fallback model. Defaults:

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `provider` | `hackclub` | which entry of `providers` to use (env `AI_PROVIDER` overrides) |
| `providers.hackclub` | `https://ai.hackclub.com/proxy/v1`, `deepseek/deepseek-v4.1-flash` | Hack Club proxy (our testing) |
| `providers.openrouter` | `https://openrouter.ai/api/v1`, `deepseek/deepseek-v4.1-flash` | OpenRouter |
| `providers.aws` | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1`, `openai.gpt-oss-120b-1:0`, region `us-east-1` | AWS Bedrock OpenAI-compatible endpoint; `{region}` comes from `AWS_REGION`, then `AWS_DEFAULT_REGION`, then `region`. `AI_API_KEY` is a Bedrock API key |
| `maxContextTokens` | 64000 | context window the agent plans for |
| `maxOutputTokens` | 8192 | `max_tokens` per reply |
| `temperature` | 0.2 | sampling temperature |
| `topP` | 1 | `top_p` |
| `seed` | 7 | sent with every request; `null` sends none |
| `maxTurns` | 60 | model calls per attempt |
| `maxSessionUsd` | 1 | stop (exit 3) when the whole session, all agents, costs this much |
| `policy` | `standard` | `standard` or `off` |
| `exitAfterTask` | true | the TUI exits after one task (`--chat` overrides) |
| `pricing.inputPerMTok` / `cachedInputPerMTok` / `outputPerMTok` | 0.035 / 0.001 / 0.29 | $ per million tokens, for cost reporting |
| `context.maxToolOutputBytes` | 16000 | longer tool output is cut to head and tail |
| `context.compactStartShare` / `compactTargetShare` | 0.7 / 0.35 | compaction start and target, as shares of `maxContextTokens` |
| `context.keptToolResults` | 4 | tool results kept in full when compacting |
| `agent.maxEmptyReplyNudges` | 2 | "please continue" nudges after empty replies |
| `agent.maxCheckRounds` | 2 | extra rounds when the done-check fails |
| `agent.failureTailLines` | 60 | failing test lines sent back |
| `loop.maxAttempts` | 3 | attempts in the improve loop |
| `loop.stallNoteTurns` / `stallEndTurns` | 6 / 12 | turns without progress before the note / the end of the attempt |
| `loop.giveUpMinAttempts` | 2 | attempts before `give_up` is accepted |
| `loop.lessonsInPrefix` | 5 | lessons loaded into the prefix at start |
| `loop.milestoneCompactShare` | 0.5 | compact at a tick when the context is above this share (once per item) |
| `loop.checkTimeoutSeconds` | 60 | timeout of a plan item check |
| `loop.maxDiffLines` | 200 | patch lines shown by `/diff` and in lessons |
| `timeouts.commandSeconds` | 120 | one bash command |
| `timeouts.testCheckSeconds` | 180 | the done-check |
| `timeouts.streamStallSeconds` | 60 | a silent stream is retried after this |
| `retries.maxRetries` / `maxStallRetries` | 3 / 1 | retries for network/429/5xx errors and stalled streams |
| `retries.baseBackoffMs` / `maxRetryAfterMs` | 1000 / 60000 | backoff base and `Retry-After` cap |
| `tools.maxSearchMatches` / `maxSearchLineLength` | 100 / 200 | search output limits |
| `tools.listDepth` / `readLineLimit` | 2 / 2000 | `list_files` depth and `read_file` lines |
| `skills.maxInstructionTokens` | 4000 | cap on AGENTS.md / CLAUDE.md |
| `skills.maxCatalogSkills` / `maxDescriptionChars` | 40 / 150 | catalog size and line length |
| `skills.maxSkillFiles` | 50 | files listed by the `skill` tool |
| `intake.maxComments` / `maxBodyChars` / `maxCommentChars` | 20 / 8000 / 2000 | issue text caps |
| `intake.cloneDepth` | 1 | shallow clone depth |
| `intake.apiTimeoutSeconds` / `gitTimeoutSeconds` | 20 / 180 | GitHub API and git timeouts |
| `agents.maxParallelAgents` | 3 | sub-agents running at once |
| `agents.explorerMaxTurns` / `workerMaxTurns` / `reviewerMaxTurns` | 15 / 40 / 10 | per-role turn caps |
| `agents.explorerMaxUsd` / `workerMaxUsd` / `reviewerMaxUsd` | 0.05 / 0.2 / 0.05 | per-agent budgets |
| `agents.reviewerEnabled` | false | allow the reviewer role |
| `agents.fanOutMinItems` / `fanOutMinFiles` | 2 / 4 | fan out to workers only for this many independent items or files |
| `agents.autoTournament` / `tournamentSize` | true / 2 | best-of-N when every attempt failed |
| `agents.maxResultLines` / `maxResultLineChars` | 10 / 200 | size of a sub-agent's returned result |
| `agents.lessonsPerAgent` | 2 | relevant lessons given to a sub-agent |
| `adapter.dialect` | auto | tool-call format: `auto` (from the probe), `native`, `xml` or `json-block` |
| `adapter.reasoningEffort` / `escalatedReasoningEffort` | low / high | normal effort, and effort for the one call after failed tests, an empty reply or repeated tool errors (`""` sends none) |
| `adapter.probe` | true | probe the model at start (`false` assumes native tools) |
| `skills.internal` | false | add short skill digests to the first task message |
| `skills.maxAuto` | 2 | most skills picked per task (one language, one task type) |
| `skills.detect` | false | also run the picked skill's project-scan script |
| `digest.enabled` / `minLines` | true / 60 | replace test/compiler output longer than this with a summarizer's digest |
| `web.enabled` | false | add `web_search` and `web_fetch` |
| `web.maxFetchParts` / `timeoutSeconds` | 4 / 20 | parts per URL and seconds per request |
| `web.excludedDomains` / `jsonDigest` | [] / true | domains never fetched; outline instead of raw JSON |

Environment: `AI_API_KEY` (required, only sent in the `Authorization`
header), `AI_PROVIDER` (`hackclub`, `openrouter` or `aws`), `AI_BASE_URL` / `AI_MODEL` (overrides, printed at start and recorded
in the trace), `AWS_REGION` (for `aws`), `REPO` / `TARGET_REPO` / `REPO_PATH` / `WORK_DIR`, `ISSUE`,
`GITHUB_TOKEN` / `GH_TOKEN` (private repos, intake only), `AI_DIALECT`
(overrides `adapter.dialect`), `BRAVE_API_KEY` / `TAVILY_API_KEY` (optional
`web_search` providers; without them DuckDuckGo HTML, DuckDuckGo Lite, then Bing).

Sources of nondeterminism that remain: the provider may ignore `seed`;
network retries and timeouts depend on timing; parallel sub-agents finish in
varying order (merges are applied in dependency order); search ordering can
differ between ripgrep and the built-in fallback; target test suites may be
flaky. The first trace line records the model, URL, overrides, sampling
parameters and policy used.

## Files

| File | Job |
| ---- | --- |
| `Makefile` | setup, run, chat, test, clean |
| `config.json` | every parameter that affects output |
| `.env.example` | an empty `AI_API_KEY=` template |
| `scripts/setup.sh` | Node check and pinned Node install |
| `skills/*/` | shipped skills (bug-fix, test-writing, code-review) and the Rosetta kit skills with digests and summarizer scripts |
| `test/smoke.js` | live run that must fix a buggy fixture |
| `test/policy.js` | allow/block probe table |
| `test/skills.js` | front matter, discovery order, catalog |
| `test/intake.js` | URL and `Repository:` parsing, task message, token hiding |
| `test/workspace.js` | worker copies, merges, conflicts, per-agent roots |
| `test/loop.js` | plan ticks, checkpoints and undo, stall, lessons |
| `test/orchestrator.js` | dependency graph, waves, fan-out rule, conflicts |
| `test/repair.js` | malformed tool calls fed through the repair chain |
| `test/skills-internal.js` | skill router and output digests |
| `test/tui.js` | TUI text layout, diff, keys and composer |
| `evals/` | `make eval` benchmark: runner, tasks, hidden tests, gold patches |
| `src/cli.js` | entry point: modes, final summary, exit codes |
| `src/input.js` | reads the task (argument, `ISSUE`, pipe) and terminal input |
| `src/lineeditor.js` | TUI line editor with paste handling and history |
| `src/slash.js` | slash commands |
| `src/taskstart.js` | starts a task, a resume or a best-of-N run |
| `src/ui.js` | terminal output; routes events to the TUI when it runs |
| `src/tui/app.js` | the TUI: live area, rendering, keys, slash commands, transcript |
| `src/tui/cells.js` | history cells (messages, commands, diffs, status box) |
| `src/tui/*.js` | text layout, Markdown, diff, key parser, composer, pickers, file search, git diff |
| `src/config.js` | loads and checks `config.json`, holds the working folder |
| `src/workdir.js` | picks the working folder without asking |
| `src/environment.js` | the shell's environment without secrets, with no-prompt settings |
| `src/intake/parse.js` | finds issue/repo URLs and `Repository:` lines |
| `src/intake/github.js` | fetches the issue and comments |
| `src/intake/checkout.js` | shallow clone or reuse and fetch |
| `src/intake/token.js` | finds the GitHub token and scopes it to one git command |
| `src/intake/message.js` | builds the task message |
| `src/intake/index.js` | runs intake and switches the working folder |
| `src/prompt.js` | builds the session's system message |
| `src/skills/instructions.js` | reads AGENTS.md / CLAUDE.md / copilot instructions |
| `src/skills/discovery.js` | finds skills in the skill folders |
| `src/skills/frontmatter.js` | parses SKILL.md front matter |
| `src/skills/catalog.js` | picks and formats the skill catalog |
| `src/agent.js` | the conversation: requests, tool results, compaction trigger |
| `src/turns.js` | the turn loop of one attempt, done-check, stall handling |
| `src/attempts.js` | the improve loop over attempts |
| `src/attemptrecord.js` | per-attempt stats and score |
| `src/plan.js` | plan ledger ticked by checks |
| `src/progress.js` | stall detection |
| `src/lessons.js` | writes and loads lessons |
| `src/checkpoints.js` | checkpoints, undo and diff |
| `src/shadowgit.js` | runs git on the shadow repo with a clean environment |
| `src/session.js` | saves and resumes the session |
| `src/state.js` | the `.rosetta/` folder and `.git/info/exclude` |
| `src/model.js` | chat completions request, retries, stall watchdog |
| `src/stream.js` | parses the streamed reply |
| `src/context.js` | token estimates, output truncation, compaction, prefix check |
| `src/checks.js` | finds and runs the project's tests, file snapshots |
| `src/trace.js` | JSONL trace |
| `src/usage.js` | token and cost accounting per agent and role |
| `src/policy.js` | allows or blocks each tool call |
| `src/commands.js` | policy rules for shell commands |
| `src/gitrules.js` | policy rules for git and gh |
| `src/paths.js` | writable, deletable and credential path zones |
| `src/readonly.js` | policy for read-only roles |
| `src/shellwords.js` | splits a command line into commands and redirects |
| `src/shellexpand.js` | reads one shell word: quotes, variables, substitutions |
| `src/roles.js` | main, explorer, worker and reviewer roles |
| `src/agents/orchestrator.js` | runs task calls in dependency waves, merges, done-check |
| `src/agents/graph.js` | dependency graph, waves and the fan-out rule |
| `src/agents/subagent.js` | runs one sub-agent with its lean context and limits |
| `src/agents/briefing.js` | a sub-agent's system message and task message |
| `src/agents/results.js` | compact sub-agent results |
| `src/agents/tournament.js` | best-of-N runs and scoring |
| `src/agents/workspace.js` | private worker copies and file-by-file merges |
| `src/agents/filetree.js` | copy skip lists and file hashes |
| `src/agents/filediff.js` | capped diffs for conflicts |
| `src/tools/index.js` | tool list, dispatch, policy and role checks |
| `src/tools/files.js` | file tools |
| `src/tools/search.js` | search tool (ripgrep or built-in) |
| `src/tools/shell.js` | bash tool |
| `src/tools/shellsession.js` | a persistent bash session |
| `src/tools/skill.js` | skill tool |
| `src/tools/todo.js` | todo tool for the plan ledger |
| `src/tools/give_up.js` | give_up tool |
| `src/tools/task.js` | task tool for sub-agents |
| `src/tools/web.js` | web_search and web_fetch tools |
| `src/web/*.js` | search providers, safe fetch, HTML and JSON digests, registry fast paths, anti-cheat |
| `src/model/prepare.js` | runs the probe, picks the dialect, prints the `probe:` line |
| `src/model/probe.js`, `probe-cache.js` | model probe and its cache |
| `src/model/adapter.js` | per-agent adapter: request options, reply repair, continuation, effort |
| `src/model/dialects.js` | native, xml and json-block tool-call formats |
| `src/model/repair.js`, `extract.js`, `json-repair.js` | the repair chain |
| `src/model/reasoning.js` | reasoning field capture, echo, drop and effort policy |
| `src/model/settings.js`, `errors.js` | `adapter.*` settings and quota errors |
| `src/skills-internal/*.js` | skill catalog, router, project scan, first-message notes |
| `src/digest/*.js` | picks a summarizer for long output, runs it, JS fallback |
