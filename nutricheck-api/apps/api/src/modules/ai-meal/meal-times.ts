import type { MealSlot } from '@nutricheck/contracts';

/**
 * Which meal each item belongs to, read out of the sentence itself.
 *
 * The model is asked for this and usually answers, but "usually" is not good
 * enough for the thing that decides where somebody's whole day is filed — and
 * the failure is silent: every item comes back with meal null, the client falls
 * back to the clock, and a day narrated at midday lands as one enormous lunch.
 * That is exactly what happened the first time this shipped.
 *
 * So the words get the last say. This is deterministic, testable, and reads
 * only what the person actually said: a time word in the sentence applies to
 * everything after it until the next one, which is how the sentence was spoken
 * and how anyone reading it would understand it.
 *
 * Two rules, and they are the whole design:
 *
 *  1. No time words in the sentence at all -> every slot is null, including any
 *     the model supplied. A model asked about a meal will read idli as
 *     breakfast at nine at night; a slot with nothing behind it in the sentence
 *     is the app inventing a fact about somebody's day. Null means "ask the
 *     clock", which is the only thing that knows.
 *  2. Time words present -> a slot the model gave is kept (it read the whole
 *     sentence, including phrasing this cannot), and anything left null is
 *     filled from the position of the item's own words.
 */

/**
 * The words people actually mark time with, in the three languages one sentence
 * can arrive in. Matched as whole tokens, never substrings — "rava" must not
 * become "ravu", and a food name must never be read as a clock.
 *
 * Spellings, not lemmas. This is transcribed speech: "kaalaila", "kalaila" and
 * "kaalayila" are the same word said by three people and typed by one model,
 * and a list that only holds the dictionary form matches none of them.
 */
const MARKERS: ReadonlyArray<{ slot: MealSlot; words: readonly string[] }> = [
  {
    slot: 'breakfast',
    words: [
      'kaalai',
      'kaalaila',
      'kalaila',
      'kaalayila',
      'kalayila',
      'kaalambara',
      'kalambara',
      'morning',
      'breakfast',
      'tiffin',
      'tiffen',
    ],
  },
  {
    slot: 'lunch',
    words: [
      'mathiyam',
      'madhiyam',
      'mathiyaanam',
      'madhyanam',
      'matiyam',
      'mathiam',
      'afternoon',
      'lunch',
      'noon',
    ],
  },
  {
    slot: 'snack',
    words: [
      'saayangaalam',
      'saayangalam',
      'sayangalam',
      'sayangaalam',
      'evening',
      'snack',
      'snacks',
      'teatime',
    ],
  },
  {
    slot: 'dinner',
    words: [
      'iravu',
      'iravula',
      'ravu',
      'raathiri',
      'rathiri',
      'raatri',
      'night',
      'dinner',
      'supper',
    ],
  },
];

/** Every marker word, flattened once, so the scan is a map lookup per token. */
const BY_WORD = new Map<string, MealSlot>(
  MARKERS.flatMap(({ slot, words }) => words.map((word) => [word, slot] as const)),
);

/**
 * The sentence with everything but letters and digits removed, plus a map back
 * to where each surviving character came from.
 *
 * Compacting is not tidiness: a transcription writes "chickenbriyani" and the
 * model echoes "chicken briyani", or the reverse, and one space is the whole
 * difference between finding an item in its own sentence and not. Comparing
 * without spaces makes both spellings the same string.
 */
function compact(text: string): { text: string; origin: number[] } {
  const kept: string[] = [];
  const origin: number[] = [];
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower[i]!;
    if (/[a-z0-9஀-௿]/.test(ch)) {
      kept.push(ch);
      origin.push(i);
    }
  }
  return { text: kept.join(''), origin };
}

/** Where each time word sits, as an index into the compacted sentence. */
function markersIn(phrase: string): Array<{ at: number; slot: MealSlot }> {
  const { text, origin } = compact(phrase);

  // Position in the ORIGINAL string -> position in the compacted one, so a
  // token found by word boundaries can be compared against compacted items.
  const compactIndexOf = new Map<number, number>();
  origin.forEach((originalIndex, compactIndex) => {
    compactIndexOf.set(originalIndex, compactIndex);
  });

  const found: Array<{ at: number; slot: MealSlot }> = [];
  const token = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = token.exec(phrase)) !== null) {
    const slot = BY_WORD.get(match[0].toLowerCase());
    if (!slot) continue;
    const at = compactIndexOf.get(match.index);
    if (at !== undefined) found.push({ at, slot });
  }

  // Sorted by where they were said. `exec` already walks left to right, but
  // the ordering is what everything below depends on, so it is asserted here
  // rather than assumed of a regex.
  return found.sort((a, b) => a.at - b.at);
  // `text` is unused here on purpose — the caller compacts once and reuses it.
}

/**
 * Fill in each item's meal from the sentence.
 *
 * Takes only what it needs — the words each item came from — so it can be
 * tested on plain data and cannot accidentally read a nutrient.
 */
export function assignMealTimes<T extends { spokenAs: string; meal: MealSlot | null }>(
  phrase: string,
  items: readonly T[],
): T[] {
  const markers = markersIn(phrase);

  // Nothing in the sentence says when. Anything the model offered here was
  // guessed from the food, and a guessed slot is worse than no slot: the
  // client's fallback is the clock, which at least knows what time it is.
  if (markers.length === 0) return items.map((item) => ({ ...item, meal: null }));

  const { text } = compact(phrase);

  return items.map((item) => {
    if (item.meal) return { ...item };

    const needle = compact(item.spokenAs).text;
    const at = needle.length > 0 ? text.indexOf(needle) : -1;
    // The words are not in the sentence — a name the model wrote rather than
    // heard. Nothing honest can be said about when it was eaten.
    if (at === -1) return { ...item, meal: null };

    let slot: MealSlot | null = null;
    for (const marker of markers) {
      if (marker.at < at) slot = marker.slot;
      else break;
    }
    return { ...item, meal: slot };
  });
}
