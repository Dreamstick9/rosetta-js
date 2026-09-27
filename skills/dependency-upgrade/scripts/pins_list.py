#!/usr/bin/env python3
"""Inventory of declared dependency constraints vs locked vs installed versions, with problem flags.

usage: pins_list.py [DIR] [--pkg NAME] [--eco python|npm|cargo|go|gem] [--all]
  → one line per dependency: "eco name declared locked installed flags file:line", problems first.
    --pkg NAME   every place NAME appears (declared file:line, each lockfile's versions, installed,
                 and which locked packages require it with what range)
    --eco E      only one ecosystem;  --all  also list Cargo members that just inherit workspace deps

Manifests: requirements*.txt / *.in (-r/-c includes, extras, markers, URLs, -e), pyproject.toml (PEP 621,
optional-dependencies, dependency-groups, poetry, uv, requires-python, build-system), setup.cfg,
setup.py, Pipfile, package.json (deps/dev/peer/optional, engines), Cargo.toml (workspace, targets,
path/git, renames), go.mod (require, replace, go), Gemfile.
Locks: package-lock v1/v2/v3, npm-shrinkwrap, yarn.lock v1/berry, pnpm-lock, Cargo.lock, poetry.lock,
pdm.lock, uv.lock, Pipfile.lock, go.sum, Gemfile.lock, X.txt compiled from X.in.
Installed: python = ./.venv|venv site-packages, else this python3's importlib.metadata; node =
node_modules/<pkg>/package.json; cargo = vendor/ or ~/.cargo/registry/src; go = vendor/modules.txt or
the module cache.
Flags: LOCK-MISMATCH (locked version outside declared range, or missing from the lock),
INSTALLED-MISMATCH, DUP (declared twice with different constraints), NOT-INSTALLED,
UNPINNED (*, latest, no constraint), LOOSE (lower bound only), GIT/PATH (git/path/url source).
Skips .git, node_modules, vendor, target, venvs, build dirs. Read-only; exit 0 unless usage is wrong."""
import ast
import bisect
import json
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import semver_check as sv  # noqa: E402

SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "vendor", "third_party", "target", ".venv", "venv", "env",
             "__pycache__", "dist", "build", ".tox", ".nox", ".mypy_cache", ".pytest_cache", "site-packages",
             ".cargo", ".idea", ".vscode", "bower_components", ".next", ".yarn", "coverage", ".gradle", "runs"}
MAX_DEPTH = 6
LOCK_NAMES = {
    "package-lock.json": "npm", "npm-shrinkwrap.json": "npm", "yarn.lock": "npm", "pnpm-lock.yaml": "npm",
    "Cargo.lock": "cargo", "poetry.lock": "python", "pdm.lock": "python", "uv.lock": "python",
    "Pipfile.lock": "python", "go.sum": "go", "Gemfile.lock": "gem",
}

# ─────────────────────────── TOML subset reader ───────────────────────────

_BARE = re.compile(r"[A-Za-z0-9_-]+")
_TOKEN = re.compile(r"[^\s,\]\}#]+")
_ESC = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "b": "\b", "f": "\f"}


def _unescape(s):
    def rep(m):
        e = m.group(1)
        if e[0] in "uU":
            try:
                return chr(int(e[1:], 16))
            except ValueError:
                return e
        return _ESC.get(e, e)
    s = re.sub(r"\\\s*\n\s*", "", s)
    return re.sub(r"\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)", rep, s)


