---
name: databases-sql
internal: true
description: "Schemas, migrations and queries (SQLite/Postgres/MySQL) and ORMs (Django, SQLAlchemy, Prisma, Sequelize): wrong results, migration and N+1 bugs."
triggers:
  keywords: [sql, database, db, query, schema, table, column, index, migration, migrate, alembic, sqlite, postgres, postgresql, mysql, orm, sqlalchemy, django orm, queryset, prisma, sequelize, knex, join, foreign key, constraint, transaction, n+1, select, insert]
  files: [alembic.ini, schema.sql, schema.prisma, prisma, migrations, "*.sql", "*.sqlite3", "*.db", knexfile.js]
tools:
  - script: scripts/schema_summary.py
    usage: "schema_summary.py [PATH…] [--table NAME] → one line per table: cols, types, PK/NN/UQ/defaults/FKs, indexes (sqlite db, .sql, Django, SQLAlchemy, Prisma)"
  - script: scripts/sql_try.py
    usage: "sql_try.py [--db F | --schema F.sql --seed F.sql] [--plan] SQL… → result tables, affected rows, errors, query plan with full scans flagged"
  - script: scripts/migration_check.py
    usage: "migration_check.py [PATH…] [--all] → destructive/locking ops (HIGH/MED) with file:line + alembic heads / django leaf conflicts"
  - script: scripts/orm_lint.py
    usage: "orm_lint.py [PATH…] [--only RULE] → SQL injection, N+1 queries in loops, called defaults, missing on_delete, float money"
checks:
  - "python3 -m pytest -q -x 2>/dev/null || python3 manage.py test --noinput"
  - "python3 manage.py makemigrations --check --dry-run 2>/dev/null || true"
---
# Databases, SQL and ORMs

## When it applies
- Wrong query results (missing/duplicate rows, bad aggregates, NULL handling, ordering), slow queries, N+1.
- Adding/changing a column, table, index or constraint; a migration that fails or conflicts.
- ORM model/relationship bugs (Django, SQLAlchemy, Prisma, Sequelize, TypeORM, Knex), transactions, locking.

## Workflow
1. `python3 skills/databases-sql/scripts/schema_summary.py` (or `--table orders`) — the real schema in one call instead of
   opening every model/migration file. Point it at a `.db`, a `schema.sql`, or the project root.
2. Query bugs: reproduce in isolation with `python3 skills/databases-sql/scripts/sql_try.py --schema schema.sql --seed seed.sql "SELECT …"`
   (write a 3–5 row seed that shows the bug: NULLs, duplicates, no matching join rows). Iterate on the SQL there,
   then port it into the code/ORM. `--plan` shows full scans → missing index.
3. Schema changes: edit the model, then create a NEW migration with the project's tool
   (`python3 manage.py makemigrations <app>`, `alembic revision --autogenerate -m …`, `prisma migrate dev --create-only`
   only if installed; otherwise hand-write it in the same style as the latest one). Never edit applied migrations.
4. `python3 skills/databases-sql/scripts/migration_check.py` — flags drops, type changes, NOT NULL without default, renames, and
   graph problems (two Alembic heads, two Django leaf migrations → merge migration).
5. `python3 skills/databases-sql/scripts/orm_lint.py <changed files>` before finishing.
6. Run the tests (they usually build a fresh test DB from migrations — a missing migration shows up here).

## Query rules that fix most bugs
- `NULL`: `= NULL` is never true → `IS NULL`; `NOT IN (subquery with NULL)` returns nothing → `NOT EXISTS`;
  `COUNT(col)` skips NULLs, `COUNT(*)` does not; `SUM` of no rows is NULL → `COALESCE(SUM(x), 0)`.
- LEFT JOIN + a `WHERE` on the right table turns it into an inner join → move the condition into `ON`.
- Joining two one-to-many tables multiplies rows → aggregate in subqueries or use `COUNT(DISTINCT …)`.
- Every non-aggregated SELECT column must be in `GROUP BY` (Postgres errors; SQLite/MySQL silently pick one).
- Pagination needs a deterministic `ORDER BY` (add the PK as tiebreaker); OFFSET without ORDER BY is random.
- Parameterize everything (`?`, `%s`, `:name`, `$1`); never f-strings / concatenation. Identifiers can't be params:
  whitelist them.
- Dialect gaps: SQLite has no `ILIKE`, loose typing, `||` concat; Postgres is case-sensitive with quoted names,
  sorts NULLs last ASC; MySQL `=` is case-insensitive on most collations.

## ORM rules
- Django: querysets are lazy and re-evaluated; `select_related` (FK) / `prefetch_related` (M2M, reverse FK) for N+1;
  `F()` for atomic updates; `update()`/`bulk_create()` skip `save()` and signals; `get()` raises DoesNotExist /
  MultipleObjectsReturned; wrap multi-writes in `transaction.atomic()`.
- SQLAlchemy: `session.commit()` or it's rolled back; `filter(Model.x == None)` / `.is_(None)`, never `is None`;
  `joinedload`/`selectinload` for N+1; lazy loads after the session closes raise DetachedInstanceError.
- Prisma/Sequelize/TypeORM: `include`/`relations` for eager loading; `$transaction` / `sequelize.transaction`.
- Defaults: pass callables (`default=timezone.now`, `default=dict`), not calls. Money: Decimal/NUMERIC.
- A model change without a migration passes on a fresh in-memory DB and breaks production.

## Checklist
- [ ] Reproduced the query bug with a tiny seed (`sql_try.py`) or a failing test
- [ ] Schema change has a new migration; old migrations untouched; `migration_check.py` shows no unintended HIGH
- [ ] NOT NULL additions have a default/backfill; renames/drops are really intended by the task
- [ ] No string-built SQL; no new N+1 in list endpoints (`orm_lint.py` clean on changed files)
- [ ] Tests pass on the project's test DB

## Pitfalls
- Running migrations against a real/dev database file in the repo; use a copy or the test runner.
- `sql_try.py --db` opens read-only; add `--write` only on a copy.
- Editing an applied migration instead of adding one; deleting migrations to "fix" a conflict.
- Alembic autogenerate misses renames (emits drop+add = data loss) and server defaults; review the file.
- Django `makemigrations` prompting for a default blocks forever without a TTY: give the field a default/null.
- Comparing timezone-aware and naive datetimes; storing local time instead of UTC.
- Fixing a failing query by adding `DISTINCT` instead of fixing the join.

## Research
- `web_fetch` the docs for the installed version with a focused `prompt`: sqlite.org/lang.html,
  postgresql.org/docs/current/, dev.mysql.com/doc/refman/8.0/en/, docs.djangoproject.com/en/stable/ref/models/querysets/,
  docs.sqlalchemy.org/en/20/, alembic.sqlalchemy.org, prisma.io/docs, sequelize.org/docs/v6/.
- Dialect differences or an unfamiliar error: `web_search` the quoted error plus the database name and version.
