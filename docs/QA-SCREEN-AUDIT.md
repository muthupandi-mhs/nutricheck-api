# Screen-by-screen QA audit

Working log for a full pass over the `nutricheck` app, one screen at a time, looking for correctness bugs, business-logic errors, and stray/wrong UI text. Started because the app is headed to a large user base and every screen needs to have been read against both what it shows and what the backend actually does, not just smoke-tested.

Companion to [USER-FLOWS.md](./USER-FLOWS.md) (the intended design) — this document tracks the *as-built* state and what was found wrong with it.

## Method

For each screen: read the component, its hooks/state, the schemas or business logic it depends on, and — where the screen makes a claim about a calculation (calories, macros, dates, money) — the backend code that's supposed to agree with it. Findings are logged below with severity, then fixed or explicitly deferred with a reason.

## Status legend

- ✅ Reviewed, clean
- 🔧 Reviewed, issue(s) found and fixed
- 🟡 Reviewed, issue(s) found and deferred (see notes)
- ⬜ Not yet reviewed

---

## 1. Onboarding

| Screen | File | Status | Notes |
|---|---|---|---|
| Welcome | `src/screens/onboarding/WelcomeScreen.tsx` | ✅ | Both buttons intentionally route to AuthEmail — by design, see route comments in `navigation/types.ts`. |
| Auth — email | `src/screens/onboarding/AuthEmailScreen.tsx` | 🔧 | Reported by the user: going back from the password step left the Continue button disabled despite the email field still showing a valid address. Root cause: `disabled` depended on `formState.isSubmitted && !formState.isValid`, derived form state that isn't guaranteed fresh across a return-to-focus with no new change event — it can get stuck showing invalid for an address that was never wrong. **Fixed**: gated `disabled` on there being text only (`!emailInput.trim()`); a genuinely bad format still gets caught and shown the moment Continue is pressed, it just never blocks the tap pre-emptively. |
| Auth — password | `src/screens/onboarding/AuthPasswordScreen.tsx` | 🔧 | "I forgot my password" was a dead button (`onPress={() => {}}`). No password-reset endpoint exists anywhere in the backend. **Fixed** as a stopgap: tapping it now shows a Notice pointing to the app-store support address. Real fix needs a decision on email provider + backend endpoint + screens — deferred, see [Open items](#open-items). Also had the same stuck-disabled-Continue bug as the email step (`f.tried && !f.ready`) — fixed the same way. |
| Name | `src/screens/onboarding/NameScreen.tsx` | 🔧 | Externally redesigned mid-session to the same rising-bottom-sheet scaffold `AuthStep` uses (scrim, spring-in panel, rounded top, handle) — correctly kept a couple of intentional differences (no brand mark, no back button, since this is a mandatory step with nothing to return to). It still used the boxed/labelled `FormField` for its two inputs though, not the pill-shaped `AuthFormField` the login screens use, so it didn't fully match. **Fixed**: switched both fields to `AuthFormField` (placeholder-only, no label slot, matching the login screens' style) and fixed the same stuck-disabled-Continue bug found on the email/password steps. |
| About you (profile) | `src/screens/onboarding/ProfileScreen.tsx` | 🔧 | Requested by the user: Height and Weight should take a decimal, matching the precision `WeightScreen`'s own weight-logging sheet already uses (`decimals: 1, step: 0.1`) — both steppers here defaulted to whole numbers. Fixed, and see the cross-cutting Stepper fix below found while making this change. |
| Activity | `src/screens/onboarding/ActivityScreen.tsx` | ✅ | |
| Objective | `src/screens/onboarding/ObjectiveScreen.tsx` | ✅ | |
| Rate | `src/screens/onboarding/RateScreen.tsx` | ✅ | |
| Targets (reveal) | `src/screens/onboarding/TargetsScreen.tsx` | 🔧 | `goalReasoning()` in `src/lib/nutrition.ts` stated the user's *requested* weight-loss/gain rate in the calorie explanation even when the rate had been capped at 20% of TDEE — e.g. told someone who picked 1.5 kg/week they were set up for that, when the actual effective rate was ~0.37 kg/week. The calorie math itself was correct; only the sentence was wrong. **Fixed**: the sentence now names the real effective rate and says the picked rate was too fast, mirroring the pattern already used in `ProfileEditorScreen.tsx`. Verified against `__tests__/nutrition.test.ts` (34/34 pass, no test asserted on the string so nothing was masking this). |
| Targets (edit) | `src/screens/onboarding/TargetsEditScreen.tsx` | ⬜ | |

