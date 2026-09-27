---
name: backend-api
internal: true
description: "HTTP services in FastAPI, Flask, Django/DRF, Express or Nest: routes, handlers, validation, status codes, auth, API tests."
triggers:
  keywords: [api, endpoint, route, handler, rest, http, server, backend, request, response, status code, json, flask, django, fastapi, express, nestjs, blueprint, router, view, viewset, serializer, pydantic, middleware, auth, 404, 500, test client]
  files: [manage.py, app.py, main.py, wsgi.py, asgi.py, server.js, server.ts, app.js, urls.py, openapi.yaml, openapi.json]
tools:
  - script: scripts/detect_backend.py
    usage: "detect_backend.py [DIR] → framework+installed?, app object/factory, settings, ORM, DB, migrations, fixtures, test command"
  - script: scripts/list_routes.py
    usage: "list_routes.py [DIR] [--grep TEXT] → METHOD full-path → handler file:line (prefixes/includes resolved, no import)"
  - script: scripts/call_endpoint.py
    usage: "call_endpoint.py [--app mod:attr] METHOD PATH [--json J] [-H 'K: V'] [METHOD PATH …] → status + trimmed body, or the project traceback of a 500"
  - script: scripts/pytest_failures.py
    usage: "pytest_failures.py [DIR] | -- CMD… | --log F → failing test ids, E-lines/exception, file:line (pytest, unittest, manage.py test)"
checks:
  - "python3 -m pytest -q -x 2>/dev/null || python3 manage.py test --noinput 2>/dev/null || python3 -m unittest discover -s tests"
---
# Backend and APIs

## When it applies
- The task names an endpoint, route, status code, request/response field, serializer/schema, middleware or auth rule.
- The repo is a web service (Flask, FastAPI, Django/DRF, Express, Nest, Koa, Gin…).
- A bug shows as a wrong HTTP status, malformed JSON, a missing field, a 500, or a failing API test.
- Schema/migration/query work → also open `databases-sql`. Outgoing calls to third-party APIs → `api-integration`.

## Workflow
1. `python3 skills/backend-api/scripts/detect_backend.py` — framework, app factory, settings, test command in one call.
2. `python3 skills/backend-api/scripts/list_routes.py --grep <path from issue>` — the handler's file:line with the full prefix
   (blueprint `url_prefix`, `include_router(prefix=)`, Django `include()`, `app.use('/x', router)` resolved).
3. Reproduce in-process before editing: `python3 skills/backend-api/scripts/call_endpoint.py POST /api/users --json '{"name":"x"}'`.
   A 500 prints the exception and the project frames: that is where to fix. Chain requests to test flows
   (create then fetch). For Express, use the project's supertest tests instead.
4. Read the handler → service → data access. Put the fix where similar logic lives (keep the layering).
5. Add/adjust a test using the framework test client (Flask `app.test_client()`, FastAPI `TestClient`,
   Django `Client`/DRF `APIClient`, supertest) next to the existing API tests; reuse conftest fixtures.
6. `python3 skills/backend-api/scripts/pytest_failures.py -- python3 -m pytest -q tests/test_api.py` until green, then the full suite.

## Contract rules
- Status codes: 201 + body (and often `Location`) on create, 204 without body on delete, 400/422 for invalid input,
  401 unauthenticated, 403 forbidden, 404 missing, 409 conflict. Never 500 for client input; never 200 with an error inside.
- Keep response field names, types, nesting, pagination shape and error shape (`{"detail": …}` in FastAPI/DRF,
  project's own in Flask/Express). Add fields; don't rename or remove.
- Validate at the boundary (pydantic model, DRF serializer, marshmallow, zod/joi) and let the framework produce
  its standard error (FastAPI 422, DRF 400 with field errors).
- Trailing slashes matter: Django `APPEND_SLASH` redirects (301) GETs but breaks POSTs; Flask `/x/` vs `/x` differ.
- FastAPI: path params are typed by the signature; `response_model` filters output fields; `Depends` for auth/db.
  Route order matters: `/items/me` must be declared before `/items/{id}`.
- Flask: `request.get_json()` returns None on wrong content type (use `silent=True` + explicit 400);
  `abort(404)`; return `(body, status)` tuples; blueprints registered in the factory.
- Django/DRF: `get_object_or_404`; permissions via `permission_classes`; querysets are lazy — `select_related`/
  `prefetch_related` to avoid N+1 in list views; serializer `validate_<field>` for field rules.
- Express: `async` handlers need errors passed to `next(err)` (Express 4) or they hang; `res.status(x).json()`
  once per request; `express.json()` must be mounted before routes.
- Time in UTC, ISO 8601 in JSON; money as integers/Decimal; parameterized queries only.

## Checklist
- [ ] Reproduced with `call_endpoint.py` or a failing test before editing
- [ ] Status code, error shape and field names match the project's conventions
- [ ] Invalid input → 4xx with a useful message, not 500
- [ ] Auth/permission checks still apply to the changed route
- [ ] Test covers success + one failure path (validation / not found / forbidden)
- [ ] Schema changes come with a migration (see `databases-sql`); old migrations untouched
- [ ] OpenAPI/docs updated if the project keeps them

## Pitfalls
- Starting a real server (`flask run`, `uvicorn`, `node server.js`) in the foreground never returns; use the test
  client. If you must, run it in the background and kill it.
- `call_endpoint.py` imports the app: module-level side effects (DB connects, env vars) may need env like
  `DATABASE_URL=sqlite://` set in the command.
- Django `manage.py test` creates a test DB; `call_endpoint.py --django` uses the configured DB as is.
- Catching broad exceptions and returning 200/500 hides the real error; catch the specific one.
- Changing a shared serializer/schema fixes one endpoint and silently changes others; grep its users.
- Tests hitting real external services: mock at the client boundary.

## Research
- Framework docs for the declared version via `web_fetch` with a focused `prompt`: flask.palletsprojects.com,
  fastapi.tiangolo.com, docs.djangoproject.com, django-rest-framework.org, expressjs.com, docs.nestjs.com.
- HTTP semantics and headers: developer.mozilla.org/en-US/docs/Web/HTTP/Status. Error messages: `web_search`
  the quoted message plus framework and version.
