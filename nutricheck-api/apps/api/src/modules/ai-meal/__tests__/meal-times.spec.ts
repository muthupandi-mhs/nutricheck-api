import { assignMealTimes } from '../meal-times';
import type { MealSlot } from '@nutricheck/contracts';

/**
 * The sentence this feature exists for, said the way it was actually said:
 * a whole day, at once, with the time words carrying the structure.
 *
 * It shipped once trusting the model to mark the slots and everything landed
 * in one meal, because the model returned nulls and the client fell back to
 * the clock. These tests are the version that does not depend on being obeyed.
 */
const DAY =
  'innaiku kalaila lemon rice sambar apram rendu muttai and mathiyam chickenbriyani raitha and lemon sodajuice and evening vengaambajji 5 and iravu 3 sappathi';

function item(spokenAs: string, meal: MealSlot | null = null) {
  return { spokenAs, meal };
}

describe('assignMealTimes', () => {
  it('splits a whole day at the words that name the time', () => {
    const assigned = assignMealTimes(DAY, [
      item('lemon rice'),
      item('sambar'),
      item('rendu muttai'),
      item('chickenbriyani'),
      item('raitha'),
      item('lemon sodajuice'),
      item('vengaambajji'),
      item('sappathi'),
    ]);

    expect(assigned.map((i) => i.meal)).toEqual([
      'breakfast',
      'breakfast',
      // "apram" is a connector, not a new time: the eggs are still breakfast.
      'breakfast',
      'lunch',
      'lunch',
      'lunch',
      'snack',
      'dinner',
    ]);
  });

  it('finds an item whose spacing does not match the sentence', () => {
    // The transcript says "chickenbriyani" and the model echoes "chicken
    // briyani". One space is the whole difference between filing this under
    // lunch and not filing it at all.
    const [assigned] = assignMealTimes(DAY, [item('chicken briyani')]);
    expect(assigned!.meal).toBe('lunch');
  });

  it('leaves everything unset when the sentence never says when', () => {
    const assigned = assignMealTimes('two dosai and chutney', [
      item('dosai'),
      item('chutney'),
    ]);
    expect(assigned.map((i) => i.meal)).toEqual([null, null]);
  });

  it('overrules a slot the model invented from the food', () => {
    // No time word anywhere, and the model has decided idli means morning.
    // It does not: idli at nine at night is dinner, and the clock knows what
    // the model is guessing at.
    const assigned = assignMealTimes('idli and sambar', [item('idli', 'breakfast')]);
    expect(assigned[0]!.meal).toBeNull();
  });

  it('keeps a slot the model gave when the sentence does carry times', () => {
    // The model read the whole sentence, including phrasing this cannot —
    // "before I left" is a time and not a word in any list.
    const assigned = assignMealTimes(DAY, [item('lemon rice', 'lunch')]);
    expect(assigned[0]!.meal).toBe('lunch');
  });

  it('says nothing about an item whose words are not in the sentence', () => {
    // A name the model wrote rather than heard. There is no position for it,
    // so there is nothing honest to say about when it was eaten.
    const assigned = assignMealTimes(DAY, [item('protein shake')]);
    expect(assigned[0]!.meal).toBeNull();
  });

  it('does not read a food name as a clock', () => {
    // "rava" is not "ravu", and a substring match would have made this dosai
    // a dinner. Whole tokens only.
    const assigned = assignMealTimes('rava dosai and filter coffee', [item('rava dosai')]);
    expect(assigned[0]!.meal).toBeNull();
  });

  it('reads English and Tamil marking the same day', () => {
    const assigned = assignMealTimes(
      'morning idli, afternoon curd rice, night 2 chapati',
      [item('idli'), item('curd rice'), item('chapati')],
    );
    expect(assigned.map((i) => i.meal)).toEqual(['breakfast', 'lunch', 'dinner']);
  });
});
