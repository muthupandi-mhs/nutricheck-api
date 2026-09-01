import type { UserProfile } from '@nutricheck/contracts';
import {
  ideasToUserTurn,
  TREND_MIN_SPAN_DAYS,
  type FastingContext,
  type IdeasInput,
  type WeightContext,
} from '../ideas-input';

/**
 * The input is a string a model reads, so the assertions are about the string.
 *
 * There is no intermediate structure worth testing here — the whole output of
 * this module IS the prose, and a test over an object it does not produce would
 * pass while the sentence handed to the model said something else entirely.
 */

const PROFILE: UserProfile = {
  firstName: null,
  lastName: null,
  sex: 'male',
  birthDate: '1990-06-01',
  heightCm: 175,
  weightKg: 72,
  activityLevel: 'active',
  objective: 'lose',
  rateKgPerWeek: 0.5,
  units: 'metric',
};

function input(over: Partial<IdeasInput> = {}): IdeasInput {
  return {
    profile: PROFILE,
    goal: { kcal: 2200, proteinG: 145, carbsG: 220, fatG: 70, fiberG: 30 },
    eaten: { kcal: 900, proteinG: 55, carbsG: 90, fatG: 30, fiberG: 12 },
    remaining: { kcal: 1300, proteinG: 90, carbsG: 130, fatG: 40, fiberG: 18 },
    entryCount: 2,
    nextMeal: 'dinner',
    fasting: null,
    weight: null,
    ...over,
  };
}

function fasting(over: Partial<FastingContext> = {}): FastingContext {
  return { current: null, habit: null, lastTargetHours: 16, ...over };
}

function weight(over: Partial<WeightContext> = {}): WeightContext {
  return { currentKg: 72, startKg: 76, trend: null, ...over };
}

/** A trend long enough to be reported, so each test varies only the rate. */
function trend(kgPerWeek: number, intendedKgPerWeek: number | null) {
  return { kgPerWeek, intendedKgPerWeek, spanDays: 60 };
}

describe('ideasToUserTurn — fasting', () => {
  it('says nothing at all about fasting for somebody who does not fast', () => {
    const turn = ideasToUserTurn(input());

    expect(turn).not.toMatch(/fast/i);
    expect(turn).not.toMatch(/window/i);
    // The section's absence is the instruction. A line reading "not fasting"
    // would invite the model to suggest they take it up.
    expect(turn).toContain('They are most likely eating dinner next.');
  });

  it('makes a running fast rewrite the closing line, not merely annotate it', () => {
    const turn = ideasToUserTurn(
      input({
        fasting: fasting({
          current: { hoursElapsed: 11, targetHours: 16, hoursToGo: 5 },
        }),
      }),
    );

    expect(turn).toContain('11 hours in, against a target of 16 hours');
    expect(turn).toContain('About 5 hours before their eating window opens');
    expect(turn).toContain('not for eating right now');
    // The clock still says dinner. Saying so would be telling somebody who has
    // decided not to eat for five hours that they are about to.
    expect(turn).not.toContain('most likely eating dinner next');
  });

  it('reports a fast past its target as a state, never as a negative countdown', () => {
    const turn = ideasToUserTurn(
      input({
        fasting: fasting({
          current: { hoursElapsed: 17.5, targetHours: 16, hoursToGo: 0 },
        }),
      }),
    );

    expect(turn).toContain('17.5 hours in, past its target of 16 hours');
    expect(turn).toContain('may break it whenever they choose');
    expect(turn).toContain('the next thing they eat breaks it');
    expect(turn).not.toMatch(/-\d+(\.\d+)? hours/);
  });

  it('describes the protocol and the habit when no fast is running', () => {
    const turn = ideasToUserTurn(
      input({
        fasting: fasting({
          lastTargetHours: 18,
          habit: { completed: 40, reached: 33, averageHours: 17.2 },
        }),
      }),
    );

    expect(turn).toContain('The protocol they are on is a fast of 18 hours');
    expect(turn).toContain('40 fasts finished, 33 of them reached their target');
    expect(turn).toContain('17.2 hours on average');
    // Not fasting now, so the ordinary closing line stands.
    expect(turn).toContain('They are most likely eating dinner next.');
  });

  it('says minutes rather than a fraction of an hour under the hour', () => {
    const turn = ideasToUserTurn(
      input({
        fasting: fasting({
          current: { hoursElapsed: 15.5, targetHours: 16, hoursToGo: 0.5 },
        }),
      }),
    );

    expect(turn).toContain('About 30 minutes before their eating window opens');
  });
});

