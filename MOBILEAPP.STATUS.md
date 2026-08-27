# NutriCheck mobile — status

**Updated:** 2026-08-26 · **App:** [nutricheck/](nutricheck/) · **Backend:** [nutricheck-api/](nutricheck-api/)

Handoff note for a fresh session. Read this first, then
[nutricheck/README.md](nutricheck/README.md) for the how-to-run detail.

---

## 1. Where things stand

The React Native client is **feature-complete against the M1/M2 screen inventory**
in [docs/USER-FLOWS.md](docs/USER-FLOWS.md) and **runs against the real API** —
the mock backend has been deleted. It has been through **two visual passes**:

| Pass | Result |
|---|---|
| v1 — editorial/Swiss, built from `design/*.dc.html` | Rejected. Read as a design exercise, not a product |
| v2 — warm & rounded, "Airbnb-level" (current) | Built, typechecks, **109 tests pass**. Running on the device against the live API |

### The logging flow is AI-first as of 2026-08-27

The composer no longer goes to `/v1/resolve`. It calls **`POST /v1/ai-meal`**,
which reads the whole sentence with one model call and searches no corpus at
all. The corpus holds 25 Tamil aliases across 13,440 foods, so a sentence like
*"rendu muttai and 5 dosai and chutney"* matched almost nothing — and a dead end
is worse for the user than an estimate they can see is an estimate.

What that changed on screen:

- **Every number is an estimate.** A summary sentence and a one-time banner sit
  above the rows; the `~` the formatter already puts on `imputed` values is the
  per-row reminder. The draft type carries `estimated: true` as a literal, so a
  screen cannot render one without having been handed that fact.
- **The skeletons no longer fill in.** The resolver streamed because its parse
  landed before its database match; one POST has no half-answer. The sheet still
  opens immediately and echoes the phrase back.
- **The item counter is gone.** It split on commas and *and*, so it read
  "Rendu dosai chutney appuram sambar oothi sapten. So, how much..." as **2**
  items — from the comma in *"So,"* — with three foods in the sentence and none
  of them found. English punctuation cannot count Tamil items.
- **Dictation has a Done button.** Listening used to end only when an amplitude
  detector guessed; when it guessed wrong the only control was Cancel, which
  discards. A pause while reaching for the English word for a dish reads as an
  ending. The detector still runs — it is the shortcut, not the only exit.
- **"AI unavailable" is its own message.** No key, or a provider outage, used to
  render as "we couldn't read that — nothing in the phrase matched a food":
  wrong twice over, and the first thing any fresh environment showed.

`src/config.ts` switches backend with one constant, `BACKEND: 'staging' | 'local'`.
The `as Backend` cast on it is load-bearing — without it TypeScript narrows the
const to its literal and the other branch fails to compile as "types with no
overlap", so the switch the file exists to provide would not build.

### Device status

v2 **is installed and running on the physical device** (A142, arm64-v8a,
Android 16), talking to the live backend over `adb reverse tcp:3000 tcp:3000`.

Verified on hardware, end to end: sign-in, Today, and the full
mic → record → `/v1/transcribe` → confirm path — including a Tamil phrase
("Naan innaiku rendu dosai…") transcribed and logged.

`npm run check` is green — **107 tests**, all screens render in both colour
schemes.

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
| Structure | Single stack, no tab bar | 2 tabs + raised centre mic button; account moved to the header |
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
  lib/          format · nutrition (BMR/targets) · haptics · id · speech ·
                recorder · turnDetector · dictation
  api/          client.ts (the seam) · types.ts (wire types) · http/ (transport)
  components/   17 files — the design system
  forms/        schemas.ts (Zod) · fields.tsx (react-hook-form ↔ the field set)
  navigation/   RootNavigator (stack) + 2-tab host
  state/        AppState (day store, undo, offline queue) · Onboarding (draft)
  screens/      onboarding · home · composer · confirm · search · entry ·
                insights · settings
