#!/usr/bin/env python3
"""Summarize a database schema compactly, one line per table:
  table(col TYPE PK|NN|UQ|=default|→ref.col, ...) [indexes]
Sources: a SQLite database file, .sql DDL files, or a project directory
(Django models, SQLAlchemy models, Prisma schema.prisma, *.sql schema files).

Usage: schema_summary.py [PATH ...] [--table NAME]
  PATH          sqlite file, .sql file, models file or directory (default .)
  --table NAME  only tables/models whose name contains NAME (case-insensitive)
"""
import ast
import os
import re
import sqlite3
import sys

MAX_LINES = 40
SKIP = {"node_modules", ".git", "venv", ".venv", "site-packages", "__pycache__", "dist", "build", "migrations", "versions", "tests"}


def is_sqlite(p):
    try:
        with open(p, "rb") as f:
            return f.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def from_sqlite(p):
    con = sqlite3.connect("file:%s?mode=ro" % os.path.abspath(p), uri=True)
    tables = []
    for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        fks = {r[3]: "%s.%s" % (r[2], r[4]) for r in con.execute('PRAGMA foreign_key_list("%s")' % name)}
        uq = set()
        idx = []
        for r in con.execute('PRAGMA index_list("%s")' % name):
            cols = [c[2] for c in con.execute('PRAGMA index_info("%s")' % r[1])]
            if r[2] and len(cols) == 1:
                uq.add(cols[0])
            if not r[1].startswith("sqlite_autoindex"):
                idx.append("%s%s(%s)" % ("UQ " if r[2] else "", r[1], ",".join(str(c) for c in cols)))
        cols = []
        for cid, cname, ctype, notnull, dflt, pk in con.execute('PRAGMA table_info("%s")' % name):
            flags = [ctype or "ANY"] + (["PK"] if pk else []) + (["NN"] if notnull and not pk else []) \
                + (["UQ"] if cname in uq else []) + (["=%s" % dflt] if dflt is not None else []) \
                + (["→" + fks[cname]] if cname in fks else [])
            cols.append("%s %s" % (cname, " ".join(flags)))
        n = con.execute('SELECT COUNT(*) FROM "%s"' % name).fetchone()[0]
        tables.append((name, cols, idx, "%d rows" % n))
    con.close()
    return tables


def split_top(body):
    parts, depth, cur, q = [], 0, [], None
    for ch in body:
        if q:
            cur.append(ch)
            if ch == q:
                q = None
            continue
        if ch in "'\"`":
            q = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    return parts


def unq(n):
    return n.strip('"`[]').split(".")[-1].strip('"`[]')


def from_sql(text):
    text = re.sub(r"--[^\n]*|/\*.*?\*/", "", text, flags=re.S)
    tables = {}
    for m in re.finditer(r"CREATE\s+(?:TEMP\w*\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"`\[\]]+)\s*\(", text, re.I):
        depth, i = 1, m.end()
        while i < len(text) and depth:
            depth += {"(": 1, ")": -1}.get(text[i], 0)
            i += 1
        name = unq(m.group(1))
        cols, extra = [], []
        for item in split_top(text[m.end():i - 1]):
            head = item.split()[0].upper() if item.split() else ""
            if head in ("CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "KEY", "INDEX", "EXCLUDE"):
                fk = re.search(r"FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([\w.\"`]+)\s*\(([^)]*)\)", item, re.I)
                pk = re.search(r"PRIMARY\s+KEY\s*\(([^)]*)\)", item, re.I)
                uq = re.search(r"UNIQUE\s*(?:KEY\s+\w+\s*)?\(([^)]*)\)", item, re.I)
                if fk:
                    extra.append("FK(%s)→%s(%s)" % (fk.group(1).replace(" ", ""), unq(fk.group(2)), fk.group(3).replace(" ", "")))
                elif pk:
                    extra.append("PK(%s)" % pk.group(1).replace(" ", ""))
                elif uq:
                    extra.append("UQ(%s)" % uq.group(1).replace(" ", ""))
                elif head == "CHECK" or "CHECK" in item.upper():
                    extra.append("CHECK" + " ".join(item.split())[item.upper().find("CHECK") + 5:][:40])
                continue
            toks = item.split()
            col = unq(toks[0])
            typ = re.match(r"\S+\s+([A-Za-z_][\w ]*?(?:\([^)]*\))?)(?=\s+(?:NOT|NULL|PRIMARY|UNIQUE|DEFAULT|REFERENCES|CHECK|GENERATED|AUTO|COLLATE|CONSTRAINT)\b|\s*$)", item, re.I)
            flags = [typ.group(1).strip() if typ else "ANY"]
            u = item.upper()
            if "PRIMARY KEY" in u:
                flags.append("PK")
            if "NOT NULL" in u and "PRIMARY KEY" not in u:
                flags.append("NN")
            if re.search(r"\bUNIQUE\b", u):
                flags.append("UQ")
            d = re.search(r"\bDEFAULT\s+('[^']*'|\([^)]*\)|[\w.\-]+(?:\(\))?)", item, re.I)
            if d:
                flags.append("=" + d.group(1))
            r = re.search(r"REFERENCES\s+([\w.\"`]+)\s*(?:\(([^)]*)\))?", item, re.I)
            if r:
                flags.append("→%s.%s" % (unq(r.group(1)), (r.group(2) or "id").strip().strip('"')))
                od = re.search(r"ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)", item, re.I)
                if od:
                    flags.append("ondelete=" + od.group(1).upper().replace(" ", "_"))
            cols.append("%s %s" % (col, " ".join(flags)))
        tables[name] = [name, cols, extra, ""]
    for m in re.finditer(r"ALTER\s+TABLE\s+(?:ONLY\s+)?([\w.\"`]+)\s+ADD\s+(?:COLUMN\s+)?(?!CONSTRAINT|PRIMARY|FOREIGN|UNIQUE)([\w\"]+)\s+([^,;]+)", text, re.I):
        t = tables.get(unq(m.group(1)))
        if t:
            t[1].append("%s %s (altered)" % (unq(m.group(2)), " ".join(m.group(3).split())[:40]))
    for m in re.finditer(r"CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w\"]+)\s+ON\s+([\w.\"`]+)\s*(?:USING\s+\w+\s*)?\(([^)]*)\)", text, re.I):
        t = tables.get(unq(m.group(3)))
        if t:
            t[2].append("%s%s(%s)" % ("UQ " if m.group(1) else "", unq(m.group(2)), m.group(4).replace(" ", "")))
    return list(tables.values())


