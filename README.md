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
| `make test`  | syntax check, deterministic tests (policy probes, skills, intake parsing, workspaces, plan/checkpoints/lessons, orchestrator), then, with `AI_API_KEY` set, a live run that must fix a buggy fixture. |
| `make clean` | removes `runs/`, `.tools/` and the `/tmp/rjs-*` scratch folders. |

`make run` and `make test` put `.tools/node/bin` first on `PATH` and load
`.env` when present (see `.env.example`; exporting `AI_API_KEY` is the
primary path).

## Commands and flags

| Input | Effect |
| ----- | ------ |
| `-p "task"` / `ISSUE=...` / piped stdin | headless run of one task |
| `--chat` | keep the TUI open after a task |
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

Lines that start with `/` are never sent to the model.

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

## Determinism and parameters

Every parameter that affects output lives in `config.json`; a missing or
mistyped field stops the agent with a message naming it, and there is no
fallback model. Defaults:

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `baseUrl` | `https://ai.hackclub.com/proxy/v1` | API base URL (`{baseUrl}/chat/completions`) |
| `model` | `deepseek/deepseek-v4.1-flash` | model name |
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

Environment: `AI_API_KEY` (required, only sent in the `Authorization`
header), `AI_BASE_URL` / `AI_MODEL` (overrides, printed at start and recorded
in the trace), `REPO` / `TARGET_REPO` / `REPO_PATH` / `WORK_DIR`, `ISSUE`,
`GITHUB_TOKEN` / `GH_TOKEN` (private repos, intake only).

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
| `skills/*/SKILL.md` | shipped skills: bug-fix, test-writing, code-review |
| `test/smoke.js` | live run that must fix a buggy fixture |
| `test/policy.js` | allow/block probe table |
| `test/skills.js` | front matter, discovery order, catalog |
| `test/intake.js` | URL and `Repository:` parsing, task message, token hiding |
| `test/workspace.js` | worker copies, merges, conflicts, per-agent roots |
| `test/loop.js` | plan ticks, checkpoints and undo, stall, lessons |
| `test/orchestrator.js` | dependency graph, waves, fan-out rule, conflicts |
| `src/cli.js` | entry point: modes, final summary, exit codes |
| `src/input.js` | reads the task (argument, `ISSUE`, pipe) and terminal input |
| `src/lineeditor.js` | TUI line editor with paste handling and history |
| `src/slash.js` | slash commands |
| `src/taskstart.js` | starts a task, a resume or a best-of-N run |
| `src/ui.js` | terminal output |
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