class _Toml(object):
    def __init__(self, text):
        self.s, self.i, self.n = text, 0, len(text)
        self.nl = [m.start() for m in re.finditer("\n", text)]
        self.lines = {}

    def line(self, i):
        return bisect.bisect_left(self.nl, i) + 1

    def ws(self):
        while self.i < self.n and self.s[self.i] in " \t\r":
            self.i += 1

    def ws_nl(self):
        while self.i < self.n:
            c = self.s[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif c == "#":
                j = self.s.find("\n", self.i)
                self.i = self.n if j < 0 else j
            else:
                break

    def key(self):
        parts = []
        while True:
            self.ws()
            c = self.s[self.i:self.i + 1]
            if c in ('"', "'"):
                parts.append(self.string())
            else:
                m = _BARE.match(self.s, self.i)
                if not m:
                    raise ValueError("bad key")
                parts.append(m.group())
                self.i = m.end()
            self.ws()
            if self.s.startswith(".", self.i):
                self.i += 1
                continue
            return parts

    def string(self):
        s, i = self.s, self.i
        for q in ('"""', "'''"):
            if s.startswith(q, i):
                j = s.find(q, i + 3)
                if j < 0:
                    raise ValueError("unterminated string")
                while s.startswith(q[0], j + 3):
                    j += 1
                raw = s[i + 3:j]
                self.i = j + 3
                raw = raw[1:] if raw.startswith("\n") else (raw[2:] if raw.startswith("\r\n") else raw)
                return _unescape(raw) if q[0] == '"' else raw
        if s[i] == "'":
            j = s.find("'", i + 1)
            if j < 0:
                raise ValueError("unterminated string")
            self.i = j + 1
            return s[i + 1:j]
        j = i + 1
        while j < self.n and s[j] != '"':
            if s[j] == "\n":
                raise ValueError("newline in string")
            j += 2 if s[j] == "\\" else 1
        self.i = j + 1
        return _unescape(s[i + 1:j])

    def value(self):
        self.ws()
        c = self.s[self.i]
        if c in "\"'":
            return self.string()
        if c == "[":
            self.i += 1
            arr = []
            while True:
                self.ws_nl()
                if self.s[self.i] == "]":
                    self.i += 1
                    return arr
                arr.append(self.value())
                self.ws_nl()
                if self.s[self.i] == ",":
                    self.i += 1
        if c == "{":
            self.i += 1
            tbl = {}
            while True:
                self.ws()
                if self.s[self.i] == "}":
                    self.i += 1
                    return tbl
                k = self.key()
                if self.s[self.i] != "=":
                    raise ValueError("expected =")
                self.i += 1
                _set_path(tbl, k, self.value())
                self.ws()
                if self.s[self.i] == ",":
                    self.i += 1
        m = _TOKEN.match(self.s, self.i)
        if not m:
            raise ValueError("bad value")
        self.i = m.end()
        t = m.group()
        if t in ("true", "false"):
            return t == "true"
        try:
            return int(t.replace("_", ""), 0) if re.match(r"^[+-]?(0[xob])?[0-9_a-fA-F]+$", t) and not re.match(r"^\d{4}-", t) else float(t)
        except ValueError:
            return t

    def record(self, path, i):
        ln = self.line(i)
        for k in range(1, len(path) + 1):
            self.lines.setdefault(tuple(path[:k]), ln)
        self.lines[tuple(path)] = ln

    def parse(self):
        root, path = {}, ()
        cur = root
        while True:
            self.ws_nl()
            if self.i >= self.n:
                break
            start = self.i
            try:
                if self.s[self.i] == "[":
                    arr = self.s.startswith("[[", self.i)
                    self.i += 2 if arr else 1
                    k = self.key()
                    cur, path = _open_table(root, k, arr)
                    self.record(path, start)
                else:
                    k = self.key()
                    if self.s[self.i:self.i + 1] != "=":
                        raise ValueError("expected =")
                    self.i += 1
                    _set_path(cur, k, self.value())
                    self.record(path + tuple(k), start)
            except (ValueError, IndexError, TypeError, AttributeError):
                pass
            j = self.s.find("\n", max(self.i, start + 1))
            self.i = self.n if j < 0 else j + 1
        return root


def _set_path(tbl, keys, val):
    for k in keys[:-1]:
        nxt = tbl.get(k)
        if nxt is None:
            nxt = tbl[k] = {}
        if isinstance(nxt, list):
            nxt = nxt[-1]
        if not isinstance(nxt, dict):
            raise ValueError("key conflict")
        tbl = nxt
    tbl[keys[-1]] = val


def _open_table(root, keys, arr):
    t, path = root, []
    for idx, k in enumerate(keys):
        if idx == len(keys) - 1 and arr:
            lst = t.setdefault(k, [])
            if not isinstance(lst, list):
                raise ValueError("not an array")
            lst.append({})
            return lst[-1], tuple(path + [k, len(lst) - 1])
        nxt = t.get(k)
        if nxt is None:
            nxt = t[k] = {}
        if isinstance(nxt, list):
            path += [k, len(nxt) - 1]
            nxt = nxt[-1]
        else:
            path.append(k)
        if not isinstance(nxt, dict):
            raise ValueError("not a table")
        t = nxt
    return t, tuple(path)


def toml_load(text):
    """→ (data, lines) where lines maps key-path tuples to 1-based line numbers."""
    p = _Toml(text)
    return p.parse(), p.lines


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


# ─────────────────────────── helpers ───────────────────────────

def norm_py(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def norm(eco, name):
    return norm_py(name) if eco == "python" else name


def find_line(lines, needle, start=1):
    for i in range(max(start, 1) - 1, len(lines)):
        if needle in lines[i]:
            return i + 1
    return start


class Dep(object):
    __slots__ = ("eco", "name", "spec", "kind", "file", "line", "src", "check", "extra", "inherit", "marker")

    def __init__(self, eco, name, spec, kind, file, line, src=None, check=None, extra="", inherit=False, marker=""):
        self.eco, self.name, self.spec, self.kind, self.file, self.line = eco, name, spec, kind, file, line
        self.src, self.extra, self.inherit, self.marker = src, extra, inherit, marker
        self.check = check or {"python": "pep440", "npm": "npm", "cargo": "cargo", "go": "go", "gem": "gem"}[eco]


# ─────────────────────────── Python manifests ───────────────────────────

_REQ = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$")


def parse_req(text):
    """PEP 508 string → (name, spec, marker, src) or None."""
    text = text.strip()
    marker = ""
    if ";" in text and not re.match(r"^\w[\w.-]*\s*@", text):
        text, marker = [x.strip() for x in text.split(";", 1)]
    elif ";" in text:
        head, tail = text.rsplit(";", 1)
        if re.search(r"(python_version|sys_platform|platform_|os_name|extra|implementation_name)", tail):
            text, marker = head.strip(), tail.strip()
    m = _REQ.match(text)
    if not m:
        return None
    rest = m.group(3).strip()
    if rest.startswith("@"):
        url = rest[1:].strip()
        src = "git" if url.startswith("git+") else ("path" if url.startswith("file:") else "url")
        return m.group(1), "@ " + url, marker, src
    spec = re.sub(r"\s+", "", rest.strip("()"))
    return m.group(1), spec, marker, None


def _url_name(url):
    m = re.search(r"[#&]egg=([A-Za-z0-9._-]+)", url)
    if m:
        return m.group(1)
    base = url.rstrip("/").split("#")[0].split("?")[0].rsplit("/", 1)[-1]
    base = re.sub(r"\.git$", "", base)
    m = re.match(r"^([A-Za-z0-9_.]+?)-\d", base)
    return m.group(1) if m else base


def requirements(path, root, seen, kind="requirements"):
    real = os.path.realpath(path)
    if real in seen or not os.path.isfile(path):
        return []
    seen.add(real)
    rel = os.path.relpath(path, root)
    out = []
    raw = read(path).split("\n")
    i = 0
    while i < len(raw):
        ln, line = i + 1, raw[i]
        while line.endswith("\\") and i + 1 < len(raw):
            i += 1
            line = line[:-1] + " " + raw[i]
        i += 1
        line = re.sub(r"(^|\s)#.*$", "", line).strip()
        line = re.sub(r"\s--hash[=\s]\S+", "", line).strip()
        if not line:
            continue
        m = re.match(r"^(-r|--requirement|-c|--constraint)\s*=?\s*(\S+)", line)
        if m:
            sub = os.path.join(os.path.dirname(path), m.group(2))
            out += requirements(sub, root, seen, "constraint" if m.group(1) in ("-c", "--constraint") else kind)
            continue
        ed = re.match(r"^(-e|--editable)\s*=?\s*(\S+)", line)
        if ed or re.match(r"^(git\+|hg\+|svn\+|https?://|file:|\.{0,2}/)", line):
            url = ed.group(2) if ed else line.split()[0]
            src = "git" if url.startswith("git+") else ("url" if re.match(r"^https?:", url) else "path")
            name = _url_name(url) if src != "path" else os.path.basename(os.path.normpath(url.split("#")[0])) or url
            if src == "path" and "#egg=" in url:
                name = _url_name(url)
            out.append(Dep("python", name, "@ " + url, kind + (" -e" if ed else ""), rel, ln, src=src))
            continue
        if line.startswith("-"):
            continue
        r = parse_req(line)
        if r:
            out.append(Dep("python", r[0], r[1], kind, rel, ln, src=r[3], marker=r[2]))
    return out


def _poetry_spec(v):
    if isinstance(v, str):
        return v, None, ""
    if isinstance(v, list):
        specs = [_poetry_spec(x)[0] for x in v]
        return " || ".join(s for s in specs if s), None, "multiple-constraints"
    if isinstance(v, dict):
        src = "git" if "git" in v else ("path" if "path" in v else ("url" if "url" in v else None))
        extra = []
        if v.get("extras"):
            extra.append("extras=" + ",".join(v["extras"]))
        if v.get("optional"):
            extra.append("optional")
        if src:
            ref = v.get("git") or v.get("path") or v.get("url")
            return "@ %s%s" % (ref, (" " + (v.get("rev") or v.get("tag") or v.get("branch") or "")).rstrip()), src, " ".join(extra)
        return str(v.get("version", "")), None, " ".join(extra)
    return str(v), None, ""


def pyproject(path, root):
    text = read(path)
    data, lines = toml_load(text)
    tl = text.split("\n")
    rel = os.path.relpath(path, root)
    out = []

    def add_list(items, kind, keypath):
        start = lines.get(keypath, 1)
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, str):
                continue
            r = parse_req(item)
            if r:
                ln = find_line(tl, '"%s' % item.strip()[:40], start) if ('"%s' % item.strip()[:40]) in text \
                    else find_line(tl, item.strip()[:40], start)
                out.append(Dep("python", r[0], r[1], kind, rel, ln, src=r[3], marker=r[2]))

    proj = data.get("project") or {}
    if isinstance(proj, dict):
        if proj.get("requires-python"):
            out.append(Dep("python", "python", str(proj["requires-python"]), "requires-python", rel,
                           lines.get(("project", "requires-python"), 1)))
        add_list(proj.get("dependencies"), "dependencies", ("project", "dependencies"))
        for g, items in sorted((proj.get("optional-dependencies") or {}).items()):
            add_list(items, "extra:" + g, ("project", "optional-dependencies", g))
    for g, items in sorted((data.get("dependency-groups") or {}).items()):
        add_list(items, "group:" + g, ("dependency-groups", g))
    bs = data.get("build-system") or {}
    if isinstance(bs, dict):
        add_list(bs.get("requires"), "build", ("build-system", "requires"))
    tool = data.get("tool") or {}
    uv = tool.get("uv") or {}
    if isinstance(uv, dict):
        add_list(uv.get("dev-dependencies"), "dev", ("tool", "uv", "dev-dependencies"))
    poetry = tool.get("poetry") or {}
    if isinstance(poetry, dict):
        tables = [(("tool", "poetry", "dependencies"), "dependencies", poetry.get("dependencies")),
                  (("tool", "poetry", "dev-dependencies"), "dev", poetry.get("dev-dependencies"))]
        for g, gv in sorted((poetry.get("group") or {}).items()):
            if isinstance(gv, dict):
                tables.append((("tool", "poetry", "group", g, "dependencies"), "group:" + g, gv.get("dependencies")))
        for kp, kind, tbl in tables:
            if not isinstance(tbl, dict):
                continue
            for name, v in tbl.items():
                spec, src, extra = _poetry_spec(v)
                ln = lines.get(kp + (name,), lines.get(kp, 1))
                if name.lower() == "python":
                    out.append(Dep("python", "python", spec, "requires-python", rel, ln, check="poetry"))
                else:
                    out.append(Dep("python", name, spec, kind, rel, ln, src=src, check="poetry", extra=extra))
    return out


def setup_cfg(path, root):
    rel = os.path.relpath(path, root)
    out = []
    section, key = "", None
    for i, line in enumerate(read(path).split("\n"), 1):
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            section, key = s[1:-1].strip(), None
            continue
        if not s or s.startswith(("#", ";")):
            continue
        m = re.match(r"^([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$", line)
        if m and not line[:1].isspace():
            key = m.group(1)
            val = m.group(2).strip()
        elif line[:1].isspace() and key:
            val = s
        else:
            continue
        kind = None
        if section == "options" and key in ("install_requires", "setup_requires", "tests_require"):
            kind = {"install_requires": "dependencies", "setup_requires": "build", "tests_require": "test"}[key]
        elif section == "options.extras_require":
            kind = "extra:" + key
        elif section == "options" and key == "python_requires" and val:
            out.append(Dep("python", "python", val, "requires-python", rel, i))
            continue
        if kind and val:
            for item in [x for x in val.split(";" if "; " not in val else "\n") if x.strip()]:
                r = parse_req(item)
                if r:
                    out.append(Dep("python", r[0], r[1], kind, rel, i, src=r[3], marker=r[2]))
    return out


def setup_py(path, root):
    rel = os.path.relpath(path, root)
    try:
        tree = ast.parse(read(path))
    except (SyntaxError, ValueError):
        return []
    names = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            names[node.targets[0].id] = node.value

    def strs(node):
        if isinstance(node, ast.Name) and node.id in names:
            node = names[node.id]
        if isinstance(node, (ast.List, ast.Tuple)):
            for e in node.elts:
                if isinstance(e, ast.Constant) and isinstance(e.value, str):
                    yield e.value, e.lineno
                elif getattr(e, "s", None) and isinstance(e.s, str):  # py3.7 ast.Str
                    yield e.s, e.lineno
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        fname = fn.id if isinstance(fn, ast.Name) else (fn.attr if isinstance(fn, ast.Attribute) else "")
        if fname != "setup":
            continue
        for kw in node.keywords:
            kind = {"install_requires": "dependencies", "tests_require": "test", "setup_requires": "build"}.get(kw.arg)
            if kind:
                for s, ln in strs(kw.value):
                    r = parse_req(s)
                    if r:
                        out.append(Dep("python", r[0], r[1], kind, rel, ln, src=r[3], marker=r[2]))
            elif kw.arg == "extras_require":
                val = names.get(kw.value.id) if isinstance(kw.value, ast.Name) else kw.value
                if isinstance(val, ast.Dict):
                    for k, v in zip(val.keys, val.values):
                        g = getattr(k, "value", getattr(k, "s", "?"))
                        for s, ln in strs(v):
                            r = parse_req(s)
                            if r:
                                out.append(Dep("python", r[0], r[1], "extra:%s" % g, rel, ln, src=r[3], marker=r[2]))
            elif kw.arg == "python_requires":
                v = kw.value
                s = getattr(v, "value", getattr(v, "s", None))
                if isinstance(s, str):
                    out.append(Dep("python", "python", s, "requires-python", rel, kw.value.lineno))
    return out


def pipfile(path, root):
    text = read(path)
    data, lines = toml_load(text)
    rel = os.path.relpath(path, root)
    out = []
    for sec, kind in (("packages", "dependencies"), ("dev-packages", "dev")):
        for name, v in sorted((data.get(sec) or {}).items()):
            src = None
            if isinstance(v, dict):
                src = "git" if "git" in v else ("path" if "path" in v else None)
                spec = "@ " + str(v.get("git") or v.get("path")) if src else str(v.get("version", ""))
            else:
                spec = str(v)
            spec = "" if spec == "*" else spec
            out.append(Dep("python", name, spec, kind, rel, lines.get((sec, name), 1), src=src))
    req = data.get("requires") or {}
    if isinstance(req, dict) and req.get("python_version"):
        out.append(Dep("python", "python", "==%s.*" % req["python_version"], "requires-python", rel,
                       lines.get(("requires", "python_version"), 1)))
    return out


# ─────────────────────────── other manifests ───────────────────────────

def package_json(path, root):
    text = read(path)
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    tl = text.split("\n")
    rel = os.path.relpath(path, root)
    out = []
    for sec, kind in (("dependencies", "dependencies"), ("devDependencies", "dev"),
                      ("peerDependencies", "peer"), ("optionalDependencies", "optional"), ("engines", "engines")):
        tbl = data.get(sec)
        if not isinstance(tbl, dict):
            continue
        start = find_line(tl, '"%s"' % sec)
        for name, spec in tbl.items():
            spec = str(spec)
            src = None
            if re.match(r"^(git\+|git:|github:|gitlab:|bitbucket:|[\w.-]+/[\w.-]+(#.*)?$)", spec):
                src = "git"
            elif re.match(r"^(file:|link:|portal:|\.{0,2}/)", spec):
                src = "path"
            elif re.match(r"^https?://", spec):
                src = "url"
            elif spec.startswith("workspace:"):
                src = "path"
            dname = name
            if spec.startswith("npm:"):
                al = spec[4:]
                dname = al.rsplit("@", 1)[0] if al.rfind("@") > 0 else al
            out.append(Dep("npm", dname if kind != "engines" else name + " (engine)", spec, kind, rel,
                           find_line(tl, '"%s"' % name, start), src=src,
                           extra=("alias " + name) if dname != name else ""))
    return out


def cargo_toml(path, root, ws_deps):
    text = read(path)
    data, lines = toml_load(text)
    rel = os.path.relpath(path, root)
    out = []
    tables = []
    for key in ("dependencies", "dev-dependencies", "build-dependencies"):
        tables.append(((key,), key, data.get(key)))
    for tname, tv in sorted((data.get("target") or {}).items()):
        if isinstance(tv, dict):
            for key in ("dependencies", "dev-dependencies", "build-dependencies"):
                tables.append((("target", tname, key), "%s target=%s" % (key, re.sub(r"\s+", "", tname)), tv.get(key)))
    ws = data.get("workspace") or {}
    if isinstance(ws, dict) and isinstance(ws.get("dependencies"), dict):
        tables.insert(0, (("workspace", "dependencies"), "workspace", ws["dependencies"]))
    pkg = data.get("package") or {}
    if isinstance(pkg, dict) and isinstance(pkg.get("rust-version"), str):
        out.append(Dep("cargo", "rust", "^" + pkg["rust-version"], "rust-version", rel,
                       lines.get(("package", "rust-version"), 1)))
    for kp, kind, tbl in tables:
        if not isinstance(tbl, dict):
            continue
        for key, v in tbl.items():
            ln = lines.get(kp + (key,), lines.get(kp, 1))
            name, src, extra, inherit = key, None, [], False
            if isinstance(v, dict):
                name = v.get("package", key)
                if v.get("workspace") is True:
                    inherit = True
                    wv = ws_deps.get(name) or ws_deps.get(key)
                    spec = wv[0] if wv else ""
                    src = wv[1] if wv else None
                    extra.append("workspace")
                else:
                    spec = str(v.get("version", ""))
                    if "git" in v:
                        src = "git"
                        spec = spec or "@ " + str(v["git"])
                    elif "path" in v:
                        src = "path"
                        spec = spec or "@ " + str(v["path"])
                if v.get("features"):
                    extra.append("features=" + ",".join(map(str, v["features"])))
                if v.get("optional"):
                    extra.append("optional")
            else:
                spec = str(v)
            if name != key:
                extra.append("renamed " + key)
            out.append(Dep("cargo", name, spec, kind, rel, ln, src=src, extra=" ".join(extra), inherit=inherit))
    return out


def cargo_ws_deps(path):
    data, _ = toml_load(read(path))
    ws = data.get("workspace") or {}
    res = {}
    for key, v in (ws.get("dependencies") or {}).items() if isinstance(ws, dict) else []:
        if isinstance(v, dict):
            src = "git" if "git" in v else ("path" if "path" in v else None)
            res[v.get("package", key)] = (str(v.get("version", "")) or ("@ " + str(v.get("git") or v.get("path"))), src)
        else:
            res[key] = (str(v), None)
    return res


def go_mod(path, root):
    rel = os.path.relpath(path, root)
    out, reps = [], {}
    block = None
    for i, raw in enumerate(read(path).split("\n"), 1):
        line = raw.split("//", 1)[0].strip()
        comment = raw.split("//", 1)[1].strip() if "//" in raw else ""
        if not line:
            continue
        m = re.match(r"^(require|replace|exclude|retract)\s*\($", line)
        if m:
            block = m.group(1)
            continue
        if line == ")":
            block = None
            continue
        m = re.match(r"^(go|toolchain)\s+(\S+)$", line)
        if m and not block:
            out.append(Dep("go", m.group(1), m.group(2).replace("go", "", 1) if m.group(1) == "toolchain" else m.group(2),
                           m.group(1), rel, i, check="pep440"))
            continue
        verb = block
        m = re.match(r"^(require|replace|exclude)\s+(.*)$", line)
        if m and not block:
            verb, line = m.group(1), m.group(2)
        if verb == "require":
            parts = line.split()
            if len(parts) >= 2:
                out.append(Dep("go", parts[0], parts[1], "indirect" if "indirect" in comment else "require", rel, i))
        elif verb == "replace" and "=>" in line:
            lhs, rhs = [x.split() for x in line.split("=>", 1)]
            if lhs and rhs:
                reps[lhs[0]] = (" ".join(rhs), i)
    for d in out:
        if d.name in reps:
            tgt, ln = reps[d.name]
            d.src = "path" if tgt.startswith((".", "/")) else "git"
            d.extra = "replace => %s (line %d)" % (tgt, ln)
    return out


def gemfile(path, root):
    rel = os.path.relpath(path, root)
    out, groups = [], []
    for i, line in enumerate(read(path).split("\n"), 1):
        s = line.split("#", 1)[0].rstrip()
        g = re.match(r"^\s*group\s+(.+?)\s+do\s*$", s)
        if g:
            groups.append(re.sub(r"[:\s]", "", g.group(1)))
            continue
        if re.match(r"^\s*end\s*$", s) and groups:
            groups.pop()
            continue
        m = re.match(r"""^\s*gem\s+['"]([^'"]+)['"]\s*,?\s*(.*)$""", s)
        if m:
            reqs = re.findall(r"""['"]\s*((?:~>|>=|<=|!=|=|>|<)?\s*\d[^'"]*)['"]""", m.group(2))
            src = "git" if re.search(r"\b(git|github)\s*:|:git\s*=>", m.group(2)) else \
                ("path" if re.search(r"\bpath\s*:|:path\s*=>", m.group(2)) else None)
            out.append(Dep("gem", m.group(1), ", ".join(r.strip() for r in reqs), "group:" + groups[-1] if groups else "dependencies", rel, i, src=src))
        r = re.match(r"""^\s*ruby\s+['"]([^'"]+)['"]""", s)
        if r:
            out.append(Dep("gem", "ruby", r.group(1), "ruby", rel, i))
    return out


# ─────────────────────────── lockfiles ───────────────────────────

class Lock(object):
    def __init__(self, path, eco, kind):
        self.path, self.eco, self.kind = path, eco, kind
        self.pkgs = {}        # name → set(versions)
        self.deps = []        # (parent, parent_version, child, spec)
        self.direct = {}      # key → version  (npm path keys, yarn "name@range", pnpm importer names)

    def add(self, name, version, eco=None):
        if name and version:
            self.pkgs.setdefault(norm(eco or self.eco, name), set()).add(str(version))


def _lock_npm(lock, text):
    try:
        data = json.loads(text)
    except ValueError:
        return
    if isinstance(data.get("packages"), dict):
        for key, meta in data["packages"].items():
            if not key or not isinstance(meta, dict) or meta.get("link"):
                continue
            name = meta.get("name") or (key.rsplit("node_modules/", 1)[-1] if "node_modules/" in key else None)
            if not name or not meta.get("version"):
                continue
            lock.add(name, meta["version"])
            if "node_modules/" in key:
                lock.direct[key] = meta["version"]
            for sec in ("dependencies", "optionalDependencies", "peerDependencies"):
                for c, r in (meta.get(sec) or {}).items():
                    lock.deps.append((name, meta["version"], c, r))
    elif isinstance(data.get("dependencies"), dict):
        def walk(tbl, top):
            for name, meta in tbl.items():
                if not isinstance(meta, dict):
                    continue
                v = meta.get("version", "")
                lock.add(name, v)
                if top:
                    lock.direct["node_modules/" + name] = v
                for c, r in (meta.get("requires") or {}).items():
                    lock.deps.append((name, v, c, r))
                walk(meta.get("dependencies") or {}, False)
        walk(data["dependencies"], True)


def _lock_yarn(lock, text):
    cur, in_deps = [], False
    for line in text.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" "):
            in_deps = False
            if line.startswith("__metadata"):
                cur = []
                continue
            specs = [s.strip().strip('"') for s in line.rstrip(":").split(",")]
            cur = []
            for s in specs:
                at = s.rfind("@")
                if at > 0:
                    cur.append((s[:at], s[at + 1:]))
            continue
        ind = len(line) - len(line.lstrip())
        s = line.strip()
        if ind == 2:
            in_deps = s.rstrip(":") in ("dependencies", "optionalDependencies", "peerDependencies")
            m = re.match(r'^version:?\s+"?([^"\s]+)"?', s)
            if m and cur:
                for name, rng in cur:
                    if rng.startswith(("workspace:", "link:", "portal:", "file:")):
                        continue
                    lock.add(name, m.group(1))
                    lock.direct["%s@%s" % (name, rng.replace("npm:", "", 1))] = m.group(1)
                lock._last = (cur[0][0], m.group(1))
        elif ind >= 4 and in_deps and cur and getattr(lock, "_last", None):
            m = re.match(r'^"?([^"\s:]+(?:/[^"\s:]+)?)"?:?\s+"?([^"]+)"?$', s)
            if m:
                lock.deps.append((lock._last[0], lock._last[1], m.group(1), m.group(2).replace("npm:", "", 1)))


