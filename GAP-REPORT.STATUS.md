# NutriCheck — client/backend gap report

**Updated:** 2026-08-26 · **App:** [nutricheck/](nutricheck/) · **API:** [nutricheck-api/](nutricheck-api/)

Every claim here was checked against the code, not inferred from the docs.

**All four gaps in §3 are closed and `httpApi` exists.** The app is wired to the
API. What follows records what was built, what was verified and how, and what is
still open — read §6 before touching the transport.

> **Two additions since, 2026-08-26.** The surface in §2 has grown by one:
> **`transcribe` → `POST /v1/transcribe`**, the only route that takes audio.
> And every nutrient shape named here — `Nutrients`, `FoodNutrientsPer100g`,
> `DaySummary.totals`, `Goal`, `DayPoint` — now carries **carbs and fat**
> alongside calories, protein and fibre, each with its own three-state field.
> The traps in §4 are unchanged and still apply.

Siblings: [BACKEND.STATUS.md](BACKEND.STATUS.md) · [MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md) · [VOICE-REFERENCE.STATUS.md](VOICE-REFERENCE.STATUS.md)

---

## 1. Where this stands now

`httpApi` is written and `App.tsx` constructs it by default
([config.ts](nutricheck/src/config.ts) flips back to the mock with one boolean).
Every method on `NutriCheckApi` now has a route behind it, and the eleven stale
route comments have been corrected against the API.

| | |
|---|---|
| Routes | **33** under `/v1`, plus 3 health probes (was 29 + 3) |
| Backend tests | **202** — 78 unit, 124 Testcontainers integration, all green |
| App tests | **102** — including 21 for the transport |
| Verified live | All four new routes, over HTTP, against the real Postgres |

---

## 2. The surface, method by method

All 20 methods on `NutriCheckApi`, plus `commitBatch`. The route on each is now
the one the API actually serves.

| Client method | Route | |
|---|---|---|
| `register` | `POST /v1/auth/register` | ✅ |
| `login` | `POST /v1/auth/login` | ✅ |
| `logout` | `POST /v1/auth/logout` | ✅ |
| `getSession` | `GET /v1/me` | ✅ |
| `getProfile` | `GET /v1/me/profile` | ✅ |
| `saveProfile` | `PUT /v1/me/profile` | ✅ |
| `previewGoal` | `POST /v1/me/goals/preview` | ✅ **new** |
| `getGoal` | `GET /v1/me/goals` | ✅ |
| `setGoal` | `POST /v1/me/goals` | ✅ |
| `getDay` | `GET /v1/logs/day?date=&tz=` | ✅ |
| `getWeek` | `GET /v1/logs/week?date=&tz=` | ✅ **new** |
| `searchFoods` | `GET /v1/foods/search?q=` | ✅ |
| `getFood` | `GET /v1/foods/:id` | ✅ |
| `createFood` | `POST /v1/foods/custom` | ✅ |
| `resolve` | `POST /v1/resolve` (SSE) | ✅ |
| `commit` | `POST /v1/logs` | ✅ |
| `commitBatch` | `POST /v1/logs/batch` | ✅ **newly exposed** |
| `deleteEntry` | `DELETE /v1/logs/:id` | ✅ |
| `updateItemGrams` | `PATCH /v1/logs/:id/items/:itemId` | ✅ **new** |
| `getRecents` | `GET /v1/suggestions/recents` + `GET /v1/meals` | ✅ |
| `getPhrases` | `GET /v1/suggestions/phrases` | ✅ **new** |

The route comments in [client.ts](nutricheck/src/api/client.ts) are now correct
and are load-bearing — a wrong one surfaces only as a 404 at runtime.

---

## 3. What was built for each gap

### 3.1 `getWeek` — `GET /v1/logs/week`

Seven `DayPoint`s ending on the requested date, aggregated in Postgres rather
than by pulling a week of entries and summing in Node — four rows instead of
four hundred. Bucketed by the user's zone the same way `day()` does it, so a bar
on the chart contains exactly what the day screen shows for that date (there is
a test asserting the two agree).

Three decisions worth knowing:

- **Averages are over LOGGED days only.** Dividing by seven punishes someone for
  a day they never claimed to have tracked.
- **`streakDays` is not capped by the window.** A fourteen-day streak reports
  fourteen. Computed as gaps-and-islands in one query.
- **The streak reads 0 when the anchor day has no entry.** That is the literal
  reading of the contract's "counting back from today" — and it means the streak
  shows zero all morning until the first log lands. **See §7; this is a product
  question, not an oversight.**

### 3.2 `getPhrases` — write side, then read side

`user_phrases` had been written by nothing. Now:

- **Write:** `rememberPhrase` runs inside the commit transaction, upserting on
  `(user, phrase)` and incrementing `useCount`. In the transaction on purpose —
  a phrase recorded by a second request is missing exactly when the connection
  was bad, which is when replaying one matters most. A repeat-tap carries no
  phrase and so cannot pad the list.
- **Read:** `GET /v1/suggestions/phrases`, ordered by recency. `kcal` is the
  total of the **most recent** entry that phrase produced, computed per request
  — the same sentence is a different size on different days.
- **Promotion:** `POST /v1/meals { fromEntryId }` now points that entry's phrase
  at the new meal, so `savedAs` fills in and the composer switches from a clock
  to a bookmark. Promotion is never automatic; the server counts, the client
  offers at the second use, a meal appears because the user said yes.

### 3.3 `previewGoal` — `POST /v1/me/goals/preview`

Synchronous, stateless, takes no userId. Shares `computeGoal` with the
persisting path, so a preview cannot disagree with the goal the user gets when
they accept it — there is a test asserting exactly that. Returns `GoalPreview`
(no `id`, no `effectiveFrom`) because nothing was written; `httpApi` fills those
in with the non-uuid sentinel `'preview'`.

