/**
 * Text normalization for the trigram index.
 *
 * `search_text` is precomputed at ingest rather than derived in the query, so
 * the GIN index is over exactly the bytes the query compares against. Doing it
 * with an expression in the WHERE clause instead would either bypass the index
 * or require a functional index kept in sync by hand.
 */
export function normalizeSearchText(name: string, brand?: string | null): string {
  const parts = [name, brand ?? ''].filter(Boolean).join(' ');
  return parts
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents: "puree" must match "purée"
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * USDA descriptions are written back-to-front for sorting — "Apples, raw, with
 * skin" rather than "raw apples with skin". People type the front of that
 * string, so the leading segment carries most of the signal.
 *
 * We keep the full description as the display name and additionally fold the
 * segments into search_text, so "raw apple" and "apple" both hit.
 */
export function usdaDisplayName(description: string): string {
  return description.trim();
}

export function usdaSearchText(description: string): string {
  const segments = description.split(',').map((s) => s.trim()).filter(Boolean);
  // Leading segment repeated: trigram similarity is a ratio over the whole
  // string, so a 6-segment description otherwise dilutes the word people
  // actually typed down to near-nothing.
  const head = segments[0] ?? '';
  return normalizeSearchText([head, ...segments].join(' '));
}

/**
 * Foundation and SR Legacy are single-ingredient reference foods; FNDDS entries
 * are prepared dishes. Both are "generic" in the sense that matters for search
 * ranking: neither is a branded supermarket product.
 */
export function isGenericDataType(dataType: string): boolean {
  return dataType !== 'branded_food';
}
