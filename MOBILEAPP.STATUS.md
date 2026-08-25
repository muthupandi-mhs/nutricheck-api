# NutriCheck mobile — status

**Updated:** 2026-08-26 · **App:** [nutricheck/](nutricheck/) · **Backend:** [nutricheck-api/](nutricheck-api/)

Handoff note for a fresh session. Read this first, then
[nutricheck/README.md](nutricheck/README.md) for the how-to-run detail.

---

## 1. Where things stand

The React Native client is **feature-complete against the M1/M2 screen inventory**
in [docs/USER-FLOWS.md](docs/USER-FLOWS.md), running entirely on a stateful mock
backend. It has been through **two visual passes**:

| Pass | Result |
|---|---|
| v1 — editorial/Swiss, built from `design/*.dc.html` | Rejected. Read as a design exercise, not a product |
| v2 — warm & rounded, "Airbnb-level" (current) | Built, typechecks, lints, 77 tests pass. **Not yet seen on a device** |

### The one thing that is not verified

**The v2 UI has never been rendered on real hardware.** The arm64 APK is built
(`nutricheck/android/app/build/outputs/apk/debug/app-debug.apk`, 53 MB,
26 Aug 02:07) and the install command was interrupted before it ran.

**First job in the next session:** install it and look at it. See §6.

Everything else below is verified: `npm run check` is green, and every screen
renders in both colour schemes under test.

---

## 2. What v2 changed, and why

The brief was: *premium, an actual mobile app, not a school/demo project. Do not
follow `design/` — those artboards were only for testing the flow.*

Direction chosen (confirmed with the user): **warm & rounded, Airbnb-adjacent.**

| | v1 (dropped) | v2 (current) |
|---|---|---|
| Canvas | `#F2F3EF` sage, hard edges | `#FBFAF7` warm paper, 20–28px radii |
| Depth | Rules and weight only | Elevation + hairline together |
| Type | 3 families (Archivo / IBM Plex Mono / Source Serif) | **One** platform sans, 9 roles |
| Accent | Teal + amber as equals | One deep green; **amber reserved for uncertainty only** |
| Structure | Single stack, no tab bar | 3 tabs + raised centre log button |
| Feel | Static | Spring press physics, haptics, gradient ring |

**Three families was the core v1 mistake.** Three voices is an editorial device;
on a phone it reads as a design exercise, because no shipping app asks you to
parse three typefaces on one screen. v2 gets hierarchy from size, weight and
colour — which is what survives at 15px on a 6-inch screen.

### The rule that outranks aesthetics

**Amber never decorates.** If something is amber, the app is saying it does not
know something: unmeasured fibre, a portion nobody stated, a low-confidence
match. Spending amber on a highlight would make the one signal that protects the
product's credibility unreadable. This is the constraint to defend hardest in any
future design change.

---

## 3. Architecture

```
nutricheck/src/
  theme/        tokens.ts · typography.ts · ThemeProvider.tsx
  lib/          format · nutrition (BMR/targets) · haptics · id
  api/          client.ts (the seam) · types.ts (wire types) · mock/
  components/   17 files — the design system
  navigation/   RootNavigator (stack) + 3-tab host
  state/        AppState (day store, undo, offline queue) · Onboarding (draft)
  screens/      onboarding · home · composer · confirm · search · entry ·
                insights · settings
```

### The backend seam — this is the important part

Screens talk to **`NutriCheckApi`** in `src/api/client.ts` and nothing else. No
screen calls `fetch`; no screen imports a fixture. Swapping in the real service
is one line in `src/App.tsx`:

```ts
const api = useMemo(() => createHttpApi(BASE_URL, getToken), []);
```

`src/api/types.ts` is a hand-mirrored copy of
[nutricheck-api/packages/contracts/src/](nutricheck-api/packages/contracts/src/).
It exists only because the app still has its own git repo. Once the two share a
workspace, delete it and re-export from `@nutricheck/contracts`.

