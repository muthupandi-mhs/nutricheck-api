/**
 * Which calendar day each item belongs to, read out of the sentence itself.
 *
 * The model is never asked. Unlike meal slot — where "morning" and "before I
 * left for work" are both time words a model might catch and a fixed list
 * might miss — "today" and "yesterday" are a closed, unambiguous set in any
 * language a sentence here arrives in. There is nothing a model adds by being
 * asked, and asking it would mean trusting an LLM with the one fact that
 * decides which day's total gets permanently wrong.
 *
 * Same rule as meal slot, because it is the same sentence: a date word
 * applies to everything after it until the next one, which is how the
 * sentence was spoken and how anyone reading it back would understand it.
 * No date words anywhere -> every item's date is null, and the client falls
 * back to whichever day was selected when the sheet was opened.
 */

/**
 * The words people mark a day with. Matched as whole tokens, same spirit as
 * `meal-times.ts`'s MARKERS: spellings as they are actually transcribed, not
 * a dictionary form.
 *
 * Both scripts, deliberately. The transcript is not always Tanglish —
 * "நேத்து ஒரு நாலு முட்டை சாப்பிட்டேன்" comes back in Tamil script when the
 * model heard it that way, and a marker list holding only the Latin spelling
 * matches none of it. Whole tokens, so this reads the same as any other word
 * here; `\p{L}` already covers the Tamil block and `compact()` already keeps
 * it, so nothing else needed to change to read it.
 */
const DATE_MARKERS: ReadonlyArray<{ offsetDays: number; words: readonly string[] }> = [
  {
    offsetDays: 0,
    words: ['today', 'innaiku', 'innaikku', 'inniku', 'iniku', 'இன்று', 'இன்னைக்கு', 'இன்னிக்கு'],
  },
  {
    offsetDays: -1,
    words: ['yesterday', 'nethu', 'netru', 'nerathu', 'நேற்று', 'நேத்து'],
  },
];

/** Every marker word, flattened once, so the scan is a map lookup per token. */
const BY_WORD = new Map<string, number>(
  DATE_MARKERS.flatMap(({ offsetDays, words }) => words.map((word) => [word, offsetDays] as const)),
);

/** Every date word, flattened, for callers that need to strip them from a food-memory key. */
export const DATE_WORDS: ReadonlySet<string> = new Set(DATE_MARKERS.flatMap((m) => m.words));

/**
 * The sentence with everything but letters and digits removed, plus a map
 * back to where each surviving character came from.
 *
 * Duplicated from `meal-times.ts` rather than shared: the two files read
 * different lexicons for different purposes, and the function itself is four
 * lines — sharing it would buy one import at the cost of coupling two things
 * that should be free to change independently.
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

/** Where each date word sits, as an index into the compacted sentence. */
function markersIn(phrase: string): Array<{ at: number; offsetDays: number }> {
  const { origin } = compact(phrase);

  // Position in the ORIGINAL string -> position in the compacted one, so a
  // token found by word boundaries can be compared against compacted items.
  const compactIndexOf = new Map<number, number>();
  origin.forEach((originalIndex, compactIndex) => {
    compactIndexOf.set(originalIndex, compactIndex);
  });

  const found: Array<{ at: number; offsetDays: number }> = [];
  // `\p{M}` alongside `\p{L}`: Tamil vowel signs and the virama (் ே ா ு …)
  // are Unicode MARKS, not letters, and `நேத்து` is a letter, a mark, a
  // letter, a mark, a letter, a mark. Without this a word regex only matches
  // isolated letters between them — "ந", "த", "த" — none of which is ever
  // the word "நேத்து", and no marker in Tamil script can ever be found.
  const token = /[\p{L}\p{M}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = token.exec(phrase)) !== null) {
    const offsetDays = BY_WORD.get(match[0].toLowerCase());
    if (offsetDays === undefined) continue;
    const at = compactIndexOf.get(match.index);
    if (at !== undefined) found.push({ at, offsetDays });
  }

  // Sorted by where they were said. `exec` already walks left to right, but
  // the ordering is what everything below depends on, so it is asserted here
  // rather than assumed of a regex.
  return found.sort((a, b) => a.at - b.at);
}

/**
 * `today` plus a day count, in the user's own calendar.
 *
 * No timezone arithmetic needed: `today` already arrived as the caller's
 * resolved local day, so this is plain date-part arithmetic on it.
 */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(y!, m! - 1, d! + n);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${shifted.getFullYear()}-${p(shifted.getMonth() + 1)}-${p(shifted.getDate())}`;
}

/**
 * Fill in each item's date from the sentence, anchored to the caller's own
 * "today".
 *
 * Takes only what it needs — the words each item came from — so it can be
 * tested on plain data and cannot accidentally read a nutrient.
 */
export function assignMealDates<T extends { spokenAs: string }>(
  phrase: string,
  items: readonly T[],
  today: string,
): (T & { date: string | null })[] {
  const markers = markersIn(phrase);

  // Nothing in the sentence says which day. Null means "ask the selected
  // day", which is the only thing that knows.
  if (markers.length === 0) return items.map((item) => ({ ...item, date: null }));

  const { text } = compact(phrase);

  return items.map((item) => {
    const needle = compact(item.spokenAs).text;
    const at = needle.length > 0 ? text.indexOf(needle) : -1;
    // The words are not in the sentence — a name the model wrote rather than
    // heard. Nothing honest can be said about when it was eaten.
    if (at === -1) return { ...item, date: null };

    let offsetDays: number | null = null;
    for (const marker of markers) {
      if (marker.at < at) offsetDays = marker.offsetDays;
      else break;
    }
    return { ...item, date: offsetDays === null ? null : addDays(today, offsetDays) };
  });
}
