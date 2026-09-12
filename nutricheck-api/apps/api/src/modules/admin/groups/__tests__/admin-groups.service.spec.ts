import type { Database } from '@nutricheck/database';
import { AdminGroupsService } from '../admin-groups.service';

/**
 * `AdminGroupsService.list()` is the campaign banner's group picker — small,
 * but it shares the same two things worth pinning as the other admin lists:
 * whether a blank search term actually skips the `where` clause, and that the
 * member-count subquery's string comes back a number.
 */

function fakeDb(opts: { rows?: Array<{ id: string; name: string; memberCount: string | number }> } = {}) {
  const whereCalls: unknown[] = [];

  const chain = {
    from: () => chain,
    where: (cond: unknown) => {
      whereCalls.push(cond);
      return chain;
    },
    orderBy: () => chain,
    limit: async () => opts.rows ?? [],
  };

  const db = { select: () => chain };
  return { db: db as unknown as Database, whereCalls };
}

describe('search filter', () => {
  it('applies no where clause when q is not given', async () => {
    const { db, whereCalls } = fakeDb({ rows: [] });
    await new AdminGroupsService(db).list(undefined);
    expect(whereCalls).toEqual([undefined]);
  });

  it('builds a name filter when q is given', async () => {
    const { db, whereCalls } = fakeDb({ rows: [] });
    await new AdminGroupsService(db).list('walkers');
    expect(whereCalls).toHaveLength(1);
    expect(whereCalls[0]).toBeDefined();
  });
});

describe('row mapping', () => {
  it('coerces the member-count subquery result to a number', async () => {
    const { db } = fakeDb({ rows: [{ id: 'g-1', name: 'Morning Walkers', memberCount: '9' }] });
    const { items } = await new AdminGroupsService(db).list(undefined);

    expect(items).toEqual([{ id: 'g-1', name: 'Morning Walkers', memberCount: 9 }]);
    expect(typeof items[0]!.memberCount).toBe('number');
  });
});