**The v2 redesign touched zero files under `api/`, `lib/` or `state/`.** That was
the payoff of the seam and it should stay true for any v3.

### The mock is stateful, not a stub

`src/api/mock/` holds real state: a commit lands, undo removes it, a portion
correction trains `user_portions` so the *next* parse of the same word is right.
`resolver.ts` stands in for `POST /v1/resolve` — not a model, but it produces the
same distribution of quantity shapes, so every branch of the confirm sheet is
reachable from something you can type.

Settings → Developer switches failure scenarios at runtime (offline, resolver
timeout, unparsed, quota, empty search, first run) — one per row of
USER-FLOWS §8.

---

## 4. Design system reference

**Tokens** — `src/theme/tokens.ts`. Never hardcode a hex or a size.

- Palette: `canvas / surface / sunken / border / ink{,Secondary,Tertiary} /
  primary / primarySoft / ring{From,To} / attention / danger / glyph[]`
- Radius `xs 8 · sm 12 · md 16 · lg 20 · xl 28 · pill`
- Elevation `e1 / e2 / e3` — warm-tinted shadows, `elevation` on Android
- Space 4→40, `gutter: 20`
- Motion: springs for finger-initiated, durations for system-initiated

**Type** — `src/theme/typography.ts`, nine roles:
`display · h1 · h2 · h3 · bodyLg · body · bodySm · label · labelSm · caption ·
overline`. Access only via `<Txt role="…" tone="…">`.

Brand face is a one-line swap: set `BRAND` in `typography.ts` after dropping
files into `src/assets/fonts/` and running `npx react-native-asset`. Inter is the
closest match to the current platform-sans look.

**Components worth knowing:**

- `Press` — the single pressable. Spring to 97.5% + optional semantic haptic.
  Everything tappable routes through it.
- `Ring` — gradient calorie ring, counts **down**, does not wrap on overshoot.
- `FoodGlyph` — tinted category glyph on every food row. Tint is hashed from the
  food id so it is stable across screens and sessions. **This is the single
  highest-leverage detail in the redesign** — it is what stops the lists reading
  as a spreadsheet.
- `Meter` — protein/fibre bar, carries the "N items unmeasured" note.
- `Chip` variant `ask` — dashed amber, the empty portion prompt.
- `TabBar` — 3 tabs + raised centre FAB that pushes the composer onto the parent
  stack (not a tab, deliberately).

---

## 5. Product invariants — do not regress these

These came from `docs/`, are enforced in code, and are covered by tests.

1. **Unknown fibre is never zero.** `fiberG` is null exactly when `fiberState ===
   'unknown'`; such items are excluded from the numerator and counted in
   `fiberUnmeasuredItems`. Coercing to 0 g under-reports every affected day
   invisibly.
2. **Never invent an amount.** "Some nuts" → `none_given`, empty focused chip.
   An unlearned personal unit ("a bowl") gets a *range*, never a number.
3. **Never auto-commit a parse.** Not on high confidence, not on a repeat.
4. **Never lose the user's words.** Every failure path keeps the phrase and lands
   on search with it pre-filled. Offline commits queue rather than erroring.
5. **The ring counts down.** "637 left" answers the question they opened the app
   with.
6. **Calorie target is floored at BMR**, and the UI says so rather than silently
   clipping.

---

## 6. Next session — start here

```bash
cd "c:/Projects/New folder/nutricheck"
npm run check                     # typecheck + lint + 77 tests (should be green)
```

**Then get v2 onto the phone and look at it:**

```bash
export MSYS_NO_PATHCONV=1
export JAVA_HOME="C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot"

npx react-native start            # Metro, port 8081
D=000553428000745                 # the A142, arm64-v8a, Android 16

# Streamed install has failed on this cable; push + pm install is reliable:
adb -s $D push android/app/build/outputs/apk/debug/app-debug.apk /data/local/tmp/nc.apk
adb -s $D shell pm install -r -t /data/local/tmp/nc.apk
adb -s $D reverse tcp:8081 tcp:8081
adb -s $D shell am start -n com.nutricheck/.MainActivity
```

