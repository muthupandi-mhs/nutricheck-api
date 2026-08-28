# Session handoff — 2026-08-28 (second session)

Written at the end of a session so the next one can pick up mid-flight. The
durable facts live in [BACKEND.STATUS.md](BACKEND.STATUS.md),
[MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md), [docs/BACKEND.md](docs/BACKEND.md),
[docs/DEPLOY.md](docs/DEPLOY.md) and [docs/CI-CD.md](docs/CI-CD.md). This file is
only what is **in flight**.

---

## 1. Read this first: everything is pushed, and staging deployed unwatched

Both repos are level with `origin/staging`. The 58-commit backlog the previous
handoff opened with is gone.

```
nutricheck-api    (c:\Projects\New folder)            f444e85   in sync
nutricheck-mobile (c:\Projects\New folder\nutricheck) 7f9c349   in sync
```

The previous handoff's headline — *"pushing the API runs migration 0007 and it
loses data"* — was **already resolved before this session started**. The API repo
was found at 0 ahead, 0 behind, so 0007–0009 had been pushed and deployed by
somebody else. Nothing in this session had to decide it.

**What is unverified: whether the staging deploy of `f444e85` finished.** Pushing
to `staging` deploys automatically and runs migrations first
([CI-CD.md](docs/CI-CD.md)), so migration `0011_profile_name` should have applied
— but `gh` is not installed on this machine and Swagger is not exposed on
staging, so it could not be confirmed from here. Check before trusting it:

```
ssh -i "C:\Users\Admin\Documents\LightsailDefaultKey-ap-south-1.pem" ubuntu@3.6.120.121
```

**This matters for the APK.** The app now sends `firstName` on the profile save.
Against an un-migrated server it does not error — the Zod pipe uses plain
`.parse()` on non-strict objects, so unknown keys are **stripped**. Onboarding
completes, the save returns 200, and the name silently never persists. It looks
like a client bug and is not one.

**The mobile tree is dirty again** with another session's work — `KeyboardAvoid`,
`RootNavigator`, `CalendarScreen`, `screens.test.tsx`. Not from this session.

---

## 2. What changed this session

Five things, all on the same seam: the profile, and how the app looks while
asking for it.

**Buttons speak with one voice.** The uppercase, tracked pill label was an opt-in
`loud` prop, so onboarding shouted and the confirm sheet murmured — one control
reading as two depending on which screen you reached it from. It is intrinsic
now: a button either looks like this or it is not a button. New `button` /
`buttonSm` type roles carry it; `loud` is deleted from all 11 call sites.
`TextButton` is untouched, because it is a link.

**A name is asked for, first.** New `OnboardName` step before "About you", first
name required and surname optional. Full-stack: `user_profiles.first_name` /
`last_name` (migration 0011, both nullable), the contract, the service, the
draft, and the You screen which now shows the name instead of "Your account".

**Text fields stop where the server stops.** `PHRASE_MAX` 500 and `SEARCH_MAX`
120, copied from the contracts rather than invented — a rule the server enforces
and the client does not is a 422 nobody can read. `Field` now counts down inside
the last tenth of the allowance, because a keyboard that stops accepting letters
without saying why is indistinguishable from one that has frozen.

**The profile is editable.** New `ProfileEditor` screen off the You screen's
identity card: name, body, activity, objective, rate, with the derived targets
recomputing live underneath. Before this, a weight that changed could never move
the calorie target — onboarding collected the profile once and there was no route
back to it.

**The permissions section is gone** from the You screen. Every row read "Not
asked", because the app asks at the moment of use and none of those moments has
arrived — three rows of furniture answering a question nobody had, and the one
place a user could get the impression something had been granted.

---

## 3. The backend a build talks to is no longer a thing to remember

`BACKEND` was a constant flipped by hand before a release build and flipped back
after. It is now derived:

```ts
const BACKEND: Backend = __DEV__ ? OVERRIDE ?? 'local' : 'staging';
```

Debug builds talk to the machine they were built on; anything handed to somebody
else talks to the deployed box. `OVERRIDE` (null by default) points a **debug**
build at staging for an afternoon and deliberately cannot reach a release build.

The asymmetry is the point. Forgetting toward local costs a confusing morning.
Forgetting toward release ships an app that cannot talk to anything:
`usesCleartextTraffic` is FALSE in release builds, so a shipped app pointed at
`localhost` gives a socket that never connects, no error beyond that, and works
perfectly on the desk it was built on.

`__tests__/config.test.ts` holds the rule — a release build must carry no
localhost, must be `https://`, and must not need a cable. Verified by mutation:
replacing the expression with a constant fails it.

---

## 4. Current environment state

| | |
|---|---|
| **App points at** | **Decided by the build** — debug → local, release → staging. `nutricheck/src/config.ts` |
| **Staging** | `https://3-6-120-121.sslip.io` — probed live this session: `/health/live` and `/health/ready` both 200, database up at 1 ms, Redis 0 ms, valid certificate |
| **Migrations on disk** | Through **0011** (`0010_food_ideas_step`, `0011_profile_name`) |
| **API tests** | 116 unit + 12 ingest, green, run with `--force` so nothing came from turbo cache. **Integration not run** — needs Postgres |
| **Mobile tests** | **138 across 10 suites, green.** The previous handoff's "not run all session" is closed |
| **Android release APK** | Builds with no signing setup — the release type is signed with the **debug keystore** (RN template default). `enableProguardInReleaseBuilds = false`. `versionCode 1` |

