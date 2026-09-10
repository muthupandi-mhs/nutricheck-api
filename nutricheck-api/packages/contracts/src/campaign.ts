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
  goalSteps: z.number().int(),
  /** Distinct users counted toward `totalSteps` — everyone, or the group's members. */
  participantCount: z.number().int(),
  /** Set when `scope` is `'group'`. */
  groupName: z.string().nullable(),
});
export type StepsCampaign = z.infer<typeof StepsCampaign>;

/** `campaign` is null when no admin has configured one — the screen renders nothing. */
export const StepsCampaignResponse = z.object({ campaign: StepsCampaign.nullable() });
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

/** The same computed totals the app sees, plus the raw config to re-populate the admin form. */
export const AdminCampaignResponse = z.object({
  campaign: StepsCampaign.nullable(),
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
