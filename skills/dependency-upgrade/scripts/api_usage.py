#!/usr/bin/env python3
"""Where and how a dependency's API is used: symbol → count → first file:line, across the repo.

usage: api_usage.py PACKAGE [DIR] [--lang py|js|rs|go]
  PACKAGE: distribution or import name (PyYAML or yaml, beautifulsoup4 or bs4, lodash, @scope/pkg,
           serde_json or serde-json, github.com/pkg/errors, gopkg.in/yaml.v3).
  → header per language (files, import styles), then one row per symbol used through the package:
      Python  ast: import X / import X as Y / from X.sub import a as b; attribute chains through the
              alias (yaml.load, requests.adapters.HTTPAdapter), from-imported names, and keyword
              arguments passed to package calls (yaml.load(Loader=))
      JS/TS   import default/namespace/{named as alias}, export-from, require(), import(), pkg/subpath;
              member use through the binding (_.map) and named bindings (debounce)
      Rust    use crate::{a, b::c as d} trees, extern crate, inline crate::path::Item and macros (log::info!)
      Go      import blocks with aliases, _ and . imports; alias.Exported uses
  Cross-check the removed/renamed names from changelog_extract.py against this list in one call.
Skips .git, node_modules, vendor, target, venvs, build dirs. Output ≤40 lines. Exit 0 unless usage is wrong."""
import ast
import os
import re
import sys

SKIP = {".git", ".hg", "node_modules", "vendor", "third_party", "target", ".venv", "venv", "env", "__pycache__",
        "dist", "build", ".tox", ".nox", ".mypy_cache", ".pytest_cache", "site-packages", ".next", "coverage",
        "bower_components", ".yarn", ".cargo"}
EXT = {".py": "py", ".pyi": "py", ".js": "js", ".jsx": "js", ".ts": "js", ".tsx": "js", ".mjs": "js",
       ".cjs": "js", ".mts": "js", ".cts": "js", ".vue": "js", ".svelte": "js", ".rs": "rs", ".go": "go"}
# distribution name → import names, for packages whose names differ
PY_IMPORTS = {
    "pyyaml": ["yaml"], "beautifulsoup4": ["bs4"], "pillow": ["PIL"], "scikit-learn": ["sklearn"],
    "scikit-image": ["skimage"], "python-dateutil": ["dateutil"], "attrs": ["attr", "attrs"],
    "protobuf": ["google.protobuf"], "opencv-python": ["cv2"], "opencv-python-headless": ["cv2"],
    "pyjwt": ["jwt"], "psycopg2-binary": ["psycopg2"], "psycopg": ["psycopg"], "typing-extensions": ["typing_extensions"],
    "python-dotenv": ["dotenv"], "pymysql": ["pymysql"], "mysqlclient": ["MySQLdb"], "pyopenssl": ["OpenSSL"],
    "pycryptodome": ["Crypto"], "pycryptodomex": ["Cryptodome"], "msgpack-python": ["msgpack"],
    "google-cloud-storage": ["google.cloud.storage"], "grpcio": ["grpc"], "pyzmq": ["zmq"], "pyserial": ["serial"],
    "python-magic": ["magic"], "ruamel.yaml": ["ruamel.yaml"], "setuptools": ["setuptools", "pkg_resources"],
    "django-rest-framework": ["rest_framework"], "djangorestframework": ["rest_framework"], "pygithub": ["github"],
    "python-multipart": ["multipart"], "markdown": ["markdown"], "pytest-asyncio": ["pytest_asyncio"],
    "discord.py": ["discord"], "websocket-client": ["websocket"], "faiss-cpu": ["faiss"], "tensorflow-cpu": ["tensorflow"],
    "email-validator": ["email_validator"], "importlib-metadata": ["importlib_metadata"], "pywin32": ["win32api", "win32con"],
}


def walk(root, langs):
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        for f in sorted(files):
            lang = EXT.get(os.path.splitext(f)[1])
            if lang and (not langs or lang in langs):
                yield os.path.join(d, f), lang


def read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


class Tally(object):
    def __init__(self):
        self.sym = {}      # symbol → [count, [(file, line)]]
        self.files = {}    # lang → set(files)
        self.styles = {}   # lang → {style: count}

    def add(self, sym, f, line):
        e = self.sym.setdefault(sym, [0, []])
        e[0] += 1
        if len(e[1]) < 3 and (f, line) not in e[1]:
            e[1].append((f, line))

    def style(self, lang, f, s):
        self.files.setdefault(lang, set()).add(f)
        st = self.styles.setdefault(lang, {})
        st[s] = st.get(s, 0) + 1


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


# ─────────────────────────── Python ───────────────────────────