def kwmap(call):
    return {k.arg: k.value for k in call.keywords if k.arg}


def lit(v):
    try:
        return repr(ast.literal_eval(v))[:20]
    except Exception:
        return (ast.unparse(v) if hasattr(ast, "unparse") else "expr")[:20]


def from_python(path, text):
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    tables = []
    for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
        bases = [ast.unparse(b) if hasattr(ast, "unparse") else "" for b in cls.bases]
        tablename, cols, extra, django = None, [], [], False
        for st in cls.body:
            if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
                name, val = st.targets[0].id, st.value
            elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                name, val = st.target.id, st.value
            elif isinstance(st, ast.ClassDef) and st.name == "Meta":
                for m in st.body:
                    if isinstance(m, ast.Assign) and isinstance(m.targets[0], ast.Name):
                        if m.targets[0].id in ("db_table", "unique_together", "abstract", "constraints", "indexes"):
                            extra.append("%s=%s" % (m.targets[0].id, (ast.unparse(m.value) if hasattr(ast, "unparse") else "…")[:60]))
                continue
            else:
                continue
            if name == "__tablename__":
                tablename = lit(val).strip("'")
                continue
            if not isinstance(val, ast.Call):
                continue
            fn = (ast.unparse(val.func) if hasattr(ast, "unparse") else "").split(".")[-1]
            kw = kwmap(val)
            if fn.endswith("Field") or fn in ("ForeignKey", "OneToOneField", "ManyToManyField"):
                django = True
                flags = [fn.replace("Field", "") or fn]
                if fn in ("ForeignKey", "OneToOneField", "ManyToManyField") and val.args:
                    tgt = val.args[0]
                    flags.append("→" + (tgt.value if isinstance(tgt, ast.Constant) else ast.unparse(tgt) if hasattr(ast, "unparse") else "?"))
                    if "on_delete" in kw:
                        flags.append("ondelete=" + ast.unparse(kw["on_delete"]).split(".")[-1] if hasattr(ast, "unparse") else "")
                for k in ("primary_key", "unique", "null", "blank", "db_index"):
                    if k in kw and isinstance(kw[k], ast.Constant) and kw[k].value is True:
                        flags.append({"primary_key": "PK", "unique": "UQ", "null": "null", "blank": "blank", "db_index": "idx"}[k])
                if "max_length" in kw:
                    flags.append("max=%s" % lit(kw["max_length"]))
                if "default" in kw:
                    flags.append("=" + lit(kw["default"]))
                cols.append("%s %s" % (name, " ".join(flags)))
            elif fn in ("Column", "mapped_column"):
                flags = []
                for a in val.args:
                    s = ast.unparse(a) if hasattr(ast, "unparse") else ""
                    if s.startswith("ForeignKey("):
                        m = re.search(r"ForeignKey\(\s*['\"]([^'\"]+)['\"]", s)
                        flags.append("→" + (m.group(1) if m else s[11:-1]))
                        m2 = re.search(r"ondelete\s*=\s*['\"](\w[\w ]*)['\"]", s)
                        if m2:
                            flags.append("ondelete=" + m2.group(1))
                    elif not isinstance(a, ast.Constant):
                        flags.insert(0, s.replace("sa.", "").replace("db.", ""))
                if isinstance(st, ast.AnnAssign):
                    ann = ast.unparse(st.annotation) if hasattr(ast, "unparse") else ""
                    if not flags or flags[0].startswith("→"):
                        inner = re.sub(r"^Mapped\[(.*)\]$", r"\1", ann)
                        inner = re.sub(r"^Optional\[(.*)\]$", r"\1", inner).replace(" | None", "")
                        flags.insert(0, inner)
                    if "Optional[" in ann or "| None" in ann:
                        flags.append("null")
                for k, tag in (("primary_key", "PK"), ("unique", "UQ"), ("index", "idx")):
                    if k in kw and isinstance(kw[k], ast.Constant) and kw[k].value is True:
                        flags.append(tag)
                if "nullable" in kw and isinstance(kw["nullable"], ast.Constant):
                    flags.append("NN" if kw["nullable"].value is False else "null")
                for k in ("default", "server_default"):
                    if k in kw:
                        flags.append("%s%s" % ("=" if k == "default" else "srv=", lit(kw[k])))
                cols.append("%s %s" % (name, " ".join(flags)))
            elif fn == "relationship":
                tgt = val.args[0] if val.args else None
                extra.append("rel %s→%s" % (name, (tgt.value if isinstance(tgt, ast.Constant) else ast.unparse(tgt) if tgt is not None and hasattr(ast, "unparse") else "?")))
        if cols and (tablename or django or any("Base" in b or "Model" in b for b in bases)):
            label = tablename or cls.name
            if django:
                label = "%s (django %s)" % (cls.name, os.path.basename(os.path.dirname(path)))
            tables.append((label, cols, extra, "%s:%d" % (path, cls.lineno)))
    return tables