Also reviewed as shared/backing code for this flow: `AuthStep.tsx`, `OnboardStep.tsx`, `LegalNote.tsx`, `useAuthForm.ts`, `useGoogleSignIn.ts`, `useTargetsPrefetch.ts`, `state/Onboarding.tsx`, `lib/nutrition.ts`, `forms/schemas.ts`, and the backend `auth.controller.ts` / `auth.service.ts` — all clean.

## 2. Core logging loop

| Screen | File | Status | Notes |
|---|---|---|---|
| Home | `src/screens/home/HomeScreen.tsx` (+ `Dial.tsx`, `MealCard.tsx`, `MealInsight.tsx`, `RecentCard.tsx`) | 🔧 | **Regression, not a text bug**: the entire "repeat route" (tap a recent food/saved meal to log it instantly at its remembered portion, long-press to adjust) was unreachable. `RecentStrip`/`RecentCard.tsx`, the backend endpoint (`/v1/suggestions/recents`), `AppState.tsx`'s `recents`/`logTile`, were all fully built and working, but `HomeScreen.tsx` never imported or rendered `RecentStrip` and never read `recents`/`logTile` from `useAppState()` — confirmed via `git log`/`git show` that commit `bb9d447` ("Give Today three dials...") rewrote the screen for the dial redesign and silently dropped the strip that a prior commit (`e200624`) had deliberately placed second in the reading order ("the ring, the repeat strip, then the meals"). Zero other screens reference `recents` or `logTile` either, so this was a fully dead, unreachable feature — plus wasted network calls fetching `recents` on every refresh for a value nothing rendered. **Fixed**: re-wired `RecentStrip` into `HomeScreen.tsx` between the macro rows and "What you ate", restoring the original tap-to-log / long-press-to-adjust behavior, matching the current three-dial screen's own text/spacing conventions rather than copying the pre-redesign styling verbatim. Verified: `tsc --noEmit` clean, full suite passes. Note: after this fix landed, the screen was edited directly (outside this audit) to gate the restored strip behind `SHOW_ADD_AGAIN = false` — the wiring stays intact for a future flip, it's just switched off for now; that looked like a deliberate call, not a mistake, so it was left alone. |
| Composer | `src/screens/composer/ComposerScreen.tsx` (+ `DictationOverlay.tsx`) | 🔧 | `micGranted` was only ever set inside the `autoStart`-gated effect, so on a normal (non-autoStart) visit — e.g. from Search or the empty-state prompt — the screen never learned the real OS mic permission state. Tapping the mic button always fell through to the "priming" permission-explainer sheet on the first tap of every session, even for a user who granted mic access months ago. `AskSheet.tsx` gets this right (checks `hasMic()` on every focus); Composer didn't. **Fixed**: added a `useFocusEffect` that checks `hasMic()` the same way `AskSheet` does, so the mic button goes straight to recording when permission is already granted, and re-checks after a trip to system settings. Also removed `countItems`, a dead helper left over from a removed item-count display (the removal is already explained in a comment a few lines below it). Verified: `tsc --noEmit` clean, full suite passes. |
| Voice — listen | `src/screens/voice/ListenScreen.tsx` | ✅ | Thin wrapper over `AskSheet`, which already does its own permission/error handling correctly. |
| Voice — type | `src/screens/voice/TypeScreen.tsx` | ✅ | |
| Voice — meal / ask sheet | `src/screens/voice/MealScreen.tsx`, `AskSheet.tsx` | ✅ | Checked as part of the Composer mic-permission fix — `hasMic()` on every focus, correctly. Multi-day/multi-meal sentence splitting and the `toHome` double-log-avoidance logic are both careful and correct. |
| Search | `src/screens/search/SearchScreen.tsx` | ✅ | Debounce/race-guard on the search-as-you-type request is correct (a `generation` counter drops stale responses). |
| Portion | `src/screens/search/PortionScreen.tsx` | ✅ | |
| Create food | `src/screens/search/CreateFoodScreen.tsx` | ✅ | |
| Confirm sheet | `src/screens/confirm/ConfirmSheetScreen.tsx` (+ `ConfirmRow.tsx`) | ✅ | |
| Entry detail | `src/screens/entry/EntryDetailScreen.tsx` | 🔧 | "Save as a meal" was a dead chip (`onPress={() => {}}`) — same class of bug as onboarding's forgot-password button. Unlike that one, the backend was fully ready for it: `POST /v1/meals` already accepts `{ name, fromEntryId }` — "save an existing log entry as a meal" is a documented, tested path (`meals.controller.ts`/`meals.service.ts`) — but there was no client-side plumbing at all (no method on `NutriCheckApi`, nothing in `httpApi.ts`, nothing in `AppState.tsx`). It was also only reachable when the entry had a `phrase`, even though the server's `fromEntryId` works for any entry (search-logged, repeat-logged, anything). **Fixed end to end**: added `createMealFromEntry` to `api/client.ts` + `httpApi.ts` (+ a stub in `__tests__/fixtures/stubApi.ts` for the render-test suite), added a `mealNameSchema`/`MEAL_NAME_MAX` to `forms/schemas.ts` (mirrors `contracts/meals.ts`'s `CreateMeal.name` bound), and built a small naming `Sheet` on `EntryDetailScreen` — defaults the name to the food name (single-item entries) or the meal slot label, validates it, calls the new endpoint, and surfaces a failure without touching the entry itself. The chip now sits outside the phrase-only block so it shows for every entry. Separately, found while auditing decimal support app-wide: opening the per-item gram editor did `setPendingGrams(Math.round(item.grams))`, silently rounding away any fraction the instant the sheet opened — a standard portion routinely carries one (a food table's "1 medium" can be 182.5 g), and Search's own initial entry already accepts a decimal gram amount, so editing was the one place that could round it away just by opening and saving with no other change. **Fixed**: seed from the real value, and gave the Stepper `decimals={1}` so a fraction displays and types correctly instead of being silently mangled by the whole-number Stepper bug below. Verified: `tsc --noEmit` clean, full suite passes. |

