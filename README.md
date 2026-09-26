# rosetta-js

A small coding agent for the terminal. It talks to an OpenAI-compatible chat
completions API, streams replies, and works on one project folder: it can list,
search, read, create, edit and delete files, and run commands in a persistent
bash shell. After it changes files it runs the project's tests and, when they
fail, hands the failure back to the model.

Plain JavaScript, no npm dependencies, Node.js 20.6 or newer. `rg` (ripgrep)
is used for search when installed.

## Judge flow

```bash
export AI_API_KEY=your-key        # the only credential; never stored in the repo
make setup                        # checks Node >= 20.6, installs a pinned Node into .tools/ if missing
make run                          # starts the agent
```

Then paste the GitHub issue or test case and press Enter. A multi-line paste
is sent as one message. If no working folder was given, the agent asks
`Which folder should I work on? [/tmp/rjs-work]` once, after the first
message. The working folder is printed before any work starts.

To point it at a project up front, or to run without a terminal:

```bash
make run REPO=/path/to/project                          # interactive, on that project
make run REPO=/path/to/project ISSUE=issue.txt          # headless, issue from a file
make run REPO=/path/to/project ISSUE="Fix the failing test in test_math.py"
cat issue.txt | make run REPO=/path/to/project          # headless, issue on stdin
```

## Working folder

The agent works on the first of these that applies:

1. `REPO` (or `REPO_PATH`): must be an existing folder.
2. The folder `src/cli.js` was started from, when that is not the rosetta-js
   folder (`cd project && node /path/to/rosetta-js/src/cli.js`).
3. Otherwise it asks once, after the first message, with `/tmp/rjs-work` as
   the default. Headless runs use the default without asking.

It never works on the rosetta-js folder itself: `REPO=.` is refused.

## Make targets

| Target       | What it does |
| ------------ | ------------ |
| `make setup` | checks for Node.js >= 20.6; if missing, downloads the pinned Node LTS (v24.21.0) from nodejs.org/dist into `.tools/node`, verified against `SHASUMS256.txt` (no sudo, nothing system-wide). Also reports ripgrep. Safe to run again. |
| `make run`   | starts the agent: interactive in a terminal, headless when stdin is piped or `ISSUE` is set. Exits non-zero when a headless task does not finish cleanly. |
| `make test`  | syntax-checks every file; with `AI_API_KEY` set it also does a real run that fixes a small buggy fixture in `/tmp/rjs-smoke-*` and checks the fixture's test passes afterwards. Without a key it prints a skip message. |
| `make clean` | removes `runs/`, `.tools/` and the `/tmp/rjs-*` scratch folders. |

`make run` and `make test` put `.tools/node/bin` first on `PATH` (so the agent's
shell and test runs also find that `node` and `npm`), and load
`.env` when one exists (see `.env.example`). Exporting `AI_API_KEY` is the
primary path; `.env` is only a local convenience and is gitignored.

Direct use, from inside the project to work on:

```bash
node /path/to/rosetta-js/src/cli.js                      # interactive
node /path/to/rosetta-js/src/cli.js -p "Fix the failing test"
```

## Commands and keys

| Input                       | Effect |
| --------------------------- | ------ |
| `/help`                     | show the commands |
| `/new`                      | clear the conversation |
| `/cost`                     | show the session cost, token totals and trace file |
| `/check off`, `/check on`   | turn the test check after changes off or on |
| `/exit`                     | quit |
| Esc or Ctrl-C during a turn | stop the turn and return to the prompt |
| Ctrl-C at the prompt        | quit |
| ↑ / ↓ at the prompt         | bring back earlier messages |

Lines that start with `/` are never sent to the model.

## Configuration

Everything that affects the agent's output lives in `config.json`. There are
no hidden defaults: a missing or mistyped field stops the agent with a message
naming the field, and there is no fallback to another model.

| Field | Meaning |
| ----- | ------- |
| `baseUrl` | API base URL; requests go to `{baseUrl}/chat/completions` |
| `model` | model name |
| `maxContextTokens` | context window the agent plans for |
| `maxOutputTokens` | maximum tokens per reply (`max_tokens`) |
| `temperature` | sampling temperature |
| `topP` | nucleus sampling (`top_p`) |
| `seed` | sampling seed sent with every request; `null` sends none |
| `maxTurns` | maximum model calls for one task |
| `pricing.*` | dollars per million tokens: `inputPerMTok`, `cachedInputPerMTok`, `outputPerMTok` (cost reporting only) |
| `context.maxToolOutputBytes` | tool output above this is cut to a head and tail |
| `context.compactStartShare` | compaction starts above this share of `maxContextTokens` |
| `context.compactTargetShare` | compaction brings the context down to this share |
| `context.keptToolResults` | tool results kept in full during compaction |
| `agent.maxEmptyReplyNudges` | "please continue" nudges after empty replies |
| `agent.maxCheckRounds` | extra tries the model gets when the tests fail |
| `agent.failureTailLines` | lines of failing test output sent back |
| `timeouts.commandSeconds` | timeout for one bash command |
| `timeouts.testCheckSeconds` | timeout for the test check |
| `timeouts.streamStallSeconds` | a silent model stream is retried after this |
| `retries.*` | `maxRetries` for network, 429 and 5xx errors, `maxStallRetries`, `baseBackoffMs`, `maxRetryAfterMs` |
| `tools.*` | `maxSearchMatches`, `maxSearchLineLength`, `listDepth` and `readLineLimit` for the file tools |