def _pnpm_key(k):
    k = k.strip().strip("'\"").rstrip(":").strip("'\"").lstrip("/")
    k = k.split("(", 1)[0]
    at = k.find("@", 1)
    if at > 0:
        return k[:at], k[at + 1:]
    if "/" in k:
        name, ver = k.rsplit("/", 1)
        return name, ver.split("_", 1)[0]
    return None, None


def _lock_pnpm(lock, text):
    section, importer, depsec, cur_name = None, None, None, None
    for line in text.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        ind = len(line) - len(line.lstrip())
        s = line.strip()
        if ind == 0:
            section = s.rstrip(":")
            importer = "." if section in ("dependencies", "devDependencies", "optionalDependencies") else None
            depsec = section if importer else None
            continue
        if section == "importers":
            if ind == 2:
                importer, depsec = s.rstrip(":").strip("'\""), None
            elif ind == 4:
                depsec = s.rstrip(":") if s.rstrip(":") in ("dependencies", "devDependencies", "optionalDependencies") else None
            elif ind == 6 and depsec:
                m = re.match(r"^'?([^':]+)'?:\s*(\S+)?$", s)
                if m:
                    cur_name = m.group(1)
                    if m.group(2):
                        lock.direct["%s:%s" % (importer, cur_name)] = m.group(2).split("(")[0]
            elif ind == 8 and depsec and s.startswith("version:"):
                lock.direct["%s:%s" % (importer, cur_name)] = s.split(":", 1)[1].strip().strip("'\"").split("(")[0]
        elif depsec and ind == 2 and section in ("dependencies", "devDependencies", "optionalDependencies"):
            m = re.match(r"^'?([^':]+)'?:\s*(\S+)$", s)
            if m:
                lock.direct[".:%s" % m.group(1)] = m.group(2).strip("'\"").split("(")[0].split("_")[0]
        elif section == "packages" and ind == 2 and s.endswith(":"):
            name, ver = _pnpm_key(s)
            if name and ver and re.match(r"^\d", ver):
                lock.add(name, ver)
                cur_name = (name, ver)
        elif section == "packages" and ind == 6 and isinstance(cur_name, tuple):
            m = re.match(r"^'?([^':]+)'?:\s*'?([^'\s]+)'?$", s)
            if m:
                lock.deps.append((cur_name[0], cur_name[1], m.group(1), m.group(2).split("(")[0]))


