#!/usr/bin/env python3
"""Call one or more endpoints in-process through the framework's test client
(Flask, FastAPI/Starlette, Django): no server, no port, no network. Prints the
status, content type and a trimmed body; on an unhandled exception prints the
exception and the project frames of the traceback (the real cause of a 500).

Usage:
  call_endpoint.py [--root DIR] [--app MODULE:ATTR | --django] REQUEST [REQUEST ...]
  REQUEST = METHOD PATH [--json JSON] [--form k=v&k2=v2] [-H 'Name: value']
Examples:
  call_endpoint.py GET /health
  call_endpoint.py --app app:create_app POST /api/users --json '{"name":"bo"}' GET /api/users/2
Requests run in order on one client (cookies and in-memory state persist).
The app is auto-detected (module-level `X = Flask(...)`/`FastAPI(...)`, a
`create_app()` factory, or manage.py for Django) unless --app is given.
"""
import importlib
import json
import os
import re
import sys
import traceback

MAX_LINES = 40
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
SKIP = {"node_modules", ".git", "venv", ".venv", "env", "site-packages", "__pycache__", "tests", "test", "migrations"}


def find_app(root):
    if os.path.exists(os.path.join(root, "manage.py")):
        return "django", None
    cands = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        for f in sorted(files):
            if not f.endswith(".py"):
                continue
            p = os.path.join(d, f)
            try:
                t = open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            mod = os.path.relpath(p, root)[:-3].replace(os.sep, ".")
            if mod.endswith(".__init__"):
                mod = mod[:-9]
            m = re.search(r"^(\w+)\s*=\s*(?:flask\.)?(Flask|FastAPI|Starlette|Quart)\(", t, re.M)
            if m:
                cands.append((0, mod, m.group(1)))
            m = re.search(r"^def (create_app|make_app|build_app|get_app)\s*\(", t, re.M)
            if m:
                cands.append((1, mod, m.group(1)))
    if not cands:
        return None, None
    cands.sort(key=lambda c: (c[0], c[1].count("."), c[1]))
    return "python", "%s:%s" % (cands[0][1], cands[0][2])


def project_frames(tb, root):
    real = os.path.realpath(root)
    frames = [f for f in traceback.extract_tb(tb) if os.path.realpath(f.filename).startswith(real)
              and "site-packages" not in f.filename and not f.filename.endswith("call_endpoint.py")]
    return ["    %s:%d in %s: %s" % (os.path.relpath(f.filename, real), f.lineno, f.name, (f.line or "").strip()[:90])
            for f in frames[-4:]]


def parse_requests(args):
    reqs, cur = [], None
    i = 0
    while i < len(args):
        a = args[i]
        if a.upper() in METHODS and i + 1 < len(args) and args[i + 1].startswith("/"):
            cur = {"method": a.upper(), "path": args[i + 1], "json": None, "form": None, "headers": {}}
            reqs.append(cur)
            i += 2
            continue
        if cur is None:
            raise SystemExit("usage error: expected METHOD PATH, got %r (see --help)" % a)
        if a == "--json":
            cur["json"] = json.loads(args[i + 1])
        elif a == "--form":
            cur["form"] = dict(kv.split("=", 1) for kv in args[i + 1].split("&") if "=" in kv)
        elif a in ("-H", "--header"):
            k, v = args[i + 1].split(":", 1)
            cur["headers"][k.strip()] = v.strip()
        else:
            raise SystemExit("usage error: unknown option %r" % a)
        i += 2
    return reqs


