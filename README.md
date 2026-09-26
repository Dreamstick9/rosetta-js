# rosetta-js

A very basic coding agent for the terminal. It talks to any OpenAI-compatible
chat completions API, streams replies, and can list, read, create, write, edit
and delete files inside the directory it is started from.

No dependencies. Requires Node.js 20 or newer.

## Run

```bash
export AI_API_KEY=your-key
make setup
make run
```

Or directly, from the directory you want the agent to work in:

```bash
node /path/to/rosetta-js/src/cli.js
node /path/to/rosetta-js/src/cli.js -p "Create notes.txt with a haiku"
```

`make run` and `make test` also load `AI_API_KEY` from a `.env` file if one
exists (see `.env.example`). `make test` does a quick one-shot smoke run in a
temporary directory.

Commands in the chat: `/help`, `/new` (clear the conversation), `/exit`.

## Configuration

`config.json`:

| Field              | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `baseUrl`          | API base URL; requests go to `{baseUrl}/chat/completions`      |
| `model`            | Model name                                                     |
| `maxContextTokens` | Context window size; compaction starts at about 70% of it      |
| `maxOutputTokens`  | Maximum tokens per reply (`max_tokens`)                        |
| `temperature`      | Sampling temperature                                           |

Environment variables:

- `AI_API_KEY` (required): the API key. It is only read from the environment.
- `AI_BASE_URL`: overrides `baseUrl`.
- `AI_MODEL`: overrides `model`.

## Context management

- The system prompt and tool definitions never change, so provider prompt
  caching can reuse them.
- Messages are only appended; they change only during compaction.
- Large tool outputs are cut to a head and tail with a `[N lines omitted]` marker.
- Above ~70% of `maxContextTokens`, old tool results are replaced with one-line
  stubs. If that is not enough, the conversation is rebuilt from the system
  prompt, the original task, the files touched and the most recent messages.
