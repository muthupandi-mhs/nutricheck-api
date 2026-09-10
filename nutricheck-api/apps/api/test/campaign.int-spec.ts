import { schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { CampaignService } from '../src/modules/campaign/campaign.service';
import { GroupsService } from '../src/modules/groups/groups.service';
import { startTestPostgres, type TestDatabase } from './postgres';

/**
 * The Steps screen banner. `current()` is what the app reads; `set`/`clear`
 * are what the admin app calls through the same service — see
 * `AdminCampaignController`'s doc comment for why there is only one.
 */
describe('campaign', () => {
  let pg: TestDatabase;
  let campaign: CampaignService;
  let groups: GroupsService;

  beforeAll(async () => {
    pg = await startTestPostgres();
    campaign = new CampaignService(pg.db);
    groups = new GroupsService(pg.db);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function newUser(tag: string): Promise<string> {
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email: `${tag}-${randomUUID()}@example.com` })
      .returning({ id: schema.users.id });
    return user!.id;
  }

  async function newAdmin(tag: string): Promise<string> {
    const [admin] = await pg.db
      .insert(schema.adminUsers)
      .values({ email: `${tag}-${randomUUID()}@example.com`, passwordHash: 'x', name: tag })
      .returning({ id: schema.adminUsers.id });
    return admin!.id;
  }

  const today = new Date().toISOString().slice(0, 10);

  async function logSteps(userId: string, steps: number): Promise<void> {
    await pg.db.insert(schema.stepLogs).values({ userId, measuredOn: today, steps });
  }

  it('is off until an admin sets one', async () => {
    expect(await campaign.current()).toBeNull();
  });

  it('totals every user’s steps for scope "all"', async () => {
    const admin = await newAdmin('all-scope-admin');
    const a = await newUser('all-scope-a');
    const b = await newUser('all-scope-b');
    await logSteps(a, 4000);
    await logSteps(b, 6000);

    await campaign.set(admin, { scope: 'all', goalSteps: 100_000, title: 'Community Steps' });
    const current = await campaign.current();

    expect(current?.scope).toBe('all');
    expect(current?.title).toBe('Community Steps');
    expect(current?.goalSteps).toBe(100_000);
    expect(current?.totalSteps).toBeGreaterThanOrEqual(10_000); // other tests share this DB
    expect(current?.participantCount).toBeGreaterThanOrEqual(2);
    expect(current?.groupName).toBeNull();

    await campaign.clear();
  });

  it('totals only one group’s members for scope "group"', async () => {
    const admin = await newAdmin('group-scope-admin');
    const owner = await newUser('group-scope-owner');
    const member = await newUser('group-scope-member');
    const outsider = await newUser('group-scope-outsider');
    const group = await groups.create(owner, { name: 'Campaign Group' });
    await groups.join(member, { inviteCode: group.inviteCode });

    await logSteps(owner, 1000);
    await logSteps(member, 2000);
    await logSteps(outsider, 50_000); // outside the group — must not count

    await campaign.set(admin, { scope: 'group', groupId: group.id, goalSteps: 5000 });
    const current = await campaign.current();

    expect(current).toEqual({
      scope: 'group',
      title: null,
      tagline: null,
      totalSteps: 3000,
      goalSteps: 5000,
      participantCount: 2,
      groupName: 'Campaign Group',
    });

    await campaign.clear();
  });

  it('404s setting a group scope to a group that does not exist', async () => {
    const admin = await newAdmin('missing-group-admin');
    await expect(
      campaign.set(admin, { scope: 'group', groupId: randomUUID(), goalSteps: 1000 }),
    ).rejects.toMatchObject({ problem: { status: 404 } });
  });

  it('clearing is idempotent, and turns the banner back off', async () => {
    const admin = await newAdmin('clear-admin');
    await campaign.set(admin, { scope: 'all', goalSteps: 1000 });
    await campaign.clear();
    await campaign.clear();
    expect(await campaign.current()).toBeNull();
  });

  it('adminView reports the raw config alongside the same computed totals', async () => {
    const admin = await newAdmin('view-admin');
    const owner = await newUser('view-owner');
    const group = await groups.create(owner, { name: 'View Group' });
    await campaign.set(admin, { scope: 'group', groupId: group.id, goalSteps: 2000 });

    const view = await campaign.adminView();
    expect(view.scope).toBe('group');
    expect(view.groupId).toBe(group.id);
    expect(view.campaign?.groupName).toBe('View Group');

    await campaign.clear();
  });
});