---

## 5. Traps found this session

- **`undefined` cannot clear a field through a merging save.** The profile save
  is `{ ...existing, ...patch }` server-side, and `JSON.stringify` drops
  undefined keys — so a cleared surname changed nothing and reappeared on the
  next load. Absent and null now mean different things on the wire: absent is "I
  am not saying anything about this field", `null` is "there is none". The
  contract is `NameField.nullish()` for that reason and no other.
- **A `Field` renders three nodes carrying `onChangeText`** — the component, its
  inner view, and the input. So `findAll(...)[1]` is still the *first* field, and
  a test typing into it is quietly typing in the wrong box. Two of this session's
  tests passed for the wrong reason before this was caught. Select by
  accessibility label.
- **`maxLength` bounds what can be TYPED and nothing else.** A prefill, a
  remembered phrase, and dictation appending to a sentence already in the box all
  arrive in code and sail past it. Dictation is the one that could actually reach
  the cap, since it appends and then navigates straight to the resolver.
  `capPhrase` in `lib/format.ts` covers all three, cutting at a word boundary —
  what is left goes to a model, and a sentence ending mid-word invites it to
  guess at a food nobody said.
- **turbo reports FULL TURBO on a stale cache.** A typecheck that "passed" in
  133ms had not looked at the edited files. Use `--force` when the answer
  matters.
- **`git stash` in a tree with concurrent edits stashes somebody else's work
  too.** A lint comparison against HEAD looked like a regression and was not.

---

## 6. Open, in rough priority order

1. **Confirm the `f444e85` staging deploy and migration 0011** (§1). Everything
   about the name feature is silently a no-op until it lands.
2. **Lint is red: 4 errors, all unused identifiers.** `countItems`
   (ComposerScreen), `Button` (SearchScreen), `Gap` (CalendarScreen), `Press`
   (HomeScreen). The last two are from in-flight work — deleting an import from a
   half-written file risks removing something about to be used. If CI ever runs
   `npm run check`, it fails at lint before reaching the tests.
3. **The API cannot lint at all.** `apps/api` has an `eslint` script, no eslint
   dependency and no config; `npx` fetches 10.9.1 from the registry and exits.
   (The previous handoff's item 9 was half right: **mobile** lint works and is in
   devDependencies.)
4. **Integration tests have not run since the schema changed.** 0010 and 0011
   both touch tables they exercise.
5. **`Change password` is a live stub** on the You screen. `ChangePasswordRequest`
   already exists in the auth contract, so this one is a screen away from
   working.
6. **Export, privacy, delete account are stubs too** (`onPress={() => {}}`).
   Those need endpoints, not just screens.
7. **A production keystore.** The release APK is signed with the debug key —
   fine for testers, rejected by Play, and an app signed with a different key
   later cannot upgrade over it. Bump `versionCode` too, or a second APK is
   refused as a downgrade.
8. **`/v1/ai-meal` prompt quality**, unchanged from the last handoff: the summary
   restates the sentence instead of giving the energy figure, and coconut chutney
   came back at 100 kcal/100 g against a real ~190.
9. **The targets prompt needs watching** — caught once returning 2,280 against a
   calculated 2,294 and calling it an adjustment. Guarded now, still the failure
   mode to watch.
10. **`identify()` + `ai_food_matches` are built and unreachable.**
11. **~100 Tamil produce aliases.** 25 of 7,928 USDA rows carry one.
12. **`I forgot my password` is still a dead link.** No reset endpoint exists; a
    forgotten password is an unrecoverable account.
13. **The legal links are unverified.** `src/lib/legal.ts` points at
    `nutricheck.app/privacy` and `/terms`, which are a guess from the API's
    problem-type domain. Nothing is published there.

---

## 7. Decisions taken this session

- **A surname is asked for and never required.** The app says the first name back
  to people and has no use for the second, so requiring it would cost completed
  signups to collect something nothing reads. Nothing is enforced about the shape
  of either: every rule anyone has written about what a name may contain is wrong
  for somebody, and being told your own name is invalid is a poor first thing for
  an app to say to you.
- **Saving the profile recalculates the targets, and says so first.** That is the
  point — a weight change that did not move the calorie target would be a lie —
  but it also replaces a target set by hand on the targets screen. The editor
  shows a card saying so when an override is in force, rather than explaining
  afterwards.
- **The uppercase button treatment is not optional.** Consistency across the app
  beat per-screen judgement about which button deserved emphasis, because the
  per-screen judgement is what produced two different-looking controls doing the
  same job.
- **Two commits carry work this session did not write.** The calendar, ideas and
  voice screens on mobile, and the ai-meal, logs and ideas work on the API, were
  uncommitted in the trees when "push everything" was asked for. They could not
  be separated by file — several files carry both — so each commit body says so
  rather than implying authorship. **That code is on staging unreviewed.**