## 3. Secondary tabs

| Screen | File | Status | Notes |
|---|---|---|---|
| Calendar | `src/screens/calendar/CalendarScreen.tsx` (+ `adherence.ts`) | ✅ | The client/server duplication the code itself flags (`ON_TARGET` here vs. `ON_TARGET_TOLERANCE` in `@nutricheck/contracts`) is genuinely guarded — both sides assert the literal `0.15` in a test, so a drift would fail a test rather than silently disagree. |
| Insights | `src/screens/insights/InsightsScreen.tsx` (+ `WeekChart.tsx`, `WeekReviewCard.tsx`) | 🔧 | Four issues, all fixed: (1) the weekly charts always drew the rightmost bar as "Today" and the legend always said "Today"/"Earlier", even on a past week paged to with the header's chevron, where that bar is just the window's last day — `WeekChart` now takes a `highlightLast` prop and the legend a `currentLabel`, both true only on the current week; (2) the weekly calorie delta always coloured "under target" good and "over" bad, backwards for a `gain` objective — now depends on `profile.objective`, matching `WeightScreen`'s `moving()`; (3) "Previous week" was always shown even once paging back reached entirely before the account existed — it now hides once the displayed window's start reaches the account's `createdAt` (fetched via `getSession()`), defaulting to shown while that's unknown; (4) carbs and fat were completely missing from both the weekly stat card and the trend charts despite the fetched `WeekSummary` already carrying them — added both, wrapping the stat row so five columns don't cram on narrow phones. Verified: `tsc --noEmit` clean, full suite passes. |
| Fasting | `src/screens/fasting/FastingScreen.tsx` (+ `FastingRing.tsx`) | 🔧 | `useNow()` only ticks while a fast is running (`active = current !== null`); while idle it freezes at whatever `Date.now()` was when the screen mounted. Opening "I stopped eating earlier" after lingering on the screen a while (reading stats, scrolling history) showed the start-time panel's clock face stuck at that stale mount-time value next to a caption that said "just now" — cosmetic only, since the actually-saved timestamp is computed fresh from `Date.now()` at save time, but visibly wrong while the panel is open. **Fixed**: `useNow` also ticks while the start-time panel is open (`current !== null \|\| panel?.kind === 'startTime'`). Everything else on this screen — the stale/404/409 "another device changed this" handling, the day-overlap logic for a fast crossing midnight, the plan-preset fallback for an out-of-band target — is careful and correct. |
| Weight | `src/screens/weight/WeightScreen.tsx` (+ `WeightChart.tsx`) | ✅ | `moving()`'s objective-aware coloring (gain vs. lose change the "good" direction) is exactly right, and is in fact the pattern Insights was missing (see below). |
| Ideas | `src/screens/ideas/IdeasScreen.tsx` | ✅ | |

