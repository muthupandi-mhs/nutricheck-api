import { schema, type Database } from '@nutricheck/database';
import { ConflictProblem, NotFoundProblem } from '../../../common/problems';
import { GroupsService } from '../groups.service';

/**
 * `GroupsService`'s branching, isolated from Postgres.
 *
 * `groups.int-spec.ts` already proves this end to end; a unit test buys the
 * ability to force shapes a real database wouldn't hand back on request —
 * an invite code that matches nothing, a caller who is a member versus one
 * who merely knows a group exists, a delete that removed nothing — in
 * milliseconds, and without needing a live Postgres.
 */

type GroupRow = typeof schema.stepGroups.$inferSelect;

const GROUP_ROW = (over: Partial<GroupRow> = {}): GroupRow => ({
  id: 'group-1',
  name: 'Morning Walkers',
  inviteCode: 'ABCD1234',
  createdBy: 'user-1',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  ...over,
});

/**
 * Just enough of `Database` for `GroupsService`: `select().from().where().limit()`
 * against two tables (distinguished by reference, same trick as
 * `campaign.service.spec.ts`), one raw `execute()` per call (each test only
 * ever exercises one of `myGroups`'s or `leaderboardFor`'s queries, so one
 * canned answer is unambiguous), `insert().values()` with and without
 * `.returning()`, `delete().where().returning()`, and a `transaction()` that
 * just runs its callback against the same fakes — `create()` never touches
 * `tx` and `db` differently in ways this needs to tell apart.
 *
 * The membership lookup is the one place state actually matters: once
 * `insertedMembers` has a row in it, a later membership check (e.g. `join()`
 * calling into `detail()` afterwards) must see it, or a happy-path join
 * would 404 on its own response.
 */
function fakeDb(
  opts: {
    groupRow?: GroupRow | null;
    membershipRow?: { id: string } | null;
    executeRows?: unknown[];
    newGroupId?: string;
    deleteReturning?: Array<{ id: string }>;
  } = {},
) {
  const insertedGroups: unknown[] = [];
  const insertedMembers: unknown[] = [];
  const deletedTables: unknown[] = [];
  let membershipLookups = 0;

  const shared = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === schema.stepGroups) {
              return opts.groupRow ? [opts.groupRow] : [];
            }
            if (table === schema.stepGroupMembers) {
              membershipLookups++;
              // A membership row inserted earlier in the same test must be
              // visible to a later lookup, the way it would be against a
              // real database — `join()` relies on exactly this when it
              // calls `detail()` right after seating the new member.
              if (opts.membershipRow) return [opts.membershipRow];
              return insertedMembers.length > 0 ? [{ id: 'seated-by-insert' }] : [];
            }
            return [];
          },
        }),
      }),
    }),
    execute: async () => ({ rows: opts.executeRows ?? [] }),
    insert: (table: unknown) => ({
      values: (row: unknown) => {
        if (table === schema.stepGroups) {
          insertedGroups.push(row);
          return { returning: async () => [{ id: opts.newGroupId ?? 'new-group-id' }] };
        }
        insertedMembers.push(row);
        return Promise.resolve(undefined);
      },
    }),
    delete: (table: unknown) => ({
      where: () => ({
        returning: async () => {
          deletedTables.push(table);
          return opts.deleteReturning ?? [];
        },
      }),
    }),
  };

  const db = {
    ...shared,
    transaction: async (fn: (tx: typeof shared) => Promise<unknown>) => fn(shared),
  };

  return {
    db: db as unknown as Database,
    insertedGroups,
    insertedMembers,
    deletedTables,
    get membershipLookups() {
      return membershipLookups;
    },
  };
}

describe('detail — window selection', () => {
  it('ranks over the last month when no window is given', async () => {
    const { db } = fakeDb({ groupRow: GROUP_ROW(), membershipRow: { id: 'm-1' }, executeRows: [] });
    const service = new GroupsService(db);
    const spy = jest.spyOn(
      service as unknown as { leaderboardFor: (groupId: string, days: number) => Promise<unknown> },
      'leaderboardFor',
    );

    const detail = await service.detail('user-1', 'group-1');

    expect(detail.window).toBe('month');
    expect(spy).toHaveBeenCalledWith('group-1', 30); // WINDOW_DAYS.month
  });

  it('switches to a 1-day window when asked for "day"', async () => {
    const { db } = fakeDb({ groupRow: GROUP_ROW(), membershipRow: { id: 'm-1' }, executeRows: [] });
    const service = new GroupsService(db);
    const spy = jest.spyOn(
      service as unknown as { leaderboardFor: (groupId: string, days: number) => Promise<unknown> },
      'leaderboardFor',
    );

    await service.detail('user-1', 'group-1', 'day');

    expect(spy).toHaveBeenCalledWith('group-1', 1); // WINDOW_DAYS.day
  });

  it('switches to a 7-day window when asked for "week"', async () => {
    const { db } = fakeDb({ groupRow: GROUP_ROW(), membershipRow: { id: 'm-1' }, executeRows: [] });
    const service = new GroupsService(db);
    const spy = jest.spyOn(
      service as unknown as { leaderboardFor: (groupId: string, days: number) => Promise<unknown> },
      'leaderboardFor',
    );

    await service.detail('user-1', 'group-1', 'week');

    expect(spy).toHaveBeenCalledWith('group-1', 7); // WINDOW_DAYS.week
  });
});

