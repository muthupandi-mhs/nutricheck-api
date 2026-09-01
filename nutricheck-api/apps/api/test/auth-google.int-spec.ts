import { and, eq, schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/modules/auth/auth.service';
import type { GoogleIdentity } from '../src/modules/auth/google-identity.service';
import { startTestPostgres, type TestDatabase } from './postgres';

/**
 * What a verified Google identity resolves to: an existing account, an existing
 * account it gets attached to, or a new one.
 *
 * Against real Postgres, because the interesting half of this is the two unique
 * indexes. `auth_identities_provider_subject_uq` is what makes a second
 * sign-in the same person, and `users_email_uq` is what makes an address
 * unrepeatable — including for a soft-deleted account, which still holds its
 * email forever and would otherwise surface as a raw 23505 rather than
 * something a person can read.
 *
 * Token verification is stubbed on purpose and tested separately, in
 * `google-identity.service.spec.ts` against real RSA signatures. Everything
 * below starts from a token that has ALREADY been verified — which is the only
 * state this code is ever reached in.
 */

const verified = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  subject: `google-sub-${randomUUID()}`,
  email: `someone-${randomUUID()}@example.com`,
  emailVerified: true,
  ...over,
});

/**
 * The service with its two irrelevant collaborators stubbed out.
 *
 * `passwords` is null because no path here hashes anything — if that ever stops
 * being true, this fails at the point it changes, which is the right moment to
 * find out that signing in with Google started touching Argon2.
 */
function service(pg: TestDatabase, identity: GoogleIdentity): AuthService {
  const google = { verify: async () => identity } as never;
  const tokens = {
    issue: async () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenType: 'Bearer' as const,
      expiresIn: 900,
    }),
  } as never;

  return new AuthService(pg.db, null as never, tokens, google);
}

/** The token itself is never read — `verify` is stubbed — but the call needs one. */
const TOKEN = 'a.b.c';

