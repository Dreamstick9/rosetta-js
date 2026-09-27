#!/usr/bin/env python3
"""Detect a backend service's stack in one call: language, web framework
(declared and whether importable/installed), app object or factory, Django
settings, ORM, database URL kind, migration tool, auth libs, test layout and
the command to run the tests offline.

Usage: detect_backend.py [DIR]
"""
import importlib.util
import json
import os
import re
import sys

MAX_LINES = 40
SKIP = {"node_modules", ".git", "venv", ".venv", "env", "site-packages", "__pycache__", "dist", "build", ".tox"}
PY_FW = [("django", "Django"), ("fastapi", "FastAPI"), ("flask", "Flask"), ("starlette", "Starlette"),
         ("aiohttp", "aiohttp"), ("tornado", "Tornado"), ("sanic", "Sanic"), ("quart", "Quart"),
         ("pyramid", "Pyramid"), ("falcon", "Falcon"), ("bottle", "Bottle"), ("litestar", "Litestar")]
PY_EXTRA = [("djangorestframework", "DRF"), ("sqlalchemy", "SQLAlchemy"), ("flask_sqlalchemy", "Flask-SQLAlchemy"),
            ("flask-sqlalchemy", "Flask-SQLAlchemy"), ("alembic", "Alembic"), ("pydantic", "pydantic"),
            ("sqlmodel", "SQLModel"), ("tortoise-orm", "Tortoise"), ("peewee", "peewee"), ("marshmallow", "marshmallow"),
            ("celery", "Celery"), ("flask-login", "Flask-Login"), ("pyjwt", "PyJWT"), ("python-jose", "python-jose"),
            ("httpx", "httpx"), ("requests", "requests"), ("pytest-django", "pytest-django"), ("psycopg2", "psycopg2"),
            ("psycopg", "psycopg"), ("asyncpg", "asyncpg"), ("pymongo", "pymongo"), ("redis", "redis")]
JS_FW = [("express", "Express"), ("@nestjs/core", "NestJS"), ("fastify", "Fastify"), ("koa", "Koa"), ("hono", "Hono"),
         ("next", "Next.js (API routes)"), ("@hapi/hapi", "hapi")]
JS_EXTRA = [("prisma", "Prisma"), ("@prisma/client", "Prisma"), ("sequelize", "Sequelize"), ("typeorm", "TypeORM"),
            ("mongoose", "Mongoose"), ("knex", "Knex"), ("drizzle-orm", "Drizzle"), ("pg", "pg"), ("mysql2", "mysql2"),
            ("sqlite3", "sqlite3"), ("better-sqlite3", "better-sqlite3"), ("jsonwebtoken", "jsonwebtoken"),
            ("passport", "passport"), ("supertest", "supertest"), ("jest", "jest"), ("vitest", "vitest"),
            ("mocha", "mocha"), ("zod", "zod"), ("joi", "joi")]


def read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def py_declared(root):
    text = ""
    for f in ("requirements.txt", "requirements-dev.txt", "requirements/base.txt", "requirements/dev.txt",
              "pyproject.toml", "setup.py", "setup.cfg", "Pipfile"):
        text += "\n" + read(os.path.join(root, f))
    decl = {}
    for m in re.finditer(r"(?im)^[\s\"']*([A-Za-z0-9_.\-\[\]]+)\s*(?:\[[^\]]*\])?\s*([<>=~!]=?\s*[\w.*]+)?", text):
        decl.setdefault(m.group(1).lower().split("[")[0], (m.group(2) or "").replace(" ", ""))
    return decl, text.lower()


def installed(mod):
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