### 3.4 `updateItemGrams` — `PATCH /v1/logs/:id/items/:itemId`

**Decision taken: the per-item route, not a taught `PATCH /v1/logs/:id`.**

`log_items.id` is server-issued, stable, and already on the wire in every
`LogEntry`. The "no stable per-item identity" note on `UpdateLogEntry` is about
a **re-parse**, which mints new items — a committed entry's items keep their ids.
So the identity objection did not apply to this edit.

The route refreezes that one item's nutrients from the corpus, flips
`quantitySource` to `stated` (the user just stated it), and **upserts
`user_portions`** — the portion correction is the signal that makes the second
"a bowl of rice" right, and the wholesale PATCH threw it away. It is scoped to
the entry, so an item id from another entry is a 404.

---

## 4. The traps, and what handles each

Each of these compiles, runs, and is wrong. All are handled in
[src/api/http/](nutricheck/src/api/http/) and covered by
[httpApi.test.ts](nutricheck/__tests__/httpApi.test.ts).

| Trap | Where it is handled |
|---|---|
| Problem `type` is a URI, `isProblem()` compares a bare slug | [problems.ts](nutricheck/src/api/http/problems.ts) strips `PROBLEM_BASE_URI`. **Verified live** — the server does send the URI form |
| Parallel refresh looks like a stolen token and revokes every session | [transport.ts](nutricheck/src/api/http/transport.ts) serialises behind one in-flight promise; losers await it and retry with the rotated token |
| `getDay` drops the timezone, defaulting to UTC | The transport injects the device zone into `getDay` and `getWeek` |
| `commit` needs a shape adapter | `toWireEntry` maps to `foodId` + grams; the food summary and optimistic nutrients never leave the device |
| The offline drain is N round trips | `commitBatch` is exposed and `retryPending` uses it, falling back to a loop for the mock |
| Offline vs. server error | A throw out of `fetch` becomes `OfflineError`, so a failed commit is queued rather than shown as an error to redo |

Two beyond the original list, found while building:

- **Offline *during a refresh* must not sign the user out.** It is not an expired
  session, and dropping them at Welcome also discards what they were part-way
  through. The refresh rethrows `OfflineError` instead of returning null.
- **A failed refresh must clear the in-flight promise.** Otherwise every later
  401 awaits a settled failure forever.

---

## 5. How this was verified

- **189 backend tests**, of which 28 are new and cover the four gaps directly
  ([gaps.int-spec.ts](nutricheck-api/apps/api/test/gaps.int-spec.ts)) — real
  Postgres, not mocks.
- **21 transport tests** with a stubbed `fetch`, each one an assertion about a
  trap in §4.
- **Live over HTTP.** Docker Hub is unreachable from this machine, so the
  container could not rebuild; the API was run directly against the compose
  Postgres on port 3100 instead. Confirmed end to end: preview returns targets
  and persists nothing (404 on `GET /v1/me/goals` after); commit records a
  phrase and `GET /v1/suggestions/phrases` returns it; a second use makes
  `useCount` 2; saving a meal from the entry fills `savedAs`; the per-item PATCH
  moves 120 g → 180 g and refreezes to 302.4 kcal; the week returns seven days
  with that same 302.4 on the right date, averages over logged days, streak 1.

**Not verified:** the `resolve` SSE path against a live model, and the app
running on a device against the API. The first needs an AI key, the second needs
a simulator — neither is available here. `resolve` is the one method whose
transport is exercised only by unit tests.

---

## 6. Before you touch the transport

**The container is stale.** `nutricheck-api-1` still runs the pre-change image
and Docker Hub could not be reached to rebuild it. Run `npm run docker:up` on a
machine with registry access before trusting anything on port 3000.

**`nutricheck/` is a separate git repository** (excluded by the root
`.gitignore`), so the app-side work is committed there, not here.

**A `.gitignore` bug was hiding the logs module.** Line 16 was `logs/`, which
git matches at *any* depth — so `apps/api/src/modules/logs/` had **never been
committed**. That is the module owning commit, the day view, the batch drain and
both new routes; a fresh clone would not have built. The pattern is now anchored
to `/logs/`. **Everything in that directory is still untracked and needs its
first commit.**

---

## 7. Open questions

| # | Question | Why it needs deciding |
|---|---|---|
| 1 | **Should the streak survive an unfinished today?** | It currently reads 0 until the first log of the day lands, which is the contract's literal wording but reads as a bug at 9am after thirty days straight. Changing it is a product call |
| 2 | **Should the onboarding screens use `previewGoal`?** | `deriveGoal` in [lib/nutrition.ts](nutricheck/src/lib/nutrition.ts) is a **client-side reimplementation of the goal formula**, called by three screens. That duplication is what `previewGoal` exists to retire — but those screens recompute synchronously in `useMemo` as sliders move, so switching means debounce and loading states |
| 3 | Refresh token in AsyncStorage | Not encrypted. Fine for a 15-minute access token, a compromise for the refresh token. `TokenStore` is the seam for a Keychain/Keystore swap |
| 5 | **Insights ignores the two new macros** | `week.averages`, `week.goal` and every `DayPoint` carry `carbsG` and `fatG`; [InsightsScreen.tsx](nutricheck/src/screens/insights/InsightsScreen.tsx) renders calories, protein and fibre only. This is now the one screen the macro change did not reach — the Today screen has all four meters. Five stat columns and five charts on one screen is a layout call, which is why it is a question and not a bug |
| 4 | A meal tile's per-item protein | `FoodSummary` carries only kcal per 100 g, so tile protein reads 0 and fiber reads `unknown` until the tile is committed and the server freezes real values |
