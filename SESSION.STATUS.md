# Session handoff — 2026-08-28 (afternoon)

Written at the end of a session so the next one can pick up mid-flight. The
durable facts live in [BACKEND.STATUS.md](BACKEND.STATUS.md),
[MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md), [docs/BACKEND.md](docs/BACKEND.md),
[docs/DEPLOY.md](docs/DEPLOY.md) and [docs/CI-CD.md](docs/CI-CD.md). This file is
only what is **in flight**.

---

## 1. The 58 unpushed commits are gone — both repos are pushed and deployed

The previous handoff opened on 58 unpushed commits and a destructive migration.
That is settled. Verified by `git fetch` and by hitting the box, not assumed:

```
nutricheck-api    HEAD f444e85 == origin/staging   0 unpushed
nutricheck-mobile HEAD 7f9c349 == origin/staging   0 unpushed
```

**Staging is running it.** `https://3-6-120-121.sslip.io/health/ready` is 200,
and both new routes answer **401** rather than 404 — they exist and want a token:

- `GET /v1/ideas`
- `GET /v1/logs/month`

**The 0007 question was answered by pushing.** Migrations 0007 → 0010 have run
against staging. 0007 folds everyone on `activity_level = 'active'` into
`'moderate'` and 0008 does not put them back, so if any staging account had
picked `'active'`, that value — and therefore their calorie target — is now
`'moderate'` and the original is unrecoverable. **This was not verified from
here**; checking costs one query on the box:

```sql
SELECT activity_level, count(*) FROM user_profiles GROUP BY 1;
```

Nothing can be done if rows moved. It is worth knowing before somebody reports
their target changed on its own.

---

## 2. What was built this session

Two features, both shipped to staging.

### The Ideas tab — food suggestions from the profile and the day

A third tab between Today and Insights. `GET /v1/ideas` computes what is left of
the day from the same `LogsService.day()` the Today screen renders, hands the
model the profile and that gap, and returns 3–5 foods with reasons. Tapping one
opens the ordinary portion screen; nothing on that tab logs anything.

**This is the third place a model produces nutrition**, after `/v1/ai-meal` and
`/v1/me/goals/suggest`, and the only one that fires because a tab was opened
rather than because somebody asked a question. It was built that way on an
explicit decision — the alternative offered was ranking the existing 13,440-row
corpus with no model at all, and it was declined. §4 is what bounds it.

**The subject is the person, not the day.** The first version led with the
remaining targets and produced a gap-filling calculator: it answered "what
closes today's arithmetic", which nobody opens an app to ask, and on a day with
nothing logged it had no subject at all. `ideasToUserTurn` now puts the profile
and goal first and today's figures last, and the prompt says the day constrains
the answer rather than being it. Sections are weighted by reading order, so the
order is the instruction.

### The calendar — history behind Today's masthead

The search button on the left of Today is **gone**, replaced by a calendar that
opens a month grid. Every day is coloured by how close it landed to its calorie
target; tapping one sets `AppState.date` and returns to Today.

That state had existed all along with no control anywhere that could move it —
every day but today was unreachable from the UI. Search was not stranded: the
composer and four paths in the confirm sheet still reach it.

`GET /v1/logs/month` generalises the week aggregate rather than copying its SQL;
the `FILTER (WHERE state <> 'unknown')` handling is the subtle part and a second
copy is a copy that can drift.

**The colour means closeness, not completion**, and that is a deliberate
departure from the reference screenshot it was modelled on. Its legend grades
completion — `>66%` green, more is greener — which is right for a step counter
and wrong here: 3,000 kcal against a 2,000 target would come out bright green,
and the day somebody most overshot would look like their best. Both directions
now cost. `adherence.test.ts` asserts exactly that, so it cannot be "fixed" back
into a bug quietly.

### Also

**The "Add again" strip is off the Today screen** — the repeat tiles, the
`Again` component and the `AGAIN` constant are all removed. See §6.1: this was
asked for and done, and it has a cost worth reading before it is left that way.

---

## 3. Current environment state

