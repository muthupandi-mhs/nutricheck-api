import { echoes } from '../chat.service';

/**
 * The assistant is allowed to decide that a message was a meal. It is not
 * allowed to decide what the meal WAS.
 *
 * The phrase it returns goes to the read-back screen, where it is shown to the
 * user as their own sentence and parsed into food. A model that quietly
 * rewrites it there is the worst failure this feature has: somebody reviews a
 * meal they never described, sees plausible numbers, and taps Add.
 */
describe('echoes', () => {
  it('accepts the sentence unchanged', () => {
    expect(echoes('two dosai and sambar', 'two dosai and sambar')).toBe(true);
  });

  it('accepts a tidy that drops what was around the food', () => {
    // The model is meant to strip "I had" and the like. Demanding equality
    // would throw away every useful correction it makes.
    expect(echoes('I had two dosai and sambar for breakfast', 'two dosai and sambar')).toBe(true);
  });

  it('accepts a transcript whose spacing differs', () => {
    // "chickenbriyani" out of the transcriber, "chicken briyani" back from the
    // model. One space is the whole difference, and it is not a substitution.
    expect(echoes('mathiyam chickenbriyani', 'chicken briyani')).toBe(true);
  });

  it('refuses a dish the user never named', () => {
    expect(echoes('two dosai and sambar', 'two plain dosa with coconut chutney')).toBe(false);
  });

  it('refuses an invented quantity', () => {
    // The number is the part nobody can check by eye on the next screen.
    expect(echoes('idli and sambar', '3 idli and sambar')).toBe(false);
  });

  it('refuses empty on either side', () => {
    expect(echoes('two dosai', '')).toBe(false);
    expect(echoes('', 'two dosai')).toBe(false);
  });
});
