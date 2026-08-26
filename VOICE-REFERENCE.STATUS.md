# Voice reference — what `C:\Ai_Chat_bot-` does, and what NutriCheck should take

**Written:** 2026-08-26 · **Reference:** `C:\Ai_Chat_bot-` (FastAPI + React + Google Gemini)
· **Subject:** [nutricheck/src/lib/speech.ts](nutricheck/src/lib/speech.ts), [docs/BACKEND.md](docs/BACKEND.md) §5

Read at the request to use that app as a reference for speech recognition. Every
claim below was read out of its source, not inferred from its README.

> **Superseded in part, 2026-08-26.** §6 recommended keeping dictation
> on-device and building a WER harness before moving anything. **That
> recommendation was overridden and the move was made** — dictation is now
> server-side and unconditional, with no on-device path at all. The reasoning
> in §6 is left intact rather than rewritten, because the costs it names are
> real and were accepted knowingly: dictation needs the network now, takes
> ~5 s instead of being instant, and sends audio off the device.
>
> What §3 got right survived the move: the domain steer, the two-duration turn
> detector, and the RMS-versus-peak point — which was then re-learned the hard
> way, see MOBILEAPP.STATUS.md. The WER harness in §3.4 is **still not built**,
> and is now the only way to know whether any of this is actually more accurate.

Siblings: [BACKEND.STATUS.md](BACKEND.STATUS.md) · [MOBILEAPP.STATUS.md](MOBILEAPP.STATUS.md) · [GAP-REPORT.STATUS.md](GAP-REPORT.STATUS.md)

---

## 1. The headline

That app puts **speech recognition on the server**; NutriCheck puts it **on the
device**. This is the single structural difference, and everything else follows
from it.

It is also a decision NutriCheck has already written down — BACKEND.STATUS.md §5:

> **Voice is not a backend feature.** The device transcribes; the backend
> receives text with `source: 'voice'` as a label. `/v1/resolve` returns **415**
> for audio. That is the design, not a gap.

The reference app is evidence that the other choice works, and works
specifically well for the case NutriCheck cares most about. It is not by itself
a reason to switch. §6 lays out the actual trade.

---

## 2. Two independent pipelines, not one

Worth separating, because only one of them is relevant to NutriCheck.

### A. Batch transcription — `POST /transcribe`

Record a clip → upload → transcribe → text into the chat box. The relevant one.

1. `routes/transcribe.py` — 15 MB cap, rate-limited, writes to a temp file and
   **always removes it** in a `finally`. No audio persists.
2. `services/transcription.py::_convert_to_wav` — PyAV decodes whatever the
   browser produced (webm/opus from Chrome, mp4/aac from Safari) into **mono
   16 kHz WAV**, so the server never tracks which recording formats the model
   accepts.
3. **One** Gemini call does three jobs at once: detect language, transcribe
   literally, and rewrite into clean English. Output is three fixed lines
   (`LANGUAGE:` / `RAW:` / `QUESTION:`) parsed by regex.

### B. Live voice — `WS /ws/voice` (Gemini Live)

Bidirectional streaming audio with barge-in, tool-calling into their SQL layer.
**Not relevant to NutriCheck** — logging a meal is a one-shot utterance, not a
conversation, and the confirm sheet is the interaction. Skimmed, not mined.

Its documentation is unusually honest and worth one look for the discipline:
a compound question was live-tested 5×, and **only 1 in 5** correctly called the
tool — the rest fabricated numbers or literally spoke `query_business_database(...)`
aloud. They wrote that down next to the mitigation and labelled it
"prompt-level mitigation, not a guarantee."

---

## 3. The four things worth stealing

### 3.1 The domain steer — highest value, lowest cost

Their transcription prompt tells the model what the app is *about* before it
listens:

> "You are transcribing a spoken question for a business/accounting assistant
> that answers questions about revenue, profit, loss, expenses…"

The comment records why, from real testing: **"what is the profit" was coming
back as "what do you prefer"** — two ordinary, similar-sounding phrases, split
by domain knowledge alone.

They previously did this cleanup in a separate `query_normalizer.py` stage and
deleted it, with this reasoning:

> doing it in the same pass the model already listens to the audio in means it
> can weigh the actual acoustics against domain plausibility together, rather
> than correcting a transcript it can no longer double-check against the sound.

**That is the whole argument for server-side ASR, stated better than I would
state it.** NutriCheck's food vocabulary is exactly this problem: "dosai",
"pongal", "rendu" and "arai" are all more plausible to a food-aware listener
than to a general one. Android's recogniser cannot be told what the app is
about — there is no such extra.

### 3.2 The silence guard — a hallucination brake

`SILENCE_RMS_THRESHOLD = 150` (int16, max 32767), checked on the decoded samples
**before** the model is called. The comment says why:

> a real, observed failure mode is Gemini confidently "transcribing" a
> plausible-sounding business question out of pure silence

Calibrated, not guessed: true digital silence measured 0, real speech 1800–2700.

**This matters more for NutriCheck than for them.** Invariant #2 is *never
invent an amount*; an ASR that invents a whole food from room noise is strictly
worse, and it would arrive already past the guard that protects the amount. They
call this "a deterministic guard over trusting a prompt instruction alone" —
the same instinct as the resolver's per-request Zod enum, which makes an
invented food *unrepresentable* rather than discouraged.

### 3.3 The turn detector — a sharper version of what I built

`frontend/src/utils/turnDetector.js`. This is the closest thing in the reference
to the bug you hit ("listening closing immediately").

Two durations, not one amplitude:

