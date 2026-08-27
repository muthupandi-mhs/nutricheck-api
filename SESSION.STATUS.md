# Session handoff — 2026-08-27

Written at the end of a long session so the next one can pick up mid-flight.
The durable facts live in [BACKEND.STATUS.md](BACKEND.STATUS.md),
[MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md), [docs/BACKEND.md](docs/BACKEND.md),
[docs/DEPLOY.md](docs/DEPLOY.md) and [docs/CI-CD.md](docs/CI-CD.md) — all of
them were reconciled with the code this session. This file is only what is
**in flight**.

---

## 1. Read this first: 22 commits are unpushed

Both repositories are committed and clean, and **neither has been pushed**.

```
nutricheck-api    (c:\Projects\New folder)          10 commits ahead of origin/staging
nutricheck-mobile (c:\Projects\New folder\nutricheck) 12 commits ahead of origin/staging
```

**Pushing the API runs a database migration against live staging.** The deploy
pipeline runs `migrate` on every push to `staging`, and `0005`/`0006` are in
this batch. They are verified — see §4 — but that is why nothing was pushed
without asking.

```bash
cd "c:\Projects\New folder"            && git push origin staging   # runs the migration
cd "c:\Projects\New folder\nutricheck" && git push origin staging
```

---

## 2. What changed this session

**The logging flow is AI-first.** `POST /v1/ai-meal` reads a whole spoken
sentence with one model call and searches no corpus at all. This is a
deliberate exception to the rule the rest of the system enforces — it is the
only place a model supplies nutrition — and the reasoning, plus what bounds it,
is [docs/BACKEND.md §7.7](docs/BACKEND.md). Read that before changing it.

Verified working end to end against the real OpenAI API:

```
"naa innaike rendu muttai and 5 dosai and chutney saapten"
   2 egg      egg       136 g   210.8 kcal  [high]
   5 dosai    dosai     300 g   525.0 kcal  [high]
   1 serving  chutney    30 g    30.0 kcal  [low]   ← portion assumed
   $0.000256 per meal
```

Also landed: FNDDS ingestion fixed (corpus **8,009 → 13,440 foods**), staging
deployed to Lightsail with HTTPS and a deploy-on-push pipeline, and a pass over
the app's onboarding copy and keyboard handling.

**Since that handoff was written**, four more commits, none of them touching the
migration or the deploy:

- **The client password minimum was still 10** while the server had moved to 6,
  left uncommitted mid-edit. The form refused passwords the API would have
  taken. Both numbers now read `PASSWORD_MIN`, in the message and the
  placeholder, and the test builds its expectation from the constant.
- **Insight calls now record to `ai_runs`** — §6.3 as was. Recorded off the
  note's own success path, so a failed write costs the dashboard a row and not
  the user a sentence. Four integration tests cover it.
- **An upstream API error logs the provider's message**, per §5.
- **`test/` is typechecked**, per §5.

---

## 3. Current environment state

| | |
|---|---|
| **App points at** | `local` — `BACKEND` in `nutricheck/src/config.ts`. Flip to `'staging'` when staging has the code |
| **Local stack** | Rebuilt and migrated. 13,440 foods. `/v1/ai-meal` works, real `AI_API_KEY` in `.env.local` |
| **Staging** | `https://3-6-120-121.sslip.io` — running an OLD commit. `AI_API_KEY` is **blank**, so `/v1/ai-meal` will 503 there until a key is set in `.env.staging` on the box |
| **Tests** | API 81 unit + 128 integration. Mobile 109. All green, all re-run since the last commit |

Staging box: `ssh -i "C:\Users\Admin\Documents\LightsailDefaultKey-ap-south-1.pem" ubuntu@3.6.120.121`

---

## 4. What was verified, and how

Do not re-verify these; do re-verify anything you change.

- **The migration, both ways.** Full `0000..0006` on an empty database, *and*
  `0005`+`0006` against a database already at `0004` — which is the state
  staging is in. The second is the one that matters: the migration drizzle-kit
  originally generated would have failed there.
