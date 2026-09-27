---
name: go
internal: true
description: "Go modules and services: build/vet errors, failing go tests, panics, data races, goroutine leaks, table-driven tests with go test -run."
triggers:
  keywords: [go, golang, goroutine, channel, go test, go vet, go.mod, gofmt, interface, context, mutex, waitgroup, nil pointer, data race, deadlock, defer, errors.is, table-driven, subtest, cgo]
  files: [go.mod, go.sum, go.work, "*.go"]
tools:
  - script: scripts/go_map.py
    usage: "go_map.py [DIR] [--for FILE] → module, go version, vendoring, packages with test counts, build tags; --for: tests calling FILE's funcs + exact -run command"
  - script: scripts/go_errors.py
    usage: "go_errors.py [FILE|-] [--run CMD] [-- PKGS] → go build then go vet; first error per file with source line and fix hint"
  - script: scripts/go_test_fail.py
    usage: "go_test_fail.py [FILE|-] [-- ARGS] → runs go test -json; failing leaf tests, t.Error lines, panic frame, data races, rerun command"
checks:
  - GOPROXY=off go build ./... && GOPROXY=off go vet ./...
  - GOPROXY=off go test ./...
---
# Go

## When it applies
- The repo has `go.mod` and the task is a bug, a failing test, a panic, a race or a feature in Go.
- The task mentions goroutines, channels, contexts, nil pointers, `go test`, `go vet` or data races.

## Workflow
1. `python3 skills/go/scripts/go_map.py`: module path, packages with test counts, vendoring and build tags in one call.
   `go_map.py --for internal/x/y.go` lists the tests that call that file's functions and the exact
   `go test ./internal/x -run '^(TestA|TestB)$'` command.
2. Compile problems: `python3 skills/go/scripts/go_errors.py -- ./internal/x/...` (build first, then vet, which also
   type-checks `_test.go` files). Fix the first error per file first.
3. Behavior bug: add a failing case to the existing table-driven test (or a new `TestX` in `x_test.go`,
   same package), then `python3 skills/go/scripts/go_test_fail.py -- ./internal/x -run '^TestX$'`.
4. Concurrency: `go_test_fail.py -- -race ./internal/x` (needs cgo and a C compiler). A race line names
   both accesses and their goroutines; protect the variable with a mutex/atomic or confine it to one goroutine.
5. Re-run the narrow test after each edit with `-count=1` (bypasses the test cache), then `go test ./...`.
6. `gofmt -l .` must print nothing for touched files; run `gofmt -w FILE`.

## Rules
- Errors are values: return them wrapped with context, `fmt.Errorf("load %s: %w", name, err)`; check with
  `errors.Is/As`. Never drop an error silently; `_ =` only when intended.
- Nil safety: initialize maps before writing (`make`), check pointers before dereference. An interface
  holding a typed nil pointer is **not** nil: return a literal `nil` for "no error".
- Slices share backing arrays: `append` to a slice you received may overwrite the caller's data;
  `copy` or use `slices.Clone` (Go 1.21+) before mutating.
- Every goroutine needs an exit path: a `context.Context` cancel or a closed channel. Use
  `sync.WaitGroup` or channels to wait, never `time.Sleep` in tests.
- `context.Context` is the first parameter of IO call chains; respect `ctx.Done()`.
- Exported names, signatures and struct fields are public API: keep them compatible.
- Match the `go` line in go.mod: no generics before 1.18, no `slices`/`maps`/`min`/`max` before 1.21,
  per-iteration loop variables only from 1.22 (earlier: `v := v` before capturing in a closure).
- No new modules: `go get` needs network; go.mod and go.sum must not change.

## Checklist
- [ ] Reproduced with a failing test first
- [ ] `go build ./...` and `go vet ./...` clean
- [ ] The fixed test and its package pass with `-count=1`; then `go test ./...`
- [ ] Concurrent code passes `-race` (when cgo is available)
- [ ] Errors wrapped with `%w` and checked; no ignored errors
- [ ] No goroutine leaks; no `time.Sleep` synchronization in tests
- [ ] gofmt clean; go.mod/go.sum unchanged

## Pitfalls
- `:=` inside an `if`/`for` block shadows the outer `err`, so the function returns the outer, nil `err`.
- Writing to a nil map panics; reading a missing key returns the zero value silently (use `v, ok :=`).
- Deadlock: unbuffered send with no receiver, or `range ch` on a channel nobody closes.
- `defer` in a loop runs at function exit, not per iteration (files stay open): wrap the body in a func.
- `defer mu.Unlock()` after an early `return` path that forgot `Lock`, or copying a struct holding a
  `sync.Mutex` (vet's copylocks).
- `time.Now()`/map iteration order/`rand` in tests make them flaky: inject clocks, sort keys, seed RNGs.
- `t.Fatal` from a goroutine other than the test's does not stop the test; send errors back on a channel.
- `-run TestA` also matches `TestAB`: anchor with `'^TestA$'`; subtests: `'^TestA$/^case_name$'`
  (spaces in subtest names become `_`).
- Build tags (`//go:build integration`) hide files: `go test -tags integration`.
- `testdata/` is ignored by the go tool: fixtures go there.

## Research (web_search / web_fetch)
- Standard library and the version an API appeared: `https://pkg.go.dev/std` (look for "added in go1.x").
- A dependency at the pinned version: `https://pkg.go.dev/MODULE@VERSION` (version from go.mod).
- Vet analyzers and what they mean: `https://pkg.go.dev/cmd/vet`.
- Race detector report format: `https://go.dev/doc/articles/race_detector`.
- Language changes per release (loopvar, generics): `https://go.dev/doc/devel/release`.
