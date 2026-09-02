import { assignMealDates } from '../meal-dates';

/**
 * The sentence this feature exists for: a whole day, but one lived across
 * two of them, with the date words carrying the split.
 */
const TWO_DAYS = 'nethu poori saptutten aprm innaiku rendu idli';

const TODAY = '2026-09-02';
const YESTERDAY = '2026-09-01';

function item(spokenAs: string) {
  return { spokenAs };
}

describe('assignMealDates', () => {
  it('splits two days at the words that name them', () => {
    const assigned = assignMealDates(TWO_DAYS, [item('poori'), item('rendu idli')], TODAY);
    expect(assigned.map((i) => i.date)).toEqual([YESTERDAY, TODAY]);
  });

  it('leaves everything unset when the sentence never says which day', () => {
    const assigned = assignMealDates('two dosai and chutney', [item('dosai'), item('chutney')], TODAY);
    expect(assigned.map((i) => i.date)).toEqual([null, null]);
  });

  it('reads a lone "yesterday" as everything before the next marker', () => {
    const assigned = assignMealDates('nethu rendu dosai and chutney', [item('dosai'), item('chutney')], TODAY);
    expect(assigned.map((i) => i.date)).toEqual([YESTERDAY, YESTERDAY]);
  });

  it('reads English and Tamil naming the same days', () => {
    const assigned = assignMealDates(
      'yesterday I had idli, today curd rice',
      [item('idli'), item('curd rice')],
      TODAY,
    );
    expect(assigned.map((i) => i.date)).toEqual([YESTERDAY, TODAY]);
  });

  it('says nothing about an item whose words are not in the sentence', () => {
    // A name the model wrote rather than heard. There is no position for it,
    // so there is nothing honest to say about which day it belongs to.
    const assigned = assignMealDates(TWO_DAYS, [item('protein shake')], TODAY);
    expect(assigned[0]!.date).toBeNull();
  });

  it('does not read a food name as a date word', () => {
    // "netrukku" contains "netru" as a substring, not as a token — whole
    // tokens only, same rule as the meal-slot matcher.
    const assigned = assignMealDates('netrukku dosai and chutney', [item('netrukku dosai')], TODAY);
    expect(assigned[0]!.date).toBeNull();
  });

  it('finds an item whose spacing does not match the sentence', () => {
    const [assigned] = assignMealDates(TWO_DAYS, [item('rendu idli')], TODAY);
    expect(assigned!.date).toBe(TODAY);
  });

  it('reads "yesterday" in Tamil script, not only in Tanglish', () => {
    // The transcript this shipped for: "நேத்து ஒரு நாலு முட்டை சாப்பிட்டேன்"
    // ("Yesterday I ate four eggs"), heard entirely in Tamil script rather
    // than transliterated. A marker list holding only the Latin spelling
    // matched none of it, and the item fell back to whichever day was
    // selected on Home instead of the day that was actually said.
    const [assigned] = assignMealDates(
      'நேத்து ஒரு நாலு முட்டை சாப்பிட்டேன்',
      [item('முட்டை')],
      TODAY,
    );
    expect(assigned!.date).toBe(YESTERDAY);
  });
});
