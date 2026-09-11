import { schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { GroupsService } from '../src/modules/groups/groups.service';
import { startTestPostgres, type TestDatabase } from './postgres';

/**
 * Walking groups. The subject of most tests here is membership — who can
 * see what, and what a leaderboard sums — since group creation itself is a
 * one-line insert.
 */
describe('groups', () => {
  let pg: TestDatabase;
  let groups: GroupsService;

  beforeAll(async () => {
    pg = await startTestPostgres();
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

  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number): string =>
    new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);

  async function logSteps(userId: string, steps: number, date = today): Promise<void> {
    await pg.db.insert(schema.stepLogs).values({ userId, measuredOn: date, steps });
  }

  describe('creating', () => {
    it('seats the creator as the first member', async () => {
      const userId = await newUser('creator');
      const group = await groups.create(userId, { name: 'Morning Walkers' });

      expect(group.name).toBe('Morning Walkers');
      expect(group.leaderboard).toHaveLength(1);
      expect(group.leaderboard[0]).toEqual({ userId, name: null, steps: 0 });
    });

    it('gives every group a distinct invite code', async () => {
      const userId = await newUser('creator2');
      const a = await groups.create(userId, { name: 'A' });
      const b = await groups.create(userId, { name: 'B' });

      expect(a.inviteCode).not.toBe(b.inviteCode);
    });
  });

  describe('joining', () => {
    it('adds a second member, visible to both in myGroups', async () => {
      const owner = await newUser('owner');
      const joiner = await newUser('joiner');
      const created = await groups.create(owner, { name: 'Evening Walkers' });

      await groups.join(joiner, { inviteCode: created.inviteCode });

      const [ownerGroups, joinerGroups] = await Promise.all([
        groups.myGroups(owner),
        groups.myGroups(joiner),
      ]);
      expect(ownerGroups.groups.find((g) => g.id === created.id)?.memberCount).toBe(2);
      expect(joinerGroups.groups.find((g) => g.id === created.id)?.memberCount).toBe(2);
    });

    it('accepts the invite code case-insensitively', async () => {
      const owner = await newUser('case-owner');
      const joiner = await newUser('case-joiner');
      const created = await groups.create(owner, { name: 'Case Test' });

      const joined = await groups.join(joiner, { inviteCode: created.inviteCode.toLowerCase() });
      expect(joined.id).toBe(created.id);
    });

    it('404s on an unknown invite code', async () => {
      const userId = await newUser('unknown-code');
      await expect(groups.join(userId, { inviteCode: 'NOSUCHCODE' })).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });

    it('refuses to join a group twice', async () => {
      const owner = await newUser('dupe-owner');
      const created = await groups.create(owner, { name: 'Dupe Test' });

      await expect(groups.join(owner, { inviteCode: created.inviteCode })).rejects.toMatchObject({
        problem: { status: 409 },
      });
    });
  });

  describe('viewing', () => {
    it("404s for someone who isn't a member, rather than revealing the group exists", async () => {
      const owner = await newUser('private-owner');
      const outsider = await newUser('private-outsider');
      const created = await groups.create(owner, { name: 'Private' });

      await expect(groups.detail(outsider, created.id)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });
  });

  describe('the leaderboard', () => {
    it('sums each member’s steps over the window and ranks by total', async () => {
      const owner = await newUser('lb-owner');
      const member = await newUser('lb-member');
      const created = await groups.create(owner, { name: 'Leaderboard Test' });
      await groups.join(member, { inviteCode: created.inviteCode });

      await logSteps(owner, 4000, daysAgo(1));
      await logSteps(owner, 3000, today);
      await logSteps(member, 9000, today);

      const detail = await groups.detail(owner, created.id);

      expect(detail.leaderboard).toEqual([
        { userId: member, name: null, steps: 9000 },
        { userId: owner, name: null, steps: 7000 },
      ]);
    });

    it('narrows to day, week or month as asked, defaulting to month', async () => {
      const owner = await newUser('window-owner');
      const created = await groups.create(owner, { name: 'Window Test' });

      await logSteps(owner, 1000, today);
      await logSteps(owner, 2000, daysAgo(3)); // inside week and month, outside day
      await logSteps(owner, 4000, daysAgo(10)); // inside month only

      const day = await groups.detail(owner, created.id, 'day');
      const week = await groups.detail(owner, created.id, 'week');
      const month = await groups.detail(owner, created.id, 'month');
      const defaulted = await groups.detail(owner, created.id);

      expect(day.window).toBe('day');
      expect(day.leaderboard[0]?.steps).toBe(1000);
      expect(week.window).toBe('week');
      expect(week.leaderboard[0]?.steps).toBe(3000);
      expect(month.window).toBe('month');
      expect(month.leaderboard[0]?.steps).toBe(7000);
      expect(defaulted.window).toBe('month');
      expect(defaulted.leaderboard[0]?.steps).toBe(7000);
    });

    it('ranks each member by the same totals in myGroups, ties sharing a rank', async () => {
      const owner = await newUser('rank-owner');
      const middle = await newUser('rank-middle');
      const tied = await newUser('rank-tied');
      const created = await groups.create(owner, { name: 'Rank Test' });
      await groups.join(middle, { inviteCode: created.inviteCode });
      await groups.join(tied, { inviteCode: created.inviteCode });

      await logSteps(owner, 9000, today);
      await logSteps(middle, 9000, today);
      await logSteps(tied, 3000, today);

      const [ownerGroups, middleGroups, tiedGroups] = await Promise.all([
        groups.myGroups(owner),
        groups.myGroups(middle),
        groups.myGroups(tied),
      ]);

      expect(ownerGroups.groups.find((g) => g.id === created.id)?.yourRank).toBe(1);
      expect(middleGroups.groups.find((g) => g.id === created.id)?.yourRank).toBe(1);
      expect(tiedGroups.groups.find((g) => g.id === created.id)?.yourRank).toBe(3);
    });

    it('does not count steps logged by someone outside the group', async () => {
      const owner = await newUser('isolated-owner');
      const outsider = await newUser('isolated-outsider');
      const created = await groups.create(owner, { name: 'Isolated' });

      await logSteps(outsider, 50_000);

      const detail = await groups.detail(owner, created.id);
      expect(detail.leaderboard).toEqual([{ userId: owner, name: null, steps: 0 }]);
    });
  });

  describe('leaving', () => {
    it('removes the membership, and the group no longer shows in myGroups', async () => {
      const owner = await newUser('leave-owner');
      const leaver = await newUser('leave-member');
      const created = await groups.create(owner, { name: 'Leave Test' });
      await groups.join(leaver, { inviteCode: created.inviteCode });

      await groups.leave(leaver, created.id);

      const leaverGroups = await groups.myGroups(leaver);
      expect(leaverGroups.groups.find((g) => g.id === created.id)).toBeUndefined();
      await expect(groups.detail(leaver, created.id)).rejects.toMatchObject({
        problem: { status: 404 },
      });

      const ownerView = await groups.detail(owner, created.id);
      expect(ownerView.leaderboard).toHaveLength(1);
    });

    it('404s leaving a group never joined', async () => {
      const owner = await newUser('never-joined-owner');
      const stranger = await newUser('never-joined-stranger');
      const created = await groups.create(owner, { name: 'Never Joined' });

      await expect(groups.leave(stranger, created.id)).rejects.toMatchObject({
        problem: { status: 404 },
      });
    });
  });
});
