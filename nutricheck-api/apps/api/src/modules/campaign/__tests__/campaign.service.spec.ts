import { schema, type Database } from '@nutricheck/database';
import { CampaignService } from '../campaign.service';

/**
 * The banner's branching logic, isolated from Postgres.
 *
 * `campaign.int-spec.ts` already proves this end to end against a real
 * database; what a fast unit test buys on top of that is the ability to hit
 * shapes an integration fixture would rather not construct on purpose — a
 * campaign still pointed at a group that has since vanished, or a caller
 * that hands `set()` a scope/groupId combination the Zod contract doesn't
 * actually forbid (see below) — and to say, in milliseconds, which of the
 * two totals queries a given scope reaches for.
 */

type CampaignRow = typeof schema.stepCampaign.$inferSelect;

/**
 * Just enough of `Database` for `CampaignService` to run against: two
 * tables' worth of `select().from().where().limit()`, one `execute` (the
 * service only ever issues one totals query per call, so a single canned
 * answer is unambiguous regardless of which branch asked for it), and the
 * write paths `set`/`clear` go through. Distinguishing `stepCampaign` from
 * `stepGroups` by reference is safe because both the service and this file
 * import the same `schema` module instance.
 */
function fakeDb(opts: {
  campaignRow?: CampaignRow | null;
  groupRow?: { name: string } | null;
  totals?: { total: string; participants: string };
}) {
  const inserted: unknown[] = [];
  const deletedIds: unknown[] = [];

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === schema.stepCampaign) {
              return opts.campaignRow ? [opts.campaignRow] : [];
            }
            if (table === schema.stepGroups) {
              return opts.groupRow ? [{ id: 'some-group-id', name: opts.groupRow.name }] : [];
            }
            return [];
          },
        }),
      }),
    }),
    execute: async () => ({ rows: [opts.totals ?? { total: '0', participants: '0' }] }),
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoUpdate: async ({ set }: { set: unknown }) => {
          inserted.push(set);
        },
      }),
    }),
    delete: () => ({
      where: (cond: unknown) => {
        deletedIds.push(cond);
        return Promise.resolve();
      },
    }),
  };

  return { db: db as unknown as Database, inserted, deletedIds };
}

const SAVED_ROW = (over: Partial<CampaignRow> = {}): CampaignRow => ({
  id: 'default',
  scope: 'all',
  groupId: null,
  goalSteps: 100000,
  title: null,
  tagline: null,
  updatedByAdminId: null,
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  ...over,
});

describe('current — what the app sees with nothing configured', () => {
  it('defaults to everyone, no goal, but a real computed total', async () => {
    const { db } = fakeDb({ campaignRow: null, totals: { total: '4500', participants: '3' } });
    const campaign = await new CampaignService(db).current();

    expect(campaign).toEqual({
      scope: 'all',
      title: null,
      tagline: null,
      goalSteps: null,
      totalSteps: 4500,
      participantCount: 3,
      groupName: null,
    });
  });
});

describe('current — an admin-saved config', () => {
  it('sums every user\'s steps for scope "all", carrying the saved goal and copy', async () => {
    const { db } = fakeDb({
      campaignRow: SAVED_ROW({ goalSteps: 500000, title: 'Walk September', tagline: 'Every step counts' }),
      totals: { total: '812345', participants: '41' },
    });
    const campaign = await new CampaignService(db).current();

    expect(campaign.scope).toBe('all');
    expect(campaign.totalSteps).toBe(812345);
    expect(campaign.participantCount).toBe(41);
    expect(campaign.goalSteps).toBe(500000);
    expect(campaign.title).toBe('Walk September');
    expect(campaign.tagline).toBe('Every step counts');
    expect(campaign.groupName).toBeNull();
  });

  it('narrows to one group\'s members for scope "group", and names that group', async () => {
    const { db } = fakeDb({
      campaignRow: SAVED_ROW({ scope: 'group', groupId: 'g-1', goalSteps: 50000 }),
      groupRow: { name: 'Morning Walkers' },
      totals: { total: '12000', participants: '5' },
    });
    const campaign = await new CampaignService(db).current();

    expect(campaign.scope).toBe('group');
    expect(campaign.totalSteps).toBe(12000);
    expect(campaign.participantCount).toBe(5);
    expect(campaign.groupName).toBe('Morning Walkers');
  });

  /**
   * The defensive branch the service's own comment calls out: a group
   * pointed at by a saved campaign is deleted via `ON DELETE CASCADE`,
   * which takes the campaign row with it in real Postgres — so this shape
   * (a group scope with no matching group) should never survive to a real
   * request. It is exactly the case worth pinning anyway, because the only
   * thing standing between it and a crash is `group?.name ?? null`.
   */
  it('names no group rather than throwing, if the saved group is gone', async () => {
    const { db } = fakeDb({
      campaignRow: SAVED_ROW({ scope: 'group', groupId: 'g-deleted', goalSteps: 50000 }),
      groupRow: null,
      totals: { total: '0', participants: '0' },
    });
    const campaign = await new CampaignService(db).current();

    expect(campaign.groupName).toBeNull();
  });
});

describe("set — normalising what an admin's form can actually send", () => {
  /**
   * `AdminSetCampaign`'s Zod refinement only forbids a MISSING `groupId`
   * when `scope` is `'group'` — it says nothing about scope `'all'` arriving
   * with a stray `groupId` still attached (a form that did not clear the
   * field when the admin switched the dropdown back to "everyone", say).
   * The service is the only place left that can stop that combination from
   * being saved as a group campaign in name only.
   */
  it('drops a groupId that arrived with scope "all", rather than saving it', async () => {
    const { db, inserted } = fakeDb({});
    await new CampaignService(db).set('admin-1', {
      scope: 'all',
      groupId: '11111111-1111-4111-8111-111111111111',
      goalSteps: 20000,
    });

    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { groupId: unknown }).groupId).toBeNull();
    expect((inserted[0] as { scope: unknown }).scope).toBe('all');
  });

  it('keeps the groupId when scope is "group" and the group exists', async () => {
    const { db, inserted } = fakeDb({ groupRow: { name: 'Anything' } });
    await new CampaignService(db).set('admin-1', {
      scope: 'group',
      groupId: '22222222-2222-4222-8222-222222222222',
      goalSteps: 20000,
    });

    expect((inserted[0] as { groupId: unknown }).groupId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('refuses to point the banner at a group that does not exist', async () => {
    const { db, inserted } = fakeDb({ groupRow: null });
    await expect(
      new CampaignService(db).set('admin-1', {
        scope: 'group',
        groupId: '33333333-3333-4333-8333-333333333333',
        goalSteps: 20000,
      }),
    ).rejects.toThrow();
    expect(inserted).toHaveLength(0);
  });
});

describe('clear — idempotent by design', () => {
  it('issues the delete whether or not a row was there to remove', async () => {
    const { db, deletedIds } = fakeDb({ campaignRow: null });
    await expect(new CampaignService(db).clear()).resolves.toBeUndefined();
    expect(deletedIds).toHaveLength(1);
  });
});