## 4. Settings / account

| Screen | File | Status | Notes |
|---|---|---|---|
| You (profile home) | `src/screens/settings/YouScreen.tsx` | 🔧 | The screen's own top comment claimed "Export and delete are top-level rows" — but there is no Export row anywhere on the screen, and no export endpoint anywhere in the backend (confirmed by search). This was a stale reference to the M4 milestone in `USER-FLOWS.md` that was never built; no user-facing control claims this, so nothing was misleading a user, just the comment. **Fixed**: corrected the comment to say export was planned but never built, so it doesn't stop the next reader short. |
| Profile editor | `src/screens/settings/ProfileEditorScreen.tsx` | 🔧 | **Confirmed, reproducible bug**: the Age stepper writes back `birthDate` as `<year>-06-15`, and `ageFrom()` docks a year off whenever *today* falls before that stored month/day. On any day from Jan 1 to Jun 14 (~5.5 months of the year), the round-trip cancels out exactly: tapping "+" requests `age+1`, the write lands on a birth year that reads back as `age` again — so **"+" produced no visible change at all**, and "−" moved the displayed age down by 2 instead of 1. Verified with a standalone reproduction before fixing. Onboarding's own age stepper (`ProfileScreen.tsx`) has no such bug — it stores a plain `birthYear` integer with no month/day logic, so this was specific to the settings editor's round-trip through `birthDate` + `ageFrom()`. **Fixed**: added `birthDateForAge()`, which keeps the existing month/day (always "06-15" in practice, since onboarding writes it that way) and solves for the year that makes `ageFrom` read back exactly the requested age regardless of today's date. Re-verified the same reproduction now moves exactly one age per tap in both directions. Separately, requested by the user: Height and Weight should take a decimal here too — same fix as onboarding's "About you", `decimals: 1, step: 0.1` on both. Updated the one existing test that exercised the weight stepper's step size. |
| Goal editor | `src/screens/settings/GoalEditorScreen.tsx` | 🔧 | "Back to derived targets" called `reset({ kcal, proteinG, fiberG })` — omitting `carbsG` and `fatG` entirely, even though the button claims to revert *all five* targets and the `overridden` banner above it compares all five. Clicking it left carbs and fat blank/undefined instead of restored. **Fixed**: added the two missing fields to the `reset()` call. |
| Nutrition info | `src/screens/settings/NutritionInfoScreen.tsx` | 🟡 | This static reference page turned out to be the one place the *server's* real protein formula (activity-level-scaled, 1.6–2.2 g/kg) was stated correctly — see the protein-formula bug below, which was in the client's live-preview code, not here. No changes needed on this screen itself. |
| Change password | `src/screens/settings/ChangePasswordScreen.tsx` | ✅ | |
| Privacy | `src/screens/settings/PrivacyScreen.tsx` | ✅ | Read in full — the "write to us at the address in the app store listing" convention (reused in the AuthPassword fix) is stated consistently. |
| Delete account | `src/screens/settings/DeleteAccountScreen.tsx` | ✅ | |

## Cross-cutting: the protein formula

Not a single-screen bug — found while checking `NutritionInfoScreen`'s numbers against the code and worth its own entry.

**`lib/nutrition.ts`'s `deriveGoal()` (the client-side live preview used by onboarding's Targets screen and by `ProfileEditorScreen`'s "What this comes to" card) computed protein from *objective alone* — `1.9`/`1.7`/`1.6` g/kg for lose/gain/maintain — completely ignoring activity level.** The real, authoritative formula, in `nutricheck-api`'s `goal-calculator.ts`, scales protein by activity level (1.6 g/kg sedentary up to 2.2 g/kg very-active/athlete), then adds a further +0.2 g/kg for `lose` capped at 2.2. These two formulas disagree for the majority of activity levels — e.g. an active or very-active person's client-side preview understated the real number by up to 0.6 g/kg.

