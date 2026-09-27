#!/usr/bin/env python3
"""List HTTP routes statically (no import, no server): METHOD PATH -> handler file:line.

Python (AST): Flask (@app.route/@bp.get, add_url_rule, Blueprint url_prefix,
register_blueprint), FastAPI (@router.get, APIRouter prefix, include_router),
Django (urls.py path/re_path/include, DRF router.register).
Regex: Express/Koa/Hono (app.get, router.post, app.use('/p', router)),
NestJS (@Controller + @Get), Go (gin/echo/chi/net/http), Spring (@GetMapping).

Usage: list_routes.py [DIR] [--grep TEXT] [--max N]
  --grep TEXT  only routes whose path or handler contains TEXT (case-insensitive)
"""
import ast
import os
import re
import sys

MAX_LINES = 40
SKIP = {"node_modules", ".git", "venv", ".venv", "env", "site-packages", "__pycache__", "dist",
        "build", ".tox", "migrations", "vendor", "target", ".mypy_cache"}
HTTP = {"get", "post", "put", "patch", "delete", "head", "options", "websocket", "api_route", "route", "trace"}


def walk(root, exts):
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        for f in sorted(files):
            if f.endswith(exts):
                yield os.path.join(d, f)


def s(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) else "{…}" for v in node.values)
    return None


def kw(call, name):
    for k in call.keywords:
        if k.arg == name:
            return k.value
    return None


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return base + "." + node.attr if base else None
    return None


def methods_of(call, attr):
    if attr in ("route", "api_route"):
        m = kw(call, "methods")
        if isinstance(m, (ast.List, ast.Tuple, ast.Set)):
            return ",".join(sorted(str(s(e)).upper() for e in m.elts if s(e)))
        return "GET"
    return "WS" if attr == "websocket" else attr.upper()


