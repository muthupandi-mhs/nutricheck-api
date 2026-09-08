import { z } from 'zod';

/**
 * The QA feedback tab. Deliberately small and unopinionated — no severity,
 * no status workflow, no assignee — because the only two questions a reviewer
 * asks first are "is this a bug or an idea" and "what screen was this on",
 * and adding a taxonomy nobody has agreed on yet is easier to regret than
 * to build. Filed for a real-time test pass; see MOBILEAPP.STATUS.md before
 * treating this as a permanent support channel.
 */

export const FeedbackKind = z.enum(['bug', 'feature']);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const SubmitFeedbackRequest = z.object({
  kind: FeedbackKind,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  /** The route the reporter was on, e.g. "Home" — best-effort, never required. */
  screen: z.string().max(200).optional(),
  /**
   * `Platform.OS`, sent as-is. No `appVersion` alongside it — reading the
   * app's own build number needs a native module this tab is not worth
   * adding, so `FeedbackItem.appVersion` stays null until something else in
   * the app already carries one.
   */
  platform: z.enum(['ios', 'android']).optional(),
});
export type SubmitFeedbackRequest = z.infer<typeof SubmitFeedbackRequest>;

/**
 * One filed report, as returned after submitting and in the review list.
 *
 * `reportedBy` is a display label (name or email), not the raw user id — the
 * only consumer of GET /v1/feedback is a human triaging reports, and a name
 * answers "who do I ask" faster than an id that needs a second lookup.
 */
export const FeedbackItem = z.object({
  id: z.string().uuid(),
  kind: FeedbackKind,
  title: z.string(),
  description: z.string(),
  screen: z.string().nullable(),
  appVersion: z.string().nullable(),
  platform: z.string().nullable(),
  reportedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type FeedbackItem = z.infer<typeof FeedbackItem>;

export const FeedbackList = z.array(FeedbackItem);
export type FeedbackList = z.infer<typeof FeedbackList>;
