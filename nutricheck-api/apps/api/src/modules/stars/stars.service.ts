import { Inject, Injectable } from '@nestjs/common';
import type { StarsResponse } from '@nutricheck/contracts';
import { sql, type Database } from '@nutricheck/database';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { stepsWindow } from '../steps/steps.service';

/** Same rolling window the personal report and group leaderboards use. */
const LEADERBOARD_WINDOW_DAYS = 30;

/**
 * The public half of Stars — reads `featured_users`, never writes it. Who is
 * featured is entirely the admin side's decision (`AdminStarsService`).
 */
@Injectable()
export class StarsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<StarsResponse> {
    const { from, to } = stepsWindow(LEADERBOARD_WINDOW_DAYS);

    const result = await this.db.execute<{ user_id: string; name: string | null; total: string }>(sql`
      SELECT
        f.user_id,
        NULLIF(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')), '') AS name,
        COALESCE(SUM(sl.steps), 0) AS total
      FROM featured_users f
      LEFT JOIN user_profiles p ON p.user_id = f.user_id
      LEFT JOIN step_logs sl
        ON sl.user_id = f.user_id AND sl.measured_on BETWEEN ${from}::date AND ${to}::date
      GROUP BY f.user_id, p.first_name, p.last_name
      ORDER BY total DESC
    `);

    return {
      stars: result.rows.map((row) => ({
        userId: row.user_id,
        name: row.name,
        steps: Number(row.total),
      })),
    };
  }
}
