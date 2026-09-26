---
name: code-review
description: Review a diff, branch or set of files. Give the verdict first, then findings ranked by severity, each with file:line, the concrete problem and a suggested fix.
---

# Code review

1. **Get the change.** Use `git diff`, `git diff main...HEAD` or `git log -p` for the named range, or read the named files. Read enough surrounding code to understand each change.
2. **Check, in this order:**
   - Correctness: logic errors, off-by-one, wrong conditions, unhandled null or empty cases, broken error handling, races.
   - Security: injection, unsafe paths, secrets in code or logs, missing input checks.
   - Tests: are the changes covered, and would the tests fail if the code were wrong? Run the suite when you can.
   - Design and readability: duplicated logic, unclear names, functions doing too much, dead code.
3. **Verify before you claim.** Only report a problem you can point to in the code. Search for callers before saying something is unused or breaks an API.

Output format:

```
Verdict: approve | approve with nits | request changes — one sentence why.

1. [high] path/file.js:42 — what is wrong and what it causes. Fix: ...
2. [medium] ...
3. [low] ...
```

Rules:
- Put the verdict first. Order findings high, medium, low. Skip nits a formatter would fix.
- Each finding names a file and line, the concrete problem, and a suggested fix.
- Say so when there are no real problems; do not invent findings.
- Do not change the code unless asked to fix the findings.
