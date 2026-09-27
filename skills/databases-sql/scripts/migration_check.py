#!/usr/bin/env python3
"""Check migrations for destructive or locking operations and for a broken
migration graph. Understands raw SQL (incl. Prisma/Flyway/goose), Alembic,
Django, and Knex/Sequelize JS migrations.

Usage: migration_check.py [PATH ...] [--all]
  PATH   migration files or directories (default: auto-find migration dirs under .)
  --all  also list INFO findings (index creation, raw SQL, data migrations)
Severity: HIGH = data loss (drop/truncate/delete/type change), MED = can fail
or lock on existing data (NOT NULL without default, rename, unique), INFO.
Graph: Alembic multiple heads / missing down_revision; Django multiple leaf
migrations per app or duplicate numbers (needs a merge migration).
"""
import os
import re
import sys

MAX_LINES = 40
SKIP = {"node_modules", ".git", "venv", ".venv", "site-packages", "__pycache__", "dist", "build"}
MIG_DIRS = ("migrations", "migration", "alembic", "versions", "db", "prisma", "sql", "schema", "migrate")

SQL_RULES = [
    ("HIGH", r"\bDROP\s+TABLE\b[^;]*", "drop table"),
    ("HIGH", r"\bDROP\s+COLUMN\b[^;,]*", "drop column"),
    ("HIGH", r"\bTRUNCATE\b[^;]*", "truncate"),
    ("HIGH", r"\bDELETE\s+FROM\s+\S+\s*(?:;|$)", "delete without WHERE"),
    ("HIGH", r"\bUPDATE\s+\S+\s+SET\b(?:(?!\bWHERE\b)[^;])*(?:;|$)", "update without WHERE"),
    ("HIGH", r"\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b[^;,]*", "column type change (may truncate/fail)"),
    ("HIGH", r"\bDROP\s+SCHEMA\b[^;]*|\bDROP\s+DATABASE\b[^;]*", "drop schema/database"),
    ("MED", r"\bADD\s+(?:COLUMN\s+)?(?:\"?\w+\"?)\s+[\w()]+[^,;]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)[^,;]*", "NOT NULL column without DEFAULT (fails on non-empty table)"),
    ("MED", r"\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b", "SET NOT NULL (fails if NULLs exist)"),
    ("MED", r"\bRENAME\s+(?:COLUMN|TO)\b[^;]*", "rename (breaks running code/old queries)"),
    ("MED", r"\bDROP\s+(?:INDEX|CONSTRAINT)\b[^;]*", "drop index/constraint"),
    ("MED", r"\bCREATE\s+UNIQUE\s+INDEX\b[^;]*|\bADD\s+CONSTRAINT\s+\S+\s+UNIQUE\b[^;]*", "unique constraint (fails on duplicates)"),
    ("INFO", r"\bCREATE\s+INDEX\s+(?!CONCURRENTLY)[^;]*", "index without CONCURRENTLY (locks writes on Postgres)"),
]
PY_RULES = [
    ("HIGH", r"op\.drop_table\([^)]*\)", "drop table"),
    ("HIGH", r"op\.drop_column\([^)]*\)", "drop column"),
    ("HIGH", r"op\.alter_column\([^)]*\btype_\s*=", "column type change"),
    ("MED", r"op\.alter_column\([^)]*nullable\s*=\s*False", "set NOT NULL"),
    ("MED", r"op\.add_column\((?:(?!server_default)[^\n])*nullable\s*=\s*False(?:(?!server_default)[^\n])*", "NOT NULL column without server_default"),
    ("MED", r"op\.rename_table\([^)]*\)|op\.alter_column\([^)]*new_column_name", "rename"),
    ("MED", r"op\.drop_(?:index|constraint)\([^)]*\)", "drop index/constraint"),
    ("MED", r"op\.create_unique_constraint\([^)]*\)|unique\s*=\s*True", "unique constraint"),
    ("HIGH", r"migrations\.DeleteModel\([^)]*\)", "delete model (drop table)"),
    ("HIGH", r"migrations\.RemoveField\([^)]*\)", "remove field (drop column)"),
    ("MED", r"migrations\.AlterField\(", "alter field (type/null change: check)"),
    ("MED", r"migrations\.Rename(?:Field|Model)\([^)]*\)", "rename"),
    ("MED", r"migrations\.AddField\((?:(?!default|null\s*=\s*True)[\s\S])*?\)\s*,?\s*\)", "add field without default/null=True"),
    ("INFO", r"migrations\.RunPython\((?:(?!reverse_code|migrations\.RunPython\.noop)[^\n])*\)", "RunPython without reverse_code (irreversible)"),
    ("INFO", r"migrations\.RunSQL\(|op\.execute\(", "raw SQL: check it below"),
]
JS_RULES = [
    ("HIGH", r"\.dropTable(?:IfExists)?\([^)]*\)", "drop table"),
    ("HIGH", r"\.dropColumns?\([^)]*\)|removeColumn\([^)]*\)", "drop column"),
    ("HIGH", r"changeColumn\([^)]*\)|\.alter\(\)", "column type change"),
    ("MED", r"renameColumn\([^)]*\)|renameTable\([^)]*\)", "rename"),
    ("MED", r"\.notNullable\(\)(?![^;\n]*defaultTo)", "NOT NULL without default"),
]


def find_files(paths):
    files = []
    for p in paths:
        if os.path.isfile(p):
            files.append(p)
            continue
        for d, dirs, fs in os.walk(p):
            dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
            parts = set(d.replace("\\", "/").lower().split("/"))
            if paths != ["."] or parts & set(MIG_DIRS):
                for f in sorted(fs):
                    full = os.path.normpath(os.path.join(d, f))
                    low = full.lower()
                    if f.endswith(".sql") or (f.endswith(".py") and ("migrations" in parts or "versions" in parts) and f != "__init__.py") \
                            or (f.endswith((".js", ".ts")) and "migration" in low and not f.endswith(".d.ts")):
                        files.append(full)
    return files


