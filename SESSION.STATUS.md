# Session handoff — 2026-08-28

Written at the end of a long session so the next one can pick up mid-flight.
The durable facts live in [BACKEND.STATUS.md](BACKEND.STATUS.md),
[MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md), [docs/BACKEND.md](docs/BACKEND.md),
[docs/DEPLOY.md](docs/DEPLOY.md) and [docs/CI-CD.md](docs/CI-CD.md). This file is
only what is **in flight**.

---

## 1. Read this first: 58 commits unpushed, and one of them is destructive

```
nutricheck-api    (c:\Projects\New folder)           8 commits ahead of origin/staging
nutricheck-mobile (c:\Projects\New folder\nutricheck) 50 commits ahead of origin/staging
```

**Pushing the API runs migrations 0007, 0008 and 0009 against live staging, and
0007 loses data.** It rewrites the `activity_level` type to drop `'active'`,
folding everyone on that level into `'moderate'` — Postgres has no DROP VALUE,
so the type has to be rebuilt and the rows moved. 0008 then puts `'active'`
back and adds `'athlete'`, but **it does not put those rows back**. That
information is gone.

On this machine that cost ten rows of test data. On staging it would silently
change the activity level, and therefore the calorie target, of anybody who had
picked `'active'`.

Two ways out, and it is a decision for a person:

- **Squash them.** 0007 and 0008 undo each other; the net change is "add
  `'athlete'`". A single hand-written migration that only does `ALTER TYPE …
  ADD VALUE 'athlete'` reaches the same schema and touches no rows. The
  snapshots and journal entries have to be rebuilt to match.
- **Accept it.** Staging is test data. Check first:
  `SELECT count(*) FROM user_profiles WHERE activity_level = 'active';`

Both trees are otherwise committed. **Mobile has uncommitted changes** — see §3.

---

## 2. What changed this session

Almost all of it is the app's face, plus one new AI capability. Nothing about
the logging pipeline, the corpus or the resolver moved.

**The whole app is dark, and only dark.** One cool near-black palette replaces
the warm light/dark pair — `#0B0C0E` page, `#191D21` cards, blue-violet accent.
`force`/`scheme` are gone, and so is every light-mode token. Android and iOS are
pinned dark natively, or the app opens on a white flash.

**Cards are a fill and a radius.** No hairline, no shadow: a card's edge is the
step in lightness between its fill and the page, which on a dark screen is the
only depth cue that carries.

**No button is the accent colour** — ink on canvas, everywhere, one treatment.
Selection is ink too. What blue is left is doing work: a focused field, a filled
ring, the mark.

**Sign-in and sign-up are one flow.** `POST /v1/auth/check-email` (new) answers
whether an address is known, so step two is a real sign-in screen or a real
sign-up screen rather than one hedging. `SignInScreen` is deleted; the routes
are `AuthEmail` / `AuthPassword`.

**Onboarding is five screens**, each asking one thing: about you → how active →
which way → how fast → targets. "How fast" was split off the objective step.
Activity levels went 5 → 4 → **6** (`athlete` added at 2.0). Units was removed
entirely — the app is metric.

**The model proposes the targets** (§4 has the guardrails). New AI step
`targets`, new endpoint `POST /v1/me/goals/suggest`, new prompt, new
`ai_step` enum value.

**Onboarding ends in the composer**, not search — the first thing after five
screens of questions is the app asking what you ate. That reverses a documented
decision; see §6.

**Auth rate limits raised**, all windows now ten minutes. See §5.

---

## 3. Current environment state

| | |
|---|---|
| **App points at** | `local` — `BACKEND` in `nutricheck/src/config.ts` |
| **Local stack** | Rebuilt many times today. 13,440 foods. Migrated through 0009. Real `AI_API_KEY` in `.env.local` |
| **Local database** | **Empty.** Every account was deleted on request. `ai_runs` kept 78 anonymised rows — that FK is `ON DELETE SET NULL` on purpose, so spend history survives an account |
| **Staging** | `https://3-6-120-121.sslip.io` — running the commit pushed at the START of this session. None of §2 is on it |
| **API tests** | 89 unit + 133 integration. Green |
| **Mobile tests** | **Not run this session, by instruction.** Typecheck and a release bundle were used instead |

**Mobile working tree is dirty.** Six onboarding files, uncommitted, removing
the step counter (`STEPS`, `step`) and every `subtitle` from `OnboardStep` and
its five screens. Not mine — it was already on disk. It typechecks and bundles.
Commit it or revert it; it should not sit there.

Staging box: `ssh -i "C:\Users\Admin\Documents\LightsailDefaultKey-ap-south-1.pem" ubuntu@3.6.120.121`

---

## 4. The model now sets targets — and what stops it

This is the second place in the system where a model produces numbers, and
unlike `/v1/ai-meal` these are what somebody eats to for months. Three things
carry that, and none of them is the model:

1. **The formula runs first.** There is a complete, checkable answer before the
   model is asked anything, and it is what the screen falls back to.
