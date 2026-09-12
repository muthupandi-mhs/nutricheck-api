import type { Database } from '@nutricheck/database';
import { AdminStepsService } from '../admin-steps.service';

/**
 * `AdminStepsService.list()`'s row-mapping and query-building, isolated from
 * Postgres. The one thing that needs a fixture rather than a fake table is
 * "what shape does a LEFT JOIN with no matching profile row hand back" —
 * that's what the "neither name" case below is standing in for.
 */

type RowInput = {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  totalSteps: string;
  lastLoggedOn: string | null;
};

/**
 * Just enough of `Database` for `list()`: two `select()` calls run through
 * `Promise.all`, one for the page of rows and one for the total count. Both
 * start as `select(cols)` — the rows query's `cols` includes `userId`, the
 * count query's doesn't, so that's what tells them apart. Every other chain
 * method (`from`, `leftJoin`, `groupBy`, `orderBy`, `limit`, `offset`)
 * just returns the same chain object; `where` additionally records what it
 * was called with, since "was a filter applied at all" is exactly the
 * branch under test.
 */
function fakeDb(opts: { rows?: RowInput[]; total?: number } = {}) {
  const whereCalls: unknown[] = [];
  const limitCalls: unknown[] = [];
  const offsetCalls: unknown[] = [];

  function chain(result: unknown[]) {
    const obj = {
      from: () => obj,
      leftJoin: () => obj,
      where: (cond: unknown) => {
        whereCalls.push(cond);
        return obj;
      },
      groupBy: () => obj,
      orderBy: () => obj,
      limit: (n: unknown) => {
        limitCalls.push(n);
        return obj;
      },
      offset: (n: unknown) => {
        offsetCalls.push(n);
        return obj;
      },
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return obj;
  }

  const db = {
    select: (cols: Record<string, unknown>) => {
      const isRowsQuery = 'userId' in cols;
      return chain(isRowsQuery ? (opts.rows ?? []) : [{ total: opts.total ?? 0 }]);
    },
  };

  return { db: db as unknown as Database, whereCalls, limitCalls, offsetCalls };
}

const ROW = (over: Partial<RowInput> = {}): RowInput => ({
  userId: 'user-1',
  email: 'walker@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
  totalSteps: '12345',
  lastLoggedOn: '2026-08-01',
  ...over,
});

describe('name derivation', () => {
  it('joins first and last when both are present', async () => {
    const { db } = fakeDb({ rows: [ROW({ firstName: 'Alice', lastName: 'Smith' })] });
    const { items } = await new AdminStepsService(db).list({ page: 1, pageSize: 20 });
    expect(items[0]!.name).toBe('Alice Smith');
  });

  it('uses just the first name when there is no last name', async () => {
    const { db } = fakeDb({ rows: [ROW({ firstName: 'Alice', lastName: null })] });
    const { items } = await new AdminStepsService(db).list({ page: 1, pageSize: 20 });
    expect(items[0]!.name).toBe('Alice');
  });

  it('uses just the last name when there is no first name', async () => {
    const { db } = fakeDb({ rows: [ROW({ firstName: null, lastName: 'Smith' })] });
    const { items } = await new AdminStepsService(db).list({ page: 1, pageSize: 20 });
    expect(items[0]!.name).toBe('Smith');
  });

  it('is null, never an empty string, when neither name is set (no profile row from the LEFT JOIN)', async () => {
    const { db } = fakeDb({ rows: [ROW({ firstName: null, lastName: null })] });
    const { items } = await new AdminStepsService(db).list({ page: 1, pageSize: 20 });
    expect(items[0]!.name).toBeNull();
  });

  it('is also null when a profile row exists but both names are blank strings, not null', async () => {
    // Different DB shape than the LEFT-JOIN-miss case above (a real profile
    // row with empty fields, rather than no row at all) — same outcome.
    const { db } = fakeDb({ rows: [ROW({ firstName: '', lastName: '' })] });
    const { items } = await new AdminStepsService(db).list({ page: 1, pageSize: 20 });
    expect(items[0]!.name).toBeNull();
  });
});

describe('search filter', () => {
  it('applies no where clause when q is blank', async () => {
    const { db, whereCalls } = fakeDb({ rows: [] });
    await new AdminStepsService(db).list({ page: 1, pageSize: 20, q: '' });
    expect(whereCalls).toEqual([undefined, undefined]);
  });

  it('applies no where clause when q is whitespace only', async () => {
    const { db, whereCalls } = fakeDb({ rows: [] });
    await new AdminStepsService(db).list({ page: 1, pageSize: 20, q: '   ' });
    expect(whereCalls).toEqual([undefined, undefined]);
  });

  it('builds a filter for both queries when q has real content', async () => {
    const { db, whereCalls } = fakeDb({ rows: [] });
    await new AdminStepsService(db).list({ page: 1, pageSize: 20, q: 'alice' });
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0]).toBeDefined();
    expect(whereCalls[1]).toBeDefined();
  });
});

describe('pagination', () => {
  it('computes offset from page and pageSize, and limits to pageSize', async () => {
    const { db, limitCalls, offsetCalls } = fakeDb({ rows: [] });
    await new AdminStepsService(db).list({ page: 3, pageSize: 10 });
    expect(limitCalls).toEqual([10]);
    expect(offsetCalls).toEqual([20]); // (3 - 1) * 10
  });

  it('is page 1, offset 0 for the first page', async () => {
    const { db, limitCalls, offsetCalls } = fakeDb({ rows: [] });
    await new AdminStepsService(db).list({ page: 1, pageSize: 20 });
    expect(limitCalls).toEqual([20]);
    expect(offsetCalls).toEqual([0]);
  });
});

describe('row mapping — the rest of the fields', () => {
  it('coerces the summed total to a number and passes the rest through', async () => {
    const { db } = fakeDb({
      rows: [ROW({ totalSteps: '987654', lastLoggedOn: '2026-08-15' })],
      total: 42,
    });
    const result = await new AdminStepsService(db).list({ page: 2, pageSize: 20 });

    expect(result.items[0]!.totalSteps).toBe(987654);
    expect(typeof result.items[0]!.totalSteps).toBe('number');
    expect(result.items[0]!.lastLoggedOn).toBe('2026-08-15');
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(42);
  });

  it('reports lastLoggedOn as null for a user who has never logged a step', async () => {
    const { db } = fakeDb({ rows: [ROW({ lastLoggedOn: null })] });
    const { items } = await new AdminStepsService(db).list({ page: 1, pageSize: 20 });
    expect(items[0]!.lastLoggedOn).toBeNull();
  });
});
