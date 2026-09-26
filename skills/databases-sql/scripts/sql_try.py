#!/usr/bin/env python3
"""Try SQL against SQLite in one call: load a schema (and seed data) into an
in-memory DB, or open an existing .db read-only, run the statements, and print
compact result tables, affected-row counts, errors and (with --plan) the query
plan with full-table SCANs flagged.

Usage:
  sql_try.py [--db FILE [--write]] [--schema F.sql ...] [--seed F.sql ...] [--plan] [--rows N] SQL | -f FILE
Examples:
  sql_try.py --schema db/schema.sql --seed db/seed.sql "SELECT u.name, SUM(o.total) FROM users u LEFT JOIN orders o ON o.user_id=u.id GROUP BY u.id"
  sql_try.py --db app.db --plan "SELECT * FROM orders WHERE status='paid'"
Postgres/MySQL DDL is translated lightly (SERIAL, NOW(), ::casts, JSONB, AUTO_INCREMENT,
ENGINE=...) and statements that still fail are reported and skipped. SQLite only:
semantics differ from Postgres (types, NULL ordering, ILIKE, RETURNING needs 3.35+).
"""
import os
import re
import sqlite3
import sys

MAX_LINES = 40


def translate(stmt):
    s = stmt
    s = re.sub(r"\bBIGSERIAL\b|\bSERIAL\b|\bSMALLSERIAL\b", "INTEGER", s, flags=re.I)
    s = re.sub(r"\bINT(?:EGER)?\s+(?:NOT\s+NULL\s+)?AUTO_INCREMENT\b", "INTEGER", s, flags=re.I)
    s = re.sub(r"\bAUTO_INCREMENT\b", "", s, flags=re.I)
    s = re.sub(r"\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b", "", s, flags=re.I)
    s = re.sub(r"::\s*[\w\[\]]+(?:\([^)]*\))?", "", s)
    s = re.sub(r"\bNOW\(\)", "CURRENT_TIMESTAMP", s, flags=re.I)
    s = re.sub(r"\bJSONB?\b|\bUUID\b|\bCITEXT\b|\bINET\b", "TEXT", s, flags=re.I)
    s = re.sub(r"\bTIMESTAMPTZ\b|\bTIMESTAMP\s+WITH(?:OUT)?\s+TIME\s+ZONE\b", "TIMESTAMP", s, flags=re.I)
    s = re.sub(r"\)\s*ENGINE\s*=\s*\w+[^;]*", ")", s, flags=re.I)
    s = re.sub(r"\bUSING\s+(?:btree|gin|gist|hash)\b", "", s, flags=re.I)
    s = re.sub(r"\bCONCURRENTLY\b", "", s, flags=re.I)
    s = re.sub(r"\bILIKE\b", "LIKE", s, flags=re.I)
    s = s.replace("`", '"')
    return s


def statements(text):
    buf, out = "", []
    for line in text.splitlines(True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


def load(con, path, label, notes):
    text = open(path, encoding="utf-8", errors="replace").read()
    ok = bad = 0
    for st in statements(text):
        if re.match(r"^\s*(SET|BEGIN|COMMIT|CREATE\s+EXTENSION|SELECT\s+pg_catalog|\\)", st, re.I):
            continue
        try:
            con.execute(st)
            ok += 1
        except sqlite3.Error:
            try:
                con.execute(translate(st))
                ok += 1
            except sqlite3.Error as e:
                bad += 1
                if bad <= 3:
                    notes.append("  skip (%s) %s: %s" % (label, " ".join(st.split())[:70], e))
    notes.append("%s %s: %d statements ok%s" % (label, path, ok, ", %d failed" % bad if bad else ""))


def fmt_rows(cur, rows, limit):
    cols = [d[0] for d in cur.description]
    cells = [[("NULL" if v is None else str(v))[:30] for v in r] for r in rows[:limit]]
    widths = [min(30, max([len(c)] + [len(r[i]) for r in cells])) for i, c in enumerate(cols)]
    lines = [" | ".join(c[:30].ljust(w) for c, w in zip(cols, widths)).rstrip()]
    lines += [" | ".join(v.ljust(w) for v, w in zip(r, widths)).rstrip() for r in cells]
    return lines


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    db, write, plan, rows = None, False, False, 15
    schemas, seeds, sql = [], [], []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--db":
            db = args[i + 1]; i += 2
        elif a == "--write":
            write = True; i += 1
        elif a == "--plan":
            plan = True; i += 1
        elif a == "--rows":
            rows = int(args[i + 1]); i += 2
        elif a == "--schema":
            schemas.append(args[i + 1]); i += 2
        elif a == "--seed":
            seeds.append(args[i + 1]); i += 2
        elif a == "-f":
            sql.append(open(args[i + 1], encoding="utf-8").read()); i += 2
        else:
            sql.append(a); i += 1
    out = []
    if db:
        if not os.path.exists(db):
            print("no such db: %s" % db)
            return 0
        con = sqlite3.connect("file:%s?mode=%s" % (os.path.abspath(db), "rw" if write else "ro"), uri=True)
        out.append("db %s (%s)" % (db, "read-write" if write else "read-only"))
    else:
        con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys=ON")
    for p in schemas:
        load(con, p, "schema", out)
    for p in seeds:
        load(con, p, "seed", out)
    out.append("sqlite %s" % sqlite3.sqlite_version)
    for st in statements("\n".join(s if s.rstrip().endswith(";") else s + ";" for s in sql)):
        head = " ".join(st.split())
        out.append("> " + head[:150])
        try:
            if plan and re.match(r"^\s*(SELECT|WITH|UPDATE|DELETE)", st, re.I):
                for r in con.execute("EXPLAIN QUERY PLAN " + st):
                    d = r[-1]
                    flag = "  <-- full scan (index?)" if re.match(r"SCAN (TABLE )?\w+$", d) or (d.startswith("SCAN") and "INDEX" not in d) else ""
                    out.append("  plan: " + d + flag)
            cur = con.execute(st)
            if cur.description:
                data = cur.fetchmany(rows + 1)
                more = len(data) > rows
                out += ["  " + ln for ln in fmt_rows(cur, data, rows)]
                rest = len(cur.fetchall()) if more else 0
                out.append("  (%d row%s%s)" % (min(len(data), rows) + rest, "" if len(data) == 1 else "s",
                                               ", showing %d" % rows if more else ""))
            else:
                out.append("  ok, %d row(s) affected" % cur.rowcount)
        except sqlite3.Error as e:
            out.append("  ERROR: %s" % e)
            if translate(st) != st:
                try:
                    cur = con.execute(translate(st))
                    out.append("  (works after Postgres→SQLite translation: dialect difference, not a logic bug)")
                except sqlite3.Error:
                    pass
    if not write:
        con.rollback()
    else:
        con.commit()
    print("\n".join(out[:MAX_LINES]))
    if len(out) > MAX_LINES:
        print("(+%d more)" % (len(out) - MAX_LINES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