class PyScan:
    def __init__(self, root):
        self.root = root
        self.objs = {}      # (mod, var) -> [kind, own_prefix]
        self.alias = {}     # (mod, localname) -> (mod2, name2 or None for module)
        self.routes = []    # (mod, var, methods, path, handler, file, line)
        self.mounts = []    # (parent(mod,var), childexpr(mod, dotted), prefix, kind)
        self.django = {}    # mod -> list of (route, target, file, line)
        self.drf = {}       # (mod, var) -> [(prefix, viewset)]
        self.modfile = {}

    def modname(self, path):
        rel = os.path.relpath(path, self.root)[:-3].replace(os.sep, ".")
        return rel[:-9] if rel.endswith(".__init__") else rel

    def resolve_mod(self, cur, level, name):
        if level:
            parts = cur.split(".")
            is_pkg = self.modfile.get(cur, "").endswith("__init__.py")
            base = parts[:len(parts) - level + (1 if is_pkg else 0)]
            name = ".".join(base + ([name] if name else []))
        if name in self.modfile:
            return name
        for m in self.modfile:  # suffix match (src/ layouts, sys.path tricks)
            if m.endswith("." + name):
                return m
        return name

    def scan(self):
        trees = {}
        for f in walk(self.root, (".py",)):
            self.modfile[self.modname(f)] = f
        for mod, f in self.modfile.items():
            try:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    trees[mod] = ast.parse(fh.read())
            except (SyntaxError, ValueError):
                continue
        for mod, tree in trees.items():
            self.scan_module(mod, tree, self.modfile[mod])

    def ref(self, mod, expr):
        """Resolve an expression like `router`, `users.router` to (mod, var)."""
        d = dotted(expr)
        if not d:
            return None
        parts = d.split(".")
        head = parts[0]
        if len(parts) == 1:
            tgt = self.alias.get((mod, head))
            if tgt and tgt[1]:
                return tgt
            return (mod, head)
        tgt = self.alias.get((mod, head))
        m = tgt[0] if tgt and tgt[1] is None else (tgt[0] + "." + tgt[1] if tgt else head)
        for p in parts[1:-1]:
            m = m + "." + p
        return (self.resolve_mod(mod, 0, m), parts[-1])

    def scan_module(self, mod, tree, path):
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                src = self.resolve_mod(mod, node.level, node.module or "")
                for a in node.names:
                    sub = src + "." + a.name
                    if sub in self.modfile:
                        self.alias[(mod, a.asname or a.name)] = (sub, None)
                    else:
                        self.alias[(mod, a.asname or a.name)] = (src, a.name)
            elif isinstance(node, ast.Import):
                for a in node.names:
                    self.alias[(mod, a.asname or a.name.split(".")[0])] = (
                        self.resolve_mod(mod, 0, a.name if a.asname else a.name.split(".")[0]), None)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                fn = (dotted(node.value.func) or "").split(".")[-1]
                for t in node.targets:
                    if not isinstance(t, ast.Name):
                        continue
                    if fn == "Blueprint":
                        p = kw(node.value, "url_prefix")
                        self.objs[(mod, t.id)] = ["flask-bp", s(p) or "" if p is not None else ""]
                    elif fn == "APIRouter":
                        p = kw(node.value, "prefix")
                        self.objs[(mod, t.id)] = ["fastapi-router", s(p) or "" if p is not None else ""]
                    elif fn in ("Flask", "FastAPI", "Quart", "Sanic", "Starlette"):
                        self.objs[(mod, t.id)] = ["app", ""]
                    if isinstance(t, ast.Name) and t.id == "urlpatterns":
                        self.django_patterns(mod, node.value, path)
            if isinstance(node, (ast.Assign, ast.AugAssign)) and isinstance(getattr(node, "value", None), (ast.List, ast.BinOp)):
                tgt = node.targets[0] if isinstance(node, ast.Assign) else node.target
                if isinstance(tgt, ast.Name) and tgt.id == "urlpatterns":
                    self.django_patterns(mod, node.value, path)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in HTTP:
                        p = s(dec.args[0]) if dec.args else s(kw(dec, "path") or kw(dec, "rule") or ast.Constant(value=None))
                        if p is None:
                            continue
                        owner = self.ref(mod, dec.func.value)
                        self.routes.append((owner, methods_of(dec, dec.func.attr), p, node.name, path, node.lineno))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                a = node.func.attr
                parent = self.ref(mod, node.func.value)
                if a in ("register_blueprint", "include_router") and node.args:
                    p = kw(node, "url_prefix" if a == "register_blueprint" else "prefix")
                    self.mounts.append((parent, self.ref(mod, node.args[0]), s(p) if p is not None else None, a))
                elif a == "add_url_rule" and node.args:
                    rule = s(node.args[0])
                    vf = kw(node, "view_func") or (node.args[2] if len(node.args) > 2 else None)
                    m = kw(node, "methods")
                    meth = ",".join(sorted(str(s(e)).upper() for e in m.elts)) if isinstance(m, (ast.List, ast.Tuple)) else "GET"
                    if rule is not None:
                        self.routes.append((parent, meth, rule, dotted(vf.func if isinstance(vf, ast.Call) else vf) if vf is not None else "?", path, node.lineno))
                elif a == "register" and len(node.args) >= 2 and s(node.args[0]) is not None:
                    self.drf.setdefault(parent, []).append((s(node.args[0]), dotted(node.args[1]) or "?", path, node.lineno))

    def django_patterns(self, mod, value, path):
        elts = []
        if isinstance(value, ast.List):
            elts = value.elts
        elif isinstance(value, ast.BinOp):
            for side in (value.left, value.right):
                if isinstance(side, ast.List):
                    elts += side.elts
        for e in elts:
            if not (isinstance(e, ast.Call) and (dotted(e.func) or "").split(".")[-1] in ("path", "re_path", "url")):
                continue
            if len(e.args) < 2:
                continue
            route = s(e.args[0]) or ""
            tgt = e.args[1]
            if isinstance(tgt, ast.Call) and (dotted(tgt.func) or "").endswith("include") and tgt.args:
                inc = tgt.args[0]
                if isinstance(inc, ast.Tuple) and inc.elts:
                    inc = inc.elts[0]
                if s(inc):
                    target = ("include", self.resolve_mod(mod, 0, s(inc)))
                elif isinstance(inc, ast.Attribute) and inc.attr == "urls":
                    target = ("router", self.ref(mod, inc.value))
                else:
                    target = ("view", dotted(inc) or "?")
            else:
                d = dotted(tgt.func) if isinstance(tgt, ast.Call) else dotted(tgt)
                target = ("view", d or "?")
            self.django.setdefault(mod, []).append((route, target, path, e.lineno))

    def prefix_of(self, obj, depth=0):
        if obj is None or depth > 8:
            return ""
        kind, own = self.objs.get(obj, ["?", ""])
        for parent, child, p, how in self.mounts:
            if child == obj:
                up = self.prefix_of(parent, depth + 1)
                if how == "register_blueprint":
                    return up + (p if p is not None else own)
                return up + (p or "") + own
        return own

    def results(self):
        out = []
        for owner, meth, p, handler, f, line in self.routes:
            out.append((meth, self.prefix_of(owner) + p, handler, f, line))
        # django: expand from root urlconfs (modules not included by others)
        included = {t[1] for pats in self.django.values() for _, t, _, _ in pats if t[0] == "include"}
        roots = [m for m in self.django if m not in included] or list(self.django)

        def expand(mod, prefix, depth):
            for route, target, f, line in self.django.get(mod, []):
                full = prefix + route
                if target[0] == "include" and depth < 6:
                    if target[1] in self.django:
                        expand(target[1], full, depth + 1)
                    else:
                        out.append(("ANY", full + "…", "include(%s) not found" % target[1], f, line))
                elif target[0] == "router":
                    for rp, vs, f2, l2 in self.drf.get(target[1], []):
                        out.append(("VIEWSET", full + rp + "/", vs, f2, l2))
                else:
                    out.append(("ANY", full, target[1], f, line))
        for r in sorted(roots):
            expand(r, "/", 0)
        return out


