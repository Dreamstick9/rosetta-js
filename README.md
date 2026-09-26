# rosetta-js

A small coding agent for the terminal. It talks to any OpenAI-compatible chat
completions API, streams replies, and works on the project in the directory it
is started from: it can list, search, read, create, edit and delete files, and
run commands in a persistent bash shell.

No dependencies. Requires Node.js 20 or newer. `rg` (ripgrep) is used for
search when installed.

## Run

```bash
export AI_API_KEY=your-key
make setup
make run
```

Or directly, from the project you want the agent to work on:

```bash
node /path/to/rosetta-js/src/cli.js
node /path/to/rosetta-js/src/cli.js -p "Fix the failing test"
cat task.txt | node /path/to/rosetta-js/src/cli.js
```

- Interactive mode: type a message and press Enter. Pasted multi-line text is
  sent as one message.
- Headless mode: `-p "task"`, or pipe the task on stdin.
- `make run` and `make test` also load `AI_API_KEY` from `.env` if it exists
  (see `.env.example`).

| Make target  | What it does                                      |
| ------------ | ------------------------------------------------- |
| `make setup` | checks the Node.js version and whether rg exists  |
| `make run`   | starts the interactive agent                      |
| `make test`  | syntax-checks the code and does a headless smoke run in a temp folder |
| `make clean` | deletes the `runs/` trace folder                  |

## Commands and keys

| Input                     | Effect                                             |
| ------------------------- | -------------------------------------------------- |
| `/help`                   | show the commands                                  |
| `/new`                    | clear the conversation                             |
| `/cost`                   | show the session cost, token totals and trace file |
| `/check off`, `/check on` | turn the test check after changes off or on        |
| `/exit`                   | quit                                               |
| Esc or Ctrl-C during a turn | stop the turn and return to the prompt           |
| Ctrl-C at the prompt      | quit                                               |
| ↑ / ↓ at the prompt       | bring back earlier messages                        |

Lines that start with `/` are never sent to the model.

## Configuration

`config.json`:

| Field              | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `baseUrl`          | API base URL; requests go to `{baseUrl}/chat/completions`      |
| `model`            | model name                                                     |
| `maxContextTokens` | context window size; compaction starts at 70% of it            |
| `maxOutputTokens`  | maximum tokens per reply (`max_tokens`)                        |
| `temperature`      | sampling temperature                                           |
| `maxTurns`         | maximum model calls for one task (default 60)                  |
| `pricing`          | dollars per million tokens: `inputPerMTok`, `cachedInputPerMTok`, `outputPerMTok` |

The default pricing for `deepseek/deepseek-v4.1-flash` ($0.035 input, $0.001
cached input, $0.29 output per million tokens) comes from the Hack Club proxy's
`GET /proxy/v1/models` endpoint, as listed in September 2026.

Environment variables:

- `AI_API_KEY` (required): the API key. It is only read from the environment.
- `AI_BASE_URL`: overrides `baseUrl`.
- `AI_MODEL`: overrides `model`.

## What it does for you

- **Tools**: `list_files`, `read_file`, `create_file`, `write_file`,
  `edit_file`, `delete_file`, `search`, `bash`. Paths are relative to the
  folder the agent was started in, or absolute. Several read-only calls in one
  reply run at the same time.
- **bash**: one shell for the whole session, so `cd`, variables and virtualenvs
  carry over. Commands time out after 120 s; a timeout or Esc stops the whole
  command line and keeps the shell.
- **No guardrails** (this branch): every command runs without asking, and
  the file tools can read and write anywhere your user account can. Run it only
  in folders and on machines where that is fine.
- **Done-check**: when a turn really changed project files (sizes or
  modification times differ from the start of the turn), the tests are run
  (`npm test`, pytest or unittest, `cargo test`, `go test`). On failure the
  model gets the last 60 lines and up to 2 more tries.
- **Robustness**: network errors, 429 and 5xx are retried 3 times with backoff
  (honoring `Retry-After`); a stream silent for 60 s is retried once; empty
  replies get up to 2 "please continue" nudges.
- **Cost and trace**: a footer after each answer
  (`$0.0002 · 6.6s · cache 90% · in 12503 · out 443`), and one JSON line per
  model call, tool call and compaction in `runs/<timestamp>/trace.jsonl`
  inside the rosetta-js folder (the first line names the project it ran in).

## Context management

- The system prompt and tool list never change, and every request is checked
  against the first one, so provider prompt caching keeps working.
- Messages are only appended; they change only during compaction.
- Large tool outputs are cut to a head and tail with a `[N lines omitted]` marker.
- Above 70% of `maxContextTokens`, the context is brought down to about 35%:
  first all but the last 4 tool results become one-line stubs, then, if still
  needed, the conversation is rebuilt from the original task, the files touched
  and the most recent messages.