| | |
|---|---|
| **App points at** | Decided by the build now, not by a constant — see commit 7f9c349 |
| **Local stack** | Docker: api, worker, postgres, redis all up. Rebuilt twice this session |
| **Local database** | **9 accounts**, including two disposable smoke accounts (§6.2). `ai_runs`: parse 32, rerank 23, meal 25, targets 24, insight 17, **ideas 5** |
| **Staging** | Current with `origin/staging`. Both new routes live |
| **API tests** | **116 unit** (10 suites) + 12 ingest. Green. Integration suite NOT run |
| **Mobile tests** | **139** (10 suites). Green. Typecheck clean |
| **eslint** | Now installed and runnable — this is new, it used to be in no `devDependencies`. `npx eslint src` gives **2 errors, 25 warnings** (§6.3) |

Staging box: `ssh -i "C:\Users\Admin\Documents\LightsailDefaultKey-ap-south-1.pem" ubuntu@3.6.120.121`

**The mobile working tree is dirty and not all of it is from this session.** A
second writer was active in `nutricheck/` throughout — `src/screens/voice/`
(ListenScreen, MealScreen, TypeScreen, AskSheet, listening.ts) appeared and grew,
`RootNavigator` gained a `Type` route, and `adherence.ts` gained a `BAND_RANGE`
export after this session wrote it. Everything below typechecks and passes
together, but do not assume the uncommitted diff is one person's work.

---

## 4. What stops the ideas model, since nobody asked it a question

Four things, in the order they run, and none of them is the model:

1. **The gap is computed here.** The model is handed "480 kcal left, 52 g of
   protein left" and never the entries, so there is no arithmetic available for
   it to get wrong and this tab cannot disagree with Today about a total.
2. **Atwater check, and a failing item is DROPPED.** Stated calories against
   4 × protein + 4 × carbs + 9 × fat. A model that returns 250 kcal beside
   macros summing to 90 has not rounded — one of the two is invented and there
   is no way to tell which, so the item is refused rather than corrected.
   Correcting would mean choosing which half to believe. **This is the check
   `/v1/ai-meal` does not have**, and this path needs it precisely because
   nobody asked for these numbers.
3. **Rates, not totals.** The model returns per-100g values and a gram weight;
   every figure the user reads is a product computed in `scaleIdea`.
4. **Rows are `source: 'ai'`**, owned by the person who opened the tab, every
   nutrient state `imputed` — so the app renders a `~` and nobody else's search
   sees them.

The Atwater tolerance is 25% and that width is load-bearing: fibre sits inside
carbohydrate but yields ~2 kcal/g rather than 4, so a correct answer about dal
or chana overshoots the flat sum. A tighter bound would refuse exactly the foods
this tab should be suggesting. There is a test for that case.

**Verified live, not reasoned about.** A 72 kg active profile losing 0.5 kg/week
returned four ideas, each reason tied to the goal — "a lean source of protein
that supports muscle retention while you lose weight", "energy for your active
lifestyle". `ai_runs` recorded it at $0.000439 and 5.3 s; the second request
served from cache with no model call; nothing was dropped by either check.

---

## 5. Traps found this session

- **A swallowed error becomes a confident lie.** `getFoodIdeas` first returned
  an empty list on any failure, copying `getMealInsight`. A 404 from a server
  that had not been restarted then reached the device as "suggestions need a
  model, and one was not reachable" — a sentence the app had no evidence for,
  naming a cause that was not the cause, on a screen with no way to tell. The
  rule that distinguishes them: **swallow only when the screen still has its
  content without the call.** A meal card keeps every number when it loses its
  note; the ideas response IS its screen. `IdeasScreen` now classifies the
  failure — offline, quota, no profile, unknown — and `unknown` says plainly
  that it cannot tell, which beats guessing.
- **The local API runs from Docker, not from `nest start --watch`.** Code
  changes do nothing until `npm run docker:up` (which rebuilds). Two features
  looked broken on the device for exactly this reason. Check for 404 vs 401
  before debugging anything else: 404 means the container predates the route.
- **A tab index is positional.** Inserting Ideas between Today and Insights
  moved Insights from index 1 to 2 and broke `tabBar.test.tsx`, which is the
  test doing its job.
- **`lastOfMonth` via day 0 of the next month** gets February and leap years
  right for free, with no table of month lengths. Verified live against the
  route: 31 / 30 / 28 / 29 (2028) / 31 / 31.
- **Months before the first goal return `goal.kcal` of 0.** Easy to hit by
  paging back. Those days are left uncoloured and the footer says "no target was
  set then" rather than "measured against a target of 0 kcal", which would be
  both nonsense and an accusation.
