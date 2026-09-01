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
| Routes | **33** under `/v1`, plus 3 health probes (the old "31" was a miscount) |
| Tests | **202 green** — 78 unit (66 api + 12 ingest) and 124 Testcontainers integration, all re-run after the macro change |
| Migrations | 5 applied (`0000`–`0004`) — `0004` adds carbohydrate and fat |
| Corpus | **8,009 foods** (7,928 USDA + 81 curated), 540 aliases, 8 locales. **Carbs and fat on 100%**, fibre on 92% |
| Live AI | Verified against OpenAI. **$0.000385/resolve**, ~2.2 s |
| Image | One OCI image, three commands (api / worker / migrate), non-root, 488 MB |

### Built

- Workspace (npm + Turborepo), Docker stack, migrations as a pre-deploy step
- Config validated at boot, pino logging with redaction, RFC 9457 errors, 3 health probes
- **Auth** — email + password only. Argon2id, 15-min access JWT, rotating refresh with
  family reuse detection, throttled
- **Corpus** — **13,440 foods**: 7,793 USDA SR Legacy, 5,431 FNDDS, 135
  Foundation, 81 curated Indian dishes. 36,768 portions, 540 aliases, 26 MB.
  FNDDS was silently ingesting zero of 5,432 until 2026-08-26 — FDC references
  nutrients by surrogate id in SR Legacy and by legacy nutrient_nbr in FNDDS,
  and the mismatch reported as "no macros" rather than as an error
- **Goals** — Mifflin–St Jeor, append-only with `effective_from`. Targets for all
  five: calories, protein, carbs, fat, fibre. Fat is 25% of calories and carbs
  take the remainder — that split is POLICY, not derivation, so the share used is
  stored on every goal's `basis.fatPctOfKcal` and an old target can still explain
  itself after the default moves
- **Transcription** — `POST /v1/transcribe`, Gemini, the only route that takes
  audio. Returns text, not a draft. A separate provider abstraction from the
  resolver's on purpose: different vendor, different billing unit, different
  failure modes, and the resolver keeps working when this is not configured
- **Logs** — commit with server-side arithmetic frozen at write, idempotent on
  `clientId`, batch drain, edit, timezone-correct day view, **per-item portion
  edit that learns the unit**, **week summary with averages and streak**
- **Phrases** — the sentence behind an entry is recorded in the commit
  transaction and served back for the composer's "say it again"; saving a meal
  from an entry promotes its phrase
- **Saved meals + repeat strip** — the two-second route
- **The resolver** — portion prefill → parse → one batched candidate search →
  constrained re-rank → arithmetic → SSE draft. Phrase cache, `ai_runs` cost
  accounting, miss log, circuit breaker, quota + spend ceiling
- **Pluggable AI provider** — Anthropic or any OpenAI-compatible host. What
  actually runs is `openai-compatible` on `gpt-4o-mini`; `.env.example` and
  PLAN.md §3 still record `anthropic`, and that contradiction is unresolved
- **The corpus-free path** — `POST /v1/ai-meal`. Reads a whole spoken sentence
  and returns foods with nutrition, searching nothing. The one place a model
  supplies numbers, and the deliberate exception to the rule everywhere else:
  rates not totals, rows written `source: 'ai'` and owned by the speaker, every
  nutrient state `imputed`. $0.000256 a meal. docs/BACKEND.md §7.7
- **Post-meal insight** — `GET /v1/insights/meal`. Facts from Postgres, prose
  from the model, no numeric field for it to invent one in
- **Staging** — 4 GB Lightsail, HTTPS via Caddy, deploys on push to `staging`.
  docs/DEPLOY.md and docs/CI-CD.md
- **Tamil / Tanglish / Hindi / Bengali / Gujarati** search
- **Weight history** — `GET`/`POST` `/v1/me/weight`, `DELETE /v1/me/weight/:date`.
  `weight_logs` is the history, `user_profiles.weight_kg` stays the CURRENT
  weight, and the two are written in step at both doors — logging the newest
  reading updates the profile and recomputes the goal in one transaction.
  Least-squares trend over the window, never last-minus-first
- **Fasting** — `GET`/`POST` `/v1/me/fasting`, `PATCH .../current`,
  `POST .../current/end`, `DELETE /v1/me/fasting/:id`. Declared sessions with a
  start, an end and a target; **never inferred from the food log**, and never
  closed by the server. At most one open fast per user, enforced by a partial
  unique index rather than a check-then-insert. The plan IS its `target_hours`
  — no enum, no preference row: the start control opens on the last one used.
  A running fast's length is null on the wire, because the device's clock is
  the only one that is right continuously