describe('ideasToUserTurn — weight', () => {
  it('omits the section for somebody who has never weighed in', () => {
    expect(ideasToUserTurn(input())).not.toContain('WHAT THE SCALE ACTUALLY SAYS');
  });

  it('refuses to state a direction when the readings do not span long enough', () => {
    const turn = ideasToUserTurn(
      input({
        weight: weight({
          trend: { kgPerWeek: -1.8, intendedKgPerWeek: -0.5, spanDays: TREND_MIN_SPAN_DAYS - 1 },
        }),
      }),
    );

    expect(turn).toContain('not enough weigh-in history yet to say which way it is going');
    // The slope exists and is dramatic. Printing it with a caveat beside it is
    // printing it, and a caveat is the part a model drops.
    expect(turn).not.toContain('1.80 kg a week');
    expect(turn).not.toContain('losing');
  });

  it('reports the slope once the span clears the threshold', () => {
    const turn = ideasToUserTurn(
      input({
        weight: weight({
          trend: { kgPerWeek: -0.48, intendedKgPerWeek: -0.5, spanDays: TREND_MIN_SPAN_DAYS },
        }),
      }),
    );

    expect(turn).toContain(`Over the last ${TREND_MIN_SPAN_DAYS} days: losing 0.48 kg a week`);
    expect(turn).toContain('so it is going roughly to plan');
  });

  it('makes the comparison itself rather than leaving two numbers side by side', () => {
    const slower = ideasToUserTurn(input({ weight: weight({ trend: trend(-0.15, -0.5) }) }));
    expect(slower).toContain('so it is moving slower than they planned');

    const faster = ideasToUserTurn(input({ weight: weight({ trend: trend(-0.9, -0.5) }) }));
    expect(faster).toContain('so it is moving faster than they planned');

    const wrongWay = ideasToUserTurn(input({ weight: weight({ trend: trend(0.3, -0.5) }) }));
    expect(wrongWay).toContain('and it is going the other way');
  });

  it('calls a slope of nearly zero what it is, rather than a direction', () => {
    const turn = ideasToUserTurn(input({ weight: weight({ trend: trend(-0.02, -0.5) }) }));

    expect(turn).toContain('holding steady');
    expect(turn).toContain('the scale has not moved');
    expect(turn).not.toContain('losing 0.02');
  });

  it('reads a maintainer without inventing an intended rate for them', () => {
    const turn = ideasToUserTurn(input({ weight: weight({ trend: trend(-0.01, null) }) }));

    expect(turn).toContain('not trying to change weight, and it is not changing');
    expect(turn).not.toContain('They meant to');
  });

  it('drops the starting weight when it is also the current one', () => {
    const turn = ideasToUserTurn(input({ weight: weight({ currentKg: 72, startKg: null }) }));

    expect(turn).toContain('They weigh 72 kg.');
    expect(turn).not.toContain('first weight they ever recorded');
  });
});

describe('ideasToUserTurn — section order', () => {
  /**
   * The order IS the instruction — see the module doc. A refactor that moves
   * the day above the person turns this back into the gap-filling calculator
   * it was rewritten out of being, and nothing else in the suite would notice.
   */
  it('puts the person and the scale above the targets, and the day last', () => {
    const turn = ideasToUserTurn(
      input({
        weight: weight({ trend: trend(-0.15, -0.5) }),
        fasting: fasting({ current: { hoursElapsed: 11, targetHours: 16, hoursToGo: 5 } }),
      }),
    );

    const at = (heading: string) => {
      const index = turn.indexOf(heading);
      expect(index).toBeGreaterThan(-1);
      return index;
    };

    expect(at('THE PERSON')).toBeLessThan(at('WHAT THE SCALE ACTUALLY SAYS'));
    expect(at('WHAT THE SCALE ACTUALLY SAYS')).toBeLessThan(at('WHAT THEY ARE EATING TO'));
    expect(at('WHAT THEY ARE EATING TO')).toBeLessThan(at('HOW THEY EAT'));
    expect(at('HOW THEY EAT')).toBeLessThan(at('TODAY, WHICH SHAPES'));
  });
});