def line_of(text, pos):
    return text[:pos].count("\n") + 1


def strip_sql_comments(t):
    t = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), t, flags=re.S)
    return re.sub(r"--[^\n]*", "", t)


def scan(path, findings):
    t = open(path, encoding="utf-8", errors="replace").read()
    if path.endswith(".sql"):
        # only the "up" part of goose/dbmate files
        m = re.search(r"--\s*\+(?:goose|migrate)\s+Down", t, re.I)
        rules, body = SQL_RULES, strip_sql_comments(t[:m.start()] if m else t)
    elif path.endswith(".py"):
        rules = PY_RULES
        body = t
        m = re.search(r"^def downgrade\(", t, re.M)
        if m:
            body = t[:m.start()]  # destructive ops in downgrade() are expected
        for s in re.finditer(r"(?:op\.execute|migrations\.RunSQL)\(\s*(?:sql\s*=\s*)?[rbuf]*(\"\"\"|'''|\"|')(.*?)\1", body, re.S):
            for sev, rx, msg in SQL_RULES:
                for m2 in re.finditer(rx, s.group(2), re.I | re.M):
                    findings.append((sev, path, line_of(body, s.start()), msg + " (raw SQL)", m2.group(0)))
    else:
        rules = JS_RULES
        body = t
        m = re.search(r"(?:exports\.down|async\s+down|down\s*[:(=])", t)
        if m:
            body = t[:m.start()]
    for sev, rx, msg in rules:
        flags = re.I | re.M if rules is SQL_RULES else re.M
        for m in re.finditer(rx, body, flags):
            findings.append((sev, path, line_of(body, m.start()), msg, m.group(0)))
    return t


def graph_checks(files, texts):
    issues = []
    revs, downs = {}, {}
    for f in files:
        t = texts.get(f, "")
        r = re.search(r"^revision\s*(?::\s*str)?\s*=\s*['\"]([\w]+)['\"]", t, re.M)
        if r:
            d = re.search(r"^down_revision\s*(?::[^=]+)?=\s*(.+)$", t, re.M)
            revs[r.group(1)] = f
            downs[r.group(1)] = re.findall(r"['\"](\w+)['\"]", d.group(1)) if d else []
    if revs:
        parents = {p for ds in downs.values() for p in ds}
        heads = sorted(r for r in revs if r not in parents)
        if len(heads) > 1:
            issues.append("alembic: %d heads %s → needs `alembic merge` (or fix down_revision)" % (len(heads), " ".join(heads)))
        for r, ds in sorted(downs.items()):
            for p in ds:
                if p not in revs:
                    issues.append("alembic: %s down_revision %s not found (%s)" % (r, p, os.path.basename(revs[r])))
    apps = {}
    for f in files:
        m = re.search(r"([\w-]+)[/\\]migrations[/\\](\d{4})_(\w+)\.py$", f)
        if m:
            apps.setdefault(m.group(1), []).append((m.group(2), m.group(2) + "_" + m.group(3), f))
    for app, migs in sorted(apps.items()):
        names = {n for _, n, _ in migs}
        depended = set()
        for _, n, f in migs:
            for dep_app, dep in re.findall(r"\(\s*['\"]([\w-]+)['\"]\s*,\s*['\"](\w+)['\"]\s*\)", texts.get(f, "")):
                if dep_app == app:
                    depended.add(dep)
                    if dep not in names and not dep.startswith("__"):
                        issues.append("django %s: %s depends on missing %s" % (app, n, dep))
        leaves = sorted(n for n in names if n not in depended)
        if len(leaves) > 1:
            issues.append("django %s: %d leaf migrations %s → makemigrations --merge" % (app, len(leaves), " ".join(leaves)))
        nums = {}
        for num, n, _ in migs:
            nums.setdefault(num, []).append(n)
        for num, ns in sorted(nums.items()):
            if len(ns) > 1:
                issues.append("django %s: duplicate number %s: %s" % (app, num, " ".join(sorted(ns))))
        latest = max(migs)[1]
        issues.append("django %s: %d migrations, latest %s" % (app, len(migs), latest))
    return issues


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    show_all = "--all" in args
    paths = [a for a in args if a != "--all"] or ["."]
    files = find_files(paths)
    if not files:
        print("no migration files found under %s (pass the directory explicitly)" % " ".join(paths))
        return 0
    findings, texts = [], {}
    for f in files:
        try:
            texts[f] = scan(f, findings)
        except OSError:
            pass
    order = {"HIGH": 0, "MED": 1, "INFO": 2}
    uniq = sorted(set(findings), key=lambda x: (order[x[0]], x[1], x[2]))
    counts = {k: sum(1 for x in uniq if x[0] == k) for k in order}
    out = ["%d migration file(s): %d HIGH, %d MED, %d INFO" % (len(files), counts["HIGH"], counts["MED"], counts["INFO"])]
    out += ["graph: " + g for g in graph_checks(files, texts)]
    shown = [x for x in uniq if show_all or x[0] != "INFO"]
    for sev, f, ln, msg, snip in shown:
        out.append("%-4s %s:%d %s | %s" % (sev, f, ln, msg, " ".join(snip.split())[:80]))
    if not show_all and counts["INFO"]:
        out.append("(%d INFO hidden; --all to show)" % counts["INFO"])
    print("\n".join(out[:MAX_LINES]))
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
