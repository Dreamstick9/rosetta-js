---
name: dependency-upgrade
internal: true
description: Bumping or pinning a dependency, fixing breakage after an upgrade, deprecations, lockfile or version-range problems (pip, npm, Cargo, Go, poetry, gems).
triggers:
  keywords: [upgrade, bump, dependency, dependencies, version, outdated, deprecation, deprecated, breaking change, changelog, release notes, lockfile, requirements, package.json, cargo.toml, pin, pinned, semver, migrate, migration, compatibility, dependabot, renovate, cve, incompatible, version range, go.mod, poetry]
  files: [requirements.txt, pyproject.toml, package.json, Cargo.toml, go.mod, Gemfile, poetry.lock, package-lock.json, yarn.lock, Cargo.lock, uv.lock, pnpm-lock.yaml, Pipfile]
tools:
  - script: scripts/pins_list.py
    usage: "pins_list.py [DIR] [--pkg NAME] [--eco E] → declared vs locked vs installed per dep with file:line, flags LOCK-MISMATCH/DUP/UNPINNED/LOOSE…, problems first"
  - script: scripts/semver_check.py
    usage: "semver_check.py V RANGE… | --bump OLD NEW | --latest-satisfying RANGE V…|@registry.json → yes/no with expanded range (npm, pep440, poetry, cargo, go, gem)"
  - script: scripts/changelog_extract.py
    usage: "changelog_extract.py FILE|- --from V1 [--to V2] [--grep API] → only breaking/removed/deprecated/security lines per version, with line numbers"
  - script: scripts/api_usage.py
    usage: "api_usage.py PACKAGE [DIR] → every symbol used from the package (py/js/ts/rust/go) with counts and first file:line, incl. keyword args"
  - script: scripts/lock_diff.py
    usage: "lock_diff.py OLD NEW | --git [REF] [LOCK…] → added/removed/changed packages with bump type (major first) and duplicated versions"
checks:
  - "python3 -m pip check"
  - "npm ls --depth=0 2>&1 | tail -20"
  - "cargo tree --offline --duplicates 2>&1 | head -30"
  - "GOFLAGS=-mod=mod GOPROXY=off go build ./... 2>&1 | tail -20"
  - "pins_list.py ."
---
# Dependency upgrades

## When it applies
- The issue asks to bump, pin, unpin or replace a dependency, or to support a newer major version.
- Code broke after an upgrade: removed/renamed API, changed default, new deprecation warning turned error.
- A lockfile, version range, `requires-python`/`engines`/`rust-version` or dependabot/renovate PR is involved.

## Workflow
1. **Inventory**: `python3 skills/dependency-upgrade/scripts/pins_list.py` shows each dependency's declared range, locked
   version and installed version, flags problems, and gives the file:line of every declaration.
   `--pkg NAME` shows every place one package appears, which lockfile packages require it, and with what range.
2. **Pin down the target** from the issue: the exact version, or "latest compatible with X". Check a candidate against a
   range with `semver_check.py 2.0.1 '^1.4' '>=1.4,<3'`, and classify the jump with `--bump OLD NEW` (major, minor,
   or a 0.x minor, which is breaking).
3. **Research the breaking changes.** `web_fetch` the project's CHANGELOG (raw GitHub URL) or its releases page,
   save the text to a file under `/tmp`, then run `changelog_extract.py /tmp/cl.md --from OLD --to NEW` so you read
   only the breaking, removed, deprecated and security lines. Add `--grep name` for an API you use.
4. **Find the call sites**: `api_usage.py PACKAGE` lists every symbol the repo uses (including keyword arguments like
   `yaml.load(Loader=)`). Compare it with the removed and renamed names from step 3. Fix only the names that are really used.
5. **Change the manifest and the code together.** Edit the one constraint the issue is about. Keep the file's
   existing style (`^` vs `>=`, quoting, sort order). Update the code call sites, tests and any documented version.
6. **Lockfile**: regenerate it only when the tool works offline (`cargo update -p NAME --precise V --offline`,
   `npm install --package-lock-only --offline`, `poetry lock --no-update`, `uv lock --offline`). If it can't be
   regenerated, change only that package's entry consistently: version, `resolved`/`source`, and remove the
   `integrity`/`checksum` rather than invent one. Say so in your answer. Then run `lock_diff.py --git` to
   confirm that nothing else moved.
7. **Verify**: run the tests and the kit's checks. `pins_list.py` should show no new LOCK-MISMATCH or DUP.

