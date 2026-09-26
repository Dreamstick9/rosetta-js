---
name: python-library
internal: true
description: "Changes to a Python package or library: public API, behavior fixes, packaging, typing and tests with pytest or unittest."
triggers:
  keywords: [python, pytest, unittest, package, module, library, pip, pyproject, setup.py, typing, mypy, import, exception, traceback, decorator, dataclass, docstring, deprecation, kwargs]
  files: ["*.py", pyproject.toml, setup.py, setup.cfg, tox.ini, pytest.ini, conftest.py, requirements.txt]
tools: []
checks:
  - "python3 -c \"import pytest; print('pytest', pytest.__version__)\" 2>/dev/null || echo \"no pytest: use unittest\""
  - "python3 -m pytest -q -x 2>/dev/null || python3 -m unittest discover -s tests -v"
---
# Python library work

## When it applies
- The repo is a Python package (pyproject.toml, setup.py or setup.cfg) and the task is a bug fix, a feature or an API change.
- A traceback, a failing test or a wrong return value is described in the task.

## Workflow
- Reproduce first with the smallest script: `python3 -c "from pkg.mod import f; print(f(...))"` or a new failing test. Read the traceback bottom-up to the first frame in the package.
- Find the test runner: pytest if `conftest.py`, `pytest.ini` or `[tool.pytest]` exist; otherwise `unittest`. Check how tests import the package (installed vs. `src/` layout on `sys.path`).
- Fix the root cause, not the symptom: if a function gets bad input from a caller, decide which side owns the contract.
- Keep the public API stable: same names, same positional order, same defaults. New parameters go at the end, keyword-only when possible. Deprecate instead of removing.
- Match the code style around you: type hints if the module has them, docstring style (Google, NumPy, reST), f-strings vs format.
- Raise specific exceptions (`ValueError`, `TypeError`, `KeyError`) with a clear message; do not swallow exceptions or return `None` silently.
- Beware mutable default arguments, shared class attributes, and iterator exhaustion (a generator consumed twice).
- For numbers: integer vs float division, `round()` banker's rounding, float comparison with tolerance (`math.isclose`).
- Add a regression test next to the existing tests for that module, named after the behavior.
- Update the changelog or docs only if the project keeps them and the change is user-visible.

## Checklist
- [ ] Reproduced the problem before editing
- [ ] Root cause fixed; minimal diff
- [ ] Public API unchanged or backward compatible
- [ ] Regression test added and passing
- [ ] Whole test suite still passes
- [ ] Type hints and docstrings consistent with the module
- [ ] No new dependencies; no network use
- [ ] No debug prints left behind

## Verify
```bash
# which runner is available
python3 -c "import pytest; print('pytest', pytest.__version__)" 2>/dev/null || echo "no pytest: use unittest"
# run the tests (quiet, stop at first failure)
python3 -m pytest -q -x 2>/dev/null || python3 -m unittest discover -s tests -v
# one test by name
python3 -m pytest -q -k "name_of_test"
# src/ layout without installing
PYTHONPATH=src python3 -m pytest -q
# type check if mypy is present
python3 -m mypy src 2>/dev/null | tail -5
```

## Useful tools
- `python3 -X dev -W error script.py` to surface warnings as errors
- `python3 -m pdb -c continue script.py` to stop at the exception
- `python3 -m cProfile -s cumtime script.py | head -30` for slow code
- `python3 -m compileall -q .` quick syntax check of all files
- `grep -rn "def name\|class Name" --include=*.py .` to find definitions

## Pitfalls
- Editing an installed copy in site-packages instead of the repo source.
- A local module shadowing a stdlib or package name (e.g. a folder named `tests` or `types`).
- Running `pip install` (no network): use what is installed; test with `PYTHONPATH` instead.
- Changing behavior of a public function to make one test pass while breaking other callers.
- Relying on dict or set ordering where the code does not guarantee it.
- Catching `Exception` broadly and hiding the real error.
- Leaving `print` debugging or `breakpoint()` in the code.
- Tests that pass alone but fail in the full suite due to shared global state.
