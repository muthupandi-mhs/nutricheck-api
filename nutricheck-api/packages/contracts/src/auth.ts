import { z } from 'zod';
import { Instant } from './common';

/**
 * Email + password only for this build. The `auth_provider` enum in the schema
 * still carries 'apple' and 'google' so adding them later is a new row, not an
 * ALTER TYPE on a hot enum — the same reasoning that keeps 'photo' in log_source.
 */
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254); // RFC 5321 practical maximum

/**
 * Length is the only rule. Composition rules (one upper, one digit, one symbol)
 * measurably reduce entropy by pushing people to `Password1!` and are advised
 * against by NIST SP 800-63B. The upper bound is a denial-of-service guard:
 * Argon2id will happily spend seconds hashing a megabyte.
 *
 * The minimum is 6, and that is BELOW the 8 the same NIST guidance sets for a
 * user-chosen password. A deliberate product decision, recorded rather than
 * quietly made: this is a nutrition tracker for a market where a long password
 * on a phone keyboard is a real reason not to finish signing up, and the
 * account holds a food log rather than money. What carries the weight instead
 * is Argon2id, rate limiting on the login route, and refresh-token reuse
 * detection -- none of which a longer minimum would improve.
 *
 * Lowering it does not affect existing accounts: sign-in deliberately validates
 * no length, so a password created under the old rule keeps working.
 */
export const Password = z.string().min(6, 'must be at least 6 characters').max(200);

export const RegisterRequest = z.object({
  email: Email,
  password: Password,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * Step one of the single auth flow: is there already an account on this
 * address?
 *
 * It decides which screen step two is — "enter your password" or "set one up" —
 * and it is the reason the client can make exactly one call at step two instead
 * of guessing with the user's password.
 *
 * This answers, without a password, a question `login` goes to real trouble to
 * refuse: it returns the same error for an unknown address as for a wrong
 * password, and spends the same CPU doing it. That defence is now half spent,
 * and it is worth being honest about why it is an acceptable trade rather than
 * pretending it is free:
 *
 *   - `register` already answers it. A 409 on a taken address is the same
 *     oracle, reachable today by anyone willing to send a junk password.
 *   - The alternative is worse for the user, not just different: without it,
 *     step two has to send a password to find out which call it should have
 *     made, and a mistyped password burns a registration attempt.
 *   - What it must not become is a *fast* oracle. It carries the tightest
 *     throttle of the auth routes for that reason — enumeration is a volume
 *     attack, and volume is the part worth denying.
 *
 * It deliberately reveals nothing else. Not whether the account is onboarded,
 * not when it was made, not how it signs in.
 */
export const CheckEmailRequest = z.object({ email: Email });
export type CheckEmailRequest = z.infer<typeof CheckEmailRequest>;

export const CheckEmailResponse = z.object({
  /** True when a live account signs in with this address. */
  registered: z.boolean(),
});
export type CheckEmailResponse = z.infer<typeof CheckEmailResponse>;

export const RefreshRequest = z.object({
  refreshToken: z.string().min(1).max(512),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const TokenPair = z.object({
  accessToken: z.string(),
  /** Opaque, not a JWT. Only its SHA-256 hash is ever stored server-side. */
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  /** Access token lifetime in seconds, so the client can refresh ahead of expiry. */
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof TokenPair>;

export const SessionUser = z.object({
  id: z.string().uuid(),
  email: z.string(),
  createdAt: Instant,
  /** False until the profile and first goal exist — drives the onboarding jump. */
  onboarded: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const AuthResponse = z.object({
  user: SessionUser,
  tokens: TokenPair,
});
export type AuthResponse = z.infer<typeof AuthResponse>;

/** Claims carried in the access token. Kept minimal — it is not a profile cache. */
export const AccessTokenClaims = z.object({
  sub: z.string().uuid(),
  email: z.string(),
  /** Token family, so a revoked session can be recognized without a DB read later. */
  sid: z.string().uuid(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;
