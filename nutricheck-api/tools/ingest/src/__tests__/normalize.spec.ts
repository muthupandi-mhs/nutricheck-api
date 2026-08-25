import {
  isGenericDataType,
  normalizeSearchText,
  usdaSearchText,
} from '../normalize';

describe('normalizeSearchText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeSearchText('  Rolled   OATS  ')).toBe('rolled oats');
  });

  it('strips accents so puree matches purée', () => {
    expect(normalizeSearchText('Purée de Café')).toBe('puree de cafe');
  });

  it('replaces punctuation with spaces rather than deleting it', () => {
    // "apples,raw" must not become the single token "applesraw", which would
    // share almost no trigrams with either word the user actually types.
    expect(normalizeSearchText('Apples,raw')).toBe('apples raw');
  });

  it('folds a brand into the searchable text', () => {
    expect(normalizeSearchText('Baked Beans', 'Heinz')).toBe('baked beans heinz');
  });

  it('drops a null brand without leaving trailing space', () => {
    expect(normalizeSearchText('Oats', null)).toBe('oats');
  });
});

describe('usdaSearchText', () => {
  const description = 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw';

  it('repeats the leading segment so it is not diluted', () => {
    // USDA writes descriptions back-to-front for sorting. Without the repeat, a
    // one-word query is a vanishing fraction of a seven-segment string.
    const text = usdaSearchText(description);
    expect(text.startsWith('chicken chicken')).toBe(true);
  });

  it('keeps every segment searchable', () => {
    const text = usdaSearchText(description);
    for (const token of ['broiler', 'breast', 'skinless', 'boneless', 'raw']) {
      expect(text).toContain(token);
    }
  });

  it('handles a description with no commas', () => {
    expect(usdaSearchText('Oats')).toBe('oats oats');
  });
});

describe('isGenericDataType', () => {
  it.each(['foundation_food', 'sr_legacy_food', 'survey_fndds_food'])(
    'treats %s as generic',
    (dataType) => {
      expect(isGenericDataType(dataType)).toBe(true);
    },
  );

  it('treats branded_food as not generic', () => {
    // Generic rows outrank branded ones in search; the branded corpus
    // outnumbers the generic roughly fifty to one.
    expect(isGenericDataType('branded_food')).toBe(false);
  });
});
