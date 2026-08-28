import { firstOfMonth, lastOfMonth } from '../logs.service';

/**
 * The calendar month window.
 *
 * Small enough to look obviously right and wrong often enough to be worth
 * testing: month lengths are irregular, February moves, and the whole grid
 * shifts by a day if either end is off by one. The calendar screen indexes its
 * cells by position in this range, so a wrong boundary does not error — it
 * silently paints every day under the wrong number.
 */
describe('the calendar month window', () => {
  it('takes any day in the month and returns that whole month', () => {
    expect(firstOfMonth('2026-08-28')).toBe('2026-08-01');
    expect(lastOfMonth('2026-08-28')).toBe('2026-08-31');
  });

  it('is unchanged when handed the first or last day itself', () => {
    expect(firstOfMonth('2026-08-01')).toBe('2026-08-01');
    expect(lastOfMonth('2026-08-31')).toBe('2026-08-31');
  });

  it('gets the thirty-day months right', () => {
    expect(lastOfMonth('2026-09-15')).toBe('2026-09-30');
    expect(lastOfMonth('2026-04-01')).toBe('2026-04-30');
  });

  it('gets February right, leap year or not', () => {
    // 2026 is not a leap year; 2028 is. `lastOfMonth` gets both from day 0 of
    // the following month rather than from a table, which is the reason it can
    // be trusted on a year nobody thought to test.
    expect(lastOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(lastOfMonth('2028-02-10')).toBe('2028-02-29');
  });

  it('does not roll into the next year at December', () => {
    expect(firstOfMonth('2026-12-25')).toBe('2026-12-01');
    expect(lastOfMonth('2026-12-25')).toBe('2026-12-31');
  });

  it('handles January without underflowing to the previous year', () => {
    expect(firstOfMonth('2026-01-09')).toBe('2026-01-01');
    expect(lastOfMonth('2026-01-09')).toBe('2026-01-31');
  });
});