2. **The model adjusts rather than authors.** It is handed the formula's result
   and asked whether it should move. A model asked "what should this person eat"
   answers confidently from nothing; one asked "here is 2,287, should it change"
   has to argue.
3. **`clampTargets` holds it.** Calories never below resting burn — the same
   floor `computeGoal` applies to itself — protein bounded per kilo rather than
   absolutely, fibre bounded outright. Every correction is returned and shown,
   because a figure the server moved is not the figure the model chose.

Carbs and fat are never asked for. They follow from the calorie target, and the
client derives them from whatever number is on screen so the four always add up.

**Verified live**, not reasoned about: three runs of one profile return the
formula's figures exactly, and a 48 kg woman asking to lose a kilo a week comes
back at her resting burn with the model explaining that is the floor.

---

## 5. Traps found this session

- **`Press` puts its `style` on an inner view, not the touchable.** So
  `flexGrow: 1` never reached anything that could act on it, and rows of
  pressables were content-sized. Fixed by hoisting the five sizing props —
  `flex`, `flexGrow`, `flexShrink`, `flexBasis`, `alignSelf`, plus
  `aspectRatio`. They have to MOVE, not be copied: `flexBasis: 0` on the inner
  view is a basis on the other axis. **The inner view still inherits none of
  it** — a stretched touchable with a content-sized thing drawn in it looks
  like a small card floating in a gap. `height: '100%'` is the fix, and it
  caught me twice.
- **`flex: 1` inside a ScrollView collapses to content height.** It resolves
  against a content box that is only as tall as what is in it. `flexGrow` on
  the content container sets a floor for the box but does not fix the child.
  `OnboardStep` has a `fill` prop that replaces the scroll for screens whose
  content should be seen at once.
- **A stale Metro cache serves an old transformer decision**, and the symptom is
  React's "expected a string but got: number" — an asset id where a component
  was expected. `npm run start:fresh` exists for it now.
- **drizzle-kit's enum-removal migration does not move the rows.** It casts to
  text, rebuilds the type and casts back, and the last statement fails on any
  row holding the value being dropped. Check generated SQL before trusting it —
  and it named the table `profiles` when it is `user_profiles`.
- **A billed call kept running after the screen was dismissed.** `alive` flags
  stop the RESULT being used, not the request. The confirm sheet aborts now.
- **Per-IP rate limits are per-carrier here.** Indian mobile carriers put
  thousands of subscribers behind one address, so 5 registrations an hour per IP
  refuses the sixth genuine person on that carrier. Now 30 per ten minutes, and
  every auth window is ten minutes so a block costs ten minutes, not an hour.

---

## 6. Open, in rough priority order

1. **Decide the 0007/0008 migration question** (§1), then push both repos.
   Staging is a whole redesign behind.
2. **Run the mobile suite.** It has not run all session by instruction, and the
   theme rewrite, the auth-flow merge and the onboarding rebuild all landed
   without it. `screens.test.tsx` renders every screen and is the natural net
   for exactly those.
3. **`/v1/ai-meal` prompt quality.** The summary is still a restatement of the
   sentence rather than the energy figure the prompt asks for. Coconut chutney
   came back at 100 kcal/100 g against a real ~190.
4. **The targets prompt needs watching.** It was caught once returning 2,280
   against a calculated 2,294 and calling it "adjusted slightly to stay within a
   reasonable range" — a fourteen-calorie difference offered as advice. The
   prompt now forbids it and the server snaps near-misses onto the formula, but
   this is the failure mode to watch.
5. **`identify()` + `ai_food_matches` are built and unreachable.**
6. **~100 Tamil produce aliases.** 25 of 7,928 USDA rows carry one.
7. **`I forgot my password` is still a dead link**, now on the password step.
   There is no reset endpoint; a forgotten password is an unrecoverable account.
8. **The legal links are unverified.** `src/lib/legal.ts` points at
   `nutricheck.app/privacy` and `/terms`, which are a guess from the API's
   problem-type domain. Nothing is published there. A line saying "you accept
   these" beside a link that 404s is worse than either half alone.
9. **eslint has never run.** The tool is in no `devDependencies`. Prettier is,
   but the repo is not prettier-formatted — running it rewrites whole files.
10. **Tests are not in CI**, deliberately — see docs/CI-CD.md.

---

## 7. Decisions taken this session that were previously open

Recorded because each reverses something written down as deliberate.

- **The first meal goes through the composer, not search.** The old route had no
  model in it and could not fail on a bad parse at the one moment a new user has
  no reason to forgive it. Traded away for a better first impression. If new
  users drop at that screen, this is why, and it is one line to restore.
- **A model sets nutrition targets.** The app's rule was that models never
  supply nutrition figures outside the documented `/v1/ai-meal` exception. §4 is
  how that was made safe rather than abandoned.
- **Welcome names both doors.** It used to offer only "Get started" into
  sign-in, on the reasoning that a new user would find the link from there.
- **The password minimum is still 6**, and server and client still agree on it.
  Whether 6 is right remains undecided; `.env.example` and `docs/PLAN.md` §3
  still record `anthropic` as the provider while `openai-compatible` is what
  runs.