def _lock_toml_packages(lock, text):
    data, _ = toml_load(text)
    for p in data.get("package") or []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        name, ver = p["name"], str(p.get("version", ""))
        src = p.get("source")
        if isinstance(src, dict) and (src.get("editable") or src.get("virtual")):
            continue
        if not ver:
            continue
        lock.add(name, ver)
        deps = p.get("dependencies")
        if isinstance(deps, list):
            for d in deps:
                if isinstance(d, str):
                    parts = d.split()
                    lock.deps.append((name, ver, parts[0], parts[1] if len(parts) > 1 else ""))
                elif isinstance(d, dict) and d.get("name"):
                    lock.deps.append((name, ver, d["name"], str(d.get("version", d.get("specifier", "")))))
        elif isinstance(deps, dict):
            for c, r in deps.items():
                if isinstance(r, dict):
                    r = r.get("version", "")
                elif isinstance(r, list):
                    r = " || ".join(str(x.get("version", "")) if isinstance(x, dict) else str(x) for x in r)
                lock.deps.append((name, ver, c, str(r)))


def _lock_pipfile(lock, text):
    try:
        data = json.loads(text)
    except ValueError:
        return
    for sec in ("default", "develop"):
        for name, meta in (data.get(sec) or {}).items():
            if isinstance(meta, dict) and meta.get("version"):
                lock.add(name, meta["version"].lstrip("="))


