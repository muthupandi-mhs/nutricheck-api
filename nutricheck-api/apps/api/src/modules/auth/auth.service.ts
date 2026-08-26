import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  PROBLEM_TYPES,
  type AuthResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type RegisterRequest,
  type SessionUser,
  type TokenPair,
} from '@nutricheck/contracts';
import { and, eq, schema, type Database } from '@nutricheck/database';
import { ProblemException, UnauthorizedProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { PasswordService } from './password.service';
import { RefreshInvalid, RefreshReuseDetected, TokenService } from './token.service';

/**
 * One error for "no such account" and for "wrong password".
 *
 * Distinguishing them turns the login endpoint into an account-existence oracle,
 * which is the input to credential-stuffing target lists.
 */
function badCredentials(): ProblemException {
  return new ProblemException({
    type: PROBLEM_TYPES.unauthorized,
    title: 'Incorrect email or password',
    status: HttpStatus.UNAUTHORIZED,
  });
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async register(input: RegisterRequest): Promise<AuthResponse> {
    const passwordHash = await this.passwords.hash(input.password);

    const user = await this.db
      .transaction(async (tx) => {
        const [created] = await tx
          .insert(schema.users)
          .values({ email: input.email })
          .returning();

        await tx.insert(schema.authIdentities).values({
          userId: created!.id,
          provider: 'email',
          subject: input.email,
          passwordHash,
        });

        return created!;
      })
      .catch((error: unknown) => {
        // Let the unique index decide, rather than SELECT-then-INSERT: the check
        // version has a race window that lets two concurrent signups both pass.
        if (isUniqueViolation(error)) {
          throw new ProblemException({
            type: PROBLEM_TYPES.conflict,
            title: 'That email is already registered',
            status: HttpStatus.CONFLICT,
            detail: 'Sign in instead, or use a different address.',
          });
        }
        throw error;
      });

    const tokens = await this.tokens.issue(user.id, user.email);
    return { user: toSessionUser(user, false), tokens };
  }

  async login(input: LoginRequest): Promise<AuthResponse> {
    const [row] = await this.db
      .select({
        user: schema.users,
        passwordHash: schema.authIdentities.passwordHash,
      })
      .from(schema.authIdentities)
      .innerJoin(schema.users, eq(schema.users.id, schema.authIdentities.userId))
      .where(
        and(
          eq(schema.authIdentities.provider, 'email'),
          eq(schema.authIdentities.subject, input.email),
        ),
      )
      .limit(1);

    if (!row?.passwordHash) {
      // Spend the same CPU as a real verification so timing does not reveal
      // whether the address exists.
      await this.passwords.verifyDummy(input.password);
      throw badCredentials();
    }

    if (row.user.deletedAt !== null) {
      await this.passwords.verifyDummy(input.password);
      throw badCredentials();
    }

    const ok = await this.passwords.verify(row.passwordHash, input.password);
    if (!ok) throw badCredentials();

    const onboarded = await this.isOnboarded(row.user.id);
    const tokens = await this.tokens.issue(row.user.id, row.user.email);
    return { user: toSessionUser(row.user, onboarded), tokens };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    try {
      return await this.tokens.rotate(refreshToken);
    } catch (error) {
      if (error instanceof RefreshReuseDetected) {
        throw new ProblemException({
          type: PROBLEM_TYPES.unauthorized,
          title: 'Session ended for security',
          status: HttpStatus.UNAUTHORIZED,
          detail:
            'This refresh token was already used. Every session was signed out — sign in again.',
        });
      }
      if (error instanceof RefreshInvalid) {
        throw new UnauthorizedProblem('Refresh token is invalid or expired');
      }
      throw error;
    }
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeFamilyOf(refreshToken);
  }

  async changePassword(userId: string, input: ChangePasswordRequest): Promise<void> {
    const [identity] = await this.db
      .select()
      .from(schema.authIdentities)
      .where(
        and(
          eq(schema.authIdentities.userId, userId),
          eq(schema.authIdentities.provider, 'email'),
        ),
      )
      .limit(1);

    if (!identity?.passwordHash) throw badCredentials();

    const ok = await this.passwords.verify(identity.passwordHash, input.currentPassword);
    if (!ok) throw badCredentials();

    const passwordHash = await this.passwords.hash(input.newPassword);

    await this.db
      .update(schema.authIdentities)
      .set({ passwordHash })
      .where(eq(schema.authIdentities.id, identity.id));

    // Every device signs out. A password change that leaves a stolen session
    // alive has not actually recovered the account.
    await this.tokens.revokeAllForUser(userId);
  }

  async findSessionUser(userId: string): Promise<SessionUser | null> {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user || user.deletedAt !== null) return null;
    return toSessionUser(user, await this.isOnboarded(user.id));
  }

  /**
   * A profile AND a goal, which is what the contract has always said.
   *
   * The client does not probe for either — it reads `onboarded` and sends the
   * user straight to Home on the strength of it. Answering true on the profile
   * alone lands a half-onboarded account on a home screen with no targets, and
   * every ring on it divides by a number that is not there. GoalsService now
   * writes both in one transaction, so this is a second lock on the same door:
   * it also covers accounts stranded by the older, non-atomic write.
   */
  private async isOnboarded(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: schema.userProfiles.userId })
      .from(schema.userProfiles)
      .innerJoin(schema.goals, eq(schema.goals.userId, schema.userProfiles.userId))
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1);
    return Boolean(row);
  }
}

function toSessionUser(
  user: typeof schema.users.$inferSelect,
  onboarded: boolean,
): SessionUser {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
    onboarded,
  };
}

/** Postgres 23505 — unique_violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
