import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  PROBLEM_TYPES,
  type AuthResponse,
  type ChangePasswordRequest,
  type CheckEmailResponse,
  type LoginRequest,
  type RegisterRequest,
  type SessionUser,
  type TokenPair,
} from '@nutricheck/contracts';
import { and, eq, schema, type Database } from '@nutricheck/database';
import { ProblemException, UnauthorizedProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import {
  GoogleIdentityService,
  type GoogleIdentity,
} from './google-identity.service';
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
    private readonly google: GoogleIdentityService,
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

  /**
   * Whether an address can be signed in to.
   *
   * Deliberately the same conditions `login` treats as an account: the email
   * identity exists AND the user is not soft-deleted. Answering on the identity
   * alone would send someone whose account was deleted to a password screen
   * that could only ever reject them.
   *
   * Returns a boolean and nothing else — no id, no timestamps, no onboarding
   * state. Whatever this endpoint returns is readable by anyone who can guess
   * an address, so it says the one thing the flow needs and stops.
   */
  async checkEmail(email: string): Promise<CheckEmailResponse> {
    const [row] = await this.db
      .select({ deletedAt: schema.users.deletedAt })
      .from(schema.authIdentities)
      .innerJoin(schema.users, eq(schema.users.id, schema.authIdentities.userId))
      .where(
        and(
          eq(schema.authIdentities.provider, 'email'),
          eq(schema.authIdentities.subject, email),
        ),
      )
      .limit(1);

    return { registered: row !== undefined && row.deletedAt === null };
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

  /**
   * Sign in with Google, which is also sign UP with Google — the client cannot
   * tell them apart and does not have to.
   *
   * `register` and `login` are two routes because the password flow has to ask
   * for the password before it knows which one it is doing. Nothing here needs
   * that: a verified token settles who this is, so the three cases —
   * returning, linking, new — are decided from the token rather than from a
   * flag the client sent.
   *
   * No throttle-equalising dummy work like `login` does, and none needed. That
   * exists so response time cannot reveal whether an address is registered;
   * here every path does the same RSA verify and the same one or two queries,
   * and none of them is the ~50ms Argon2 hash that made the difference
   * measurable in the first place.
   */
  async signInWithGoogle(idToken: string): Promise<AuthResponse> {
    const identity = await this.google.verify(idToken);
    const user = await this.resolveGoogleUser(identity);

    const onboarded = await this.isOnboarded(user.id);
    const tokens = await this.tokens.issue(user.id, user.email);
    return { user: toSessionUser(user, onboarded), tokens };
  }

  /**
   * The account behind a verified Google identity: found, linked, or created.
   *
   * Written as one method because the three outcomes are one decision, and
   * splitting them is how a caller ends up taking two of the branches.
   */
  private async resolveGoogleUser(
    identity: GoogleIdentity,
  ): Promise<typeof schema.users.$inferSelect> {
    const existing = await this.userByGoogleSubject(identity.subject);

    if (existing) {
      // A soft-deleted account does not come back by signing in again — the
      // same rule `login` applies. Deleting an account has to mean something.
      if (existing.deletedAt !== null) throw badCredentials();
      return existing;
    }

    /**
     * Everything past here needs a verified address, including CREATING an
     * account, and that is stricter than it strictly has to be.
     *
     * Linking requires it for the obvious reason: `email_verified` is the only
     * thing standing between "sign in with Google" and "type somebody else's
     * address into a provider that will not check it, and be handed their food
     * log". That much is not negotiable.
     *
     * Creating requires it too, which is the arguable half. An unverified
     * address on a NEW account cannot steal anything — but it does take the
     * address, and `users_email_uq` means the person who actually owns it then
     * gets a 409 when they try to register. Refusing is a worse error message
     * for a case that essentially does not occur (consumer and Workspace
     * accounts both come back verified) in exchange for closing a squat that
     * would be permanent. Loosen this only with the unique index in view.
     */
    if (!identity.emailVerified) {
      throw new ProblemException({
        type: PROBLEM_TYPES.unauthorized,
        title: 'Google has not verified that address',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Verify your email with Google, or sign in with a password instead.',
      });
    }

    const linked = await this.linkGoogleToExistingAccount(identity);
    if (linked) return linked;

    return this.createGoogleUser(identity);
  }

  /**
   * Attach a Google identity to the account that already owns this address.
   *
   * Returns null when there is no such account, which is the signal to create
   * one. Throws when the address belongs to a DELETED account: the email is
   * still spent as far as `users_email_uq` is concerned, so the alternative is
   * a raw 23505 rather than something a person can read.
   */
  private async linkGoogleToExistingAccount(
    identity: GoogleIdentity,
  ): Promise<typeof schema.users.$inferSelect | null> {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, identity.email))
      .limit(1);

    if (!user) return null;

    if (user.deletedAt !== null) {
      throw new ProblemException({
        type: PROBLEM_TYPES.conflict,
        title: 'That account was deleted',
        status: HttpStatus.CONFLICT,
        detail: 'Use a different Google account, or get in touch to restore it.',
      });
    }

    await this.db
      .insert(schema.authIdentities)
      .values({ userId: user.id, provider: 'google', subject: identity.subject })
      // Two devices signing in at once both find no identity and both insert.
      // The second is not an error — it is the same row.
      .onConflictDoNothing({
        target: [schema.authIdentities.provider, schema.authIdentities.subject],
      });

    return user;
  }

  /** First sign-in from an address nobody holds: the user and the identity together. */
  private async createGoogleUser(
    identity: GoogleIdentity,
  ): Promise<typeof schema.users.$inferSelect> {
    try {
      return await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(schema.users)
          .values({ email: identity.email })
          .returning();

        await tx.insert(schema.authIdentities).values({
          userId: created!.id,
          provider: 'google',
          // No passwordHash. That column is nullable precisely for this: a
          // Google account has no password here, and inventing one would be a
          // credential nobody chose and nobody can rotate.
          subject: identity.subject,
        });

        return created!;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      /**
       * Lost a race with another device signing in at the same instant, on
       * either unique index. Whichever row won, it is this same person's — the
       * subject came out of a token we verified — so read it back rather than
       * failing a sign-in that has already succeeded once.
       */
      const raced = await this.userByGoogleSubject(identity.subject);
      if (raced && raced.deletedAt === null) return raced;

      throw new ProblemException({
        type: PROBLEM_TYPES.conflict,
        title: 'That email is already registered',
        status: HttpStatus.CONFLICT,
        detail: 'Sign in with your password instead.',
      });
    }
  }

  private async userByGoogleSubject(
    subject: string,
  ): Promise<typeof schema.users.$inferSelect | undefined> {
    const [row] = await this.db
      .select({ user: schema.users })
      .from(schema.authIdentities)
      .innerJoin(schema.users, eq(schema.users.id, schema.authIdentities.userId))
      .where(
        and(
          eq(schema.authIdentities.provider, 'google'),
          eq(schema.authIdentities.subject, subject),
        ),
      )
      .limit(1);

    return row?.user;
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

  /**
   * `currentFamilyId` is the session making the change — its `sid` claim —
   * and is spared from the sign-out. Every OTHER device still goes: the
   * point of the sweep is that a stolen session elsewhere does not survive
   * the owner recovering their account, not that the owner has to sign back
   * in on the device they just used to do it.
   */
  async changePassword(
    userId: string,
    input: ChangePasswordRequest,
    currentFamilyId?: string,
  ): Promise<void> {
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

    await this.tokens.revokeAllForUser(userId, currentFamilyId);
  }

  /**
   * Soft-deletes the account: stamps `deletedAt` rather than removing the
   * row, and signs out every device the same way `changePassword` does.
   *
   * A stamp rather than a row deletion because the account is meant to stay
   * recoverable for a 30-day grace window — every place that gates on it
   * (`login`, `checkEmail`, `signInWithGoogle`) already reads `deletedAt`, so
   * setting it is what actually turns the account off. Purging the row once
   * the window has passed is a separate, later concern; this method only
   * marks the moment the window starts.
   */
  async deleteAccount(userId: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, userId));

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