def _lock_gosum(lock, text):
    full, modonly = {}, {}
    for line in text.split("\n"):
        parts = line.split()
        if len(parts) < 3:
            continue
        mod, ver = parts[0], parts[1]
        if ver.endswith("/go.mod"):
            modonly.setdefault(mod, set()).add(ver[:-7])
        else:
            full.setdefault(mod, set()).add(ver)
    for mod in set(full) | set(modonly):
        for v in full.get(mod) or modonly[mod]:
            lock.add(mod, v)
    lock.gomod_only = modonly


def _lock_gomod(lock, text):
    for d in go_mod_text(text):
        lock.add(d[0], d[1])


def go_mod_text(text):
    res, block = [], False
    for raw in text.split("\n"):
        line = raw.split("//", 1)[0].strip()
        if line.startswith("require ("):
            block = True
            continue
        if line == ")":
            block = False
            continue
        if line.startswith("require "):
            line = line[8:].strip()
        elif not block:
            continue
        parts = line.split()
        if len(parts) >= 2:
            res.append((parts[0], parts[1]))
    return res


def _lock_gemfile(lock, text):
    in_specs, last = False, None
    for line in text.split("\n"):
        if not line.startswith(" "):
            in_specs = False
            continue
        if line.strip() == "specs:":
            in_specs = True
            continue
        if not in_specs:
            continue
        ind = len(line) - len(line.lstrip())
        m = re.match(r"^([A-Za-z0-9_.-]+)(?: \(([^)]*)\))?$", line.strip())
        if not m:
            continue
        if ind == 4 and m.group(2):
            ver = m.group(2).split("-", 1)[0] if re.search(r"-(x86|arm|aarch|java|universal)", m.group(2)) else m.group(2)
            lock.add(m.group(1), ver)
            last = (m.group(1), ver)
        elif ind == 6 and last:
            lock.deps.append((last[0], last[1], m.group(1), m.group(2) or ""))


def _lock_requirements(lock, text):
    for line in text.split("\n"):
        line = re.sub(r"(^|\s)#.*$", "", line).strip().rstrip("\\").strip()
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*===?\s*([^\s;\\]+)", line)
        if m:
            lock.add(m.group(1), m.group(3))


def lock_kind(path):
    b = os.path.basename(path)
    if b in ("package-lock.json", "npm-shrinkwrap.json"):
        return "npm", "package-lock"
    if b == "yarn.lock":
        return "npm", "yarn"
    if b == "pnpm-lock.yaml":
        return "npm", "pnpm"
    if b == "Cargo.lock":
        return "cargo", "toml"
    if b in ("poetry.lock", "pdm.lock", "uv.lock"):
        return "python", "toml"
    if b == "Pipfile.lock":
        return "python", "pipfile"
    if b == "go.sum":
        return "go", "gosum"
    if b == "go.mod":
        return "go", "gomod"
    if b == "Gemfile.lock":
        return "gem", "gemfile"
    if b.endswith((".txt", ".in")):
        return "python", "requirements"
    return None, None


def parse_lock(path, text=None, name_hint=None):
    eco, kind = lock_kind(name_hint or path)
    if eco is None:
        return None
    lock = Lock(path, eco, kind)
    text = read(path) if text is None else text
    {"package-lock": _lock_npm, "yarn": _lock_yarn, "pnpm": _lock_pnpm, "toml": _lock_toml_packages,
     "pipfile": _lock_pipfile, "gosum": _lock_gosum, "gomod": _lock_gomod, "gemfile": _lock_gemfile,
     "requirements": _lock_requirements}[kind](lock, text)
    return lock


# ─────────────────────────── installed ───────────────────────────

