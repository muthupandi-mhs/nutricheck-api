import { z } from 'zod';

/**
 * The Steps screen's banner — a total against a goal, scoped by an admin to
 * either every user or one group. See `StepsCampaignResponse`.
 */
export const CampaignScope = z.enum(['all', 'group']);
export type CampaignScope = z.infer<typeof CampaignScope>;

export const StepsCampaign = z.object({
  scope: CampaignScope,
  title: z.string().nullable(),
  tagline: z.string().nullable(),
  totalSteps: z.number().int(),
  /** Null until an admin sets one — the banner still shows the total, just without a goal to measure it against. */
  goalSteps: z.number().int().nullable(),
  /** Distinct users counted toward `totalSteps` — everyone, or the group's members. */
  participantCount: z.number().int(),
  /** Set when `scope` is `'group'`. */
  groupName: z.string().nullable(),
});
export type StepsCampaign = z.infer<typeof StepsCampaign>;

/**
 * Never null: with nothing configured yet, the screen still gets the
 * "everyone" scope and a real total, un-set fields and all — a banner an
 * admin can later point at a goal or a single group, not one that has to be
 * switched on first.
 */
export const StepsCampaignResponse = z.object({ campaign: StepsCampaign });
export type StepsCampaignResponse = z.infer<typeof StepsCampaignResponse>;

// --- admin ---------------------------------------------------------------

export const AdminSetCampaign = z
  .object({
    scope: CampaignScope,
    groupId: z.string().uuid().optional(),
    goalSteps: z.number().int().positive(),
    title: z.string().trim().max(80).optional(),
    tagline: z.string().trim().max(140).optional(),
  })
  .refine((v) => v.scope === 'all' || !!v.groupId, {
    message: 'groupId is required when scope is "group"',
    path: ['groupId'],
  });
export type AdminSetCampaign = z.infer<typeof AdminSetCampaign>;

/**
 * The same computed totals the app sees, plus the raw config to re-populate
 * the admin form. `scope`/`groupId` are null only when nothing has been
 * explicitly saved yet — `campaign` itself is never null, see `StepsCampaignResponse`.
 */
export const AdminCampaignResponse = z.object({
  campaign: StepsCampaign,
  scope: CampaignScope.nullable(),
  groupId: z.string().uuid().nullable(),
});
export type AdminCampaignResponse = z.infer<typeof AdminCampaignResponse>;

export const AdminGroupSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  memberCount: z.number().int(),
});
export type AdminGroupSummary = z.infer<typeof AdminGroupSummary>;

export const AdminGroupListResponse = z.object({ items: z.array(AdminGroupSummary) });
export type AdminGroupListResponse = z.infer<typeof AdminGroupListResponse>;