- **`psql -U postgres` is wrong for this stack.** The role is `nutricheck`.
- **Postgres takes a moment after `docker:up`.** "the database system is
  starting up" is not a failure; poll rather than concluding.

---

## 6. Open, in rough priority order

1. **Decide whether the repeat strip stays gone.** It was removed from Today on
   request. `SuggestionsService` calls it "the retention feature and the margin
   — once the frequent-and-recent list is good, the majority of logs stop
   costing an AI call at all". With it gone **every log goes through a model
   call**: a repeat that took two seconds and cost nothing now takes a sentence
   and a billed request. If it was in the way visually rather than unwanted,
   moving it below the day's ledger keeps the cheap path. Restoring it is JSX
   only — the plumbing is untouched.
2. **Two disposable accounts in the local database.**
   `ideas-smoke-…@example.com` and `cal-smoke-…@example.com`, created to verify
   the routes end to end. Harmless, and mine to have made; delete them whenever.
3. **eslint runs now, and finds 2 errors.** `countItems` unused in
   `ComposerScreen`, `Button` unused in `SearchScreen` — both in the other
   writer's in-flight files, so they were left alone rather than risk a
   conflict. 25 warnings, almost all `no-void`. The repo is still not
   prettier-formatted; running it rewrites whole files.
4. **`AppState` still fetches recents that nothing reads.** Three `getRecents()`
   calls remain after the strip came off Today. Wasted work on every refresh.
   Left in place because removing store plumbing is a separate decision and the
   other writer may be building against it.
5. **`RecentCard.tsx` is orphaned** — nothing imports it, and it was already
   unreferenced before the strip was removed.
6. **The ideas prompt runs on `gpt-4o-mini` and it shows.** Reasons are
   serviceable but generic: "a good source of protein and probiotics". A
   stronger model would sharpen them. Watch also for it reaching for elaborate
   dishes, whose numbers it would be inventing rather than recalling.
7. **The API integration suite has not run** this session. It is the natural net
   for `/v1/ideas` and `/v1/logs/month`, neither of which has an integration
   test — only unit tests over their arithmetic.
8. **`/v1/ai-meal` prompt quality.** Unchanged and still open: the summary
   restates the sentence rather than giving the energy figure, and coconut
   chutney came back at 100 kcal/100 g against a real ~190.
9. **The targets prompt still needs watching** — the fourteen-calorie
   near-miss failure mode.
10. **`identify()` + `ai_food_matches` are built and unreachable.**
11. **~100 Tamil produce aliases.** 25 of 7,928 USDA rows carry one.
12. **"I forgot my password" is still inert.** The TODO is at
    `AuthPasswordScreen.tsx:75`; there is no reset endpoint, so a forgotten
    password is an unrecoverable account.
13. **The legal links are unverified.** `src/lib/legal.ts` points at
    `nutricheck.app/privacy` and `/terms`; nothing is published there.
14. **Tests are not in CI**, deliberately — see docs/CI-CD.md.

---

## 7. Decisions taken this session that were previously open

Recorded because each one settles or reverses something written down.

- **Both repos were pushed**, taking the 0007 data loss on staging rather than
  squashing the migrations. §1 has the query that says what it cost.
- **A model authors food suggestions AND their nutrition.** Offered a
  corpus-only ranking with no model, no cost and every number measured, and the
  model path was chosen instead. §4 is how that was bounded rather than
  abandoned — the Atwater check exists only because of this decision.
- **Suggestions are about the person, not the day's arithmetic.** The first
  build was a gap-filling calculator and was rewritten. §2.
- **Calendar colour grades closeness, not completion**, departing from the
  reference the feature was modelled on. §2.
- **Search left Today's masthead** in favour of the calendar, reversing the
  comment that put it there. It is still reachable from the composer and the
  confirm sheet, which is where people are when they want it.
- **The food image tile on idea cards is a circle**, matching the buttons, while
  every other food row keeps the rounded square. `FoodGlyph` took a `shape` prop
  rather than changing app-wide. The same food therefore renders two ways
  depending on the screen — accepted deliberately; the default flips it back.
- **`/v1/ideas` is the one AI route without `QuotaGuard`**, and that is not an
  omission. The guard runs before the handler and therefore before the cache, so
  an exhausted user would be refused a list they had already been shown and
  already paid for. The service checks the same quota itself, after the cache
  lookup and before the call.
