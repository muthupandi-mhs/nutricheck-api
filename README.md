# NutriCheck

AI nutrition tracker. Daily calories, protein and fiber.

## Layout

| Path | What it is |
|---|---|
| **[nutricheck-api/](nutricheck-api/)** | Backend — NestJS service, Postgres, Redis, Docker. Start here to run anything |
| [nutricheck/](nutricheck/) | React Native app. Own git repo, ignored by this one |
| [docs/](docs/) | Product, flows and technical design — shared by both |
| [design/](design/) | Design canvas artboards |

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
