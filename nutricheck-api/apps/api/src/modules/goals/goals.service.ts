import { Inject, Injectable } from '@nestjs/common';
import type {
  Goal,
  GoalPreview,
  SetGoal,
  UpdateUserProfile,
  UserProfile,
} from '@nutricheck/contracts';
import { and, desc, eq, lte, schema, type Database } from '@nutricheck/database';
import { NotFoundProblem } from '../../common/problems';
import { DATABASE } from '../../infrastructure/database/database.tokens';
import { computeGoal, type GoalBasis } from './goal-calculator';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

@Injectable()
export class GoalsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const profile = await this.findProfile(userId);
    if (!profile) throw new NotFoundProblem('Profile');
    return profile;
  }

  /**
   * Upserting the profile recomputes the goal, because every input to the goal
   * math lives on the profile. Recalculating on weight change is the whole
   * reason goals are append-only.
   *
   * Both writes are one transaction. The profile row is what makes a session
   * `onboarded`, and the client sends an onboarded user straight to Home
   * without asking for anything else — so a profile that commits while the
   * goal insert fails strands that account on a home screen with no targets.
   * Either both rows land or neither does.
   */
  async upsertProfile(userId: string, patch: UpdateUserProfile): Promise<UserProfile> {
    const existing = await this.findProfile(userId);
    const merged = { ...existing, ...patch } as UserProfile;

    for (const field of REQUIRED_FIELDS) {
      if (merged[field] === undefined || merged[field] === null) {
        throw new NotFoundProblem(`Profile field '${field}'`);
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.userProfiles)
        .values({
          userId,
          sex: merged.sex,
          birthDate: merged.birthDate,
          heightCm: merged.heightCm,
          weightKg: merged.weightKg,
          activityLevel: merged.activityLevel,
          objective: merged.objective,
          rateKgPerWeek: merged.rateKgPerWeek ?? 0,
          units: merged.units ?? 'metric',
        })
        .onConflictDoUpdate({
          target: schema.userProfiles.userId,
          set: {
            sex: merged.sex,
            birthDate: merged.birthDate,
            heightCm: merged.heightCm,
            weightKg: merged.weightKg,
            activityLevel: merged.activityLevel,
            objective: merged.objective,
            rateKgPerWeek: merged.rateKgPerWeek ?? 0,
            units: merged.units ?? 'metric',
            updatedAt: new Date(),
          },
        });

      await this.recalculate(userId, merged, tx);
    });

    return merged;
  }

  /** Derive a goal from the profile and append it, effective today. */
  async recalculate(userId: string, profile?: UserProfile, db: Executor = this.db): Promise<Goal> {
    const source = profile ?? (await this.getProfile(userId));
    const computed = computeGoal(source);
    return this.append(
      userId,
      {
        kcal: computed.kcal,
        proteinG: computed.proteinG,
        carbsG: computed.carbsG,
        fatG: computed.fatG,
        fiberG: computed.fiberG,
        basis: computed.basis,
      },
      db,
    );
  }

  /**
   * The same math as `recalculate`, with nothing written and nothing read.
   *
   * Synchronous and stateless on purpose: it takes no userId because it needs
   * none, which is what makes it safe to call on every keystroke of the
   * targets screen. It shares `computeGoal` with the persisting path, so a
   * preview cannot disagree with the goal the user gets when they accept it.
   */
  previewGoal(profile: UserProfile): GoalPreview {
    const computed = computeGoal(profile);
    return {
      kcal: computed.kcal,
      proteinG: computed.proteinG,
      carbsG: computed.carbsG,
      fatG: computed.fatG,
      fiberG: computed.fiberG,
      basis: computed.basis,
    };
  }

  /**
   * Override one or more targets. Users who can see the math trust it and
   * change it less, but they must still be able to change it.
   */
  async override(userId: string, patch: SetGoal): Promise<Goal> {
    const current = await this.currentGoal(userId);
    return this.append(userId, {
      kcal: patch.kcal ?? current.kcal,
      proteinG: patch.proteinG ?? current.proteinG,
      carbsG: patch.carbsG ?? current.carbsG,
      fatG: patch.fatG ?? current.fatG,
      fiberG: patch.fiberG ?? current.fiberG,
      basis: current.basis,
      effectiveFrom: patch.effectiveFrom,
    });
  }

  async currentGoal(userId: string): Promise<Goal> {
    const goal = await this.goalInEffect(userId, today());
    if (!goal) throw new NotFoundProblem('Goal');
    return goal;
  }

  /**
   * The goal in effect on a given DATE, not the current one.
   *
   * A day view that used today's goal would retroactively turn last month's
   * "you hit your target" into a miss the moment the user's weight changed.
   */
  async goalInEffect(userId: string, date: string): Promise<Goal | null> {
    const [row] = await this.db
      .select()
      .from(schema.goals)
      .where(
        and(eq(schema.goals.userId, userId), lte(schema.goals.effectiveFrom, date)),
      )
      .orderBy(desc(schema.goals.effectiveFrom))
      .limit(1);

    return row ? toGoal(row) : null;
  }

  async history(userId: string): Promise<Goal[]> {
    const rows = await this.db
      .select()
      .from(schema.goals)
      .where(eq(schema.goals.userId, userId))
      .orderBy(desc(schema.goals.effectiveFrom));
    return rows.map(toGoal);
  }

  /**
   * Append-only, with one exception: re-saving on a date that already has a row
   * replaces it. Otherwise adjusting a target twice in one day would fail on the
   * unique index, and "I changed my mind" is not an error condition.
   */
  private async append(
    userId: string,
    input: {
      kcal: number;
      proteinG: number;
      carbsG: number;
      fatG: number;
      fiberG: number;
      basis: GoalBasis;
      effectiveFrom?: string;
    },
    db: Executor = this.db,
  ): Promise<Goal> {
    const effectiveFrom = input.effectiveFrom ?? today();

    const [row] = await db
      .insert(schema.goals)
      .values({
        userId,
        kcal: input.kcal,
        proteinG: input.proteinG,
        carbsG: input.carbsG,
        fatG: input.fatG,
        fiberG: input.fiberG,
        effectiveFrom,
        basis: input.basis,
      })
      .onConflictDoUpdate({
        target: [schema.goals.userId, schema.goals.effectiveFrom],
        set: {
          kcal: input.kcal,
          proteinG: input.proteinG,
          carbsG: input.carbsG,
          fatG: input.fatG,
          fiberG: input.fiberG,
          basis: input.basis,
        },
      })
      .returning();

    return toGoal(row!);
  }

  private async findProfile(userId: string): Promise<UserProfile | null> {
    const [row] = await this.db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, userId))
      .limit(1);

    if (!row) return null;

    return {
      sex: row.sex,
      birthDate: row.birthDate,
      heightCm: row.heightCm,
      weightKg: row.weightKg,
      activityLevel: row.activityLevel,
      objective: row.objective,
      rateKgPerWeek: row.rateKgPerWeek,
      units: row.units as 'metric' | 'imperial',
    };
  }
}

const REQUIRED_FIELDS = [
  'sex',
  'birthDate',
  'heightCm',
  'weightKg',
  'activityLevel',
  'objective',
] as const satisfies ReadonlyArray<keyof UserProfile>;

function toGoal(row: typeof schema.goals.$inferSelect): Goal {
  return {
    id: row.id,
    kcal: row.kcal,
    proteinG: row.proteinG,
    carbsG: row.carbsG,
    fatG: row.fatG,
    fiberG: row.fiberG,
    effectiveFrom: row.effectiveFrom,
    basis: row.basis as Goal['basis'],
  };
}

/** Server-side "today" in UTC. The client sends its own date for day views. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
