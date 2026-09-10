import { z } from 'zod';
import { StepsLeaderboardEntry } from './steps';

/**
 * The Stars leaderboard — who appears is chosen by an admin (see
 * `AdminStarsResponse`), not by the user reading it. This is the read-only
 * public side: any signed-in user can see it, nobody can change it here.
 */
export const StarsResponse = z.object({
  stars: z.array(StepsLeaderboardEntry),
});
export type StarsResponse = z.infer<typeof StarsResponse>;
