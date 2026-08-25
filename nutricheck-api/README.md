# NutriCheck

AI nutrition tracker. Daily calories, protein and fiber.

- **[docs/PLAN.md](../docs/PLAN.md)** — product and architecture
- **[docs/USER-FLOWS.md](../docs/USER-FLOWS.md)** — every screen, route and failure path
- **[docs/BACKEND.md](../docs/BACKEND.md)** — backend technical design (this is what the code implements)

## Layout

```
apps/api/            NestJS service — HTTP (main.ts) and worker (worker.ts) entrypoints
packages/contracts/  Zod schemas — the wire contract, shared with the mobile app
packages/database/   Drizzle schema + migrations
docker/              Dockerfile (one image, three commands) and the local stack
```

Shared design docs and the mobile app are siblings of this directory, one level up.

## Auth

Email and password. No social providers in this build — the `auth_provider` enum
already carries `apple` and `google`, so adding them later is a new row rather than
a migration on a live enum.

| Route | Limit | Notes |
|---|---|---|
| `POST /v1/auth/register` | 5 / hour / IP | 409 on a duplicate email, decided by the unique index |
| `POST /v1/auth/login` | 10 / 15 min / IP | Same 401 for unknown account and wrong password |
| `POST /v1/auth/refresh` | 30 / min / IP | Rotates; replaying a used token revokes the whole family |
| `POST /v1/auth/logout` | — | Idempotent |
| `POST /v1/auth/change-password` | 5 / 15 min | Signs out every device |
| `GET /v1/me` | — | Requires a bearer token |

`JwtAuthGuard` is global and fail-closed: a new controller is authenticated unless
someone writes `@Public()`. Health endpoints carry that decorator — without it the
probes 401 and the pod never becomes ready.

There is **no password reset yet**, so a forgotten password is currently an
unrecoverable account. That needs a mail provider; see open item 9 in the design.

## Requirements

Node >= 22.11, npm >= 10, Docker.

## Run it

```bash
cp .env.example .env.local
npm install
npm run docker:up          # postgres + redis + migrate + api + worker
curl http://localhost:3000/health/ready
```

`docker:up` builds the image, applies migrations as a one-shot service, then starts
`api` and `worker`. Service ordering uses real health gates, not sleeps — the API
container will not start until `migrate` has exited successfully.

OpenAPI is at <http://localhost:3000/docs> outside production.

### Without Docker

Postgres 16 with `pgvector` and `pg_trgm` must already exist and the extensions must
be created (see [docker/initdb/01-extensions.sql](docker/initdb/01-extensions.sql)).

```bash
npm run build
npm run db:migrate
npm run dev -w @nutricheck/api
```

## Health endpoints

Three probes answering three different questions. Do not conflate them.

| Endpoint | Question | Failure means |
|---|---|---|
| `/health/live` | Is the process wedged? | Restart the container |
| `/health/ready` | Can it serve traffic now? | Stop routing to it — **do not restart** |
| `/health/startup` | Has it finished booting? | Keep waiting |

A liveness probe that checks the database restarts every replica during a database
blip, turning a degradation into an outage.

## Corpus

```bash
# the committed 13-food subset — no download, used by the tests
npm run ingest -w @nutricheck/ingest -- --fixture

# a real release, unzipped from https://fdc.nal.usda.gov/download-datasets.html
npm run ingest -w @nutricheck/ingest -- --dir /path/to/FoodData_Central_csv
```

The CLI takes a **local directory**, not a URL: FDC download filenames carry a
release date and change every few months, so a hardcoded URL is a 404 waiting to
happen.

Re-running is an upsert on `(source, source_id)`, so re-ingesting a reissued
release is safe. Nutrient columns are resolved by the stable `nutrient_nbr`
(203 / 208 / 291) rather than by the surrogate `id`, and the run prints what it
skipped — a silent skip must never look like a clean import.

## Tests

```bash
npm test                  # unit — fast, no Docker
npm run test:int          # Testcontainers: real Postgres + pgvector + pg_trgm
```

Integration tests spin up `pgvector/pgvector:pg16` and run the production
migrations against it. Not SQLite — the entire search subsystem is trigram and
vector operators SQLite does not have, so a mock would test nothing worth
testing. Not a shared CI database either: parallel jobs against one database
produce flakes that get papered over with retries.

## Migrations

```bash
npm run db:generate        # after editing packages/database/src/schema
npm run db:migrate         # apply
```

Migrations are reviewed like code and run as a **pre-deploy step**, never on
application boot — two replicas booting concurrently would race. The rules
(expand/contract, `CREATE INDEX CONCURRENTLY`, `lock_timeout`) are in
[docs/BACKEND.md §8.6](../docs/BACKEND.md).

## Mobile

The React Native app is a **sibling** of this directory (`../nutricheck`) with its own
git repo, and the workspace root ignores it. It is not an npm workspace of this
project — the two are versioned and released separately.

The shared wire contract is `@nutricheck/contracts`. Until the app consumes it from a
registry or a path dependency, treat this package as the source of truth and mirror
changes deliberately rather than hand-writing types on the client.

If the two are ever merged into one workspace, use **npm workspaces, not pnpm** —
Metro resolves modules by walking `node_modules` and has a long history of failing
against pnpm's symlinked store.

## Status

M0 in progress. Verified working end to end (`docker compose up` -> healthy):

- [x] npm workspaces + Turborepo, shared strict TypeScript config
- [x] `@nutricheck/contracts` — Zod wire contract; the resolver draft and log-commit
      invariants are schema refinements, so an inconsistent payload cannot serialize
- [x] `@nutricheck/database` — 18 tables, HNSW + trigram indexes, initial migration
- [x] NestJS service — config validation at boot, pino logging with redaction,
      RFC 9457 error envelope, helmet, URI versioning, three health probes
- [x] One image, three commands (api / worker / migrate), non-root, devDeps pruned
- [x] Local stack with real health gates and a compiled pre-deploy migrator
- [x] Auth — **email + password only**: Argon2id, 15-min access JWT, rotating
      refresh with family reuse detection, throttled endpoints, `GET /v1/me`
- [x] Corpus ingestion — USDA Foundation / SR / FNDDS CSV reader, fiber state
      assigned at ingest, idempotent on `(source, source_id)`
- [x] `/v1/foods/search` — trigram word-similarity with familiarity and generic
      boosts, default portion in the result row
- [x] Goals — Mifflin-St Jeor, activity factors, 20% adjustment cap, BMR floor,
      append-only rows resolved by `effective_from`
- [x] `POST /v1/logs` — nutrients recomputed server-side and frozen, idempotent
      on `clientId` under concurrency, batch drain, timezone-correct day view
- [x] Tests — 48 unit + 34 Testcontainers integration, all green
- [ ] Embeddings + RRF fusion (the second half of hybrid search)
- [ ] CI pipeline
- [ ] Recents / saved meals (the two-second repeat route)

Known gaps worth naming: the image is 488MB against a 400MB target (the OTel
packages and the Debian base dominate); search is trigram-only, so `food_embeddings`
and its HNSW index exist but hold no rows yet; and there is no password reset, which
makes a forgotten password an unrecoverable account.