```

### Forms — react-hook-form + Zod

Every form in the app is a Zod schema and a `useForm` bound to it. Screens hold
no field state and write no validation.

- **`forms/schemas.ts`** is the client half of
  `nutricheck-api/packages/contracts/src`. Bounds are *copied* from the server
  contract, never invented — a rule only the client enforces is a field the user
  cannot fill, and a rule only the server enforces is a 422 they cannot read.
  Each number names its twin over there in a comment.
- **A schema's output is the wire shape.** `customFoodSchema` takes the eight
  text fields off the create-food screen and produces a `CreateCustomFood`,
  blank-means-unknown included, so no screen is left holding a half-validated
  value. `useForm<Input, unknown, Parsed>` carries that through to
  `handleSubmit`, which is handed the parsed request rather than the strings.
- **`forms/fields.tsx`** is the only place `Controller` appears. `FormField`
  wires a field's error to `Field`'s `problem`, so the amber ring and the
  sentence under it cannot come apart from the schema that decided them.
  `REVEAL_ON_SUBMIT` sets the timing for every form: silent until they press
  the button, live from then on.
- The numeric text fields exist because `keyboardType="numeric"` is a hint, not
  a restriction. A paste or a hardware keyboard reaches the field, `Number('')`
  is 0 and `Number('1.2.3')` is NaN — both silently wrong numbers in a food log.

`@hookform/resolvers`, `react-hook-form` and `zod` are the three dependencies
this added; all are JS-only, so no rebuild.

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

### The mock backend is gone

`src/api/mock/` has been **deleted**, along with the Developer scenario switcher
that drove it. There is one implementation of `NutriCheckApi` now — `http/` —
and `config.ts` has no flag to turn it off. The fixtures could never prove
anything about the transport anyway: they emitted bare problem slugs, ignored
timezones and never rotated a refresh token, which are three of the failure
modes that only appear against the real server.

Tests use two doubles instead, and the split is deliberate:

- **`__tests__/fixtures/stubApi.ts`** — a flat, stateless `NutriCheckApi` for
  *rendering*. It proves every screen survives its loading state in both colour
  schemes. It asserts nothing about behaviour.
- **`__tests__/httpApi.test.ts`** — a stubbed `fetch` for *behaviour*. The only
  place that can prove anything about the transport, and it is where the
  problem-URI stripping, the serialised refresh and the timezone injection are
  actually held.

**What was lost with the mock:** the ability to force offline, resolver timeout,
unparsed, quota and empty-search on demand — the USER-FLOWS §8 screens. Against
a real backend those states are now much harder to reach deliberately. Worth
rebuilding as a transport-level fault injector if reviewing them becomes
painful.

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
- `TabBar` — 2 tabs + raised centre MIC that pushes the composer onto the parent
  stack (not a tab, deliberately).

---

## 5. Product invariants — do not regress these

These came from `docs/`, are enforced in code, and are covered by tests.

1. **An unknown macro is never zero.** Carbs, fat and fibre each have their own
   state: the value is null exactly when that state is `'unknown'`, such items
   are excluded from that nutrient's numerator, and each is counted separately
   in `carbsUnmeasuredItems` / `fatUnmeasuredItems` / `fiberUnmeasuredItems`.
   Coercing to 0 g under-reports every affected day invisibly.

   Counted per nutrient, not shared: the item missing fibre is usually not the
   item missing carbs, and one number could not say which total to distrust.
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
npm run check                     # typecheck + lint + 107 tests (should be green)
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
| `installDebug` fails with `INSTALL_PARSE_FAILED_NO_CERTIFICATES … SHA-256 digest of contents did not verify` | **Not a signing problem** — check before chasing keystores. Verify the local APK with `apksigner verify --verbose` first; if it says `Verifies`, the file is fine and the install was corrupted on the way to a device. Root cause here: **the emulator was attached and dying**, so Gradle installed to *both* targets and one produced a torn APK — the message never says which device failed. Detach or delete the emulator, and see the ABI row below. |
| A phone **and** the emulator are both attached | Gradle installs to every attached device and reports one failure without naming it. `--deviceId=<serial>`, or stop the emulator. `adb devices -l` first — the AVD here has died mid-session more than once. |
| Phone shows `unauthorized`, or vanishes from `adb devices` | `adb kill-server && adb start-server` after Windows enumerates it. Check Windows sees "ADB Interface" via `Get-PnpDevice`. |
| `adb reverse` lost after a USB re-enumeration | Re-run it; Metro will otherwise show "Unable to load script". |
| **App says "No connection" on sign-in while the backend is plainly running** | **`adb reverse tcp:3000 tcp:3000` is missing.** Since the app talks to the real API, port 3000 needs reversing too — not just Metro's 8081/8082 — and a reconnect wipes *all* reverses. `adb reverse --list` is the check; there should be three lines. The phone's `localhost` is the phone, so with no tunnel `fetch` throws, the transport turns that into `OfflineError`, and the screen honestly reports no connection. It looks like a server outage and is not one. Verify from the device, not the host: `adb shell '(printf "GET /health/ready HTTP/1.0\r\n\r\n"; sleep 2) \| nc localhost 3000'` |
| Android 16 shows a local-network-access prompt on first launch | Expected — it is the debug build reaching Metro. Manifest declares only `INTERNET`. |
| Red screen: ``zod/v4/classic/external.js: Export namespace should be first transformed by `@babel/plugin-transform-export-namespace-from` `` | zod v4 ships `export * as core` and the RN preset does not transform that syntax. `babel.config.js` now loads the plugin explicitly. The failure is whole-app — no JS reaches the device at all — so it reads like Metro being down when Metro is fine. After changing babel config, restart Metro with `--reset-cache`. |
| Emulator `nutricheck_x86_64` exists but boots slowly under software GL | Prefer the physical device. Delete with `avdmanager delete avd -n nutricheck_x86_64`. |
| Metro wedged on 8081 | Kill the stale node process and restart; a wedged Metro returns nothing for `/index.bundle`. `curl localhost:8081/status` is the check — a healthy Metro answers `packager-status:running`, a wedged one accepts the connection and never replies, so `netstat` alone cannot tell the two apart. |
| App shows "Loading from localhost:8082" | A second Metro started on 8082 and the app latched onto it. `adb reverse` **both** ports, or kill the duplicate. |
| Fast Refresh silently not applying | Force-stop and relaunch: `adb shell am force-stop com.nutricheck && adb shell am start -n com.nutricheck/.MainActivity`. Re-run `adb reverse` first. |

### The debug APK was 188 MB; it is now 55 MB

`reactNativeArchitectures` in `gradle.properties` lists all four ABIs, so every
debug build shipped `x86`, `x86_64`, `armeabi-v7a` **and** `arm64-v8a`. The
phone (A142 / Pacman) is `arm64-v8a` only — three quarters of that payload could
not run on it, and a 188 MB streamed install is a much bigger target for a torn
transfer than a 55 MB one.

`npm run android` now passes `--active-arch-only`, which detects the attached
device's ABI per-run and builds only that. **188 MB → 54.6 MB, 71% smaller**, and
the streaming install that had been failing then succeeded first try.

The flag is dynamic, not a pin — plug in an x86_64 emulator and it builds
x86_64. `gradle.properties` is untouched, so release builds are unaffected. Note
it does *not* solve the two-device case: with a phone and an emulator attached it
detects both arches and builds both.

### Dictation is server-side now. The voice library is gone.

`@react-native-voice/voice` has been **removed**, along with its three-file
`patch-package` patch. Nothing in the app imports it. If you find a reference,
it is stale.

The short history, because it is the reason for the current design:

| Attempt | Outcome |
|---|---|
| `@react-native-voice/voice@3.2.4` (2021) | Five patches to build at all — `jcenter()`, `compileSdkVersion`, manifest `package`, `appcompat-v7`, `react-native:+`. Then it returned **null** at the JS boundary: `getName()` is `RCTVoice`, and the New Architecture stopped stripping the `RCT` prefix the old bridge stripped natively |
| Its recognition quality | The real killer. `en-IN` renders Tanglish phonetically at best; `ta-IN` needs a language pack most phones lack and no Android API can query |
| `react-native-audio-recorder-player@4.5.0` (Nitro) | Kotlin compiled after pinning Nitro to 0.29.x — then **crashed the app on launch**. `UnsatisfiedLinkError: cannot locate symbol "__cxa_init_primary_exception"`. Kotlin and C++ needed *different* Nitro versions; no single pin satisfies both |

**Both failures were ABI mismatches in code we did not control.** So the
recorder is now **ours**:
`android/app/src/main/java/com/nutricheck/recorder/RecorderModule.kt`, ~180
lines over the platform's own `MediaRecorder`. No third-party native
dependency, nothing left to mismatch.

Four things in it are deliberate:

- **`NutriCheckRecorder`, unprefixed.** Naming it `RCTFoo` is exactly what made
  the voice library resolve to null under the New Architecture.
- **`VOICE_RECOGNITION` audio source**, not `MIC` — it disables the call-tuned
  AGC and noise suppression that chew the consonants a transcriber needs.
- **16 kHz mono at 32 kbps AAC.** Speech models resample to 16 kHz anyway, and
  every extra kilobyte is billed and travels on the user's connection.
- **The clip is deleted before `stop()` resolves.** A recording of somebody
  saying what they ate is health-adjacent and has no reason to outlive the
  request that consumed it.

### End-of-turn detection: two durations, never one threshold

`src/lib/turnDetector.ts`. There is no Done button — the pause at the end of a
sentence is the signal.

The first version used a fixed amplitude threshold of 1500 and **never
stopped**. Replaying a real trace off the test device explains why:

```
1475 real samples, MediaRecorder.getMaxAmplitude() at 100ms
  quiet floor ~3400,  speech peaks ~9300

