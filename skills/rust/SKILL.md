---
name: rust
internal: true
description: "Rust crates and workspaces: compile and borrow-checker errors, failing cargo tests, clippy, features, bug fixes and new code."
triggers:
  keywords: [rust, cargo, crate, rustc, borrow, borrow checker, lifetime, trait, impl, unwrap, panic, clippy, async, tokio, serde, macro, workspace, feature flag, cfg, e0382, e0502, mismatched types]
  files: [Cargo.toml, Cargo.lock, rust-toolchain.toml, rust-toolchain, "*.rs"]
tools:
  - script: scripts/crate_map.py
    usage: "crate_map.py [DIR] [--for FILE] → workspace crates, targets, features, test counts, vendoring, undeclared cfg(feature); --for: owning crate + exact test command"
  - script: scripts/cargo_errors.py
    usage: "cargo_errors.py [FILE|-] [--run CMD] [--warnings] [-- CARGO_ARGS] → runs cargo check (JSON), first error per file with code line, labels, help"
  - script: scripts/cargo_test_fail.py
    usage: "cargo_test_fail.py [FILE|-] [-- CARGO_ARGS] → runs cargo test, prints only failing tests: panic site, message, left/right, rerun command"
  - script: scripts/explain_code.py
    usage: "explain_code.py E0502 [E0382 ...] → 2-line fix recipe per rustc error code or clippy lint (--list for known codes)"
checks:
  - cargo check --all-targets --offline
  - cargo test --offline
---
# Rust

## When it applies
- The repo has `Cargo.toml` and the task is a compile error, a failing test, a bug or a feature in Rust.
- The task mentions ownership, lifetimes, traits, panics, `unwrap`, async, clippy, features or cargo.

## Workflow
1. `python3 skills/rust/scripts/crate_map.py` once: crate names, which crate has tests, whether to use `--offline`
   (vendored sources), and features. `crate_map.py --for src/x/y.rs` gives the owning crate and the
   exact `cargo test -p CRATE --lib x::y` command.
2. Reproduce. Compile problem: `python3 skills/rust/scripts/cargo_errors.py -- -p CRATE` (runs `cargo check --all-targets`
   with JSON, so test code is checked too). Behavior bug: write a failing test next to the code
   (`#[cfg(test)] mod tests`) or in `tests/`, then `python3 skills/rust/scripts/cargo_test_fail.py -- -p CRATE NAME`.
3. Fix the **first** error first; later errors are often consequences. For an unfamiliar code run
   `python3 skills/rust/scripts/explain_code.py E0xxx`.
4. Re-run the same narrow command after each edit. Only at the end run the whole crate, then the
   workspace (`cargo test --offline`).
5. Lints if the project enforces them (CI config, `#![deny(...)]`, `clippy.toml`):
   `cargo_errors.py --warnings --run "cargo clippy --all-targets --message-format=json -- -D warnings"`.
6. Formatting: `cargo fmt --check` if the repo is formatted (a `rustfmt.toml` or CI step); run `cargo fmt -p CRATE`.

## Borrow checker playbook
- E0502/E0499 (conflicting borrows): copy the small value out first (`let n = v.len();`), end the shared
  borrow before mutating, or do two passes (collect indices, then mutate). Borrow disjoint struct fields
  separately instead of calling a `&mut self` method while holding `&self.field`.
- E0382 (moved): borrow (`&x`, `for v in &xs`), reorder, or `.clone()` only small/cheap values.
  `Option<T>` fields: `.as_ref()`, `.as_mut()`, `.take()`.
- E0507 (move out of borrow): `std::mem::take`/`replace`, `.clone()`, or iterate `.iter()`.
- E0597/E0716/E0515 (lifetimes): return owned data; bind temporaries with `let`; do not fight with
  `'static` or `unsafe`.
- Shared mutable state across threads: `Arc<Mutex<T>>`; single thread: `Rc<RefCell<T>>` only as a last
  resort. Never hold a `MutexGuard`/`RefCell` borrow across `.await` or a callback.

## Features and cfg
- Code behind `#[cfg(feature = "x")]` is not compiled by default: check with `--features x`,
  `--all-features` and `--no-default-features` when you touch it. `crate_map.py` flags feature names
  used in code but missing from `[features]` (typo or missing declaration).
- `#[cfg(test)]` helpers are invisible to other crates and to integration tests in `tests/`.
- Platform cfgs (`target_os`) may hide code on this machine; do not assume it compiled.

## Rules
- Return `Result` with the crate's existing error type and `?`; no new `unwrap()` on input-dependent
  values in library code; `expect("why")` only for true invariants.
- Keep public API stable: new enum variants or struct fields can break users; add constructors or
  `#[non_exhaustive]` only if the crate already does.
- Match the edition and toolchain in `rust-toolchain.toml`; do not use newer std APIs.
- No new dependencies, no `cargo update`: `Cargo.lock` must not change (there is no network).
- Integer overflow panics in debug and wraps in release: use `checked_*`/`saturating_*` where input
  decides; prefer `TryFrom` over `as` casts that truncate.
- Async: no blocking calls (`std::thread::sleep`, blocking IO) inside async fns; use the runtime's
  versions or `spawn_blocking`.

## Checklist
- [ ] Reproduced with a failing test or compile error first
- [ ] `cargo check --all-targets` clean for the touched crates; no new warnings
- [ ] Regression test added; `cargo test -p CRATE` passes, then the workspace
- [ ] Feature combinations touched are compiled (`--all-features` / `--no-default-features`)
- [ ] No new `unwrap()` on fallible input; public API compatible
- [ ] `Cargo.lock` unchanged; no new crates
- [ ] `cargo fmt --check` and clippy clean if the project enforces them

## Pitfalls
- Building the whole workspace on every iteration when `-p CRATE` would do.
- Silencing the borrow checker with gratuitous `.clone()`, `Rc<RefCell<>>` everywhere, or `unsafe`.
- Fixing the 5th error before the 1st: the rest often disappear.
- Tests relying on `HashMap` iteration order or on test execution order (tests run in parallel;
  `-- --test-threads=1` to confirm shared-state flakiness).
- Doc tests: examples in `///` comments are compiled and run by `cargo test`; update them with the API.
- `cargo test NAME` filters by substring; use `-- --exact` for one test.
- Forgetting `RUST_BACKTRACE=1` when a panic's origin is unclear.
- `--offline` failing with "no matching package": the crate is not vendored/cached; do not add it.

## Research (web_search / web_fetch)
- Error codes: `https://doc.rust-lang.org/error_codes/E0502.html` (or `rustc --explain E0502` offline).
- std API and the version it was stabilized in: `https://doc.rust-lang.org/std/` (check "since").
- A crate's API at the locked version: `https://docs.rs/CRATE/VERSION` (version from `Cargo.lock`).
- Clippy lint explanations: `https://rust-lang.github.io/rust-clippy/master/` (search the lint name).
- Cargo features and manifest keys: `https://doc.rust-lang.org/cargo/reference/features.html`.