def py_roots(pkg):
    n = re.sub(r"[-_.]+", "-", pkg).lower()
    roots = list(PY_IMPORTS.get(n, []))
    roots += [pkg, pkg.replace("-", "_"), pkg.lower().replace("-", "_")]
    try:
        import importlib.metadata as md
        dist = md.distribution(pkg)
        top = dist.read_text("top_level.txt") or ""
        roots += [x.strip() for x in top.split() if x.strip() and not x.startswith("_")]
    except Exception:
        pass
    out = []
    for r in roots:
        if r and r not in out and re.match(r"^[A-Za-z_][\w.]*$", r):
            out.append(r)
    return out


def _chain(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return parts[::-1]
    return None


def py_file(path, rel, roots, t):
    src = read(path)
    if not any(r.split(".")[0] in src for r in roots):
        return
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        return
    under = lambda m: any(m == r or m.startswith(r + ".") for r in roots)
    aliases, names = {}, {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if under(a.name):
                    if a.asname:
                        aliases[a.asname] = a.name
                        t.style("py", rel, "import %s as %s" % (a.name, a.asname))
                    else:
                        top = a.name.split(".")[0]
                        aliases[top] = top
                        t.style("py", rel, "import %s" % a.name)
                        if a.name != top:
                            t.add(a.name, rel, node.lineno)
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module and under(node.module):
            t.style("py", rel, "from %s import" % node.module)
            for a in node.names:
                full = node.module + "." + a.name
                if a.name == "*":
                    t.add(node.module + ".*", rel, node.lineno)
                    continue
                names[a.asname or a.name] = full
                t.add(full, rel, node.lineno)
    if not aliases and not names:
        return

    def resolve(node):
        c = _chain(node)
        if not c:
            return None
        if c[0] in aliases:
            return ".".join([aliases[c[0]]] + c[1:])
        if c[0] in names:
            return ".".join([names[c[0]]] + c[1:])
        return None

    class V(ast.NodeVisitor):
        def visit_Attribute(self, node):
            s = resolve(node)
            if s:
                t.add(s, rel, node.lineno)
            else:
                self.generic_visit(node)

        def visit_Name(self, node):
            if node.id in names and isinstance(node.ctx, ast.Load):
                t.add(names[node.id], rel, node.lineno)

        def visit_Call(self, node):
            s = resolve(node.func)
            if s:
                for kw in node.keywords:
                    t.add("%s(%s=)" % (s, kw.arg if kw.arg else "**"), rel, node.lineno)
            self.generic_visit(node)
    V().visit(tree)


# ─────────────────────────── JS / TS ───────────────────────────

def _blank(text, spans):
    chars = list(text)
    for a, b in spans:
        for i in range(a, b):
            if chars[i] != "\n":
                chars[i] = " "
    return "".join(chars)


_STR_DQ = r'"(?:\\.|[^"\\\n])*"'
_STR_SQ = r"'(?:\\.|[^'\\\n])*'"


def strip_code(text, single_quotes):
    """Blank string literals and // comments (positions kept) so usage counts skip them."""
    pat = re.compile("|".join([_STR_DQ] + ([_STR_SQ] if single_quotes else []) + [r"//[^\n]*", r"/\*[\s\S]*?\*/"]))
    return pat.sub(lambda m: re.sub(r"[^\n]", " ", m.group()), text)


def js_file(path, rel, pkg, t):
    text = read(path)
    if pkg not in text:
        return
    q = re.escape(pkg)
    spec = r"""['"](%s(?:/[^'"]*)?)['"]""" % q
    binds = {}  # local → symbol base
    members = {}  # local → base (namespace/default/require objects: X.member)
    spans = []
    for m in re.finditer(r"\bimport\s+(?:type\s+)?([\w$*{}\s,]+?)\s+from\s*" + spec, text):
        spans.append(m.span())
        clause, base = m.group(1), m.group(2)
        ln = line_of(text, m.start())
        ns = re.search(r"\*\s+as\s+([\w$]+)", clause)
        if ns:
            members[ns.group(1)] = base
            t.style("js", rel, "import * as")
        br = re.search(r"\{([^}]*)\}", clause)
        if br:
            t.style("js", rel, "import {named}")
            for item in br.group(1).split(","):
                item = re.sub(r"^\s*type\s+", "", item).strip()
                if not item:
                    continue
                parts = re.split(r"\s+as\s+", item)
                binds[parts[-1].strip()] = "%s.%s" % (base, parts[0].strip())
                t.add("%s.%s" % (base, parts[0].strip()), rel, ln)
        default = re.match(r"^\s*([\w$]+)\s*(,|$)", clause)
        if default and default.group(1) != "type":
            members[default.group(1)] = base
            t.style("js", rel, "import default")
            t.add(base + " (default)", rel, ln)
    for m in re.finditer(r"\bexport\s+(?:\*|\{([^}]*)\})\s+from\s*" + spec, text):
        spans.append(m.span())
        t.style("js", rel, "export from")
        for item in (m.group(1) or "*").split(","):
            if item.strip():
                t.add("%s.%s" % (m.group(2), re.split(r"\s+as\s+", item.strip())[0]), rel, line_of(text, m.start()))
    for m in re.finditer(r"\b(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*require\(\s*" + spec + r"\s*\)(\.[\w$]+)?", text):
        spans.append(m.span())
        target, base, prop = m.group(1), m.group(2), m.group(3)
        ln = line_of(text, m.start())
        t.style("js", rel, "require()")
        if prop:
            base = base + "." + prop[1:]
            t.add(base, rel, ln)
        if target.startswith("{"):
            for item in target.strip("{} ").split(","):
                if item.strip():
                    parts = [p.strip() for p in item.split(":")]
                    binds[parts[-1]] = "%s.%s" % (base, parts[0])
                    t.add("%s.%s" % (base, parts[0]), rel, ln)
        else:
            members[target] = base
    for m in re.finditer(r"""(?<![\w$.])(?:require|import)\(\s*""" + spec + r"\s*\)", text):
        if not any(a <= m.start() < b for a, b in spans):
            t.style("js", rel, "require()/import() inline")
            t.add(m.group(1) + " (inline)", rel, line_of(text, m.start()))
    for m in re.finditer(r"\bimport\s+" + spec, text):
        spans.append(m.span())
        t.style("js", rel, "import (side effect)")
    body = strip_code(_blank(text, spans), True)
    for local, base in members.items():
        for m in re.finditer(r"(?<![\w$.])%s\s*(?:\?\.|\.)\s*([\w$]+)" % re.escape(local), body):
            t.add("%s.%s" % (base, m.group(1)), rel, line_of(body, m.start()))
        for m in re.finditer(r"(?<![\w$.])%s\s*\(" % re.escape(local), body):
            t.add("%s()" % base, rel, line_of(body, m.start()))
    for local, sym in binds.items():
        for m in re.finditer(r"(?<![\w$.])%s(?![\w$])(?!\s*:)" % re.escape(local), body):
            t.add(sym, rel, line_of(body, m.start()))


# ─────────────────────────── Rust ───────────────────────────

def _split_top(s):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _expand(prefix, s):
    s = s.strip()
    if not s:
        return
    if s.startswith("{") and s.endswith("}"):
        for item in _split_top(s[1:-1]):
            for x in _expand(prefix, item):
                yield x
        return
    if "::" in s and not s.startswith("{"):
        head, rest = s.split("::", 1)
        for x in _expand(prefix + [head.strip()], rest):
            yield x
        return
    parts = re.split(r"\s+as\s+", s)
    yield prefix + [parts[0].strip()], (parts[1].strip() if len(parts) > 1 else None)


def rs_file(path, rel, crate, t):
    text = read(path)
    if crate not in text:
        return
    c = re.escape(crate)
    spans = []
    local = {}
    for m in re.finditer(r"\bextern\s+crate\s+%s(?:\s+as\s+(\w+))?\s*;" % c, text):
        spans.append(m.span())
        t.style("rs", rel, "extern crate")
        if m.group(1):
            local[m.group(1)] = crate
    for m in re.finditer(r"\buse\s+(?:::)?%s((?:\s*::\s*[^;]*)?);" % c, text, re.S):
        spans.append(m.span())
        t.style("rs", rel, "use")
        rest = re.sub(r"\s+", " ", m.group(1)).strip()
        ln = line_of(text, m.start())
        if not rest:
            continue
        for path_parts, alias in _expand([crate], rest.lstrip(":").strip() if rest.startswith("::") else rest):
            path_parts = [p for p in path_parts if p]
            if path_parts[-1] == "self":
                path_parts = path_parts[:-1]
            sym = "::".join(path_parts)
            if path_parts[-1] == "*":
                t.add(sym, rel, ln)
                continue
            t.add(sym, rel, ln)
            name = alias or path_parts[-1]
            if name != "_":
                local[name] = sym
    body = strip_code(_blank(text, spans), False)
    for m in re.finditer(r"(?<![\w:])%s::((?:\w+::)*\w+!?)" % c, body):
        t.add("%s::%s" % (crate, m.group(1)), rel, line_of(body, m.start()))
    for name, sym in local.items():
        if name == crate:
            continue
        for m in re.finditer(r"(?<![\w:.])%s(?![\w])(!?)" % re.escape(name), body):
            t.add(sym + m.group(1), rel, line_of(body, m.start()))


# ─────────────────────────── Go ───────────────────────────

def go_alias(path):
    parts = path.split("/")
    last = parts[-1]
    if re.match(r"^v\d+$", last) and len(parts) > 1:
        last = parts[-2]
    last = re.sub(r"\.v\d+$", "", last)
    last = re.sub(r"^go-", "", last)
    last = re.sub(r"[-.]go$", "", last)
    return re.sub(r"[^\w]", "", last)


def go_file(path, rel, mod, t):
    text = read(path)
    if mod not in text:
        return
    imports = []
    for blk in re.finditer(r"\bimport\s*\(([^)]*)\)", text):
        for m in re.finditer(r'^\s*(\w+|\.|_)?\s*"([^"]+)"', blk.group(1), re.M):
            imports.append((m.group(1), m.group(2), line_of(text, blk.start(1) + m.start())))
    for m in re.finditer(r'^\s*import\s+(\w+|\.|_)?\s*"([^"]+)"', text, re.M):
        imports.append((m.group(1), m.group(2), line_of(text, m.start())))
    for alias, p, ln in imports:
        if not (p == mod or p.startswith(mod + "/")):
            continue
        t.style("go", rel, "import" + (" " + alias if alias else ""))
        t.add(p, rel, ln)
        if alias in ("_", "."):
            continue
        a = alias or go_alias(p)
        body = strip_code(text, False)
        for m in re.finditer(r"(?<![\w.])%s\.([A-Z]\w*)" % re.escape(a), body):
            t.add("%s.%s" % (a, m.group(1)), rel, line_of(text, m.start()))


# ─────────────────────────── main ───────────────────────────

def main(argv):
    if not argv or "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    langs = None
    args = []
    i = 0
    while i < len(argv):
        if argv[i] == "--lang":
            if i + 1 >= len(argv) or argv[i + 1] not in ("py", "js", "rs", "go"):
                print("api_usage: --lang needs py|js|rs|go", file=sys.stderr)
                return 2
            langs = {argv[i + 1]}
            i += 2
            continue
        if argv[i].startswith("-"):
            print("api_usage: unknown option %s" % argv[i], file=sys.stderr)
            return 2
        args.append(argv[i])
        i += 1
    if not args or len(args) > 2:
        print("api_usage: need PACKAGE [DIR] (see --help)", file=sys.stderr)
        return 2
    pkg = args[0]
    root = args[1] if len(args) > 1 else "."
    if not os.path.isdir(root):
        print("api_usage: %s is not a directory" % root, file=sys.stderr)
        return 2
    roots = py_roots(pkg)
    crate = pkg.replace("-", "_")
    t = Tally()
    nfiles = 0
    mention = 0
    for path, lang in walk(root, langs):
        nfiles += 1
        rel = os.path.relpath(path, root)
        before = sum(e[0] for e in t.sym.values())
        if lang == "py":
            py_file(path, rel, roots, t)
        elif lang == "js":
            js_file(path, rel, pkg, t)
        elif lang == "rs" and re.match(r"^[\w-]+$", pkg):
            rs_file(path, rel, crate, t)
        elif lang == "go" and ("." in pkg.split("/")[0] or "/" in pkg):
            go_file(path, rel, pkg, t)
        if sum(e[0] for e in t.sym.values()) > before:
            t.files.setdefault(lang, set()).add(rel)
        elif pkg in read(path):
            mention += 1
    print("api_usage %s in %s: scanned %d source files%s" % (
        pkg, root, nfiles, ("; python import names tried: " + ", ".join(roots[:4])) if roots and "/" not in pkg else ""))
    for lang in sorted(t.files):
        st = t.styles.get(lang, {})
        print("  %s: %d files; %s" % (lang, len(t.files[lang]),
                                      ", ".join("%s ×%d" % kv for kv in sorted(st.items(), key=lambda kv: (-kv[1], kv[0]))[:5])))
    if not t.sym:
        print("no imports of %s found%s" % (pkg, ("; %d source files mention the name textually (strings, "
                                                     "configs, dynamic imports?)" % mention) if mention else ""))
        return 0
    rows = sorted(t.sym.items(), key=lambda kv: (-kv[1][0], kv[0]))
    w = min(48, max(len(k) for k, _ in rows))
    print("%-*s %5s  %s" % (w, "SYMBOL", "COUNT", "FIRST LOCATIONS"))
    budget = 40 - 2 - len(t.files) - 1
    for sym, (n, locs) in rows[:budget]:
        s = sym if len(sym) <= w else sym[:w - 1] + "~"
        print("%-*s %5d  %s" % (w, s, n, ", ".join("%s:%d" % fl for fl in locs)))
    if len(rows) > budget:
        print("(+%d more symbols; use --lang or a subdirectory to narrow)" % (len(rows) - budget))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
