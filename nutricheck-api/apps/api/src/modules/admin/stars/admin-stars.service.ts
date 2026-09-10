import { Inject, Injectable } from '@nestjs/common';
import type { AdminStarsResponse } from '@nutricheck/contracts';
import { desc, eq, schema, type Database } from '@nutricheck/database';
import { NotFoundProblem } from '../../../common/problems';
import { DATABASE } from '../../../infrastructure/database/database.tokens';

@Injectable()
export class AdminStarsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<AdminStarsResponse> {
    const rows = await this.db
      .select({
        userId: schema.featuredUsers.userId,
        addedAt: schema.featuredUsers.addedAt,
        email: schema.users.email,
        firstName: schema.userProfiles.firstName,
        lastName: schema.userProfiles.lastName,
      })
      .from(schema.featuredUsers)
      .innerJoin(schema.users, eq(schema.users.id, schema.featuredUsers.userId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.featuredUsers.userId))
      .orderBy(desc(schema.featuredUsers.addedAt));

    return {
      stars: rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || null,
        addedAt: r.addedAt.toISOString(),
      })),
    };
  }

  /** Idempotent: featuring someone already featured changes nothing rather than erroring. */
  async add(adminId: string, userId: string): Promise<void> {
    const [user] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundProblem('User');

    await this.db
      .insert(schema.featuredUsers)
      .values({ userId, addedByAdminId: adminId })
      .onConflictDoNothing();
  }

  async remove(userId: string): Promise<void> {
    const [deleted] = await this.db
      .delete(schema.featuredUsers)
      .where(eq(schema.featuredUsers.userId, userId))
      .returning({ userId: schema.featuredUsers.userId });
    if (!deleted) throw new NotFoundProblem('Featured user');
  }
}