def py_files(root):
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        for f in sorted(files):
            if f.endswith(".py"):
                yield os.path.join(d, f)


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    root = args[0] if args else "."
    out = []
    decl, dtext = py_declared(root)
    files = list(py_files(root))
    corpus = {f: read(f) for f in files[:1500]}
    imported = set()
    for t in corpus.values():
        imported.update(m.lower() for m in re.findall(r"^\s*(?:from|import)\s+(\w+)", t, re.M))
    if files:
        fws = []
        for mod, name in PY_FW:
            if mod in decl or mod in imported:
                ver = decl.get(mod, "")
                fws.append("%s%s%s" % (name, ver and " " + ver, "" if installed(mod) else " (NOT installed)"))
        out.append("python: %d .py files; framework: %s" % (len(files), ", ".join(fws) or "none detected"))
        extras = sorted({name for key, name in PY_EXTRA if key in decl or key.replace("-", "_") in imported})
        if extras:
            out.append("  libs: " + ", ".join(extras))
        # app objects / factories
        apps = []
        for f, t in corpus.items():
            for m in re.finditer(r"^(\w+)\s*=\s*(?:flask\.)?(Flask|FastAPI|Starlette|Quart|Sanic)\(", t, re.M):
                apps.append("%s = %s() in %s:%d" % (m.group(1), m.group(2), os.path.relpath(f, root), t[:m.start()].count("\n") + 1))
            for m in re.finditer(r"^def (create_app|make_app|get_application)\s*\(", t, re.M):
                apps.append("factory %s() in %s:%d" % (m.group(1), os.path.relpath(f, root), t[:m.start()].count("\n") + 1))
        for a in apps[:3]:
            out.append("  app: " + a)
        mp = read(os.path.join(root, "manage.py"))
        if mp:
            m = re.search(r"DJANGO_SETTINGS_MODULE['\"]\s*,\s*['\"]([\w.]+)", mp)
            out.append("  django settings: %s" % (m.group(1) if m else "?"))
            apps_dirs = sorted({os.path.relpath(os.path.dirname(f), root) for f in files if f.endswith(os.sep + "models.py")})
            if apps_dirs:
                out.append("  django apps with models: " + " ".join(apps_dirs[:10]))
        dburl = None
        for f, t in corpus.items():
            m = re.search(r"(sqlite:///[^\s'\"]*|postgres(?:ql)?(?:\+\w+)?://|mysql(?:\+\w+)?://|mongodb(?:\+srv)?://)", t)
            m2 = re.search(r"['\"]ENGINE['\"]\s*:\s*['\"]django\.db\.backends\.(\w+)", t)
            if m2:
                dburl = "django %s (%s)" % (m2.group(1), os.path.relpath(f, root))
                break
            if m and not dburl:
                dburl = "%s… (%s)" % (m.group(1)[:30], os.path.relpath(f, root))
        if dburl:
            out.append("  database: " + dburl)
        mig = []
        if os.path.exists(os.path.join(root, "alembic.ini")):
            mig.append("alembic (alembic.ini)")
        n = sum(1 for f in files if os.sep + "migrations" + os.sep in f and re.search(r"\d{4}_\w+\.py$", f))
        if n:
            mig.append("django migrations (%d files)" % n)
        if mig:
            out.append("  migrations: " + ", ".join(mig))
        tests = [f for f in files if re.search(r"(^|/)(test_[^/]*|[^/]*_test|tests)\.py$", f) or "/tests/" in f]
        conftest = [os.path.relpath(f, root) for f in files if f.endswith("conftest.py")]
        cfg = [c for c in ("pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml") if "[pytest" in read(os.path.join(root, c)) or "[tool.pytest" in read(os.path.join(root, c))]
        out.append("  tests: %d test files; conftest: %s; pytest config: %s" % (len(tests), " ".join(conftest[:3]) or "-", " ".join(cfg) or "-"))
        fixtures_ = sorted({m for t in (corpus.get(os.path.join(root, c), "") for c in conftest) for m in re.findall(r"@pytest\.fixture[^\n]*\n\s*(?:async\s+)?def (\w+)", t)})
        if fixtures_:
            out.append("  fixtures: " + ", ".join(fixtures_[:12]))
        if mp and "pytest-django" not in decl:
            cmd = "python3 manage.py test --noinput [app.tests.Class.test_x]"
        elif installed("pytest"):
            cmd = "python3 -m pytest -q tests/test_x.py::test_name" + (" (pytest-django: --ds=settings)" if mp else "")
        else:
            cmd = "python3 -m unittest discover -s tests (pytest NOT installed)"
        out.append("  run tests: " + cmd)
    pj = None
    try:
        pj = json.loads(read(os.path.join(root, "package.json")) or "null")
    except ValueError:
        pass
    if pj:
        deps = {}
        for k in ("dependencies", "devDependencies"):
            deps.update(pj.get(k) or {})
        fw = ["%s %s" % (name, deps[k]) for k, name in JS_FW if k in deps]
        out.append("node: %s type=%s; framework: %s" % (pj.get("name", "?"), pj.get("type", "commonjs"), ", ".join(fw) or "none"))
        ex = sorted({name for k, name in JS_EXTRA if k in deps})
        if ex:
            out.append("  libs: " + ", ".join(ex))
        sc = pj.get("scripts") or {}
        for k in ("start", "dev", "test", "migrate"):
            if k in sc:
                out.append("  script %-6s %s" % (k, sc[k][:80]))
        if os.path.isdir(os.path.join(root, "prisma")):
            out.append("  prisma schema: prisma/schema.prisma; migrations: prisma/migrations")
        nm = os.path.isdir(os.path.join(root, "node_modules"))
        out.append("  node_modules %s; tests: %s" % ("present" if nm else "MISSING",
                                                      "npx --no-install jest --ci / vitest run (supertest for HTTP)" if nm else "cannot run offline"))
    if os.path.exists(os.path.join(root, "go.mod")):
        gm = read(os.path.join(root, "go.mod"))
        fw = [n for n in ("gin-gonic/gin", "labstack/echo", "go-chi/chi", "gorilla/mux", "gofiber/fiber") if n in gm]
        out.append("go: %s; tests: go test ./... (httptest for handlers)" % (", ".join(fw) or "net/http"))
    for spec in ("openapi.yaml", "openapi.json", "swagger.yaml", "swagger.json", "docs/openapi.yaml"):
        if os.path.exists(os.path.join(root, spec)):
            out.append("api spec: " + spec)
    if not out:
        out.append("no backend markers found in %s" % root)
    out.append("next: list_routes.py [--grep PATH]; call_endpoint.py METHOD PATH; pytest_failures.py")
    print("\n".join(out[:MAX_LINES]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