### Not built

| Gap | Why it matters |
|---|---|
| **Eval harness** | The highest-value missing thing. Without it "the model picked the wrong chicken" is an anecdote, not a number |
| **Tests in CI** | The pipeline deploys but runs no tests — a deliberate call, recorded in docs/CI-CD.md. Nothing stops a commit that fails `npm test` from reaching staging; the readiness probe catches a stack that will not boot, not one that boots and is wrong |
| **`identify()` + `ai_food_matches`** | Built and unreachable. Translating an unmatched Tamil name into English search terms is the safe half of the corpus problem — the model proposes names, the corpus decides, and a confirmed mapping becomes an alias so the name costs one call once, ever |
| **Insight cost accounting** | `/v1/insights/meal` calls the model and records nothing, so its spend is invisible and never reaches `RESOLVE_USER_DAILY_SPEND_USD`. The `ai_step` enum already has the value; wiring `recordCall` is a one-liner |
| **eslint** | `npm run lint` exists in apps/api and eslint is in no devDependencies anywhere, so it has never once run |
| **Tamil aliases** | 25 of 7,928 USDA rows carry one. That number is the entire reason `/v1/ai-meal` exists, and ~100 hand-written aliases would fix the common cases with no model involved and no invented numbers |
| Embeddings + RRF | Search is trigram-only. `food_embeddings` exists and is empty |
| ~~Weight tracking (M3)~~ | **Built.** Weight history, trend and the report screen; fasting sits beside it as a separate module that derives nothing from the log. See §1 |
| Password reset | Email+password with no recovery = a forgotten password is a lost account |
| ~~Server-side transcription~~ | **Built 2026-08-26.** Reversed the deferral: on-device dictation could not carry Tamil or Tanglish, so `POST /v1/transcribe` now exists. See §5 |

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
npm run ingest -w @nutricheck/ingest -- --download   # ~7,900 USDA ingredients, pinned + checksummed
npm run ingest -w @nutricheck/ingest -- --fixture    # 13-row test fixture only
npm run ingest -w @nutricheck/ingest -- --curated    # 81 Indian dishes + aliases
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

**Search returns nothing rather than something wrong.** MIN_SCORE (0.95) is a
floor on the blended similarity. Without it, "maggi" answered with SMUCKERS MAGIC
SHELL at 609 kcal and "murukku" with drumstick pods at 37 -- confident, plausible,
wrong. A miss is recoverable (search box, custom food, miss log); a wrong frozen
number discovered a week later is not. If a real food starts missing, curate it or
lower the floor deliberately -- do not assume the floor is the bug.

**Ranking that works at 13 rows can break at 8,000.** `word_similarity` returns
1.000 for every row containing the query, so "mango" tied "Mangos, raw" with
"Babyfood, fruit dessert, mango with tapioca". The fix was blending in whole-string
`similarity()`. Re-check ranking after any corpus growth — the test fixture is too
small to reveal this class of problem.

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