class Installed(object):
    def __init__(self, root):
        self.root = root
        self._py = None
        self.py_label = ""
        self.py_version = None
        self._cargo = None
        self.cargo_label = ""
        self._go = None

    def python(self):
        if self._py is not None:
            return self._py
        self._py = {}
        for vd in (".venv", "venv", "env", ".env"):
            base = os.path.join(self.root, vd)
            if not os.path.isfile(os.path.join(base, "pyvenv.cfg")):
                continue
            cfg = read(os.path.join(base, "pyvenv.cfg"))
            m = re.search(r"^(?:version|version_info)\s*=\s*([\d.]+)", cfg, re.M)
            self.py_version = m.group(1) if m else None
            for lib in ("lib", "Lib", "lib64"):
                ld = os.path.join(base, lib)
                if not os.path.isdir(ld):
                    continue
                sps = [os.path.join(ld, "site-packages")] + [os.path.join(ld, d, "site-packages")
                                                           for d in sorted(os.listdir(ld))]
                for sp in sps:
                    if os.path.isdir(sp):
                        for e in os.listdir(sp):
                            m = re.match(r"^(.+?)-([^-]+?)(?:-py[\d.]+)?\.(dist-info|egg-info)$", e)
                            if m:
                                self._py[norm_py(m.group(1))] = m.group(2)
            self.py_label = "%s (%d dists)" % (vd, len(self._py))
            return self._py
        try:
            import importlib.metadata as md
            for d in md.distributions():
                try:
                    n = d.metadata["Name"]
                except Exception:
                    n = None
                if n:
                    self._py.setdefault(norm_py(n), d.version)
        except Exception:
            pass
        self.py_version = "%d.%d.%d" % sys.version_info[:3]
        self.py_label = "python3 %s (%d dists)" % (self.py_version, len(self._py))
        return self._py

    def node(self, name, start_dir):
        d = start_dir
        while True:
            pj = os.path.join(d, "node_modules", name, "package.json")
            if os.path.isfile(pj):
                try:
                    return str(json.loads(read(pj)).get("version") or "?")
                except ValueError:
                    return "?"
            if os.path.abspath(d) == os.path.abspath(self.root) or os.path.dirname(d) == d:
                return None
            d = os.path.dirname(d)

    def cargo(self):
        if self._cargo is not None:
            return self._cargo
        self._cargo = {}
        dirs = []
        vd = os.path.join(self.root, "vendor")
        if os.path.isdir(vd) and any(os.path.isfile(os.path.join(vd, e, ".cargo-checksum.json"))
                                     for e in sorted(os.listdir(vd))[:20]):
            dirs.append(vd)
            self.cargo_label = "vendor/"
        home = os.environ.get("CARGO_HOME") or os.path.join(os.path.expanduser("~"), ".cargo")
        reg = os.path.join(home, "registry", "src")
        try:
            regs = sorted(os.listdir(reg)) if os.path.isdir(reg) else []
        except OSError:
            regs = []
        if regs:
            dirs += [os.path.join(reg, e) for e in regs]
            self.cargo_label = (self.cargo_label + " + " if self.cargo_label else "") + "~/.cargo/registry"
        for d in dirs:
            try:
                entries = os.listdir(d)
            except OSError:
                continue
            for e in entries:
                m = re.match(r"^(.+?)-(\d+\.\d+\.\d+.*)$", e)
                if m:
                    self._cargo.setdefault(m.group(1), set()).add(m.group(2))
                elif d.endswith("vendor"):
                    mm = re.search(r'^version\s*=\s*"([^"]+)"', read(os.path.join(d, e, "Cargo.toml")), re.M)
                    if mm:
                        self._cargo.setdefault(e, set()).add(mm.group(1))
        return self._cargo

    def go(self):
        if self._go is not None:
            return self._go
        self._go = {}
        vm = os.path.join(self.root, "vendor", "modules.txt")
        if os.path.isfile(vm):
            for line in read(vm).split("\n"):
                m = re.match(r"^# (\S+) (v\S+)", line)
                if m:
                    self._go[m.group(1)] = {m.group(2)}
            self._go["__source__"] = "vendor/modules.txt"
            return self._go
        cache = os.environ.get("GOMODCACHE") or os.path.join(
            os.environ.get("GOPATH") or os.path.join(os.path.expanduser("~"), "go"), "pkg", "mod")
        if os.path.isdir(os.path.join(cache, "cache", "download")):
            self._go["__cache__"] = os.path.join(cache, "cache", "download")
        return self._go

    def go_has(self, mod, ver):
        g = self.go()
        if "__source__" in g:
            return ver in g.get(mod, ())
        c = g.get("__cache__")
        if not c:
            return None
        esc = re.sub(r"[A-Z]", lambda m: "!" + m.group().lower(), mod)
        return os.path.isfile(os.path.join(c, esc, "@v", ver + ".mod"))


# ─────────────────────────── scan & evaluate ───────────────────────────

def discover(root):
    manifests, locks = [], []
    root_depth = root.rstrip(os.sep).count(os.sep)
    for d, dirs, files in os.walk(root):
        depth = d.rstrip(os.sep).count(os.sep) - root_depth
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith(".") and depth < MAX_DEPTH
                         or x == "requirements")
        in_req_dir = os.path.basename(d) == "requirements"
        for f in sorted(files):
            p = os.path.join(d, f)
            if f in LOCK_NAMES:
                locks.append(p)
            if f in ("pyproject.toml", "setup.cfg", "setup.py", "Pipfile", "package.json", "Cargo.toml", "go.mod", "Gemfile"):
                manifests.append(p)
            elif re.match(r"^.*requirements.*\.(txt|in)$|^constraints.*\.txt$", f) or (in_req_dir and f.endswith((".txt", ".in"))):
                manifests.append(p)
    return manifests, locks


def local_path(dep, root):
    """True for path deps that stay inside the scanned tree (workspace members, -e .)."""
    if dep.src != "path":
        return False
    if dep.eco == "go":
        return False  # a replace directive always matters: bumping the require alone changes nothing
    p = re.sub(r"^(@\s*)?(file:|link:|portal:)?", "", dep.spec.strip())
    if p.startswith("workspace:"):
        return True
    if not p or p.startswith("/"):
        return False
    full = os.path.normpath(os.path.join(root, os.path.dirname(dep.file), p.split("#")[0]))
    return not os.path.relpath(full, os.path.abspath(root) if os.path.isabs(full) else root).startswith("..")


def spec_flags(dep, root="."):
    s = dep.spec.strip()
    if dep.src:
        return [] if local_path(dep, root) else ["GIT/PATH"]
    if dep.kind in ("requires-python", "rust-version", "go", "toolchain", "ruby", "engines"):
        return []
    if s in ("", "*", "latest", "x", "X", ">=0", ">=0.0", ">=0.0.0") or (dep.eco == "gem" and not s):
        return ["UNPINNED"]
    try:
        if dep.check in ("npm", "cargo"):
            alts = sv.parse_sv_range(s, dep.check)
            if all(len(a) == 1 and a[0] == (">=", (0, 0, 0, ())) for a in alts):
                return ["UNPINNED"]
            if any(not any(op in ("<", "<=", "=") for op, _ in a) for a in alts):
                return ["LOOSE"]
        elif dep.check in ("pep440", "poetry", "gem"):
            alts = sv.poetry_to_pep(s) if dep.check == "poetry" else \
                ([sv.gem_to_pep(s)] if dep.check == "gem" else [sv.parse_pep_specs(s)])
            if all(not a for a in alts):
                return ["UNPINNED"]
            if any(a and not any(op in ("<", "<=", "==", "~=", "===") for op, _ in a) for a in alts):
                return ["LOOSE"]
    except ValueError:
        pass
    return []


def ok_for(dep, version):
    if not version or dep.src or dep.spec.startswith("@") or dep.eco == "go":
        return None
    spec = dep.spec
    if dep.kind == "engines" and not re.match(r"^[\d<>=^~*v ]", spec):
        return None
    try:
        r = sv.satisfies(version, spec, dep.check, prereleases=True if dep.check in ("pep440", "poetry", "gem") else None)
    except Exception:
        return None
    return r[0]