The default pricing for `deepseek/deepseek-v4.1-flash` ($0.035 input, $0.001
cached input, $0.29 output per million tokens) comes from the Hack Club
proxy's `GET /proxy/v1/models` endpoint, as listed in September 2026.

Environment variables:

- `AI_API_KEY` (required): the API key. It is only read from the environment
  and only sent in the `Authorization` header.
- `AI_BASE_URL`, `AI_MODEL`: override `baseUrl` and `model`. The effective
  model and URL are printed at start, with a note when an override is active,
  and recorded in the trace.
- `REPO` / `REPO_PATH`: the working folder. `ISSUE`: the task text, or a path
  to a file holding it.

## Determinism and parameters

- All sampling parameters (`temperature`, `topP`, `seed`, `maxOutputTokens`)
  and every limit, timeout and retry count come from `config.json`, listed
  above. The first line of each trace records the model, URL, overrides,
  temperature, top_p and seed that were used.
- The system prompt (`src/agent.js`) and the tool descriptions
  (`src/tools/*.js`) are part of the code and change only with a commit. They
  never change during a session, which keeps provider prompt caching working.
- Remaining sources of nondeterminism: the provider may ignore `seed` or
  sample differently between runs; network retries and timeouts depend on
  timing; search output ordering differs slightly between ripgrep and the
  built-in fallback; test commands of the target project may be flaky.

## What it does

- **Tools**: `list_files`, `read_file`, `create_file`, `write_file`,
  `edit_file`, `delete_file`, `search`, `bash`. Paths are relative to the
  working folder, or absolute. Several read-only calls in one reply run at the
  same time.
- **bash**: one shell for the whole session, so `cd`, variables and virtualenvs
  carry over. A timeout or Esc stops the whole command line and keeps the shell.
- **No guardrails** (this branch): every command runs without asking, and the
  file tools can read and write anywhere your user account can. Run it only in
  folders and on machines where that is fine.
- **Done-check**: when a turn really changed project files, the tests are run
  (`npm test`, pytest or unittest, `cargo test`, `go test`). On failure the
  model gets the last lines of output and more tries.
- **Outcome**: each task ends as `done`, `tests_failing`, `max_turns` or
  `empty_reply`. Headless runs exit 0 only for `done`.
- **Robustness**: network errors, 429 and 5xx are retried with backoff
  (honoring `Retry-After`); a silent stream is retried; empty replies get
  "please continue" nudges.
- **Cost and trace**: a footer after each answer
  (`$0.0002 · 6.6s · cache 90% · in 12503 · out 443`), and one JSON line per
  model call, tool call, compaction and finished task in
  `runs/<timestamp>/trace.jsonl` inside the rosetta-js folder.

## Context management

- The system prompt and tool list never change, and every request is checked
  against the first one, so provider prompt caching keeps working.
- Messages are only appended; they change only during compaction.
- Large tool outputs are cut to a head and tail with a `[N lines omitted]` marker.
- Above `compactStartShare` of `maxContextTokens`, the context is brought down
  to about `compactTargetShare`: first all but the last `keptToolResults` tool
  results become one-line stubs, then, if still needed, the conversation is
  rebuilt from the original task, the files touched and the most recent
  messages.

## Files

| File | Job |
| ---- | --- |
| `Makefile` | setup, run, test, clean |
| `config.json` | every parameter that affects output |
| `scripts/setup.sh` | Node check and pinned Node install |
| `test/smoke.js` | live smoke run on a buggy fixture |
| `src/cli.js` | entry point: modes, commands, task outcome |
| `src/config.js` | loads and checks `config.json`, holds the working folder |
| `src/workdir.js` | picks and opens the working folder |
| `src/agent.js` | the agent loop, done-check and compaction trigger |
| `src/model.js` | chat completions request, retries, stall watchdog |
| `src/stream.js` | parses the streamed reply |
| `src/context.js` | token estimates, output truncation, compaction |
| `src/checks.js` | finds and runs the project's tests |
| `src/trace.js` | JSONL trace and cost |
| `src/input.js` | terminal line editor, paste handling, piped input |
| `src/ui.js` | terminal output |
| `src/tools/*.js` | file, search and bash tools |