**Carbs, fat and fibre each have three states.** `known`, `imputed` (shown with a
`~`), `unknown` (excluded from that nutrient's denominator). Never coalesce
`null` to `0`. Curated dishes are `imputed` across all three, because their
values are estimates.

Each carries its OWN state and its own unmeasured count — the item missing fibre
is usually not the item missing carbs, and one shared counter could not say which
total to distrust. Measured against the corpus this is not symmetric: SR Legacy
reports carbs and fat for **100%** of its 7,793 rows and fibre for **92.8%**, so
in practice only fibre is often genuinely absent.

`kcal` and `proteinG` are never null. Both are reported for every row and both
are goal-bearing, so a missing one is a corpus bug rather than a state to render.

**Curated carbohydrate is DERIVED, never authored.** Each dish supplies one fat
estimate; carbs are `kcal − 4×protein − 9×fat`, clamped at zero. That is exactly
how USDA defines nutrient 1005, "Carbohydrate, by difference", so the 81 curated
rows are computed the same way the 7,793 beside them were. A dish with no fat
estimate gets `unknown` for both rather than a guess.

**Nutrients are frozen at commit.** History is served verbatim. A USDA reissue must
not rewrite a Tuesday in March. There is a test that mutates the corpus and asserts
the entry is unchanged.

**Voice IS a backend feature now — this reversed.** It used to read: *the device
transcribes, the backend receives text with `source: 'voice'` as a label, and
`/v1/resolve` returns 415 for audio; that is the design, not a gap.*

Android's offline models could not carry the language this app is actually
spoken in. `en-IN` renders Tanglish phonetically at best, and `ta-IN` needs a
language pack most phones do not have and no API can even ask about — both
failed silently, in different ways, on the one input the product depends on.

So **`POST /v1/transcribe`** accepts audio and Gemini transcribes it. Two things
did NOT change, and both are load-bearing: `/v1/resolve` still returns **415**
for audio, and transcription returns **text, never a draft**. The user reads the
words before anything is resolved, and there is still one parse path rather than
three.

---

## 6. Open decisions — these need you, not a fresh session

| # | Question | Why it is blocked |
|---|---|---|
| 1 | **Deepen Tamil, or build recipe decomposition?** | Only 34 of 81 curated dishes are Tamil-reachable. Deepening is direct but every dish is a research task; recipe decomposition makes dishes derive from real USDA ingredient rows, needs full USDA first. **This was the live question when the last session ended** |
| 2 | Model choice for the re-rank | `gpt-4o-mini` picked battered-fried chicken over plain breast — correctly flagged low-confidence, but wrong. Unanswerable without the eval harness |
| 3 | Free-tier quota | Currently 50/day + $1/day spend ceiling, both guesses |
| 4 | Open Food Facts share-alike | Licence review never opened. A launch blocker if found late |
| 5 | Barcode scanning | Decides whether the app asks for camera permission at all |
| 6 | Sign in with Apple | **Google shipped** — `POST /v1/auth/google`, verified locally against Google's JWKS. That makes Apple mandatory before the first iOS submission (App Store 4.8); Android is unaffected |

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

## 8. What the mobile app expects — now wired

**The app talks to the API.** `httpApi` exists, `App.tsx` constructs it by
default, and every method on `NutriCheckApi` has a route behind it. Full detail
in [GAP-REPORT.STATUS.md](GAP-REPORT.STATUS.md); the backend-side summary:

**Built for the client, this pass:**

- `POST /v1/me/goals/preview` — targets without persisting, sharing `computeGoal`
  with the path that does persist
- `PATCH /v1/logs/:id/items/:itemId` — one portion, refrozen, and **the personal
  unit is learned**. The wholesale `PATCH /v1/logs/:id` discarded that signal
- `GET /v1/logs/week?date=&tz=` — seven days, averages over logged days only,
  an uncapped streak
- `GET /v1/suggestions/phrases` plus the write side inside the commit
  transaction. `user_phrases` had been written by nothing and would have
  answered empty forever

**Fixed earlier in the same pass:**

- **A throttled auth request reached the user as a heading reading "Throttler".**
  `ProblemThrottlerGuard` now returns a real `rate-limited` problem with the
  contract's `resetAt`.
- **`onboarded` could be true with no targets.** The profile and its goal are one
  transaction now, and `isOnboarded` requires both rows.

**Still true and worth knowing:**

| Item | Note |
|---|---|
| Throttler storage is in-memory | [docs/BACKEND.md §12](docs/BACKEND.md) specifies Redis. Per-pod counters mean the login limit multiplies by the replica count. Needs `@nest-lab/throttler-storage-redis`, not installed |
| Password reset | Still nothing server-side; `SignInScreen` has an empty `onPress`. Building it means picking an email transport |
| Problem `type` is a URI on the wire | Unchanged and correct. The client strips `PROBLEM_BASE_URI` in its transport — that is the app's job, not the server's |
| The running container is stale | Docker Hub was unreachable when this was written, so `nutricheck-api-1` still serves the pre-change image. Rebuild before trusting port 3000 |

## 9. If you only do one thing

**Commit the logs module.** The root `.gitignore` had an unanchored `logs/`
pattern, which git matches at any depth — so `apps/api/src/modules/logs/` had
**never been committed**. That directory owns commit, the day view, the batch
drain and both new routes; a fresh clone would not have built. The pattern is
fixed (`/logs/`), the files are visible to git, and they are still untracked.

Then build the **eval harness** ([docs/BACKEND.md §15.4](docs/BACKEND.md)). Now
that the app talks to the API, this is the largest remaining unknown: it is the
only way to answer whether the current model is good enough, and it gates every
prompt edit from then on. Everything else — more dishes, embeddings, a bigger
model — is guesswork until it exists.

Third: **CI**. There are 189 backend tests and 102 app tests, and no automation.