This matters because of what the number is used for beyond just being wrong on screen: both `TargetsScreen` (onboarding) and `ProfileEditorScreen` compare the *saved* goal against this client formula's output to decide whether to show "your targets are set by hand, not tracking your profile" — so anyone whose activity level wasn't close enough to "moderate" got told their correctly-server-derived targets were an override, for no reason they could see.

`nutrition.test.ts` has a whole suite titled "the goal formula mirrors the server" whose own docstring says the two "must mirror... exactly," and which exists specifically to catch this kind of drift — but it only ever asserted on `kcal`, `flooredAtBmr`, `rateCapped`, and `effectiveRateKgPerWeek`. `proteinG` was never compared, so the drift shipped silently.

**Fixed**: `lib/nutrition.ts` now carries the same `PROTEIN_G_PER_KG` activity table, cap, and floor as the server, and `deriveGoal` calls it. Also softened `goalReasoning()`'s protein sentence, which used to claim the non-`lose` case sits at "the middle of the evidence-backed range" — no longer true now that a sedentary maintainer sits at the floor and a very-active one at the ceiling. **Also fixed the coverage gap**: added the same activity table to the test's `server()` mirror and asserted `mine.proteinG === theirs.proteinG` across all 4 test profiles × 4 rates (16 cases) — this is what would have caught the original drift, and will catch the next one. Verified: `tsc --noEmit` clean, `nutrition.test.ts` 34/34 pass, full suite passes.

## Cross-cutting: the Stepper's whole-number typed input

Found while adding decimal support to Height/Weight. `src/components/Field.tsx`'s `Stepper` handles typed digits differently depending on whether the field allows a fraction: a field WITH decimals correctly splits on the first `.` and keeps the whole and fractional parts apart (`decimalDigits()`); a whole-number field instead did `raw.replace(/[^0-9]/g, '')`, which **strips the `.` and concatenates the two halves it separated** — typing `150.5` into any whole-number Stepper silently became `1505`, a number ten times too big, with no error and no indication a keystroke was rejected. This is the shared component every whole-number Stepper in the app uses — the goal targets among them, which are integers on purpose (`goalTargetsSchema`'s `.int()`, "has to be a whole number").