def from_prisma(text):
    tables = []
    for m in re.finditer(r"^model\s+(\w+)\s*\{(.*?)^\}", text, re.S | re.M):
        cols, extra = [], []
        for ln in m.group(2).splitlines():
            ln = ln.split("//")[0].strip()
            if not ln:
                continue
            if ln.startswith("@@"):
                extra.append(ln[:60])
                continue
            toks = ln.split()
            if len(toks) < 2:
                continue
            flags = [toks[1]]
            if "@id" in ln:
                flags.append("PK")
            if "@unique" in ln:
                flags.append("UQ")
            d = re.search(r"@default\(([^)]*\)?)\)", ln)
            if d:
                flags.append("=" + d.group(1))
            r = re.search(r"@relation\([^)]*fields:\s*\[([^\]]*)\][^)]*references:\s*\[([^\]]*)\]", ln)
            if r:
                flags.append("fk(%s)→%s.%s" % (r.group(1), toks[1].rstrip("?"), r.group(2)))
            cols.append("%s %s" % (toks[0], " ".join(flags)))
        tables.append((m.group(1), cols, extra, "prisma"))
    return tables


def collect(path):
    if os.path.isfile(path):
        if is_sqlite(path):
            return from_sqlite(path)
        text = open(path, encoding="utf-8", errors="replace").read()
        if path.endswith(".sql"):
            return from_sql(text)
        if path.endswith(".prisma"):
            return from_prisma(text)
        if path.endswith(".py"):
            return from_python(path, text)
        return []
    out = []
    for d, dirs, files in os.walk(path):
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        for f in sorted(files):
            p = os.path.join(d, f)
            if f.endswith(".prisma") or (f.endswith(".sql") and re.search(r"schema|init|create|ddl|structure", f, re.I)) \
                    or f.endswith((".sqlite", ".sqlite3", ".db")):
                out += collect(p)
            elif f.endswith(".py"):
                t = open(p, encoding="utf-8", errors="replace").read()
                if re.search(r"models\.Model\b|__tablename__|mapped_column\(|db\.Column\(", t):
                    out += from_python(os.path.relpath(p, path), t)
    return out


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    flt = None
    if "--table" in args:
        i = args.index("--table")
        flt = args[i + 1].lower()
        del args[i:i + 2]
    tables = []
    for p in args or ["."]:
        tables += collect(p)
    if flt:
        tables = [t for t in tables if flt in t[0].lower()]
    if not tables:
        print("no tables/models found")
        return 0
    out = ["%d table(s)/model(s)" % len(tables)]
    for name, cols, extra, src in tables:
        line = "%s(%s)" % (name, ", ".join(cols))
        if extra:
            line += " [" + "; ".join(extra) + "]"
        if src:
            line += "  {%s}" % src
        if flt or len(line) <= 220:
            out.append(line if flt else line[:220])
        else:
            out.append(line[:217] + "...")
    print("\n".join(out[:MAX_LINES]))
    if len(out) > MAX_LINES:
        print("(+%d more; use --table)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
