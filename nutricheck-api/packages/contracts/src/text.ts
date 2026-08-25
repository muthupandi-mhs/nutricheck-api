/**
 * Search-text normalization. **One definition, used by both the ingest and the
 * query** — if these two ever diverge, the query compares against bytes the
 * index was never built over and matches silently stop happening.
 *
 * It lives in contracts rather than in either consumer for exactly that reason.
 */

/**
 * Scripts we deliberately keep.
 *
 * The original implementation was `[^a-z0-9\s]` and it deleted every non-Latin
 * character, so "தோசை" normalized to the empty string and could never match
 * anything. That is not a tuning problem — the query is erased before it is
 * ever compared.
 *
 * `\p{L}` keeps every Unicode letter, `\p{N}` every digit, and `\p{M}` the
 * combining marks Indic scripts need: Tamil வowel signs are separate code
 * points, so stripping marks would turn "தோசை" into "தசை", a different word.
 */
const KEEP = /[^\p{L}\p{N}\p{M}\s]/gu;

/**
 * Latin accents are folded (café -> cafe) because people type them
 * inconsistently. Indic combining marks are NOT — they are load-bearing, not
 * decoration. NFKD then removing only the Latin-1 range does both.
 */
const LATIN_DIACRITICS = /[̀-ͯ]/g;

export function normalizeSearchText(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => Boolean(p))
    .join(' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(LATIN_DIACRITICS, '')
    // Recompose so Tamil letters are single code points again, matching how
    // they arrive from a keyboard and how Postgres stores them.
    .normalize('NFC')
    .replace(KEEP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a string contains no Latin letters — a Tamil-script query, say.
 *
 * Trigram similarity works on any script, but a corpus row whose `search_text`
 * is pure Latin can never match one, so the caller can decide whether to fall
 * back to the alias table rather than returning nothing.
 */
export function isNonLatin(text: string): boolean {
  return text.length > 0 && !/\p{Script=Latin}/u.test(text);
}
