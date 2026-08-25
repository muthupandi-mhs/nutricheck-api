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
 */
export const Password = z.string().min(10, 'must be at least 10 characters').max(200);

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
