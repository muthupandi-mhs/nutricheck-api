# NutriCheck backend — status

**Updated:** 2026-08-26 · **Code:** [nutricheck-api/](nutricheck-api/) · **Design:** [docs/BACKEND.md](docs/BACKEND.md)

Handoff note for a fresh session. Read this, then [nutricheck-api/README.md](nutricheck-api/README.md)
for how to run it and [docs/BACKEND.md](docs/BACKEND.md) for why it is shaped this way.

---

## 1. Where things stand

**M0 and M1 are complete. The resolver (M2) is built and has been exercised against
a live model.** The API is fully usable with zero AI, and the AI route works on top
of that rather than instead of it.

| | |
|---|---|
| Routes | 31, versioned under `/v1` |
| Tests | **156 green** — 60 unit, 96 Testcontainers integration |
| Migrations | 4 applied (`0000`–`0003`) |
| Corpus | **~8,000 foods** (7,929 USDA + 79 curated), 522 aliases, 8 locales |
| Live AI | Verified against OpenAI. **$0.000385/resolve**, ~2.2 s |
| Image | One OCI image, three commands (api / worker / migrate), non-root, 488 MB |

### Built

- Workspace (npm + Turborepo), Docker stack, migrations as a pre-deploy step
- Config validated at boot, pino logging with redaction, RFC 9457 errors, 3 health probes
- **Auth** — email + password only. Argon2id, 15-min access JWT, rotating refresh with
  family reuse detection, throttled
- **Corpus** — full USDA Foundation + SR Legacy ingested (~7,900 ingredient rows),
  curated Indian dishes, Tamil aliases attached to USDA rows, trigram search, custom foods
- **Goals** — Mifflin–St Jeor, append-only with `effective_from`
- **Logs** — commit with server-side arithmetic frozen at write, idempotent on
  `clientId`, batch drain, edit, timezone-correct day view
- **Saved meals + repeat strip** — the two-second route
- **The resolver** — portion prefill → parse → one batched candidate search →
  constrained re-rank → arithmetic → SSE draft. Phrase cache, `ai_runs` cost
  accounting, miss log, circuit breaker, quota + spend ceiling
- **Pluggable AI provider** — Anthropic or any OpenAI-compatible host
- **Tamil / Tanglish / Hindi / Bengali / Gujarati** search

### Not built

| Gap | Why it matters |
|---|---|
| **Eval harness** | The highest-value missing thing. Without it "the model picked the wrong chicken" is an anecdote, not a number |
| **CI pipeline** | 156 tests that only run when someone remembers. A remote exists (`muthupandi-mhs/nutricheck-api`); nothing has ever gone through a pipeline |
| Embeddings + RRF | Search is trigram-only. `food_embeddings` exists and is empty |
| Insights / weight (M3) | Not started |
| Password reset | Email+password with no recovery = a forgotten password is a lost account |
| Server-side transcription | Backend does no speech recognition — by design, see §5 |

---

## 2. Run it

```bash
cd nutricheck-api
cp .env.example .env.local          # put the AI key in .env.local, never .env.example
npm install
npm run docker:up
curl localhost:3000/health/ready
```

Then seed a corpus — without this, search returns nothing:

```bash
npm run ingest -w @nutricheck/ingest -- --dir <unzipped USDA csv dir>   # ~7,900 ingredients
npm run ingest -w @nutricheck/ingest -- --fixture    # 13-row test fixture only
npm run ingest -w @nutricheck/ingest -- --curated    # 79 Indian dishes + aliases
```

```bash
npm test                # unit, fast, no Docker
npm run test:int        # Testcontainers: real Postgres + pgvector
```

**The AI key lives in `nutricheck-api/.env.local`** (gitignored). Compose layers it
over the committed `.env.example`, so it wins. Currently configured for OpenAI:

```
AI_PROVIDER=openai-compatible
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-proj-...
```