## Range semantics (easy to get wrong)
| Syntax | npm / Cargo | PEP 440 / poetry |
|---|---|---|
| `^1.2.3` | `>=1.2.3 <2.0.0` | poetry: same |
| `^0.2.3` | `>=0.2.3 <0.3.0` (0.x minor = breaking) | poetry: same |
| `^0.0.3` | `>=0.0.3 <0.0.4` | poetry: same |
| `~1.2.3` / `~1.2` | `>=1.2.3 <1.3.0` / `>=1.2.0 <1.3.0` | poetry: same |
| `~=2.2` / `~=2.2.0` | n/a | `>=2.2,<3` / `>=2.2.0,<2.3` |
| `1.2.3` bare | npm: exact; **Cargo: `^1.2.3`** | poetry: exact |
| `==1.4.*` / `1.4.x` | `1.4.x` = `>=1.4.0 <1.5.0` | `==1.4.*` matches 1.4.0rc1 … 1.4.99 |
| prereleases | only if the range names the same M.m.p prerelease | excluded unless a specifier names one |
| order | `1.0.0-alpha < 1.0.0-rc.1 < 1.0.0` | `1.0.dev0 < 1.0a1 < 1.0rc1 < 1.0 < 1.0.post1` |
- Go: `require` is a *minimum* (MVS); a major ≥2 needs the `/vN` module path; `replace` overrides the version.
- Ruby `~> 1.2` = `>=1.2,<2`; `~> 1.2.3` = `>=1.2.3,<1.3`.

## Checklist
- [ ] Only the requested package (plus required peers) changed: `lock_diff.py --git` shows nothing unexpected
- [ ] The new version satisfies every declaration of it (`pins_list.py --pkg NAME`: no DUP/LOCK-MISMATCH)
- [ ] Removed/renamed APIs from the changelog are fixed at every call site that `api_usage.py` found
- [ ] Deprecated-but-working calls updated only when cheap, safe and in scope
- [ ] `requires-python` / `engines.node` / `rust-version` / `go` directive still hold for the new version
- [ ] Lockfile consistent with the manifest (or explicitly noted as not regenerable offline)
- [ ] Tests pass; `pip check` / `npm ls` / `cargo tree -d` show no new conflicts

## Pitfalls
- **Upgrading more than asked**: `npm update`, `cargo update`, `poetry update` without a package name move
  everything. Always pass the package name. Hidden tests are written for the requested version only.
- **Hand-edited lockfiles that disagree**: bumping `version` but leaving the old `resolved` URL, `integrity`,
  `checksum` or dependency list. Cargo rejects a wrong checksum, and npm reinstalls. Keep every field in one entry consistent.
- **0.x caret**: `^0.2` does *not* allow 0.3. In Cargo a bare `"0.2"` is also a caret. A 0.x minor bump is a major bump.
- **`~=` with one component** is invalid. `~=2` fails, so write `~=2.0`. `~=1.4.5` stops before 1.5, not 2.0.
- **Transitive pins**: another package may require `<2` of your target (`pins_list.py --pkg NAME` shows "required by").
  Then you must bump that package too, or pick the highest version that fits: `semver_check.py --latest-satisfying`.
- **Interpreter/runtime floors**: new majors often drop old Python/Node/Rust. Check `python_requires`/`engines` in
  registry metadata against the repo's own `requires-python` and CI matrix.
- **Removed defaults**: a major release often changes a default (`yaml.load` needs `Loader=`; pandas
  `inplace`, `numeric_only`). Search for calls that relied on the old default, not only for renamed names.
- **No network in the sandbox**: `pip install`/`npm install`/`cargo fetch` from registries will fail or hang.
  Use what is installed or vendored (`pins_list.py` shows it). Research goes through `web_fetch`, never the shell.
- **Same package declared twice** (requirements.txt and pyproject, dev and peer deps, workspace members): update all
  declarations or they drift (DUP flag).
- Keep changes minimal: no reformatting of manifests, no re-sorting, no unrelated version bumps.

## Research (use `web_fetch`, then save the text and run the kit's scripts on it)
- PyPI: `https://pypi.org/pypi/<pkg>/json` (all releases, `requires_python`, yanked) and `/pypi/<pkg>/<ver>/json`
  (that version's `requires_dist`). Save it and run `semver_check.py --latest-satisfying '<range>' @file`.
- npm: `https://registry.npmjs.org/<pkg>` (versions, `dist-tags`, `engines`, `peerDependencies`).
- crates.io: `https://crates.io/api/v1/crates/<name>` (versions, yanked) and docs.rs `https://docs.rs/<name>/<ver>`.
- Go: `https://proxy.golang.org/<module>/@v/list` and `https://pkg.go.dev/<module>?tab=versions`.
- Changelogs: `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/CHANGELOG.md` (also `CHANGES.rst`, `HISTORY.md`,
  `NEWS`), `https://github.com/<owner>/<repo>/releases`, and "migration guide" or "upgrading" pages in the docs.
- Dependency graph and advisories: `https://deps.dev` and OSV (`POST https://api.osv.dev/v1/query` with
  `{"package":{"name":"<pkg>","ecosystem":"PyPI|npm|crates.io|Go"},"version":"<ver>"}`), plus GitHub advisories (GHSA).
