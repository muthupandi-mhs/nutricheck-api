import { Inject, Injectable } from '@nestjs/common';
import {
  FASTING_BACKDATE_MAX_HOURS,
  FASTING_DEFAULT_TARGET_HOURS,
  type AdjustFast,
  type EndFast,
  type Fast,
  type FastingStats,
  type FastingSummary,
  type StartFast,
} from '@nutricheck/contracts';
import {
  and,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  schema,
  sql,
  type Database,
} from '@nutricheck/database';
import {
  ConflictProblem,
  NotFoundProblem,
  ValidationFailedException,
} from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';

/**
 * Declared fasts.
 *
 * One rule holds the module together, and everything else follows from it:
 * **a user has at most one open fast, and only the user closes it.**
 *
 * The first half is the database's job — a partial unique index on
 * `(user_id) WHERE ended_at IS NULL`, because two taps a few milliseconds
 * apart would both pass a check-then-insert and leave somebody with two
 * timers. The service checks first anyway, so the common case is a sentence
 * rather than a constraint name, and treats the index as the authority.
 *
 * The second half is a decision, not an omission. Nothing here ever ends a
 * fast on its own: no cron closes one at its target, none is auto-closed when
 * a meal is logged, and a fast left running for a week comes back as a fast
 * that has been running for a week. All of those would be the server inventing
 * a moment somebody stopped fasting, and the whole value of this record over
 * the gap between meal logs — which the app can already compute — is that
 * every instant in it was stated by the person it belongs to. The screen deals
 * with a forgotten timer by offering to end or discard it, which is the same
 * fix made by the only party who knows the answer.
 */
