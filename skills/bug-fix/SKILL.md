---
name: bug-fix
description: Fix a reported bug or failing test. Reproduce it with a failing test first, find the root cause, make the smallest fix, then run the full test suite.
---

# Bug fix

1. **Understand the report.** Restate the expected and the actual behavior in one sentence each. Note the exact error message, input and file names.
2. **Find the test command.** Look at package.json scripts, Makefile, pyproject.toml, Cargo.toml or the README. Run the suite once to see the current state.
3. **Reproduce.** Run the failing test, or write a small new test that fails for the reported reason. Do not change code until you have seen it fail.
4. **Find the root cause.** Read the code on the failing path. Use search to find every caller and every place with the same pattern. Ask why the wrong value appears, not only where.
5. **Make the smallest fix** at the root cause. Keep the existing style. Do not refactor, rename or reformat unrelated code.
6. **Verify.**
   - The reproducing test now passes.
   - The full test suite passes, not just the one test.
   - If the same mistake appears elsewhere, fix it too and say so.
7. **Report** in two or three lines: the cause, the fix, and the test result.

Rules:
- Never edit, skip or delete an existing test to make it pass. If a test itself is wrong, say why and ask before changing it.
- Do not add special cases for the test input (no `if (x === 5)` fixes).
- Do not silence errors with try/catch or by loosening checks.
- If you cannot reproduce the bug, say so and show what you tried instead of guessing a fix.
