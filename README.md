# NutriCheck

AI nutrition tracker. Daily calories, protein and fiber.

## Layout

| Path | What it is |
|---|---|
| **[nutricheck-api/](nutricheck-api/)** | Backend — NestJS service, Postgres, Redis, Docker. Start here to run anything |
| [nutricheck/](nutricheck/) | React Native app. Own git repo, ignored by this one — see **[MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md)** |
| [docs/](docs/) | Product, flows and technical design — shared by both |
| [design/](design/) | Design canvas artboards |

## Handoff notes

Read these first in a fresh session — they carry the state and the traps that
are not obvious from the code:

- **[BACKEND.STATUS.md](BACKEND.STATUS.md)** — backend state, gotchas, open decisions
- **[MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md)** — mobile app state
- **[GAP-REPORT.STATUS.md](GAP-REPORT.STATUS.md)** — what the app expects vs. what the API
  serves, method by method. Read before writing the HTTP client

## Docs

- **[docs/PLAN.md](docs/PLAN.md)** — the product bet, the resolver architecture, cost model, roadmap
- **[docs/USER-FLOWS.md](docs/USER-FLOWS.md)** — every screen, route and failure path
- **[docs/BACKEND.md](docs/BACKEND.md)** — backend technical design; the API implements this

## Run the backend

```bash
cd nutricheck-api
cp .env.example .env.local
npm install
npm run docker:up
curl http://localhost:3000/health/ready
```

See [nutricheck-api/README.md](nutricheck-api/README.md) for everything else.