describe('sign in with Google', () => {
  let pg: TestDatabase;

  beforeAll(async () => {
    pg = await startTestPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  /** An email + password account, as `register` would leave one. */
  async function passwordAccount(email: string): Promise<string> {
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email })
      .returning({ id: schema.users.id });

    await pg.db.insert(schema.authIdentities).values({
      userId: user!.id,
      provider: 'email',
      subject: email,
      passwordHash: 'not-a-real-hash',
    });

    return user!.id;
  }

  function identitiesOf(userId: string) {
    return pg.db
      .select({ provider: schema.authIdentities.provider })
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.userId, userId));
  }

  describe('a Google account nobody here has seen', () => {
    it('creates the user and the identity together', async () => {
      const identity = verified();
      const auth = await service(pg, identity).signInWithGoogle(TOKEN);

      expect(auth.user.email).toBe(identity.email);
      // Nothing has been asked yet, so there is nowhere to go but onboarding.
      expect(auth.user.onboarded).toBe(false);

      await expect(identitiesOf(auth.user.id)).resolves.toEqual([
        { provider: 'google' },
      ]);
    });

    it('stores no password hash, that column being nullable for exactly this', async () => {
      const identity = verified();
      const auth = await service(pg, identity).signInWithGoogle(TOKEN);

      const [row] = await pg.db
        .select({ passwordHash: schema.authIdentities.passwordHash })
        .from(schema.authIdentities)
        .where(eq(schema.authIdentities.userId, auth.user.id));

      expect(row!.passwordHash).toBeNull();
    });
  });

  describe('a Google account that has signed in before', () => {
    /**
     * Keyed on `sub`, not on the email. People rename Gmail accounts and
     * Workspace admins rename them for you, and an account matched on address
     * would follow the address rather than the person — silently making a
     * second account out of somebody who did nothing but change their name.
     */
    it('is the same account the second time, even under a new email', async () => {
      const subject = `google-sub-${randomUUID()}`;
      const first = await service(pg, verified({ subject })).signInWithGoogle(TOKEN);

      const renamed = verified({ subject, email: `renamed-${randomUUID()}@example.com` });
      const second = await service(pg, renamed).signInWithGoogle(TOKEN);

      expect(second.user.id).toBe(first.user.id);
      // And the address on file is the one the account was made with. Chasing
      // the token's email here would be a write racing `users_email_uq`.
      expect(second.user.email).toBe(first.user.email);
      await expect(identitiesOf(first.user.id)).resolves.toHaveLength(1);
    });

    it('refuses a deleted account rather than resurrecting it', async () => {
      const identity = verified();
      const auth = await service(pg, identity).signInWithGoogle(TOKEN);

      await pg.db
        .update(schema.users)
        .set({ deletedAt: new Date() })
        .where(eq(schema.users.id, auth.user.id));

      await expect(
        service(pg, identity).signInWithGoogle(TOKEN),
      ).rejects.toMatchObject({ problem: { status: 401 } });
    });
  });

  describe('an address that already has a password account', () => {
    /**
     * The linking case, and the whole reason `email_verified` is read strictly.
     * Somebody who signed up with a password months ago and now taps the Google
     * button must land in their own food log, not in an empty second account
     * they cannot tell apart from the first.
     */
    it('attaches Google to it, keeping one account and one history', async () => {
      const email = `both-${randomUUID()}@example.com`;
      const userId = await passwordAccount(email);

      const auth = await service(pg, verified({ email })).signInWithGoogle(TOKEN);

      expect(auth.user.id).toBe(userId);

      const providers = (await identitiesOf(userId)).map(r => r.provider).sort();
      expect(providers).toEqual(['email', 'google']);
    });

    it('leaves the password working after linking', async () => {
      const email = `still-${randomUUID()}@example.com`;
      const userId = await passwordAccount(email);

      await service(pg, verified({ email })).signInWithGoogle(TOKEN);

      const [row] = await pg.db
        .select({ passwordHash: schema.authIdentities.passwordHash })
        .from(schema.authIdentities)
        .where(
          and(
            eq(schema.authIdentities.userId, userId),
            eq(schema.authIdentities.provider, 'email'),
          ),
        );

      expect(row!.passwordHash).toBe('not-a-real-hash');
    });

    /**
     * The attack this whole flag exists to stop: a provider that will hand out
     * an unverified address is a way to be given somebody else's account.
     * Nothing about the rest of the flow is suspicious — the token is genuine,
     * the signature is Google's, the audience is ours.
     */
    it('refuses to link when Google has not verified the address', async () => {
      const email = `unverified-${randomUUID()}@example.com`;
      const userId = await passwordAccount(email);

      await expect(
        service(pg, verified({ email, emailVerified: false })).signInWithGoogle(TOKEN),
      ).rejects.toMatchObject({ problem: { status: 401 } });

      // And nothing was attached on the way out.
      await expect(identitiesOf(userId)).resolves.toEqual([{ provider: 'email' }]);
    });

    it('says so readably when the address belongs to a deleted account', async () => {
      const email = `gone-${randomUUID()}@example.com`;
      const userId = await passwordAccount(email);
      await pg.db
        .update(schema.users)
        .set({ deletedAt: new Date() })
        .where(eq(schema.users.id, userId));

      // A 409 rather than the bare 23505 that creating over `users_email_uq`
      // would otherwise produce.
      await expect(
        service(pg, verified({ email })).signInWithGoogle(TOKEN),
      ).rejects.toMatchObject({ problem: { status: 409 } });
    });
  });

  describe('two devices at once', () => {
    /**
     * Both find no identity, both try to create. One wins each unique index;
     * the loser must read back the row that won rather than failing a sign-in
     * that has, from the user's side, already succeeded.
     */
    it('resolves to one account when the same first sign-in races itself', async () => {
      const identity = verified();

      const [a, b] = await Promise.all([
        service(pg, identity).signInWithGoogle(TOKEN),
        service(pg, identity).signInWithGoogle(TOKEN),
      ]);

      expect(a.user.id).toBe(b.user.id);
      await expect(identitiesOf(a.user.id)).resolves.toHaveLength(1);
    });
  });
});
