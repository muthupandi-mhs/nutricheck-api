/**
 * Creates or updates an admin_users row. No Nest DI — same independence as
 * packages/database/src/migrate.ts, and for the same reason: this runs before
 * there is an admin account to log in with, so it cannot go through the API.
 *
 *   npm run admin:create -w @nutricheck/api -- --email you@nutricheck.app --password 'x' --name 'Jane'
 *
 * Re-running with the same email updates the name and password rather than
 * failing on the unique index — rotating an admin's password is the same
 * command as creating them.
 */
import { Algorithm, hash } from '@node-rs/argon2';
import { createDatabase, createPool, eq, schema } from '@nutricheck/database';

/** OWASP Password Storage Cheat Sheet defaults — same as PasswordService. */
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const email = arg('email')?.trim().toLowerCase();
  const password = arg('password');
  const name = arg('name')?.trim();

  if (!email || !password || !name) {
    console.error('Usage: create-admin --email <email> --password <password> --name <name>');
    process.exitCode = 1;
    return;
  }
  if (password.length < 6) {
    console.error('[admin:create] password must be at least 6 characters');
    process.exitCode = 1;
    return;
  }

  const pool = createPool({ url, poolMax: 1 });
  const db = createDatabase(pool);

  try {
    const passwordHash = await hash(password, PARAMS);
    const [existing] = await db
      .select({ id: schema.adminUsers.id })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, email))
      .limit(1);

    if (existing) {
      await db.update(schema.adminUsers).set({ passwordHash, name }).where(eq(schema.adminUsers.id, existing.id));
      console.log(`[admin:create] updated existing admin ${email}`);
    } else {
      await db.insert(schema.adminUsers).values({ email, passwordHash, name });
      console.log(`[admin:create] created admin ${email}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[admin:create] failed:', error);
  process.exitCode = 1;
});
