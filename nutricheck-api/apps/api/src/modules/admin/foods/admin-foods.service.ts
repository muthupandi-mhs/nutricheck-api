import { Inject, Injectable } from '@nestjs/common';
import {
  normalizeSearchText,
  type AdminCreateFood,
  type AdminFoodDetail,
  type AdminFoodListQuery,
  type AdminFoodListResponse,
  type AdminUpdateFood,
} from '@nutricheck/contracts';
import { and, count, desc, eq, ilike, schema, type Database } from '@nutricheck/database';
import { randomUUID } from 'node:crypto';
import { ConflictProblem, NotFoundProblem } from '../../../common/problems';
import { DATABASE } from '../../../infrastructure/database/database.tokens';

/** Postgres 23503 — foreign_key_violation. */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
  );
}

@Injectable()
export class AdminFoodsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(query: AdminFoodListQuery): Promise<AdminFoodListResponse> {
    const offset = (query.page - 1) * query.pageSize;
    const search = query.q?.trim();

    const conditions = [
      search ? ilike(schema.foods.name, `%${search}%`) : undefined,
      query.source ? eq(schema.foods.source, query.source) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          id: schema.foods.id,
          name: schema.foods.name,
          brand: schema.foods.brand,
          source: schema.foods.source,
          isGeneric: schema.foods.isGeneric,
          createdByUserId: schema.foods.createdByUserId,
          createdAt: schema.foods.createdAt,
          kcal: schema.foodNutrients.kcal,
        })
        .from(schema.foods)
        .innerJoin(schema.foodNutrients, eq(schema.foodNutrients.foodId, schema.foods.id))
        .where(whereClause)
        .orderBy(desc(schema.foods.createdAt))
        .limit(query.pageSize)
        .offset(offset),
      this.db.select({ total: count() }).from(schema.foods).where(whereClause),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        brand: row.brand,
        kcalPer100g: row.kcal,
        source: row.source,
        isGeneric: row.isGeneric,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: totalRow?.total ?? 0,
    };
  }

  async detail(id: string): Promise<AdminFoodDetail> {
    const [row] = await this.db
      .select({
        id: schema.foods.id,
        name: schema.foods.name,
        brand: schema.foods.brand,
        source: schema.foods.source,
        isGeneric: schema.foods.isGeneric,
        createdByUserId: schema.foods.createdByUserId,
        createdAt: schema.foods.createdAt,
        updatedAt: schema.foods.updatedAt,
        kcal: schema.foodNutrients.kcal,
        proteinG: schema.foodNutrients.proteinG,
        carbsG: schema.foodNutrients.carbsG,
        carbsState: schema.foodNutrients.carbsState,
        fatG: schema.foodNutrients.fatG,
        fatState: schema.foodNutrients.fatState,
        fiberG: schema.foodNutrients.fiberG,
        fiberState: schema.foodNutrients.fiberState,
      })
      .from(schema.foods)
      .innerJoin(schema.foodNutrients, eq(schema.foodNutrients.foodId, schema.foods.id))
      .where(eq(schema.foods.id, id))
      .limit(1);

    if (!row) throw new NotFoundProblem('Food');

    const [portions, aliases] = await Promise.all([
      this.db
        .select({ label: schema.foodPortions.label, grams: schema.foodPortions.grams, isDefault: schema.foodPortions.isDefault })
        .from(schema.foodPortions)
        .where(eq(schema.foodPortions.foodId, id))
        .orderBy(desc(schema.foodPortions.isDefault)),
      this.db
        .select({ id: schema.foodAliases.id, alias: schema.foodAliases.alias, locale: schema.foodAliases.locale })
        .from(schema.foodAliases)
        .where(eq(schema.foodAliases.foodId, id)),
    ]);

    return {
      id: row.id,
      name: row.name,
      brand: row.brand,
      kcalPer100g: row.kcal,
      source: row.source,
      isGeneric: row.isGeneric,
      nutrients: {
        kcal: row.kcal,
        proteinG: row.proteinG,
        carbsG: row.carbsG,
        carbsState: row.carbsState,
        fatG: row.fatG,
        fatState: row.fatState,
        fiberG: row.fiberG,
        fiberState: row.fiberState,
      },
      portions,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      aliases,
    };
  }

  /**
   * Always `source: 'curated'` and `createdByUserId: null` — an admin
   * addition is not a user's custom food, and `source` is how everything
   * downstream (search's ranking bonus, the "how much of this did a model
   * write" query) tells the two apart.
   */
  async create(input: AdminCreateFood): Promise<AdminFoodDetail> {
    const id = await this.db.transaction(async (tx) => {
      const [food] = await tx
        .insert(schema.foods)
        .values({
          source: 'curated',
          sourceId: `admin:${randomUUID()}`,
          name: input.name.trim(),
          brand: input.brand,
          isGeneric: input.isGeneric,
          searchText: normalizeSearchText(input.name, input.brand),
          createdByUserId: null,
        })
        .returning({ id: schema.foods.id });

      await tx.insert(schema.foodNutrients).values({
        foodId: food!.id,
        kcal: input.per100g.kcal,
        proteinG: input.per100g.proteinG,
        carbsG: input.per100g.carbsState === 'unknown' ? null : input.per100g.carbsG,
        carbsState: input.per100g.carbsState,
        fatG: input.per100g.fatState === 'unknown' ? null : input.per100g.fatG,
        fatState: input.per100g.fatState,
        fiberG: input.per100g.fiberState === 'unknown' ? null : input.per100g.fiberG,
        fiberState: input.per100g.fiberState,
      });

      if (input.defaultPortionGrams) {
        await tx.insert(schema.foodPortions).values({
          foodId: food!.id,
          label: '1 serving',
          grams: input.defaultPortionGrams,
          isDefault: true,
        });
      }

      return food!.id;
    });

    return this.detail(id);
  }

  async update(id: string, input: AdminUpdateFood): Promise<AdminFoodDetail> {
    const [existing] = await this.db
      .select({ name: schema.foods.name, brand: schema.foods.brand })
      .from(schema.foods)
      .where(eq(schema.foods.id, id))
      .limit(1);
    if (!existing) throw new NotFoundProblem('Food');

    await this.db.transaction(async (tx) => {
      const touchesName = input.name !== undefined || input.brand !== undefined;
      if (touchesName || input.isGeneric !== undefined) {
        const name = input.name ?? existing.name;
        const brand = input.brand === undefined ? existing.brand : input.brand;

        await tx
          .update(schema.foods)
          .set({
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.brand !== undefined ? { brand: input.brand } : {}),
            ...(input.isGeneric !== undefined ? { isGeneric: input.isGeneric } : {}),
            ...(touchesName ? { searchText: normalizeSearchText(name, brand) } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.foods.id, id));
      }

      if (input.per100g) {
        await tx
          .update(schema.foodNutrients)
          .set({
            kcal: input.per100g.kcal,
            proteinG: input.per100g.proteinG,
            carbsG: input.per100g.carbsState === 'unknown' ? null : input.per100g.carbsG,
            carbsState: input.per100g.carbsState,
            fatG: input.per100g.fatState === 'unknown' ? null : input.per100g.fatG,
            fatState: input.per100g.fatState,
            fiberG: input.per100g.fiberState === 'unknown' ? null : input.per100g.fiberG,
            fiberState: input.per100g.fiberState,
          })
          .where(eq(schema.foodNutrients.foodId, id));
      }
    });

    return this.detail(id);
  }

  /**
   * Refuses to delete a row this API did not create. USDA and Open Food Facts
   * rows are re-ingested from source, not authored here — deleting one just
   * has it reappear on the next ingest, so the honest refusal is a 409, not a
   * delete that silently doesn't stick.
   */
  async remove(id: string): Promise<void> {
    const [existing] = await this.db.select({ source: schema.foods.source }).from(schema.foods).where(eq(schema.foods.id, id)).limit(1);
    if (!existing) throw new NotFoundProblem('Food');

    if (existing.source !== 'user' && existing.source !== 'curated' && existing.source !== 'ai') {
      throw new ConflictProblem(
        'Cannot delete a corpus food',
        'USDA and Open Food Facts rows are re-ingested from source — remove or correct the source data instead.',
      );
    }

    try {
      await this.db.delete(schema.foods).where(eq(schema.foods.id, id));
    } catch (error) {
      // log_items.food_id is ON DELETE RESTRICT: a food someone has actually
      // logged must not vanish out from under their history.
      if (isForeignKeyViolation(error)) {
        throw new ConflictProblem(
          'Food is in use',
          'This food is referenced by at least one log entry and cannot be deleted.',
        );
      }
      throw error;
    }
  }
}
