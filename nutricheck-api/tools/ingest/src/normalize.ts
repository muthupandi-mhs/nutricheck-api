import { normalizeSearchText } from '@nutricheck/contracts';

export { normalizeSearchText };

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
