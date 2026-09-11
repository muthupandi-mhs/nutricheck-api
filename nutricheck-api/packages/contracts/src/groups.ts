import { z } from 'zod';
import { Instant } from './common';
import { StepsLeaderboardEntry } from './steps';

/**
 * Walking groups. Anyone can create one or join one — there is no
 * invitation-by-admin here, unlike Stars. A group's own steps are never
 * tracked separately: its leaderboard is the sum of what each member has
 * already synced from their device (see `StepsLeaderboardEntry`).
 */

export const CreateGroup = z.object({
  name: z.string().trim().min(1).max(60),
});
export type CreateGroup = z.infer<typeof CreateGroup>;

export const JoinGroup = z.object({
  inviteCode: z.string().trim().min(1).max(16),
});
export type JoinGroup = z.infer<typeof JoinGroup>;

/** How far back a leaderboard looks — today only, the last 7 days, or the last 30. */
export const LeaderboardWindow = z.enum(['day', 'week', 'month']);
export type LeaderboardWindow = z.infer<typeof LeaderboardWindow>;

export const GroupDetailQuery = z.object({
  window: LeaderboardWindow.default('month'),
});
export type GroupDetailQuery = z.infer<typeof GroupDetailQuery>;

/**
 * One row in "the groups I'm in" — no full leaderboard here, just enough to
 * list, show standing, and open one. `yourRank` is 1-based and standard
 * competition ranking: tied members share a rank and the next rank skips
 * ahead by the tie's size, same as the podium reads on `GroupDetail`'s full
 * leaderboard.
 */
export const StepGroup = z.object({
  id: z.string().uuid(),
  name: z.string(),
  memberCount: z.number().int().positive(),
  yourRank: z.number().int().positive(),
  createdAt: Instant,
});
export type StepGroup = z.infer<typeof StepGroup>;

export const MyGroupsResponse = z.object({
  groups: z.array(StepGroup),
});
export type MyGroupsResponse = z.infer<typeof MyGroupsResponse>;

/**
 * One group in full — the invite code is visible to every member, not just
 * whoever created it, since any of them sharing it is how the group grows.
 */
export const GroupDetail = z.object({
  id: z.string().uuid(),
  name: z.string(),
  inviteCode: z.string(),
  createdAt: Instant,
  /** Which window `leaderboard` was ranked over — echoed back rather than assumed, so a toggle and an in-flight response can never disagree about what's on screen. */
  window: LeaderboardWindow,
  leaderboard: z.array(StepsLeaderboardEntry),
});
export type GroupDetail = z.infer<typeof GroupDetail>;
