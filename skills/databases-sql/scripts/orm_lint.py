#!/usr/bin/env python3
"""Find common SQL/ORM bugs statically (Python and JS/TS), most severe first:
  sqli        SQL built with f-strings, %, +, .format() or `${}` passed to execute/raw/query/text
  n+1         ORM query inside a for-loop body (Django .objects, session.query/execute, Model.find*)
  call-default  default=datetime.now() / uuid4() evaluated once at import (drop the parentheses)
  mutable-default  default={} / [] shared between rows (use dict / list callables)
  no-on-delete  Django ForeignKey/OneToOneField without on_delete
  float-money  FloatField/Float for price/amount/total columns (use Decimal/Numeric)
  none-compare  SQLAlchemy `is None` / `is not None` in filter() (always False; use == None / .is_(None))
  naive-dt     datetime.utcnow()/now() without tz stored in models (compare with aware values fails)

Usage: orm_lint.py [PATH ...] [--only RULE,RULE]
"""
import os
import re
import sys

MAX_LINES = 40
SKIP = {"node_modules", ".git", "venv", ".venv", "site-packages", "__pycache__", "dist", "build", "migrations", "versions"}
EXEC = r"(?:execute|executemany|executescript|raw|text|query|exec_driver_sql|extra|RawSQL|\$queryRawUnsafe|\$executeRawUnsafe|sequelize\.query|knex\.raw|db\.run|db\.all|db\.get|db\.exec)"
SQL_KW = re.compile(r"\b(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM|VALUES|ORDER BY)\b", re.I)
PY_CALL = re.compile(EXEC + r"\(\s*(?:text\(\s*)?([rRbB]?[fF]?[rR]?)(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')\s*(%\s*[\w(]|\+|\.format\()?")
JS_CALL = re.compile(EXEC + r"\(\s*(`[^`]*`|\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*')\s*(\+)?")


def is_sqli(line, is_py):
    for m in (PY_CALL if is_py else JS_CALL).finditer(line):
        if is_py:
            prefix, lit, op = m.group(1), m.group(2), m.group(3)
            dyn = ("f" in prefix.lower() and "{" in lit) or bool(op)
        else:
            lit, op = m.group(1), m.group(2)
            dyn = (lit.startswith("`") and "${" in lit) or bool(op)
        if dyn and SQL_KW.search(lit):
            return True
    return False


QUERY_IN_LOOP = re.compile(r"\.objects\.|session\.(?:query|execute|get|scalars?)\(|\.query\.(?:filter|get|all)|"
                           r"\b\w+\.(?:findOne|findAll|findByPk|findUnique|findMany|findFirst|count)\(|\bawait\s+\w+\.query\(|cursor\.execute\(")
SEVERITY = {"sqli": 0, "n+1": 1, "call-default": 1, "none-compare": 1, "no-on-delete": 2, "mutable-default": 2,
            "float-money": 3, "naive-dt": 3}


def walk(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
            continue
        for d, dirs, files in os.walk(p):
            dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
            for f in sorted(files):
                if f.endswith((".py", ".js", ".ts", ".mjs", ".cjs")) and not f.endswith(".d.ts"):
                    yield os.path.join(d, f)


def indent(s):
    return len(s) - len(s.lstrip())


def lint(path, text):
    found = []
    lines = text.splitlines()
    is_py = path.endswith(".py")
    joined = [" ".join(lines[i:i + 3]) for i in range(len(lines))]  # calls often span lines
    for n, ln in enumerate(lines, 1):
        s = ln.strip()
        if s.startswith(("#", "//", "*")):
            continue
        if is_sqli(ln, is_py) or (not is_sqli(lines[n - 2] if n > 1 else "", is_py)
                                  and re.search(EXEC + r"\(\s*$", ln) and is_sqli(joined[n - 1], is_py)):
            found.append(("sqli", n, s))
        if is_py:
            if re.search(r"\bdefault\s*=\s*(?:\w+\.)*(?:datetime\.(?:now|utcnow|today)|timezone\.now|date\.today|uuid\.?uuid4|uuid4|time\.time)\(\)", s):
                found.append(("call-default", n, s))
            if re.search(r"\bdefault\s*=\s*(?:\{\}|\[\])", s) and re.search(r"Field\(|Column\(|mapped_column\(", s):
                found.append(("mutable-default", n, s))
            if re.search(r"models\.(?:ForeignKey|OneToOneField)\(", s):
                call = " ".join(lines[n - 1:n + 4])
                depth, end = 0, len(call)
                start = call.find("(")
                for i in range(start, len(call)):
                    depth += {"(": 1, ")": -1}.get(call[i], 0)
                    if depth == 0:
                        end = i
                        break
                if "on_delete" not in call[start:end]:
                    found.append(("no-on-delete", n, s))
            if re.search(r"\b(price|amount|total|cost|balance|money|fee)\w*\s*[:=].*\b(FloatField|Float\b|REAL)", s, re.I):
                found.append(("float-money", n, s))
            if re.search(r"\.(?:filter|where)\([^)]*\bis\s+(?:not\s+)?None", s):
                found.append(("none-compare", n, s))
            if re.search(r"(?:default|onupdate)\s*=\s*(?:\w+\.)*datetime\.(?:utcnow|now)\b(?!\(\s*(?:tz|timezone))", s) and "DateTime(timezone=True)" not in s:
                found.append(("naive-dt", n, s))
        else:
            if re.search(r"\b(price|amount|total|balance)\w*\s*:\s*\{[^}]*DataTypes\.FLOAT", s, re.I):
                found.append(("float-money", n, s))
    # N+1: a query call inside a for-loop body, where the loop iterates a queryset/list of rows
    for n, ln in enumerate(lines, 1):
        s = ln.strip()
        m = re.match(r"(for\s+\w+(?:\s*,\s*\w+)*\s+in\s+.+:|for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+.+\)\s*\{?|\w+\.forEach\()", s)
        if not m:
            continue
        base = indent(ln)
        for k in range(n, min(n + 25, len(lines))):
            body = lines[k]
            if body.strip() == "":
                continue
            if is_py and indent(body) <= base:
                break
            if not is_py and body.strip().startswith("}") and indent(body) <= base:
                break
            if QUERY_IN_LOOP.search(body) and not re.search(r"bulk_create|bulk_update|in_bulk|executemany", body):
                found.append(("n+1", k + 1, "loop@%d: %s" % (n, body.strip())))
                break
    return found


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    only = None
    if "--only" in args:
        i = args.index("--only")
        only = set(args[i + 1].split(","))
        del args[i:i + 2]
    res = []
    nfiles = 0
    for f in walk(args or ["."]):
        try:
            t = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        nfiles += 1
        for rule, n, s in lint(f, t):
            if only is None or rule in only:
                res.append((SEVERITY[rule], rule, os.path.normpath(f), n, s))
    res = sorted(set(res))
    counts = {}
    for r in res:
        counts[r[1]] = counts.get(r[1], 0) + 1
    print("%d finding(s) in %d file(s)%s" % (len(res), nfiles, (": " + ", ".join("%s×%d" % kv for kv in sorted(counts.items(), key=lambda kv: SEVERITY[kv[0]]))) if res else ""))
    for _, rule, f, n, s in res[:MAX_LINES - 2]:
        print("%-15s %s:%d  %s" % (rule, f, n, " ".join(s.split())[:110]))
    if len(res) > MAX_LINES - 2:
        print("(+%d more; use --only RULE or a narrower PATH)" % (len(res) - (MAX_LINES - 2)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