def body_lines(ctype, raw):
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    if "json" in (ctype or ""):
        try:
            obj = json.loads(text)
            text = json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            if len(text) > 150:
                text = json.dumps(obj, indent=1, sort_keys=True, ensure_ascii=False)
        except ValueError:
            pass
    elif "html" in (ctype or ""):
        text = re.sub(r"<script.*?</script>|<style.*?</style>", "", text, flags=re.S)
        title = re.search(r"<title>(.*?)</title>", text, re.S)
        text = (("title: " + title.group(1).strip() + "\n") if title else "") + re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"[ \t]+", " ", text)
    lines = [ln.rstrip()[:150] for ln in text.splitlines() if ln.strip()]
    return lines


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    root, spec, force_django = ".", None, False
    while args and args[0].startswith("--"):
        if args[0] == "--root":
            root = args[1]
            args = args[2:]
        elif args[0] == "--app":
            spec = args[1]
            args = args[2:]
        elif args[0] == "--django":
            force_django = True
            args = args[1:]
        else:
            break
    reqs = parse_requests(args)
    root = os.path.abspath(root)
    sys.path.insert(0, root)
    os.chdir(root)
    kind = "django" if force_django else ("python" if spec else None)
    if kind is None:
        kind, spec = find_app(root)
    if kind is None:
        print("no Flask/FastAPI app or manage.py found under %s; pass --app module:attr" % root)
        return 0
    out = []
    try:
        if kind == "django":
            mp = open(os.path.join(root, "manage.py"), encoding="utf-8").read() if os.path.exists("manage.py") else ""
            m = re.search(r"DJANGO_SETTINGS_MODULE['\"]\s*,\s*['\"]([\w.]+)", mp)
            os.environ.setdefault("DJANGO_SETTINGS_MODULE", m.group(1) if m else "settings")
            import django
            django.setup()
            from django.conf import settings
            from django.test import Client
            settings.ALLOWED_HOSTS = list(settings.ALLOWED_HOSTS) + ["testserver"]
            client = Client(raise_request_exception=True)
            out.append("app: django (%s); DB is whatever settings point to (no test DB created)" % os.environ["DJANGO_SETTINGS_MODULE"])

            def call(r):
                kw = dict(r["headers"] and {"headers": r["headers"]} or {})
                if r["json"] is not None:
                    resp = client.generic(r["method"], r["path"], json.dumps(r["json"]), content_type="application/json", **kw)
                elif r["form"] is not None:
                    resp = getattr(client, r["method"].lower())(r["path"], r["form"], **kw)
                else:
                    resp = client.generic(r["method"], r["path"], **kw)
                return resp.status_code, resp.get("Content-Type", ""), resp.content, resp.get("Location")
        else:
            mod_name, attr = spec.split(":")
            obj = getattr(importlib.import_module(mod_name), attr)
            if callable(obj) and not hasattr(obj, "test_client") and not hasattr(obj, "router") and attr.islower():
                obj = obj()
            if hasattr(obj, "test_client"):
                obj.config["PROPAGATE_EXCEPTIONS"] = True
                obj.testing = True
                client = obj.test_client()
                out.append("app: flask %s" % spec)

                def call(r):
                    resp = client.open(r["path"], method=r["method"], json=r["json"], data=r["form"], headers=r["headers"])
                    return resp.status_code, resp.content_type, resp.data, resp.headers.get("Location")
            else:
                from starlette.testclient import TestClient
                client = TestClient(obj, raise_server_exceptions=True)
                out.append("app: asgi (fastapi/starlette) %s" % spec)

                def call(r):
                    resp = client.request(r["method"], r["path"], json=r["json"], data=r["form"], headers=r["headers"])
                    return resp.status_code, resp.headers.get("content-type", ""), resp.content, resp.headers.get("location")
    except Exception as e:  # import/setup failure: show the cause compactly
        print("cannot load app %s: %s: %s" % (spec or kind, type(e).__name__, str(e)[:200]))
        for ln in project_frames(e.__traceback__, root):
            print(ln)
        return 0
    budget = max(4, (MAX_LINES - 2) // max(1, len(reqs)) - 1)
    for r in reqs:
        try:
            status, ctype, raw, loc = call(r)
        except Exception as e:
            out.append("→ %s %s  raised %s: %s" % (r["method"], r["path"], type(e).__name__, str(e)[:160]))
            out += project_frames(e.__traceback__, root)
            continue
        out.append("→ %s %s  %s  %s%s" % (r["method"], r["path"], status, ctype or "-", "  Location: " + loc if loc else ""))
        bl = body_lines(ctype, raw)
        out += ["  " + b for b in bl[:budget]]
        if len(bl) > budget:
            out.append("  (+%d more body lines)" % (len(bl) - budget))
    print("\n".join(out[:MAX_LINES]))
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