Screenshot loop (`-p` needs `MSYS_NO_PATHCONV=1` or Git Bash rewrites the path):

```bash
adb -s $D shell screencap -p /sdcard/nc.png && adb -s $D pull /sdcard/nc.png ./nc.png
```

Review in this order — these are the screens the redesign is judged on:
**Today → Composer → Confirm sheet → Search → Insights.** Check both colour
schemes; the phone is currently set to dark.

---

## 7. Environment gotchas (all real, all hit at least once)

| Problem | Fix |
|---|---|
| `JAVA_HOME` points to `…\Android Studio\jbr`, which does not exist | Override per-command as above. **Worth fixing system-wide.** |
| `adb install` fails with an *empty* error message | The USB link drops mid-transfer. Use `push` + `pm install`. Consider a different cable. |
| Phone shows `unauthorized`, or vanishes from `adb devices` | `adb kill-server && adb start-server` after Windows enumerates it. Check Windows sees "ADB Interface" via `Get-PnpDevice`. |
| `adb reverse` lost after a USB re-enumeration | Re-run it; Metro will otherwise show "Unable to load script". |
| Android 16 shows a local-network-access prompt on first launch | Expected — it is the debug build reaching Metro. Manifest declares only `INTERNET`. |
| Emulator `nutricheck_x86_64` exists but boots slowly under software GL | Prefer the physical device. Delete with `avdmanager delete avd -n nutricheck_x86_64`. |
| Metro wedged on 8081 | Kill the stale node process and restart; a wedged Metro returns nothing for `/index.bundle`. |

Native deps added this round (**require a rebuild, not just a Metro restart**):
`react-native-linear-gradient`, `react-native-haptic-feedback`,
`@react-navigation/bottom-tabs` (JS-only). Earlier: `react-native-screens`,
`react-native-svg`, `@react-navigation/native{,-stack}`.

---

## 8. Tests — 77, five suites

| Suite | Covers |
|---|---|
| `nutrition.test.ts` | scale/total arithmetic, unknown-fibre exclusion, BMR floor |
| `resolver.test.ts` | quantity types + every contract invariant on `Quantity` |
| `mockApi.test.ts` | auth, day/commit/undo, frozen entries, failure paths, learning |
| `screens.test.tsx` | all 15 screens rendered past loading, **light and dark** |
| `App.test.tsx` | full-tree boot smoke |

Tests have caught three real bugs so far — a resolver that invented a portion
from a food-name collision, a silent sign-up block, and a fresh account showing
seeded history. Keep adding to them rather than around them.

---

## 9. Open work

**Blocking review**
- [ ] Install v2 on the device and evaluate it (§6)

**Known gaps**
- [ ] Brand typeface not bundled — currently platform sans (`BRAND` in
      `typography.ts` is the switch)
- [ ] "Save as a meal" on entry detail is a no-op button
- [ ] Export / delete account / change password rows are no-ops
- [ ] Forgot-password flow is a no-op
- [ ] No offline persistence — the queue in `AppState` is in-memory only, so a
      cold start loses queued commits. Needs AsyncStorage or MMKV before this is
      honest about "nothing is ever lost".
- [ ] `httpApi` against `nutricheck-api` not written; mock is still the only
      implementation
- [ ] Photo logging is parked by design (see USER-FLOWS §1), not missing

**Decisions already made — do not relitigate without reason**
- Email + password only. Apple/Google are in the `auth_provider` enum but not in
  this build; the contract says so explicitly.
- No tab for logging — it is a raised centre action pushing onto the parent stack.
- Ring uses round caps (v1 used butt caps on an honesty argument; the overhang is
  ~1% and every credible fitness ring rounds). Honesty is spent on the fibre
  denominator instead.
- `react-native-reanimated` deliberately **not** added — the animation surface is
  small enough that RN `Animated` covers it without the build risk.
