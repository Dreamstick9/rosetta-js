#!/usr/bin/env python3
"""Detect a JS frontend project's framework, bundler, test runner and commands.

Usage: detect_frontend.py [DIR]

Reads package.json (and nested workspaces one level down), lockfiles and config
files, then prints one compact report: framework + version, bundler, test
runner(s), package manager, useful npm scripts, entry points, and the exact
test command to run (only locally installed tools, no network).
"""
import json
import os
import sys

MAX_LINES = 40

FRAMEWORKS = [
    ("next", "Next.js"), ("nuxt", "Nuxt"), ("@sveltejs/kit", "SvelteKit"),
    ("svelte", "Svelte"), ("@angular/core", "Angular"), ("vue", "Vue"),
    ("solid-js", "Solid"), ("preact", "Preact"), ("react", "React"),
    ("@remix-run/react", "Remix"), ("astro", "Astro"), ("lit", "Lit"),
]
BUNDLERS = [("vite", "vite"), ("webpack", "webpack"), ("parcel", "parcel"),
            ("esbuild", "esbuild"), ("rollup", "rollup"), ("react-scripts", "CRA (react-scripts)"),
            ("@angular-devkit/build-angular", "angular-cli"), ("turbo", "turborepo")]
TESTERS = [("vitest", "vitest"), ("jest", "jest"), ("@playwright/test", "playwright"),
           ("cypress", "cypress"), ("mocha", "mocha"), ("@testing-library/react", "RTL"),
           ("@testing-library/vue", "VTL"), ("@testing-library/svelte", "STL"),
           ("@vue/test-utils", "vue-test-utils"), ("karma", "karma"), ("ava", "ava")]
CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vitest.config.ts",
           "vitest.config.js", "jest.config.js", "jest.config.ts", "jest.config.cjs",
           "jest.config.mjs", "playwright.config.ts", "playwright.config.js",
           "cypress.config.ts", "cypress.config.js", "next.config.js", "next.config.mjs",
           "nuxt.config.ts", "svelte.config.js", "angular.json", "tsconfig.json",
           "babel.config.js", ".babelrc", "webpack.config.js", ".eslintrc.json",
           ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", "postcss.config.js",
           "tailwind.config.js", "tailwind.config.ts"]
ENTRIES = ["src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js", "src/index.tsx",
           "src/index.ts", "src/index.jsx", "src/index.js", "src/App.tsx", "src/App.jsx",
           "src/App.vue", "src/App.svelte", "app/layout.tsx", "app/page.tsx",
           "pages/_app.tsx", "pages/_app.js", "pages/index.tsx", "pages/index.js",
           "src/routes/+page.svelte", "src/app/app.component.ts", "index.html"]


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def installed_version(root, name):
    pj = load(os.path.join(root, "node_modules", name, "package.json"))
    return pj.get("version") if pj else None


def pkg_manager(root):
    for lock, pm in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"),
                     ("bun.lockb", "bun"), ("bun.lock", "bun"),
                     ("package-lock.json", "npm"), ("npm-shrinkwrap.json", "npm")):
        if os.path.exists(os.path.join(root, lock)):
            return pm, lock
    return "npm", None


def test_command(root, scripts, testers):
    bin_dir = os.path.join(root, "node_modules", ".bin")
    have = set(os.listdir(bin_dir)) if os.path.isdir(bin_dir) else set()
    if "vitest" in testers:
        cmd = "npx --no-install vitest run" if "vitest" in have else "vitest run (NOT installed)"
        return cmd + "  [one file: add path; one test: -t 'name']"
    if "jest" in testers:
        cmd = "npx --no-install jest --ci" if "jest" in have else "jest (NOT installed)"
        return cmd + "  [one file: add path; one test: -t 'name']"
    if "react-scripts" in testers:
        return "CI=true npx --no-install react-scripts test --watchAll=false"
    if "mocha" in testers:
        return "npx --no-install mocha"
    if "test" in scripts:
        return "npm test --silent   (script: %s)" % scripts["test"][:60]
    return "no test runner found"


def analyse(root, out, label=""):
    pj = load(os.path.join(root, "package.json"))
    if pj is None:
        return False
    deps = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        deps.update(pj.get(key) or {})
    scripts = pj.get("scripts") or {}
    name = pj.get("name", "?")
    out.append("== %s%s (%s) type=%s" % (label, name, root, pj.get("type", "commonjs")))
    fw = []
    for key, pretty in FRAMEWORKS:
        if key in deps:
            v = installed_version(root, key)
            fw.append("%s %s%s" % (pretty, deps[key], " (installed %s)" % v if v else ""))
    out.append("framework: " + (", ".join(fw) if fw else "none detected (vanilla?)"))
    b = [p for k, p in BUNDLERS if k in deps]
    out.append("bundler:   " + (", ".join(b) if b else "none"))
    t = [p for k, p in TESTERS if k in deps]
    out.append("tests:     " + (", ".join(t) if t else "none"))
    if "typescript" in deps:
        out.append("typescript: %s" % deps["typescript"])
    pm, lock = pkg_manager(root)
    nm = os.path.isdir(os.path.join(root, "node_modules"))
    out.append("pkg mgr:   %s (%s); node_modules %s" % (pm, lock or "no lockfile",
                                                        "present" if nm else "MISSING (tests cannot run offline)"))
    keys = [k for k in ("dev", "build", "test", "test:unit", "test:e2e", "lint", "typecheck", "check") if k in scripts]
    for k in keys:
        out.append("  script %-10s %s" % (k, scripts[k][:70]))
    testers = [k for k, _ in TESTERS if k in deps]
    if "react-scripts" in deps:
        testers.append("react-scripts")
    out.append("run tests: " + test_command(root, scripts, testers))
    cfg = [c for c in CONFIGS if os.path.exists(os.path.join(root, c))]
    if cfg:
        out.append("configs:   " + " ".join(cfg))
    ent = [e for e in ENTRIES if os.path.exists(os.path.join(root, e))]
    if ent:
        out.append("entries:   " + " ".join(ent[:6]))
    if "jest" in pj:
        out.append("jest cfg in package.json: " + json.dumps(pj["jest"])[:90])
    ws = pj.get("workspaces")
    if isinstance(ws, dict):
        ws = ws.get("packages")
    if ws:
        out.append("workspaces: " + " ".join(ws[:6]))
    return True


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    out = []
    if not analyse(root, out):
        out.append("no package.json in %s" % root)
    # one level of sub-packages (monorepos: packages/*, apps/*, frontend/, client/, web/)
    for parent in ("packages", "apps", "."):
        base = os.path.join(root, parent)
        if not os.path.isdir(base):
            continue
        for d in sorted(os.listdir(base)):
            sub = os.path.join(base, d)
            if d in ("node_modules", ".git") or not os.path.isdir(sub) or sub == root:
                continue
            if os.path.exists(os.path.join(sub, "package.json")) and len(out) < MAX_LINES - 6:
                analyse(sub, out, label="sub ")
    for line in out[:MAX_LINES]:
        print(line)
    if len(out) > MAX_LINES:
        print("(+%d more; run on a sub-dir)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