- **`/v1/ai-meal` end to end** against the live OpenAI API, with rows landing
  `source: 'ai'`, every nutrient state `imputed`, and the cost recorded.
- **The password rule**, against the running API: 6 characters returns 201,
  5 returns 422.

---

## 5. Traps found this session — all cost real time

- **`.positive()` in a Zod schema is a 400 from OpenAI.** `zod-to-json-schema`
  renders it draft-4 style as `{ minimum: 0, exclusiveMinimum: true }`;
  structured outputs wants draft 2020-12 where that key is a number, and it
  rejects the whole schema rather than ignoring the keyword. `tighten()` in
  `openai-compatible.service.ts` normalises it now. The symptom was
  `upstream error 400` with no provider message — **fixed**: the message, code,
  param and type are logged, so the next one of these is readable.
- **`migrations/meta/0004_snapshot.json` is missing**, so drizzle-kit diffed
  from `0003` and re-emitted every carbs/fat column `0004_macros.sql` already
  added. `0005` is hand-written for that reason. Self-healing from here
  (`0005_snapshot.json` exists), but check generated SQL before trusting it.
- **`apps/api/tsconfig.json` includes only `src/**`**, so `test/` was never
  typechecked. That is how a broken `FakeAi` stub reached CI. The mobile
  tsconfig *does* cover `__tests__`, which is why the same class of break
  surfaced instantly there. **Fixed**: `apps/api/tsconfig.test.json` covers
  `test/` and runs as the second half of `npm run typecheck`; the build config
  is untouched. Confirmed by planting a type error in a test and watching it
  fail.
- **Two tests expired.** They asserted a goal on a hardcoded `2026-08-26` while
  `upsertProfile` derives one effective *today* — passing the day they were
  written and failing every day after. Fixed by backdating the goal.
- **Edge-to-edge broke `adjustResize`.** RN 0.81+ on Android 15: the window no
  longer resizes, so `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`
  left footers behind the keyboard. See `src/components/KeyboardAvoid.tsx`.

---

## 6. Open, in rough priority order

1. **Push, then set `AI_API_KEY` on staging.** Until both happen, the app on
   staging bounces every meal to Search.
2. **`/v1/ai-meal` prompt quality.** Real output: names come back lowercase
   (`dosai`, not `Dosai, plain`), the summary is a translation rather than the
   energy figure the prompt asks for, and coconut chutney came back at
   100 kcal/100 g against a real ~190. Prompt tuning, not code.
3. **`identify()` + `ai_food_matches` are built and unreachable.** The safe half
   of the corpus problem: the model proposes English names, the corpus decides,
   and a confirmed mapping becomes an alias so a name costs one call once, ever.
4. **~100 Tamil produce aliases.** 25 of 7,928 USDA rows carry one. Zero risk —
   no invented numbers, USDA's measured values — and it is what would let the
   corpus path work at all for Tamil.
5. **`I forgot my password` is a dead link** in a newly prominent position.
   There is no reset endpoint; a forgotten password is an unrecoverable account.
6. **eslint has never run.** The script exists in `apps/api`; the tool is in no
   `devDependencies` anywhere.
7. **Tests are not in CI**, deliberately — see docs/CI-CD.md. Nothing stops a
   failing commit reaching staging, so run them locally before pushing:
   `npm run typecheck && npm test && npm run test:int`.

---

## 7. Two contradictions left standing on purpose

Both are decisions for a person, not something to be quietly settled:

- **`.env.example` and `docs/PLAN.md` §3 record `anthropic`** as the provider.
  What runs is `openai-compatible` on `gpt-4o-mini`. Which one is the mistake
  has never been decided.
- **The password minimum is 6**, below the 8 that NIST SP 800-63B sets and that
  the comment beside the rule still cites. The deviation is written down next to
  it rather than hidden. Server and client now agree on the number — what has
  not been decided is whether 6 is the right number.