| | |
|---|---|
| `minSpeechDurationMs` | **250 ms of *continuous*** above-threshold audio before speech counts as started. Any dip resets the run, so two noise blips cannot add up |
| `silenceDurationMs` | **900 ms** of continuous silence after confirmed speech before the turn ends |

The bug it fixes is one I have not fully fixed in NutriCheck: a *single* ~90 ms
block of noise was enough to mark the turn as started, after which ordinary
silence immediately ended a turn nobody had spoken.

Two design notes I'd copy:

- **Deliberately a duration fix, not an amplitude one.** Raising the threshold
  instead would reintroduce an earlier bug where a quiet opening word never
  registered. They fixed one bug without un-fixing the other.
- **Extracted as a pure state machine** that never reads the clock — `now` is a
  parameter. So `turnDetector.test.js` drives it with a plain counter, no
  `AudioContext`, no fake timers, and tests *the same code the component runs*.

NutriCheck's equivalent (`began` in `ComposerScreen`) is coarser: it only
distinguishes "has begun" from "has not". Android exposes `onRmsChanged`, so
this state machine is portable more or less as-is.

### 3.4 The WER benchmark — the eval harness NutriCheck doesn't have

`backend/scripts/benchmark_voice_accuracy.py`. Word Error Rate by word-level
edit distance, and three decisions worth copying:

- It calls **the real `transcribe_audio()`**, not a parallel path — "so the
  number this produces reflects what a real user actually gets."
- It scores the **cleaned** output, not the raw transcript, "since that's the
  thing accuracy matters for."
- Its own docstring undercuts it: *"This only measures what you feed it: a
  handful of clean English clips tells you little about Tamil-English
  code-mixing."*

BACKEND.STATUS.md calls an eval harness **"the highest-value missing thing"** —
without it "the model picked the wrong chicken" is an anecdote, not a number.
This is a working, copyable shape for one.

---

## 4. What does NOT transfer

- **Gemini Live / WebSocket streaming.** Wrong interaction model. A meal is one
  utterance; the confirm sheet is the conversation.
- **Their `detectLanguage`** (a Tamil-script regex for TTS voice selection).
  NutriCheck has no TTS, and `normalizeSearchText`/`isNonLatin` in
  `packages/contracts/src/text.ts` already do this better for the search case.
- **The tool-calling DB path.** NutriCheck's resolver already has the stronger
  version — a per-request Zod enum of real food ids, so the model cannot name a
  food that does not exist. Their 1-in-5 fabrication rate is exactly what that
  design prevents.
- **PyAV.** Server-side only. Irrelevant while the device transcribes.

---

## 5. What NutriCheck already does better

Stated so the comparison is fair:

- **The parse prompt.** `packages/prompts/src/parse.ts` handles Tamil script,
  Tanglish and mixed English explicitly, and enumerates counts (oru/rendu/moonu/
  arai), Tamil digits, and personal vessels (kinnam/thattu/dabara) by name. It
  is more specific about Tamil than the reference app's one-line "untangle that
  into plain English."
- **Unrepresentable errors.** The re-rank schema is a per-request enum of ids
  Postgres just returned. The reference app relies on prompt instructions and
  measured a 4-in-5 failure rate on its hard case.
- **Nothing is auto-committed.** A parse becomes a draft, never a log.

---

## 6. The decision this forces

The reference proves server-side ASR handles code-mixed Indian speech well. The
question is whether NutriCheck should move.

**For:**

- The device recogniser is now the weakest link. `en-IN` handles Tanglish only
  phonetically, and `ta-IN` needs a language pack that **may not be installed** —
  unverifiable and unfixable from inside the app.
- §3.1's argument: one pass could go **audio → resolved items**, letting the
  model weigh acoustics against food plausibility together, instead of a
  device transcript that a later prompt can no longer check against the sound.
- It would close the "is Tamil even available on this phone" hole entirely.

**Against:**

- **Cost.** Currently **$0.000385/resolve**. Audio tokens are materially more
  expensive than the ~30 text tokens a phrase costs today.
- **Latency.** Currently ~2.2 s, on top of which an upload would sit.
- **Offline.** Device ASR works with no network. Audio upload cannot. Working
  offline is a stated product property, not a nice-to-have.
- **Privacy.** Meal audio is health-adjacent. `docs/BACKEND.md` §9 already logs
  the *phrase* at `debug` only; raw audio raises that stake.
- **Integration cost, and it is not small.** `AiService` is an abstract class
  with exactly two methods — `parse(phrase)` and `rerank(items)` — both
  text-only, implemented twice (Anthropic, OpenAI-compatible). Audio means a
  third abstract method on both providers, a new content type through the
  resolver, and undoing the deliberate `415`.

### Recommendation

**Do not move transcription to the backend yet.** Take the three cheap wins
first, because two of them are worth having *whatever* you decide, and one of
them will tell you whether the move is even needed:

1. **Build the WER harness** (§3.4) against real Tamil/Tanglish/English clips of
   people naming food. Right now nobody knows how bad device transcription
   actually is — that is an anecdote, not a number, and it is the number this
   entire decision turns on.
2. **Port the turn detector** (§3.3). It is a strictly better version of the fix
   already in `useSpeech`, it is device-side, and it costs nothing per resolve.
3. **Add a silence guard** (§3.2) before anything reaches the resolver, on the
   same principle as the zero-row guards.

Then, if the harness shows device ASR failing on Tamil, the move has a measured
justification and an obvious shape: **a server-side fallback, not a
replacement** — device first, audio uploaded only when the device recogniser is
unavailable or returns nothing. That keeps offline, keeps the cost at zero for
the common path, and confines the `415` reversal to one route.