@Injectable()
export class FastingService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The timer, the record and the history, in one read.
   *
   * Three queries rather than one over all history. The stats are all-time and
   * the list is not, so pulling every row to satisfy both would grow with the
   * habit — somebody a year into daily fasting has three hundred rows and a
   * screen that draws thirty.
   */
  async summary(userId: string, limit: number): Promise<FastingSummary> {
    const [open, recent, stats] = await Promise.all([
      this.openFast(userId),
      this.db
        .select(COLUMNS)
        .from(schema.fastingSessions)
        .where(
          and(
            eq(schema.fastingSessions.userId, userId),
            isNotNull(schema.fastingSessions.endedAt),
          ),
        )
        .orderBy(desc(schema.fastingSessions.startedAt))
        .limit(limit),
      this.statsOf(userId),
    ]);

    return {
      current: open ? toFast(open) : null,
      recent: recent.map(toFast),
      stats,
      /**
       * The plan, which is not stored as a preference anywhere.
       *
       * The running fast's target if there is one, else the last one finished,
       * else the default. Ordered that way because "what am I on" is answered
       * by what somebody is doing now before it is answered by what they did
       * last — and `recent` is already newest-first, so `[0]` is the most
       * recent finished fast rather than the oldest one in the window.
       */
      lastTargetHours:
        open?.targetHours ?? recent[0]?.targetHours ?? FASTING_DEFAULT_TARGET_HOURS,
    };
  }

  /**
   * Begin one.
   *
   * The 409 is thrown twice on purpose — once from the check, once from the
   * index — and both say the same thing. The first exists so the message names
   * what is wrong; the second exists because the first can lose a race, and a
   * raw constraint violation would reach the client as a 500 about an account
   * that is in a perfectly ordinary state.
   */
  async start(userId: string, input: StartFast, limit: number): Promise<FastingSummary> {
    const startedAt = this.backdatable(input.startedAt, 'startedAt');

    const open = await this.openFast(userId);
    if (open) throw alreadyRunning();

    try {
      await this.db
        .insert(schema.fastingSessions)
        .values({ userId, startedAt, targetHours: input.targetHours });
    } catch (error) {
      if (isUniqueViolation(error)) throw alreadyRunning();
      throw error;
    }

    return this.summary(userId, limit);
  }

  /**
   * Change the open fast without finishing it — its target, its start, or both.
   *
   * Extending mid-fast is the point of this route. Somebody fourteen hours
   * into a sixteen who feels fine pushes on to eighteen, and the alternative —
   * end and restart — would throw away the fourteen hours they had already
   * done, which is the one thing the screen exists to hold onto.
   *
   * The start time can move too, and can move in both directions: forwards for
   * somebody who started the timer early, backwards for the far commoner case
   * of remembering an hour late. It cannot move into the future, and it cannot
   * move past `FASTING_BACKDATE_MAX_HOURS`.
   */
  async adjust(userId: string, input: AdjustFast, limit: number): Promise<FastingSummary> {
    // Checked here rather than by a `.refine` on the contract, so an empty body
    // fails as a rule with a field name on it rather than a schema-level
    // message the client cannot attach to any control.
    if (input.startedAt === undefined && input.targetHours === undefined) {
      throw new ValidationFailedException([
        { path: 'targetHours', message: 'provide targetHours, startedAt, or both' },
      ]);
    }

    const open = await this.openFast(userId);
    if (open === null) throw new NotFoundProblem('Open fast');

    const startedAt =
      input.startedAt === undefined
        ? open.startedAt
        : this.backdatable(input.startedAt, 'startedAt');

    await this.db
      .update(schema.fastingSessions)
      .set({ startedAt, targetHours: input.targetHours ?? open.targetHours })
      .where(eq(schema.fastingSessions.id, open.id));

    return this.summary(userId, limit);
  }

  /**
   * Finish it.
   *
   * `endedAt` is bounded by `startedAt` rather than by the backdate window the
   * other two use, and the difference matters: a fast that was left running
   * for five days is ended with an `endedAt` five days after it began, which
   * the 72-hour floor would refuse. What cannot happen is an end before the
   * start — the database rejects that too, via `fasting_sessions_span_ck`.
   *
   * The `isNull(endedAt)` in the WHERE is what makes a double tap safe. Two
   * requests both find the same open fast, and only the first writes; the
   * second sees no rows and 404s rather than silently overwriting an end time
   * the user has already been shown.
   */
  async end(userId: string, input: EndFast, limit: number): Promise<FastingSummary> {
    const open = await this.openFast(userId);
    if (open === null) throw new NotFoundProblem('Open fast');

    const endedAt = this.notFuture(input.endedAt, 'endedAt');
    if (endedAt.getTime() <= open.startedAt.getTime()) {
      throw new ValidationFailedException([
        { path: 'endedAt', message: 'must be after the fast started' },
      ]);
    }

    const closed = await this.db
      .update(schema.fastingSessions)
      .set({ endedAt })
      .where(
        and(
          eq(schema.fastingSessions.id, open.id),
          isNull(schema.fastingSessions.endedAt),
        ),
      )
      .returning({ id: schema.fastingSessions.id });

    if (closed.length === 0) throw new NotFoundProblem('Open fast');

    return this.summary(userId, limit);
  }

  /**
   * Throw one away — the running one, or one that finished last week.
   *
   * Deliberately one operation rather than "cancel" and "delete". From the
   * user's side both are "this should not be in my history", and the row does
   * not care whether it had an end time when it went. That is also why there
   * is no equivalent of the weight screen's "you cannot delete your last
   * reading": nothing is derived from a fast, so an empty history is an
   * ordinary state rather than one the rest of the app would break on.
   *
   * Scoped by `userId` as well as `id` so an id from somebody else's account
   * is a 404 rather than a deletion.
   */
  async remove(userId: string, id: string, limit: number): Promise<FastingSummary> {
    const [row] = await this.db
      .delete(schema.fastingSessions)
      .where(
        and(eq(schema.fastingSessions.userId, userId), eq(schema.fastingSessions.id, id)),
      )
      .returning({ id: schema.fastingSessions.id });

    if (!row) throw new NotFoundProblem('Fast');

    return this.summary(userId, limit);
  }

  /** The open fast, or null. At most one exists — see the class comment. */
  private async openFast(userId: string): Promise<Row | null> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(schema.fastingSessions)
      .where(
        and(
          eq(schema.fastingSessions.userId, userId),
          isNull(schema.fastingSessions.endedAt),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  /**
   * The all-time record, aggregated in Postgres rather than in TypeScript.
   *
   * Every figure here is over the whole history — a personal best that forgot
   * March is a worse number than no number — and "the whole history" is the
   * one set of rows that must never be pulled into memory to be counted.
   *
   * `reached` compares against `hours` rounded the same way `toFast` rounds
   * it, by adding half a second to the duration before the comparison. Without
   * that, a fast of 15.9994 hours is printed as "16h" by the client and
   * counted as a miss here, and the screen contradicts itself on one row.
   */
  private async statsOf(userId: string): Promise<FastingStats | null> {
    const seconds = sql<number>`extract(epoch from (${schema.fastingSessions.endedAt} - ${schema.fastingSessions.startedAt}))`;

    const [row] = await this.db
      .select({
        completed: count(),
        reached: sql<number>`count(*) filter (where ${seconds} + 0.5 >= ${schema.fastingSessions.targetHours} * 3600)`.mapWith(
          Number,
        ),
        longestSeconds: sql<number>`coalesce(max(${seconds}), 0)`.mapWith(Number),
        averageSeconds: sql<number>`coalesce(avg(${seconds}), 0)`.mapWith(Number),
      })
      .from(schema.fastingSessions)
      .where(
        and(
          eq(schema.fastingSessions.userId, userId),
          isNotNull(schema.fastingSessions.endedAt),
        ),
      );

    // Null rather than four zeroes. "Your average fast is 0h" is a claim about
    // somebody who has never finished one, and it is not true of them.
    if (!row || row.completed === 0) return null;

    return {
      completed: row.completed,
      reached: row.reached,
      longestHours: round(row.longestSeconds / 3600, 2),
      averageHours: round(row.averageSeconds / 3600, 2),
    };
  }

  /**
   * A client-supplied instant that may sit in the past but not the future.
   *
   * The skew allowance is what keeps a correctly behaving phone from being
   * refused: the client sends its own clock, and two clocks a few seconds
   * apart is the normal state of the world rather than an error worth showing
   * anybody.
   */
  private notFuture(value: string | undefined, field: string): Date {
    const now = Date.now();
    if (value === undefined) return new Date(now);

    // The format is already guaranteed by the contract; this is about range.
    const at = new Date(value);
    if (at.getTime() > now + CLOCK_SKEW_MS) {
      throw new ValidationFailedException([{ path: field, message: 'cannot be in the future' }]);
    }
    return at;
  }

  /** As above, and no further back than the backdate window. */
  private backdatable(value: string | undefined, field: string): Date {
    const at = this.notFuture(value, field);
    if (at.getTime() < Date.now() - FASTING_BACKDATE_MAX_HOURS * 3_600_000) {
      throw new ValidationFailedException([
        {
          path: field,
          message: `cannot be more than ${FASTING_BACKDATE_MAX_HOURS} hours ago`,
        },
      ]);
    }
    return at;
  }
}

/** The columns every read of this table selects. Named once so they cannot drift. */
const COLUMNS = {
  id: schema.fastingSessions.id,
  startedAt: schema.fastingSessions.startedAt,
  endedAt: schema.fastingSessions.endedAt,
  targetHours: schema.fastingSessions.targetHours,
} as const;

type Row = {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  targetHours: number;
};

/**
 * A row as the wire sees it.
 *
 * `hours` and `reachedTarget` are null on an open fast, and that is the
 * contract rather than a gap in it: a running fast's length changes every
 * second, so the device holding the screen computes it from `startedAt`
 * against its own clock. See `Fast` in the contracts.
 */
function toFast(row: Row): Fast {
  const hours =
    row.endedAt === null
      ? null
      : round((row.endedAt.getTime() - row.startedAt.getTime()) / 3_600_000, 2);

  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    targetHours: row.targetHours,
    hours,
    // Compared on the ROUNDED figure, which is the one the client prints. A
    // raw comparison would let a row read "16h" and "missed" at once.
    reachedTarget: hours === null ? null : hours >= row.targetHours,
  };
}

function alreadyRunning(): ConflictProblem {
  return new ConflictProblem(
    'A fast is already running',
    'End or discard the one in progress before starting another. There is only ever one, so a second timer would leave you with no way to say which is yours.',
  );
}

/**
 * Postgres 23505 — unique violation, here only ever the one open fast per user.
 *
 * Matched on the SQLSTATE rather than the constraint name: the name is a
 * detail of a migration and the code is the contract the driver publishes.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** Two minutes. Long enough for an unsynchronised phone, short enough to still refuse a typo. */
const CLOCK_SKEW_MS = 120_000;

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
