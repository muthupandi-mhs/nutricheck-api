import { z } from 'zod';
import { Email, Password } from './auth';
import { Instant } from './common';
import { FoodDetail, FoodNutrientsPer100g, FoodSource, FoodSummary } from './food';

/**
 * The admin web app's contract. A separate namespace from `auth.ts` on
 * purpose — see `admin_users` in packages/database for why admin sign-in is
 * not just another row in `users`.
 */

export const AdminLoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(200),
});
export type AdminLoginRequest = z.infer<typeof AdminLoginRequest>;

export const AdminSessionUser = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  createdAt: Instant,
  lastLoginAt: Instant.nullable(),
});
export type AdminSessionUser = z.infer<typeof AdminSessionUser>;

export const AdminAuthResponse = z.object({
  admin: AdminSessionUser,
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});
export type AdminAuthResponse = z.infer<typeof AdminAuthResponse>;

/** Claims carried in the admin access token — a distinct signing key from the app's. */
export const AdminTokenClaims = z.object({
  sub: z.string().uuid(),
  email: z.string(),
  name: z.string(),
});
export type AdminTokenClaims = z.infer<typeof AdminTokenClaims>;

/**
 * Offset pagination, unlike the app's opaque `CursorPage`.
 *
 * The app paginates feeds a screen scrolls through once; an admin table is
 * paged back and forth and wants a page number and a total — cursor paging
 * cannot answer "how many rows are there" or "go to page 3" without a scan.
 */
export const AdminPageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(200).optional(),
});
export type AdminPageQuery = z.infer<typeof AdminPageQuery>;

export const adminPaginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });

// --- users -------------------------------------------------------------

export const AdminUserListItem = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  createdAt: Instant,
  deletedAt: Instant.nullable(),
  onboarded: z.boolean(),
  currentWeightKg: z.number().nullable(),
  goalKcal: z.number().int().nullable(),
});
export type AdminUserListItem = z.infer<typeof AdminUserListItem>;

export const AdminUserListResponse = adminPaginated(AdminUserListItem);
export type AdminUserListResponse = z.infer<typeof AdminUserListResponse>;

// --- steps ---------------------------------------------------------------

/** One row of the admin Steps page — every user ranked by their all-time total. */
export const AdminStepsListItem = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  totalSteps: z.number().int(),
  /** The most recent day they logged, or null if they never have. */
  lastLoggedOn: z.string().nullable(),
});
export type AdminStepsListItem = z.infer<typeof AdminStepsListItem>;

export const AdminStepsListResponse = adminPaginated(AdminStepsListItem);
export type AdminStepsListResponse = z.infer<typeof AdminStepsListResponse>;

export const AdminUserProfile = z.object({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  sex: z.enum(['male', 'female']),
  birthDate: z.string(),
  heightCm: z.number(),
  weightKg: z.number(),
  activityLevel: z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active', 'athlete']),
  objective: z.enum(['lose', 'maintain', 'gain']),
  units: z.string(),
});
export type AdminUserProfile = z.infer<typeof AdminUserProfile>;

export const AdminUserGoal = z.object({
  kcal: z.number().int(),
  proteinG: z.number().int(),
  carbsG: z.number().int(),
  fatG: z.number().int(),
  fiberG: z.number().int(),
  effectiveFrom: z.string(),
});
export type AdminUserGoal = z.infer<typeof AdminUserGoal>;

export const AdminUserDetail = z.object({
  id: z.string().uuid(),
  email: z.string(),
  createdAt: Instant,
  deletedAt: Instant.nullable(),
  profile: AdminUserProfile.nullable(),
  goal: AdminUserGoal.nullable(),
  counts: z.object({
    logEntries: z.number().int(),
    weightLogs: z.number().int(),
    feedbackReports: z.number().int(),
  }),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetail>;

// --- foods ---------------------------------------------------------------

export const AdminFoodListItem = FoodSummary.extend({
  source: FoodSource,
  isGeneric: z.boolean(),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: Instant,
});
export type AdminFoodListItem = z.infer<typeof AdminFoodListItem>;

export const AdminFoodListQuery = AdminPageQuery.extend({
  source: FoodSource.optional(),
});
export type AdminFoodListQuery = z.infer<typeof AdminFoodListQuery>;

export const AdminFoodListResponse = adminPaginated(AdminFoodListItem);
export type AdminFoodListResponse = z.infer<typeof AdminFoodListResponse>;

export const AdminFoodAlias = z.object({
  id: z.string().uuid(),
  alias: z.string(),
  locale: z.string(),
});
export type AdminFoodAlias = z.infer<typeof AdminFoodAlias>;

export const AdminFoodDetail = FoodDetail.extend({
  createdByUserId: z.string().uuid().nullable(),
  createdAt: Instant,
  updatedAt: Instant,
  aliases: z.array(AdminFoodAlias),
});
export type AdminFoodDetail = z.infer<typeof AdminFoodDetail>;

/** Admin-curated addition to the corpus — `source` is always `'curated'`, never a user's. */
export const AdminCreateFood = z.object({
  name: z.string().trim().min(1).max(120),
  brand: z.string().trim().max(120).nullable().default(null),
  isGeneric: z.boolean().default(false),
  per100g: FoodNutrientsPer100g,
  defaultPortionGrams: z.number().positive().nullable().default(null),
});
export type AdminCreateFood = z.infer<typeof AdminCreateFood>;

/**
 * Nutrition is replaced as a whole, never merged field-by-field — a PATCH that
 * changed only `kcal` and left a stale `proteinG` behind would be a row that
 * looks edited but is actually half-wrong.
 */
export const AdminUpdateFood = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  brand: z.string().trim().max(120).nullable().optional(),
  isGeneric: z.boolean().optional(),
  per100g: FoodNutrientsPer100g.optional(),
});
export type AdminUpdateFood = z.infer<typeof AdminUpdateFood>;

// --- dashboard -------------------------------------------------------------

export const AdminDashboardStats = z.object({
  totalUsers: z.number().int(),
  activeUsers7d: z.number().int(),
  newUsers7d: z.number().int(),
  deletedUsers: z.number().int(),
  totalFeedback: z.number().int(),
  feedbackByKind: z.object({ bug: z.number().int(), feature: z.number().int() }),
  totalFoods: z.number().int(),
  foodsBySource: z.record(z.string(), z.number().int()),
  aiRunsToday: z.number().int(),
  aiCostTodayUsd: z.number(),
  aiCostMonthUsd: z.number(),
  logEntriesToday: z.number().int(),
});
export type AdminDashboardStats = z.infer<typeof AdminDashboardStats>;

// --- stars -----------------------------------------------------------------

/**
 * Who is currently featured. Carries email/name for the admin table, not the
 * step counts the public `StarsResponse` ranks by — this list is about
 * membership, not standing.
 */
export const AdminStarEntry = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string().nullable(),
  addedAt: Instant,
});
export type AdminStarEntry = z.infer<typeof AdminStarEntry>;

export const AdminStarsResponse = z.object({
  stars: z.array(AdminStarEntry),
});
export type AdminStarsResponse = z.infer<typeof AdminStarsResponse>;

export const AdminAddStar = z.object({
  userId: z.string().uuid(),
});
export type AdminAddStar = z.infer<typeof AdminAddStar>;

// Re-exported so admin-only DTOs never need to import from `./auth` directly.
export { Email as AdminEmail, Password as AdminPassword };
