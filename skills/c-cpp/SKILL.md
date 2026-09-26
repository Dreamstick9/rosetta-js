---
name: c-cpp
internal: true
description: "C and C++ with CMake/Make/Meson: compile and link errors, failing ctest/gtest/Catch2 tests, crashes, memory bugs via sanitizers or valgrind."
triggers:
  keywords: [c++, cpp, c language, cmake, makefile, gcc, clang, g++, segfault, segmentation fault, undefined reference, linker, header, pointer, malloc, memory leak, use after free, buffer overflow, sanitizer, valgrind, gtest, ctest, catch2, template]
  files: [CMakeLists.txt, Makefile, meson.build, configure.ac, "*.c", "*.cpp", "*.cc", "*.h", "*.hpp"]
tools:
  - script: scripts/cc_build_detect.py
    usage: "cc_build_detect.py [DIR] → build system, targets, tests, test framework, exact configure/build/test/ASan commands, compilers present"
  - script: scripts/cc_errors.py
    usage: "cc_errors.py [FILE|-] [--run CMD] [--warnings] → first compile error per file (function, code line, fix-it, candidates); undefined symbols demangled with cause"
  - script: scripts/cc_test_fail.py
    usage: "cc_test_fail.py [FILE|-] [-- CMD] → runs ctest/make check; failing ctest/gtest/Catch2/doctest/Unity cases with file:line and values; rerun command"
  - script: scripts/san_summary.py
    usage: "san_summary.py FILE|- | --run CMD → ASan/LSan/UBSan/TSan/valgrind report as kind + project-only access/free/alloc frames + hint"
checks:
  - cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build -j4 && ctest --test-dir build --output-on-failure
  - make -j4 && make test
---
# C and C++

## When it applies
- The repo builds C or C++ (CMakeLists.txt, Makefile, meson.build, autotools) and the task is a compile
  error, link error, failing test, crash, leak, or a behavior bug or feature.
- The task mentions segfaults, undefined references, sanitizers, valgrind, headers or templates.

## Workflow
1. `python3 skills/c-cpp/scripts/cc_build_detect.py`: the build system, the exact configure/build/test commands, the test
   framework and which compilers exist. Reuse an existing `build/` dir; do not reconfigure without need.
2. Build: `python3 skills/c-cpp/scripts/cc_errors.py --run "cmake --build build -j4"` (or `"make -k -j4"`). Fix the
   first error of each file first. A header error cascades into every file including it; fix the header.
3. Tests: `python3 skills/c-cpp/scripts/cc_test_fail.py` prints failing cases with expected/actual and a rerun command
   (`ctest -R '^name$'`, `--gtest_filter=Suite.Name`, Catch2 `"name"`). Rebuild before rerunning.
4. Crash, wrong output with no clear cause, or a leak: build with sanitizers (the `asan:` line from
   step 1), then `python3 skills/c-cpp/scripts/san_summary.py --run "./build/prog args"`. No sanitizer support: use
   `valgrind -q --leak-check=full ./prog` and pipe it into `san_summary.py -`.
5. Add a regression test in the project's framework (same file as neighboring tests); new test files
   must be registered in CMakeLists.txt (`add_executable` + `add_test`/`gtest_discover_tests`) or the Makefile.
6. Finish with a clean full build (no new warnings under the project's flags) and all tests passing.

## Link errors (cc_errors.py prints the likely cause)
- `undefined reference to Foo::bar()`: declared but never defined, the .cpp is missing from the
  target's sources, a signature mismatch between .h and .cpp (const, reference, namespace), or a
  template defined in a .cpp (move it to the header).
- `undefined reference to sqrt` / `pthread_create`: add `-lm` / `-pthread` (CMake: `target_link_libraries`).
- `vtable for X`: a virtual function (often the destructor) declared but not defined.
- C called from C++: the C header needs `extern "C"` guards.
- `multiple definition`: a non-inline function or a global variable defined in a header: mark it
  `inline`/`static`, or `extern` in the header plus one definition in a .c/.cpp file.

## Rules
- Keep the language standard of the project (`CMAKE_CXX_STANDARD`, `-std=`): no C++20 features in C++17 code.
- Memory: every `malloc`/`new` has one owner and one release on every path, error paths included.
  In C++ prefer RAII (`std::unique_ptr`, containers) when touching ownership code.
- Bounds: loops `i < n`, not `i <= n`; `malloc(n * sizeof *p)`; `strncpy`/`snprintf` with the real
  buffer size; check return values of `malloc`, `fopen`, `read`.
- Integer types: `size_t` for sizes, beware of signed/unsigned comparisons and overflow (UB for signed).
- Do not change compiler flags or disable warnings to make an error go away.
- No new dependencies: `find_package` of a library not installed, or `FetchContent` (network), will fail.

## Checklist
- [ ] Reproduced (failing test, crash or error) before editing
- [ ] Clean build of the affected targets; no new warnings
- [ ] Regression test added and registered with the build
- [ ] Sanitizer (or valgrind) run clean for memory-related fixes
- [ ] All tests pass (`ctest --output-on-failure` / `make check`)
- [ ] Headers and sources agree on every changed signature

## Pitfalls
- Iterator/pointer/reference invalidation: `push_back`/`erase` on a vector while holding pointers or
  iterators into it (ASan: heap-use-after-free).
- Returning a pointer or reference to a local (stack-use-after-return).
- `sizeof(ptr)` instead of the buffer size; `strlen` without room for the terminating `'\0'`.
- Uninitialized members or locals: valgrind "Conditional jump depends on uninitialised value".
- Editing a generated file (in `build/`, `*.in` templates, protobuf output) instead of its source.
- Stale builds: changed a header but the build did not pick it up; rebuild the target or touch the file.
- Macros with side effects evaluated twice (`MAX(i++, j)`); missing parentheses in macro bodies.
- Undefined behavior "works" at -O0 and breaks at -O2: run UBSan when results differ by optimization level.
- Tests that depend on the working directory: ctest runs each test in its build dir unless `WORKING_DIRECTORY` is set.

## Research (web_search / web_fetch)
- Standard library and language features by standard version: `https://en.cppreference.com/`.
- GCC warnings and flags: `https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html`; clang
  diagnostics: `https://clang.llvm.org/docs/DiagnosticsReference.html`.
- Sanitizer report formats and options: `https://github.com/google/sanitizers/wiki`.
- CMake commands (`target_link_libraries`, `add_test`, `FetchContent`): `https://cmake.org/cmake/help/latest/`.
- GoogleTest assertions and filters: `https://google.github.io/googletest/`.
