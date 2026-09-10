import { Inject, Injectable } from '@nestjs/common';
import type { AdminGroupListResponse } from '@nutricheck/contracts';
import { desc, ilike, schema, sql, type Database } from '@nutricheck/database';
import { DATABASE } from '../../../infrastructure/database/database.tokens';

/**
 * Search-only — no detail route, unlike `AdminUsersService`. The one caller
 * is the campaign banner's group picker, which needs nothing past a name and
 * a member count to let an admin recognise the right group.
 */
@Injectable()
export class AdminGroupsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(q?: string): Promise<AdminGroupListResponse> {
    const rows = await this.db
      .select({
        id: schema.stepGroups.id,
        name: schema.stepGroups.name,
        memberCount: sql<number>`(
          SELECT COUNT(*) FROM step_group_members m WHERE m.group_id = ${schema.stepGroups.id}
        )`,
      })
      .from(schema.stepGroups)
      .where(q ? ilike(schema.stepGroups.name, `%${q}%`) : undefined)
      .orderBy(desc(schema.stepGroups.createdAt))
      .limit(20);

    return { items: rows.map((r) => ({ id: r.id, name: r.name, memberCount: Number(r.memberCount) })) };
  }
}