JS_ROUTE = re.compile(r"\b(\w+)\s*\.\s*(get|post|put|patch|delete|all|head|options)\s*\(\s*(['\"`])([^'\"`]*)\3\s*,\s*([^\n]*)")
JS_CHAIN = re.compile(r"\b(\w+)\s*\.\s*route\s*\(\s*(['\"`])([^'\"`]*)\2\s*\)([^;]*)")
JS_USE = re.compile(r"\b(\w+)\s*\.\s*use\s*\(\s*(['\"`])([^'\"`]*)\2\s*,\s*(?:[\w.]+\s*,\s*)*([\w.]+)\s*\)")
JS_IMPORT = re.compile(r"(?:import\s+(\w+)\s+from\s+|(?:const|let|var)\s+(\w+)\s*=\s*require\()\s*['\"](\.[^'\"]+)['\"]")
NEST_CTRL = re.compile(r"@Controller\(\s*(?:['\"]([^'\"]*)['\"])?")
NEST_M = re.compile(r"@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:['\"]([^'\"]*)['\"])?\s*\)\s*(?:\n\s*@[^\n]*)*\s*(?:async\s+)?(\w+)\s*\(")
GO_ROUTE = re.compile(r"\.\s*(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\s*\(\s*\"([^\"]+)\"\s*,\s*([\w.]+)")
SPRING_CLS = re.compile(r"@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\"([^\"]*)\"")
SPRING_M = re.compile(r"@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\"?([^\")]*)\"?[^)]*\)\s*(?:\n\s*@[^\n]*)*\s*(?:public\s+)?[\w<>\[\], ?]+\s+(\w+)\s*\(")


def js_handler(rest):
    """Last plain identifier argument (the handler after middlewares), or (inline)."""
    head = rest.split("=>")[0].split("function")[0]
    if "=>" in rest or "function" in rest:
        if not re.search(r"[\w.]+\s*,\s*(?:async\s*)?(?:\(|function|\w+\s*=>)", rest):
            return "(inline)"
    ids = re.findall(r"([A-Za-z_$][\w.$]*)\s*(?:,|\))", head)
    ids = [i for i in ids if i not in ("req", "res", "next", "ctx", "async")]
    return ids[-1][:40] if ids else "(inline)"