describe('detail — two different reasons for the same 404', () => {
  it('404s when the group itself does not exist, without ever checking membership', async () => {
    // `membershipLookups` is a getter (see fakeDb) — read it off `fake` after
    // the call, not via destructuring, or it freezes at its value from
    // before `detail()` ever ran.
    const fake = fakeDb({ groupRow: null });

    await expect(new GroupsService(fake.db).detail('user-1', 'nonexistent')).rejects.toThrow(NotFoundProblem);
    expect(fake.membershipLookups).toBe(0);
  });

  it('404s when the group exists but the caller is not a member', async () => {
    const fake = fakeDb({ groupRow: GROUP_ROW(), membershipRow: null });

    await expect(new GroupsService(fake.db).detail('outsider', 'group-1')).rejects.toThrow(NotFoundProblem);
    // The membership check was actually reached this time — this 404 comes
    // from a different branch than the "group doesn't exist" case above.
    expect(fake.membershipLookups).toBe(1);
  });
});

describe('join', () => {
  it('404s on an invite code that matches no group, and never touches membership', async () => {
    const fake = fakeDb({ groupRow: null });

    await expect(new GroupsService(fake.db).join('user-1', { inviteCode: 'nope' })).rejects.toThrow(NotFoundProblem);
    expect(fake.insertedMembers).toHaveLength(0);
    expect(fake.membershipLookups).toBe(0);
  });

  it('refuses to join a group the caller is already in', async () => {
    const { db, insertedMembers } = fakeDb({ groupRow: GROUP_ROW(), membershipRow: { id: 'already-a-member' } });

    await expect(new GroupsService(db).join('user-1', { inviteCode: 'abcd1234' })).rejects.toThrow(ConflictProblem);
    expect(insertedMembers).toHaveLength(0);
  });

  it('seats a new member and returns their view of the group', async () => {
    const { db, insertedMembers } = fakeDb({
      groupRow: GROUP_ROW(),
      membershipRow: null, // not a member yet — the check before the insert must pass
      executeRows: [],
    });

    const detail = await new GroupsService(db).join('user-1', { inviteCode: 'abcd1234' });

    expect(insertedMembers).toEqual([{ groupId: 'group-1', userId: 'user-1' }]);
    expect(detail.id).toBe('group-1');
    expect(detail.inviteCode).toBe('ABCD1234');
    expect(detail.window).toBe('month');
  });
});

describe('create', () => {
  it('seats the creator as the first member, then returns their own detail view', async () => {
    const { db, insertedGroups, insertedMembers } = fakeDb({
      newGroupId: 'group-99',
      groupRow: GROUP_ROW({ id: 'group-99', name: 'New Group' }),
      executeRows: [],
    });

    const detail = await new GroupsService(db).create('user-1', { name: 'New Group' });

    expect(insertedGroups).toHaveLength(1);
    expect(insertedMembers).toEqual([{ groupId: 'group-99', userId: 'user-1' }]);
    expect(detail.id).toBe('group-99');
    expect(detail.name).toBe('New Group');
  });
});

describe('myGroups — row mapping', () => {
  it('coerces the raw query\'s string counts to numbers, and formats the date', async () => {
    const { db } = fakeDb({
      executeRows: [
        { id: 'group-1', name: 'Morning Walkers', created_at: '2026-08-01T00:00:00.000Z', member_count: '5', your_rank: '2' },
      ],
    });

    const result = await new GroupsService(db).myGroups('user-1');

    expect(result.groups).toEqual([
      {
        id: 'group-1',
        name: 'Morning Walkers',
        memberCount: 5,
        yourRank: 2,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    expect(typeof result.groups[0]!.memberCount).toBe('number');
    expect(typeof result.groups[0]!.yourRank).toBe('number');
  });

  it('is empty when the caller belongs to no groups', async () => {
    const { db } = fakeDb({ executeRows: [] });
    const result = await new GroupsService(db).myGroups('user-1');
    expect(result.groups).toEqual([]);
  });
});

describe('leave', () => {
  it('404s when there was no membership row to delete', async () => {
    const { db } = fakeDb({ deleteReturning: [] });
    await expect(new GroupsService(db).leave('user-1', 'group-1')).rejects.toThrow(NotFoundProblem);
  });

  it('resolves when a membership row was actually removed', async () => {
    const { db } = fakeDb({ deleteReturning: [{ id: 'm-1' }] });
    await expect(new GroupsService(db).leave('user-1', 'group-1')).resolves.toBeUndefined();
  });
});