fixed threshold 1500  ->  1473/1475 samples classed as SPEECH  (100%)
adaptive (floor x1.5) ->   378 speech / 1097 silence  (26% / 74%)
```

At 100% speech a turn starts and can never end. That was not a tuning miss — it
was a broken premise: phone noise floors are not "in the low hundreds".

The deeper cause is worth remembering: **`getMaxAmplitude()` returns the PEAK of
each window, not its RMS.** Peaks are dominated by transients, so speech and
silence compress into the same band. The reference app in `C:\Ai_Chat_bot-`
computes RMS over decoded PCM, which separates them properly — moving to
`AudioRecord` and doing the same is the real fix if this stays temperamental.

Two more decisions:

- **`SILENCE_MS` is 1800, not the ~900 a chat assistant uses.** Listing a meal
  is full of pauses — "two rotis… dal… and a bowl of curd". Waiting too long
  costs a second; cutting in early costs half a meal.
- **The detector never reads the clock.** `now` is a parameter, and the native
  meter's fixed 100 ms interval doubles as the clock. That is what lets the
  tests drive it with a plain counter — no microphone, no fake timers — and the
  1,475-sample device trace is committed as a fixture two tests replay.

**Traps.** `SPEECH_RATIO` and `MIN_MARGIN` are calibrated to one room on one
device; a very different environment may need them moved. And dictation now
needs the network, which on-device recognition did not — there is a dedicated
`offline` failure that says so rather than "try again".

**Native code added this round requires a rebuild, not just a Metro restart** —
and it is ours, not a package: `com.nutricheck.recorder`, registered by hand in
`MainApplication.kt` because autolinking has nothing to find for a module that
lives in the app.

Native deps still in use: `react-native-linear-gradient`,
`react-native-haptic-feedback`, `react-native-screens`, `react-native-svg`,
`react-native-safe-area-context`, `@react-native-async-storage/async-storage`.
JS-only: `@react-navigation/*`, `axios`.

**Removed:** `@react-native-voice/voice` (and its patch),
`react-native-audio-recorder-player`, `react-native-nitro-modules`,
`react-native-fs`. `patches/` is now empty — if `patch-package` has nothing to
apply, that is correct, not a missing file.

---

## 8. Tests — 107, seven suites

| Suite | Covers |
|---|---|
| `nutrition.test.ts` | scale/total arithmetic, unknown-fibre exclusion, BMR floor |
| `httpApi.test.ts` | the real transport against a stubbed `fetch` — routes, error mapping, SSE |
| `dictation.test.ts` | recorder lifecycle and the upload to `POST /v1/transcribe` |
| `turnDetector.test.ts` | end-of-speech detection, replayed against the committed device trace |
| `screens.test.tsx` | all 15 screens rendered past loading, **light and dark** |
| `forms.test.tsx` | every schema's accepted/rejected table, plus the create-food screen driven end to end: typing, the message under each field, and the request that leaves |
| `App.test.tsx` | full-tree boot smoke |

Tests have caught three real bugs so far — a resolver that invented a portion
from a food-name collision, a silent sign-up block, and a fresh account showing
seeded history. Keep adding to them rather than around them.

---

## 9. Open work

**Blocking review**
- [ ] Install v2 on the device and evaluate it (§6)

**Known gaps**
- [ ] **Insights shows three of the five nutrients.** The macro change reached
      every other screen; `InsightsScreen.tsx` still renders calories, protein
      and fibre only. The API already sends `carbsG` and `fatG` on
      `week.averages`, `week.goal` and every `DayPoint` — the data is there and
      unused. Verified on the device 2026-08-26.
- [ ] **A goal written before migration `0004` has `carbsG`/`fatG` of 0**, so
      the two new meters read `0 / 0 g` on the Today screen for anyone who set
      a goal earlier. That is the migration's deliberate choice (zero means "no
      target set", rather than back-filling a split nobody chose) — but the
      meter renders it as a target of zero, which is not the same statement.
      Re-saving the profile writes a goal with real macro targets.
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

**Welcome screen — settled**

Went through three passes. Landed on **four elements**: brand mark, headline,
one line of subcopy, action block. Cut along the way:

- the sentence→numbers demo card — an argument aimed at somebody still
  deciding, which a user who already opened the app is not. The first real log
  makes the point better, ninety seconds later.
- "no camera, microphone or notifications" — a real differentiator, but a trust
  claim belongs where trust is being asked for. **Still owed a home on the
  account screen.**

Content is anchored to the bottom above the CTA; a full-bleed `wash` gradient
gives the empty upper half depth. `Dock` gained a `fill` prop for this — over a
gradient its opaque canvas fill cuts a visible band.

**Decisions already made — do not relitigate without reason**
- Email + password only. Apple/Google are in the `auth_provider` enum but not in
  this build; the contract says so explicitly.
- No tab for logging — it is a raised centre action pushing onto the parent stack.
- Ring uses round caps (v1 used butt caps on an honesty argument; the overhang is
  ~1% and every credible fitness ring rounds). Honesty is spent on the fibre
  denominator instead.
- `react-native-reanimated` deliberately **not** added — the animation surface is
  small enough that RN `Animated` covers it without the build risk.
