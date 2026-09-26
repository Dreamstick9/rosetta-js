---
name: test-writing
description: Write or extend automated tests for existing code. Match the project's test framework and style, cover behavior and edge cases, and make sure every new test can fail.
---

# Test writing

1. **Find the setup.** Locate the test folder, framework and command (package.json, Makefile, pytest.ini, go test, cargo test). Read two or three existing tests and copy their style, naming and helpers.
2. **Pick what to test.** Read the code under test. List its public behavior: normal inputs, boundaries (empty, zero, one, max), invalid input and error paths. Test through the public interface, not private details.
3. **Write small tests.** One behavior per test, a name that says what is expected, and a clear arrange / act / assert shape. Use literal expected values, not values recomputed with the code under test.
4. **Keep tests deterministic.** No real network, no sleeps, no dependence on the clock, random numbers or test order. Use temp folders for files and clean them up.
5. **Prove each test can fail.** Temporarily break the code (or assert a wrong value) and confirm the test fails, then restore it.
6. **Run the full suite** and make sure everything passes.
7. **Report** the tests added, what they cover, and anything left untested.

Rules:
- Do not change the code under test unless asked. If a new test exposes a real bug, stop and report it instead of hiding it.
- Do not add test dependencies when the project already has a framework.
- Prefer a few meaningful tests over many shallow ones.
