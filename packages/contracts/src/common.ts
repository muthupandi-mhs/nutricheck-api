import { z } from 'zod';

/**
 * RFC 9457 problem details. Every error the API emits serializes to this shape,
 * produced centrally by AllExceptionsFilter — controllers never build one.
 */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  /** Present on 422 only. */
  violations: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
  /** Present on 429 only. */
  resetAt: z.string().datetime().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/**
 * Problem `type` slugs. The client switches on these, so they are part of the
 * contract and may not be renamed without a client release.
 */
export const PROBLEM_TYPES = {
  validationFailed: 'validation-failed',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  notFound: 'not-found',
  conflict: 'conflict',
  rateLimited: 'rate-limited',
  quotaExhausted: 'quota-exhausted',
  resolverTimeout: 'resolver-timeout',
  resolverRefused: 'resolver-refused',
  resolverUnavailable: 'resolver-unavailable',
  internal: 'internal-error',
} as const;

export type ProblemType = (typeof PROBLEM_TYPES)[keyof typeof PROBLEM_TYPES];

export const PROBLEM_BASE_URI = 'https://api.nutricheck.app/problems/';

/** Opaque cursor pagination. Cursors are server-generated and never parsed by the client. */
export const CursorPage = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type CursorPage = z.infer<typeof CursorPage>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

/** RFC 3339 instant. The client always sends its own offset-aware timestamp. */
export const Instant = z.string().datetime({ offset: true });

/** Calendar date in the user's local zone — a "day" in the tracker is local, not UTC. */
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
