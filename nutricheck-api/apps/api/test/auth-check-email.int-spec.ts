import { eq, schema } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/modules/auth/auth.service';
import { startTestPostgres, type TestDatabase } from './postgres';

/**
 * The endpoint that decides which screen step two of the auth flow is.
 *
 * It only reads, and it only reads the database, so it is built with the two
 * collaborators it never touches left out. If `checkEmail` ever grows a
 * dependency on either, this fails loudly at the point it does — which is the
 * right moment to find out that answering "does this address exist" started
 * hashing something.
 */
function service(pg: TestDatabase): AuthService {
  return new AuthService(pg.db, null as never, null as never);
}

describe('check-email', () => {
  let pg: TestDatabase;
  let auth: AuthService;

  beforeAll(async () => {
    pg = await startTestPostgres();
    auth = service(pg);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  /** A user with an email identity, as `register` would leave one. */
  async function account(email: string): Promise<string> {
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

  it('says yes to an address that can sign in', async () => {
    const email = `known-${randomUUID()}@example.com`;
    await account(email);

    expect(await auth.checkEmail(email)).toEqual({ registered: true });
  });

  it('says no to an address nobody has used', async () => {
    expect(await auth.checkEmail(`nobody-${randomUUID()}@example.com`)).toEqual({
      registered: false,
    });
  });

  it('says no once the account is deleted, matching what sign-in would do', async () => {
    const email = `gone-${randomUUID()}@example.com`;
    const id = await account(email);

    await pg.db
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, id));

    // The identity row still exists. Answering on that alone would send someone
    // to a password screen that could only ever reject them, because `login`
    // treats a soft-deleted user as no account at all.
    expect(await auth.checkEmail(email)).toEqual({ registered: false });
  });

  it('answers on the email identity, not on any other provider', async () => {
    const email = `social-${randomUUID()}@example.com`;
    const [user] = await pg.db
      .insert(schema.users)
      .values({ email })
      .returning({ id: schema.users.id });

    await pg.db.insert(schema.authIdentities).values({
      userId: user!.id,
      provider: 'google',
      subject: email,
      passwordHash: null,
    });

    // There is no Google sign-in in this build, but the enum carries it and the
    // row shape allows it. Such an account cannot take a password, so the
    // password step must not be offered for one.
    expect(await auth.checkEmail(email)).toEqual({ registered: false });
  });

  it('returns nothing but the answer', async () => {
    const email = `shape-${randomUUID()}@example.com`;
    await account(email);

    // Whatever this returns is readable by anyone who can guess an address.
    expect(Object.keys(await auth.checkEmail(email))).toEqual(['registered']);
  });
});