def js_routes(root):
    out, files, mounts = [], {}, {}
    for f in walk(root, (".js", ".ts", ".mjs", ".cjs")):
        if re.search(r"\.(test|spec|d)\.[cm]?[jt]s$", f):
            continue
        try:
            files[f] = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            pass
    for f, t in files.items():  # app.use('/api', usersRouter) -> prefix for the imported file
        imports = {}
        for m in JS_IMPORT.finditer(t):
            name = m.group(1) or m.group(2)
            base = os.path.normpath(os.path.join(os.path.dirname(f), m.group(3)))
            for cand in (base, base + ".js", base + ".ts", os.path.join(base, "index.js"), os.path.join(base, "index.ts")):
                if cand in files:
                    imports[name] = cand
        for m in JS_USE.finditer(t):
            tgt = imports.get(m.group(4).split(".")[0])
            if tgt:
                mounts[tgt] = m.group(3).rstrip("/")
    for f, t in files.items():
        pre = mounts.get(f, "")
        seen = set()
        for m in JS_ROUTE.finditer(t):
            if m.group(1) in ("axios", "http", "https", "request", "fetch", "client", "api", "supertest", "cy", "res", "req", "map", "cache", "params", "headers", "searchParams", "localStorage", "store", "db", "redis"):
                continue
            if m.group(2) == "get" and not m.group(4).startswith("/") and m.group(4) != "*":
                continue
            h = js_handler(m.group(5))
            line = t[:m.start()].count("\n") + 1
            seen.add(line)
            out.append((m.group(2).upper(), pre + m.group(4), h, f, line))
        for m in JS_CHAIN.finditer(t):
            pairs = re.findall(r"\.\s*(get|post|put|patch|delete|all)\s*\(\s*([\w.]*)", m.group(4))
            for meth, h in pairs:
                out.append((meth.upper(), pre + m.group(3), h or "(inline)", f, t[:m.start()].count("\n") + 1))
        c = NEST_CTRL.search(t)
        if c:
            base = "/" + (c.group(1) or "").strip("/")
            for m in NEST_M.finditer(t):
                sub = (m.group(2) or "").strip("/")
                out.append((m.group(1).upper(), (base.rstrip("/") + "/" + sub) if sub else base, m.group(3), f, t[:m.start()].count("\n") + 1))
    return out


def other_routes(root):
    out = []
    for f in walk(root, (".go",)):
        t = open(f, encoding="utf-8", errors="replace").read()
        for m in GO_ROUTE.finditer(t):
            meth = m.group(1).upper()
            out.append(("ANY" if meth.startswith("HANDLE") else meth, m.group(2), m.group(3), f, t[:m.start()].count("\n") + 1))
    for f in walk(root, (".java", ".kt")):
        t = open(f, encoding="utf-8", errors="replace").read()
        c = SPRING_CLS.search(t)
        base = c.group(1).rstrip("/") if c else ""
        for m in SPRING_M.finditer(t):
            if m.group(1) == "Request" and c and m.start() == c.start():
                continue
            out.append((m.group(1).upper().replace("REQUEST", "ANY"), base + "/" + m.group(2).strip("/"), m.group(3), f, t[:m.start()].count("\n") + 1))
    return out


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    grep, mx = None, MAX_LINES - 2
    if "--grep" in args:
        i = args.index("--grep")
        grep = args[i + 1].lower()
        del args[i:i + 2]
    if "--max" in args:
        i = args.index("--max")
        mx = min(int(args[i + 1]), MAX_LINES - 2)
        del args[i:i + 2]
    root = args[0] if args else "."
    py = PyScan(root)
    py.scan()
    routes = py.results() + js_routes(root) + other_routes(root)
    routes = [(m, re.sub(r"/{2,}", "/", p) or "/", h, os.path.relpath(f, root), l) for m, p, h, f, l in routes]
    if grep:
        routes = [r for r in routes if grep in r[1].lower() or grep in str(r[2]).lower()]
    uniq = sorted(set(routes), key=lambda r: (r[1], r[0], r[3], r[4]))
    print("%d route(s)%s" % (len(uniq), " matching %r" % grep if grep else ""))
    for m, p, h, f, l in uniq[:mx]:
        print("%-7s %-38s -> %s  %s:%d" % (m, p, h, f, l))
    if len(uniq) > mx:
        print("(+%d more; use --grep)" % (len(uniq) - mx))
    return 0


if __name__ == "__main__":
    sys.exit(main())