def evaluate(root, eco_filter=None):
    manifests, lockpaths = discover(root)
    ws_deps = {}
    for m in manifests:
        if os.path.basename(m) == "Cargo.toml" and "[workspace" in read(m):
            ws_deps.update(cargo_ws_deps(m))
    deps = []
    seen_req = set()
    for m in manifests:
        b = os.path.basename(m)
        try:
            if b == "pyproject.toml":
                deps += pyproject(m, root)
            elif b == "setup.cfg":
                deps += setup_cfg(m, root)
            elif b == "setup.py":
                deps += setup_py(m, root)
            elif b == "Pipfile":
                deps += pipfile(m, root)
            elif b == "package.json":
                deps += package_json(m, root)
            elif b == "Cargo.toml":
                deps += cargo_toml(m, root, ws_deps)
            elif b == "go.mod":
                deps += go_mod(m, root)
            elif b == "Gemfile":
                deps += gemfile(m, root)
            else:
                deps += requirements(m, root, seen_req)
        except Exception as e:  # keep going: one broken manifest must not hide the rest
            deps.append(Dep("python" if b.endswith((".txt", ".in", ".toml", ".py", ".cfg")) else "npm",
                            "(parse error)", str(e)[:40], "error", os.path.relpath(m, root), 1))
    # compiled requirements: X.in → X.txt acts as the lock
    for m in manifests:
        if m.endswith(".in") and os.path.isfile(m[:-3] + ".txt"):
            lockpaths.append(m[:-3] + ".txt")
    locks = []
    for p in sorted(set(lockpaths)):
        try:
            lk = parse_lock(p)
        except Exception:
            lk = None
        if lk:
            locks.append(lk)
    if eco_filter:
        deps = [d for d in deps if d.eco == eco_filter]
    return deps, locks, manifests


def locks_for(dep, locks, root):
    """Lockfiles in the manifest's dir or its ancestors (nearest first)."""
    d = os.path.dirname(os.path.join(root, dep.file))
    res = []
    while True:
        for lk in locks:
            if lk.eco == dep.eco and os.path.dirname(lk.path) == d:
                if dep.eco == "python":
                    mb, lb = os.path.basename(dep.file), os.path.basename(lk.path)
                    if lk.kind == "requirements":
                        if not (mb.endswith(".in") and lb[:-4] == mb[:-3]):
                            continue
                    elif lb == "Pipfile.lock":
                        if mb != "Pipfile":
                            continue
                    elif mb != "pyproject.toml":  # poetry.lock / pdm.lock / uv.lock belong to pyproject.toml
                        continue
                res.append(lk)
        if res or os.path.abspath(d) == os.path.abspath(root) or os.path.dirname(d) == d:
            return res
        d = os.path.dirname(d)


def locked_version(dep, lk, root):
    n = norm(dep.eco, dep.name)
    if lk.kind == "package-lock":
        mdir = os.path.relpath(os.path.dirname(os.path.join(root, dep.file)), os.path.dirname(lk.path))
        for key in ((mdir + "/node_modules/" + dep.name) if mdir != "." else None, "node_modules/" + dep.name):
            if key and key in lk.direct:
                return [lk.direct[key]]
    if lk.kind == "yarn":
        v = lk.direct.get("%s@%s" % (dep.name, dep.spec.replace("npm:", "", 1)))
        if v:
            return [v]
    if lk.kind == "pnpm":
        mdir = os.path.relpath(os.path.dirname(os.path.join(root, dep.file)), os.path.dirname(lk.path))
        v = lk.direct.get("%s:%s" % (mdir, dep.name))
        if v:
            return [v]
    vs = lk.pkgs.get(n)
    if not vs:
        return []
    key = lambda v: (sv.parse_version(v, dep.check) is not None, _vkey(v, dep.check))
    return sorted(vs, key=key, reverse=True)


def _vkey(v, eco):
    p = sv.parse_version(v, eco if eco != "go" else "go")
    if p is None:
        return ()
    return sv.version_key(p, eco)


def analyze(root, deps, locks, inst):
    rows = []
    groups = {}
    proj = {}
    for d in deps:
        lks = locks_for(d, locks, root)
        proj[id(d)] = os.path.dirname(lks[0].path) if lks else os.path.dirname(os.path.join(root, d.file))
    for d in deps:
        if d.kind in ("error",):
            continue
        if not d.inherit:
            groups.setdefault((d.eco, norm(d.eco, d.name), proj[id(d)]), set()).add(re.sub(r"\s+", "", d.spec))
    for d in deps:
        flags = spec_flags(d, root)
        if d.kind == "error":
            flags = ["LOCK-MISMATCH"]
        locked = "-"
        lks = locks_for(d, locks, root) if d.kind not in ("requires-python", "rust-version", "go", "toolchain",
                                                           "engines", "ruby", "error") else []
        lv = []
        for lk in lks:
            lv = locked_version(d, lk, root)
            if lv:
                break
        if lv:
            good = [v for v in lv if ok_for(d, v) is not False] if d.eco != "go" else lv
            if d.eco == "go":
                exact = d.spec in lk_versions(lks, d.name)
                locked = d.spec if exact else ("|".join(lv[:2]))
                if not exact:
                    flags.append("LOCK-MISMATCH")
            else:
                locked = good[0] if good else "|".join(lv[:2])
                if not good:
                    flags.append("LOCK-MISMATCH")
        elif lks and not d.src and d.kind not in ("constraint", "build") and not d.marker and "optional" not in d.extra:
            locked = "missing"
            flags.append("LOCK-MISMATCH")
        installed = "-"
        want = locked if locked not in ("-", "missing") else None
        if d.eco == "python":
            if d.name == "python":
                inst.python()
                installed = inst.py_version or "-"
                if installed != "-" and ok_for(d, installed) is False:
                    flags.append("INSTALLED-MISMATCH")
            else:
                iv = inst.python().get(norm_py(d.name))
                optional = d.kind.startswith(("extra:", "build", "constraint")) or bool(d.marker)
                if iv:
                    installed = iv
                    if ok_for(d, iv) is False or (want and not d.src and _vkey(iv, "pep440") != _vkey(want, "pep440")):
                        flags.append("INSTALLED-MISMATCH")
                elif not optional and not d.src:
                    installed = "no"
                    flags.append("NOT-INSTALLED")
        elif d.eco == "npm" and d.kind != "engines":
            iv = inst.node(d.name, os.path.dirname(os.path.join(root, d.file)))
            if iv:
                installed = iv
                if ok_for(d, iv) is False or (want and iv != want):
                    flags.append("INSTALLED-MISMATCH")
            elif os.path.isdir(os.path.join(root, "node_modules")) and d.kind not in ("peer", "optional"):
                installed = "no"
                flags.append("NOT-INSTALLED")
        elif d.eco == "cargo" and not d.src and d.kind != "rust-version":
            have = inst.cargo()
            if inst.cargo_label:  # "installed" = available for an offline build (vendor/ or registry cache)
                vs = have.get(d.name, set())
                if want:
                    installed = want if want in vs else "no"
                else:
                    good = [v for v in vs if ok_for(d, v)]
                    installed = sorted(good, key=lambda v: _vkey(v, "cargo"))[-1] if good else "no"
                if installed == "no":
                    flags.append("NOT-INSTALLED")
        elif d.eco == "go" and d.kind in ("require", "indirect") and not d.src:
            h = inst.go_has(d.name, d.spec)
            if h is True:
                installed = d.spec
            elif h is False:
                installed = "no"
                flags.append("NOT-INSTALLED")
        if len(groups.get((d.eco, norm(d.eco, d.name), proj[id(d)]), ())) > 1 and not d.inherit:
            flags.append("DUP")
        rows.append((d, locked, installed, flags))
    return rows