**Fixed**: the whole-number path now takes only the digits before the first decimal point (normalizing a comma to a point first, matching `decimalDigits`' own locale handling) and ignores anything typed after it, rather than folding it into the integer. Added regression coverage (`__tests__/forms.test.tsx`, "stepper typed input") asserting a whole-number field produces `150`, never `1505`, for input `"150.5"`, and that a field which allows a fraction still accepts one.

## Cross-cutting: Continue getting stuck disabled after a back-navigation

Reported by the user: on the password step, navigating back to the email step left its Continue button disabled despite the email field still showing a valid address. All three sheet-style auth/name screens (`AuthEmailScreen`, `AuthPasswordScreen`, `NameScreen`) gated their Continue button on `formState.isSubmitted && !formState.isValid` (or the equivalent `tried && !ready`) — derived React Hook Form state that isn't guaranteed to refresh across a return-to-focus with no new change event, so it can get stuck reporting invalid for a value that was never wrong.

**Fixed**: all three now gate `disabled` on there being text only. A genuinely invalid value still gets caught and shown the moment the button is pressed — nothing about real validation changed — it just never pre-emptively blocks the tap based on stale state.

## Decimal-entry audit: every Height/Weight/target field in the app

Requested by the user directly: is decimal entry consistent everywhere it's relevant? Checked every `Stepper`/`FormStepper` usage in the app:

| Field(s) | Where | decimals | Correct? |
|---|---|---|---|
| Height, Weight | onboarding `ProfileScreen.tsx` | 1 | ✅ (fixed this session) |
| Height, Weight | `ProfileEditorScreen.tsx` | 1 | ✅ (fixed this session) |
| Weight | `WeightScreen.tsx` (logging sheet) | 1 | ✅ (already correct) |
| Item grams | `EntryDetailScreen.tsx` (edit sheet) | was 0, silently rounding on open | 🔧 fixed — see the Entry detail row above |
| Rate (kg/week) | onboarding `RateScreen.tsx` | 2 | ✅ |
| Calories, Protein, Carbs, Fat, Fibre (goal targets) | `GoalEditorScreen.tsx`, onboarding `TargetsEditScreen.tsx` | 0 | ✅ — correct as whole numbers; the server's `goalTargetsSchema` is `.int()` on purpose, so this is by design, not a gap. Now also protected by the whole-number Stepper fix above, so a stray decimal is refused instead of silently mangled. |

Portion grams typed directly on `PortionScreen.tsx`/`CreateFoodScreen.tsx` (plain `Field`, not `Stepper`) already accepted decimals via `portionGramsField`'s schema — never affected by the Stepper bug.

---

## Open items

Issues found that were deferred rather than fixed inline, because they need a product/infra decision rather than a code change:

- **No self-serve password reset exists anywhere in the stack.** There is no email-sending infrastructure in `nutricheck-api` at all (checked for nodemailer/SendGrid/SES/etc — none present). Building real reset requires: picking an email provider, a reset-token table + endpoint on the backend, an email template, and new mobile screens. Currently mitigated with an honest in-app message (see Onboarding table above) instead of a dead button.

## Fixed so far

1. `src/lib/nutrition.ts` — `goalReasoning()` now reports the actual effective rate when a requested weight-loss/gain rate gets capped, instead of repeating the (higher) requested figure.
2. `src/screens/onboarding/AuthPasswordScreen.tsx` — "I forgot my password" now shows an explanatory Notice instead of doing nothing.
3. `src/screens/home/HomeScreen.tsx` — restored the "repeat route" (`RecentStrip`), which had been silently dropped from the screen during the three-dial redesign despite all of its backend/state plumbing still being live.
4. `src/screens/composer/ComposerScreen.tsx` — the mic button now knows if permission is already granted (checked on every focus, matching `AskSheet`), instead of always showing the priming sheet first; removed an orphaned dead helper (`countItems`).
5. `src/screens/entry/EntryDetailScreen.tsx` + `api/client.ts` + `api/http/httpApi.ts` + `forms/schemas.ts` — built "Save as a meal" end to end (it was a dead chip with no backing client code at all, despite the server already supporting it), and widened it to work for every entry, not just phrase-based ones.
6. `src/screens/insights/WeekChart.tsx` + `InsightsScreen.tsx` — the weekly charts no longer mislabel the last day of a past week as "Today" when paging backward.
7. `src/screens/insights/InsightsScreen.tsx` — the weekly calorie delta's color now depends on the profile's objective (matching `WeightScreen.tsx`'s `moving()`), instead of always treating "under target" as good and "over" as bad — backwards for anyone with a `gain` objective.
8. `src/screens/fasting/FastingScreen.tsx` — the start-time panel's clock face no longer freezes at a stale mount-time value while the screen sits idle.
9. `src/screens/settings/YouScreen.tsx` — corrected a stale comment claiming an "Export" row exists; it never shipped and there's no backend support for it.
10. `src/screens/settings/ProfileEditorScreen.tsx` — fixed the Age stepper being completely stuck (tapping "+" did nothing) for roughly half the days of the year.
11. `src/screens/settings/GoalEditorScreen.tsx` — "Back to derived targets" now actually restores all five targets, not three.
12. `src/lib/nutrition.ts` + `__tests__/nutrition.test.ts` — the client-side protein formula now matches the server's activity-scaled one instead of a simpler objective-only formula that had silently drifted from it; added the missing cross-check the "mirrors the server" test suite should have had from the start.
13. `src/screens/insights/InsightsScreen.tsx` — "Previous week" now hides once paging back would reach entirely before the account existed, and Carbs/Fat were added to both the weekly stat card and the trend charts (previously missing entirely, despite the fetched data already carrying them).
14. `src/screens/onboarding/AuthEmailScreen.tsx`, `AuthPasswordScreen.tsx`, `NameScreen.tsx` — Continue no longer gets stuck disabled after navigating back with valid data still in the field; also switched `NameScreen`'s fields onto the same `AuthFormField` the login screens use.
15. `src/components/Field.tsx` — the shared `Stepper` no longer silently turns a typed decimal into a wrong whole number on every integer field in the app (e.g. `150.5` becoming `1505`); added regression tests.
16. `src/screens/onboarding/ProfileScreen.tsx`, `src/screens/settings/ProfileEditorScreen.tsx` — Height and Weight now take one decimal place, matching `WeightScreen`'s own logging precision.
17. `src/screens/entry/EntryDetailScreen.tsx` — the per-item gram editor no longer silently rounds away a portion's fraction the instant it's opened, and its Stepper now takes a decimal like every other gram-entry field in the app.