Switch to Anthropic by setting `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.
Without any key the API boots fine and only `/v1/resolve` returns 503 — every
other route works.

---

## 3. Things that will bite you

Each of these cost real time to find. They are in the code as comments too, but
they are the kind of thing a fresh session re-discovers the hard way.

**`npm install` after moving anything.** npm creates the workspace links in
`node_modules/@nutricheck/*` as Windows junctions with absolute paths. They do not
survive a directory move, and every `@nutricheck/*` import then fails to resolve.

**Never write source files with bash heredocs containing regexes.** A heredoc ate
the backslashes in `[^a-z\s]`, turning it into `[^a-zs]` — splitting words on the
letter "s". Another wrote three NUL bytes into a template literal in place of
spaces. Use the Write/Edit tools for anything with escapes.

**Drizzle's `sql` template expands a JS array into a parameter *list***, not a
single array parameter, so `unnest($1::text[])` fails as "malformed array literal".
Bind the array as one JSON parameter and use `json_array_elements_text`.

**Drizzle's raw `.execute()` bypasses its result mapper**, so `timestamptz` arrives
as a **string**, not a `Date`. Coerce at the boundary.

**Throwing inside a Drizzle transaction rolls back everything in it** — including
work you did before the throw. This silently defeated refresh-token reuse
detection: the revoke ran, then the throw undid it. Return an outcome from the
transaction and act on it outside.

**`z.coerce.boolean()` is wrong for env vars.** `Boolean("false") === true`, so
every flag written that way is permanently on. Use an explicit enum + transform.

**The phrase cache key must carry `RESOLVER_VERSION`.** It already carries the
prompt version (a content hash, so it cannot be forgotten) and the model — but a
code change to resolution logic is invisible for the 24-hour TTL unless you bump
`RESOLVER_VERSION` in `draft-store.service.ts`. This has already caught someone out.

**Prompt caching has a floor.** Claude Opus 5 will not cache a prefix under 512
tokens, silently. The re-rank prompt was ~444 tokens and would have been re-billed
at full price forever. `packages/prompts` exports `approximateTokens` — check it
after editing a prompt.

---

## 4. Decisions already made

Full reasoning in [docs/BACKEND.md §3](docs/BACKEND.md). The short version:

| Decision | Instead of | Because |
|---|---|---|
| NestJS + Fastify adapter | bare Fastify | Real module boundaries; adapter keeps the throughput |
| Drizzle | Prisma | Prisma models `vector` as `Unsupported`, which kills the type safety it exists for |
| In-repo `createZodDto` | `nestjs-zod` | One less version matrix; errors map straight onto the RFC 9457 envelope |
| One image, three commands | per-role images | One SBOM, one scan, one digest promoted |
| `AiService` abstract class | direct SDK use | Pipeline testable without a network — and it made the provider swap nearly free |
| Curated dish table | tuning search harder | USDA has essentially nothing Indian; no ranking change finds `dosai` |

---

## 5. Things worth knowing that are easy to get wrong

**A draft is not a log.** `POST /v1/resolve` writes nothing. `POST /v1/logs` commits.
That is what makes "never auto-commit a parse" a property of the API rather than
client discipline, and it is what lets an offline queue replay without re-invoking
the model.

**The model never emits a nutrient value.** There is no field in the parse schema in
which it could. The re-rank schema is a per-request Zod enum of the ids Postgres
just returned, so an invented food is *unrepresentable*, not merely discouraged.
`AI_STRICT_SCHEMA=false` gives that guarantee up — it is opt-out for a reason.

**Fiber has three states.** `known`, `imputed` (shown with a `~`), `unknown`
(excluded from the day's denominator). Never coalesce `null` to `0`. Curated dishes
are `imputed` because their values are estimates.

**Nutrients are frozen at commit.** History is served verbatim. A USDA reissue must
not rewrite a Tuesday in March. There is a test that mutates the corpus and asserts
the entry is unchanged.

**Voice is not a backend feature.** The device transcribes; the backend receives
text with `source: 'voice'` as a label. `/v1/resolve` returns **415** for audio.
That is the design, not a gap.

---

## 6. Open decisions — these need you, not a fresh session

| # | Question | Why it is blocked |
|---|---|---|
| 1 | **Deepen Tamil, or build recipe decomposition?** | Only 34 of 79 curated dishes are Tamil-reachable. Deepening is direct but every dish is a research task; recipe decomposition makes dishes derive from real USDA ingredient rows, needs full USDA first. **This was the live question when the last session ended** |
| 2 | Model choice for the re-rank | `gpt-4o-mini` picked battered-fried chicken over plain breast — correctly flagged low-confidence, but wrong. Unanswerable without the eval harness |
| 3 | Free-tier quota | Currently 50/day + $1/day spend ceiling, both guesses |
| 4 | Open Food Facts share-alike | Licence review never opened. A launch blocker if found late |
| 5 | Barcode scanning | Decides whether the app asks for camera permission at all |
| 6 | Social login | Email+password only. Apple is mandatory on iOS once any social login exists |

**Language scope is settled: Tamil and English.** Hindi/Bengali/Gujarati rows exist
and should NOT be deleted — they cost nothing and much of that food (chapati, dal,
biryani, samosa, chai) is everyday eating in Tamil Nadu. No further investment there.

---

## 7. Honest gaps in what exists

Not bugs — things that are true and should not be discovered by surprise.

- **Curated nutrition values are estimates.** Fiber signals this via `imputed`;
  **kcal and protein carry no such marker**, so a curated dish's calories look
  exactly as authoritative as a measured USDA row. That is the biggest honesty gap
  in the corpus.
- **79 *dishes* is a seed** (ingredients are covered by USDA). PLAN §5 reckons ~200 well-chosen dishes
  covers a startling share of logs. `match_misses` records the exact words of every
  failed lookup — that is the curation queue, and it is already filling.
- **`effort` is not wired.** The SDK on npm has no parameter for it, so both model
  calls run at the default rather than the design's medium/low.
- **Cache hit ratio reads zero on OpenAI.** Its automatic caching needs a ≥1024-token
  prefix. Expected, not a silent invalidator — but the §16.2 alarm needs a
  per-provider threshold or it will cry wolf.
- **The image is 488 MB against a 400 MB target.** OTel packages and the Debian base.
- **Integration tests take ~50 s** (container start dominates).

---

## 8. If you only do one thing

Build the **eval harness** ([docs/BACKEND.md §15.4](docs/BACKEND.md)). It is the only
way to answer whether the current model is good enough, and it gates every prompt
edit from then on. Everything else — more dishes, embeddings, a bigger model — is
guesswork until it exists.

Second: **CI**. There are 156 tests and no automation.