def lk_versions(lks, name):
    out = set()
    for lk in lks:
        out |= lk.pkgs.get(name, set())
        out |= getattr(lk, "gomod_only", {}).get(name, set())
    return out


SEVERITY = ["LOCK-MISMATCH", "INSTALLED-MISMATCH", "DUP", "NOT-INSTALLED", "UNPINNED", "LOOSE", "GIT/PATH"]


def cut(s, n):
    s = str(s)
    return s if len(s) <= n else s[:n - 1] + "~"


def main(argv):
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    pkg = eco = None
    show_all = False
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--pkg", "--eco"):
            if i + 1 >= len(argv):
                print("pins_list: %s needs a value" % a, file=sys.stderr)
                return 2
            if a == "--pkg":
                pkg = argv[i + 1]
            else:
                eco = argv[i + 1]
            i += 2
            continue
        if a == "--all":
            show_all = True
        elif a.startswith("-"):
            print("pins_list: unknown option %s (see --help)" % a, file=sys.stderr)
            return 2
        else:
            rest.append(a)
        i += 1
    if len(rest) > 1:
        print("pins_list: one DIR only", file=sys.stderr)
        return 2
    root = rest[0] if rest else "."
    if not os.path.isdir(root):
        print("pins_list: %s is not a directory" % root, file=sys.stderr)
        return 2
    deps, locks, manifests = evaluate(root, eco)
    inst = Installed(root)
    if pkg:
        return show_pkg(root, pkg, deps, locks, inst)
    rows = analyze(root, deps, locks, inst)
    shown = [r for r in rows if show_all or not r[0].inherit]
    hidden = len(rows) - len(shown)
    rank = lambda r: (min([SEVERITY.index(f) for f in r[3]] or [99]), local_path(r[0], root), r[0].eco, norm(r[0].eco, r[0].name), r[0].file, r[0].line)
    shown.sort(key=rank)
    by_eco = {}
    for r in shown:
        by_eco[r[0].eco] = by_eco.get(r[0].eco, 0) + 1
    counts = {}
    for r in shown:
        for f in set(r[3]):
            counts[f] = counts.get(f, 0) + 1
    hdr = "pins_list %s: %d declared (%s) in %d manifests" % (
        root, len(shown), ", ".join("%s %d" % kv for kv in sorted(by_eco.items())) or "none", len(manifests))
    if hidden:
        hdr += "; %d workspace-inherited hidden (--all)" % hidden
    print(hdr)
    li = []
    if locks:
        li.append("locks: " + ", ".join(os.path.relpath(lk.path, root) for lk in locks[:6]) +
                  (" (+%d more)" % (len(locks) - 6) if len(locks) > 6 else ""))
    if by_eco.get("python"):
        inst.python()
        li.append("python installed: " + inst.py_label)
    if by_eco.get("cargo") and inst.cargo_label:
        li.append("cargo sources: %s (%d crates)" % (inst.cargo_label, len(inst.cargo())))
    if li:
        print("; ".join(li))
    print("problems: " + (", ".join("%d %s" % (counts[f], f) for f in SEVERITY if f in counts) or "none"))
    if not shown:
        print("no dependency manifests found (looked for requirements*.txt, pyproject.toml, setup.cfg/py, "
              "Pipfile, package.json, Cargo.toml, go.mod, Gemfile)")
        return 0
    wn = min(30, max(len(r[0].name) for r in shown))
    wd = min(22, max(len(r[0].spec or "-") for r in shown))
    wl = min(14, max(len(r[1]) for r in shown))
    wi = min(14, max(len(r[2]) for r in shown))
    budget = 36
    for r in shown[:budget]:
        d, locked, installed, flags = r
        print("%-6s %-*s %-*s %-*s %-*s %s  %s:%d%s" % (
            d.eco, wn, cut(d.name, wn), wd, cut(d.spec or "-", wd), wl, cut(locked, wl), wi, cut(installed, wi),
            " ".join(sorted(set(flags), key=SEVERITY.index)) or "ok", d.file, d.line,
            ("  [%s]" % cut(" ".join(x for x in (d.kind if d.kind not in ("dependencies", "requirements", "require") else "",
                                                d.extra, d.marker) if x), 50)) if (d.kind not in ("dependencies", "requirements", "require") or d.extra or d.marker) else ""))
    if len(shown) > budget:
        print("(+%d more; --pkg NAME or --eco E to narrow)" % (len(shown) - budget))
    return 0


def show_pkg(root, pkg, deps, locks, inst):
    matches = [d for d in deps if norm(d.eco, d.name) == norm(d.eco, pkg) or d.name == pkg
               or (d.eco == "cargo" and d.name.replace("_", "-") == pkg.replace("_", "-"))]
    out = []
    names = set()
    rows = analyze(root, matches, locks, inst) if matches else []
    for d, locked, installed, flags in rows:
        names.add((d.eco, norm(d.eco, d.name)))
        out.append("declared  %s:%d  %s  %s  [%s%s]  locked=%s installed=%s %s" % (
            d.file, d.line, d.name, d.spec or "(any)", d.kind, (" " + d.extra) if d.extra else "",
            locked, installed, " ".join(sorted(set(flags), key=SEVERITY.index))))
    if not names:
        for eco in ("python", "npm", "cargo", "go", "gem"):
            if any(lk.eco == eco and (norm(eco, pkg) in lk.pkgs or pkg in lk.pkgs) for lk in locks):
                names.add((eco, norm(eco, pkg)))
    if not names:
        for eco in ("python", "npm", "cargo", "go", "gem"):
            names.add((eco, norm(eco, pkg)))
    for lk in locks:
        for eco, n in sorted(names):
            if lk.eco != eco:
                continue
            vs = lk.pkgs.get(n) or lk.pkgs.get(pkg)
            if vs:
                out.append("locked    %s: %s %s%s" % (os.path.relpath(lk.path, root), pkg,
                                                     ", ".join(sorted(vs, key=lambda v: _vkey(v, "pep440" if eco == "python" else "npm"))),
                                                     "  (DUPLICATE versions)" if len(vs) > 1 else ""))
            req = sorted(set("%s %s%s" % (p, pv, (" (=%s)" % r if lk.kind == "toml" and lk.eco == "cargo" else " → " + r) if r else "")
                             for p, pv, c, r in lk.deps
                             if norm(eco, c) == n or c == pkg))
            if req:
                out.append("required by (%s, %d): %s" % (os.path.relpath(lk.path, root), len(req),
                                                         "; ".join(req[:12]) + (" (+%d more)" % (len(req) - 12) if len(req) > 12 else "")))
    for eco, n in sorted(names):
        if eco == "python":
            v = inst.python().get(n)
            out.append("installed python: %s (%s)" % (v or "not installed", inst.py_label))
        elif eco == "npm":
            v = inst.node(pkg, root)
            if v or os.path.isdir(os.path.join(root, "node_modules")):
                out.append("installed node_modules: %s" % (v or "not installed"))
        elif eco == "cargo" and inst.cargo() and inst.cargo_label:
            vs = inst.cargo().get(pkg) or inst.cargo().get(pkg.replace("_", "-"))
            out.append("available offline (%s): %s" % (inst.cargo_label, ", ".join(sorted(vs)) if vs else "none"))
    if not out:
        print("pins_list: %s not found in any manifest or lockfile under %s" % (pkg, root))
        return 0
    print("pins_list --pkg %s (%d declarations)" % (pkg, len(rows)))
    for line in out[:39]:
        print(cut(line, 300))
    if len(out) > 39:
        print("(+%d more)" % (len(out) - 39))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
