import { inArray, schema, sql, type Database } from '@nutricheck/database';
import { isGenericDataType, usdaDisplayName, usdaSearchText } from './normalize';
import { readCsv, resolveNutrientIds, type UsdaFoodNutrientRow, type UsdaFoodRow, type UsdaPortionRow } from './usda';

const BATCH = 500;

/** FDC data_type -> our food_source enum. Anything else is skipped, loudly. */
const SOURCE_BY_DATA_TYPE: Record<string, 'usda_foundation' | 'usda_sr' | 'usda_fndds'> = {
  foundation_food: 'usda_foundation',
  sr_legacy_food: 'usda_sr',
  survey_fndds_food: 'usda_fndds',
};

interface Nutrients {
  kcal?: number;
  proteinG?: number;
  /** Present only if USDA actually reports each. Absence is the whole point. */
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
}

export interface IngestReport {
  read: number;
  ingested: number;
  skippedUnknownType: Record<string, number>;
  skippedNoMacros: number;
  fiberKnown: number;
  fiberUnknown: number;
  carbsKnown: number;
  fatKnown: number;
  portions: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function ingestUsda(db: Database, dir: string): Promise<IngestReport> {
  const nutrientIds = await resolveNutrientIds(dir);
  const byId = new Map<string, keyof Nutrients>([
    [nutrientIds.energyKcal, 'kcal'],
    [nutrientIds.protein, 'proteinG'],
    [nutrientIds.fat, 'fatG'],
    [nutrientIds.carbs, 'carbsG'],
    [nutrientIds.fiber, 'fiberG'],
  ]);

  const report: IngestReport = {
    read: 0,
    ingested: 0,
    skippedUnknownType: {},
    skippedNoMacros: 0,
    fiberKnown: 0,
    fiberUnknown: 0,
    carbsKnown: 0,
    fatKnown: 0,
    portions: 0,
  };

  // --- pass 1: foods ------------------------------------------------------
  const foods = new Map<string, { source: string; description: string }>();
  for await (const row of readCsv<UsdaFoodRow>(dir, 'food.csv')) {
    report.read += 1;
    const source = SOURCE_BY_DATA_TYPE[row.data_type];
    if (!source) {
      report.skippedUnknownType[row.data_type] =
        (report.skippedUnknownType[row.data_type] ?? 0) + 1;
      continue;
    }
    foods.set(row.fdc_id, { source, description: row.description });
  }

  // --- pass 2: nutrients --------------------------------------------------
  const nutrients = new Map<string, Nutrients>();
  for await (const row of readCsv<UsdaFoodNutrientRow>(dir, 'food_nutrient.csv')) {
    if (!foods.has(row.fdc_id)) continue;
    const field = byId.get(row.nutrient_id);
    if (!field) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;

    const existing = nutrients.get(row.fdc_id) ?? {};
    existing[field] = amount;
    nutrients.set(row.fdc_id, existing);
  }

  // --- pass 3: portions ---------------------------------------------------
  const units = new Map<string, string>();
  for await (const row of readCsv<{ id: string; name: string }>(dir, 'measure_unit.csv')) {
    units.set(row.id, row.name);
  }

  const portions = new Map<string, Array<{ label: string; grams: number }>>();
  for await (const row of readCsv<UsdaPortionRow>(dir, 'food_portion.csv')) {
    if (!foods.has(row.fdc_id)) continue;
    const grams = Number(row.gram_weight);
    if (!Number.isFinite(grams) || grams <= 0) continue;

    // FDC spreads the human label across three columns and any of them may be
    // blank. Prefer the prose description, fall back to composing one.
    const unit = units.get(row.measure_unit_id);
    const label =
      row.portion_description?.trim() ||
      [row.amount, unit && unit !== 'undetermined' ? unit : '', row.modifier?.trim()]
        .filter(Boolean)
        .join(' ')
        .trim();
    if (!label) continue;

    const list = portions.get(row.fdc_id) ?? [];
    list.push({ label, grams });
    portions.set(row.fdc_id, list);
  }

  // --- write --------------------------------------------------------------
  const rows = [...foods.entries()].flatMap(([fdcId, food]) => {
    const n = nutrients.get(fdcId);
    // kcal and protein are non-negotiable: two of the three headline numbers.
    if (!n || n.kcal === undefined || n.proteinG === undefined) {
      report.skippedNoMacros += 1;
      return [];
    }
    return [{ fdcId, food, n }];
  });

  for (const group of chunk(rows, BATCH)) {
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.foods)
        .values(
          group.map(({ fdcId, food }) => ({
            source: food.source as 'usda_sr',
            sourceId: fdcId,
            name: usdaDisplayName(food.description),
            brand: null,
            isGeneric: isGenericDataType(food.source),
            searchText: usdaSearchText(food.description),
          })),
        )
        .onConflictDoUpdate({
          target: [schema.foods.source, schema.foods.sourceId],
          set: {
            name: sql`excluded.name`,
            searchText: sql`excluded.search_text`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: schema.foods.id, sourceId: schema.foods.sourceId });

      const idBySourceId = new Map(inserted.map((r) => [r.sourceId, r.id]));

      await tx
        .insert(schema.foodNutrients)
        .values(
          group.map(({ fdcId, n }) => {
            // The three-state rule, applied once, here. A missing 291 row means
            // "not measured", never zero — a reported 0.0 is a real known zero.
            const fiberKnown = n.fiberG !== undefined;
            if (fiberKnown) report.fiberKnown += 1;
            else report.fiberUnknown += 1;

            // Same rule for all three: a missing row means "not measured",
            // never zero. A reported 0.0 is a real known zero and stays one.
            const carbsKnown = n.carbsG !== undefined;
            const fatKnown = n.fatG !== undefined;
            if (carbsKnown) report.carbsKnown += 1;
            if (fatKnown) report.fatKnown += 1;

            return {
              foodId: idBySourceId.get(fdcId)!,
              kcal: n.kcal!,
              proteinG: n.proteinG!,
              carbsG: carbsKnown ? n.carbsG! : null,
              carbsState: (carbsKnown ? 'known' : 'unknown') as 'known' | 'unknown',
              fatG: fatKnown ? n.fatG! : null,
              fatState: (fatKnown ? 'known' : 'unknown') as 'known' | 'unknown',
              fiberG: fiberKnown ? n.fiberG! : null,
              fiberState: (fiberKnown ? 'known' : 'unknown') as 'known' | 'unknown',
            };
          }),
        )
        .onConflictDoUpdate({
          target: schema.foodNutrients.foodId,
          set: {
            kcal: sql`excluded.kcal`,
            proteinG: sql`excluded.protein_g`,
            carbsG: sql`excluded.carbs_g`,
            carbsState: sql`excluded.carbs_state`,
            fatG: sql`excluded.fat_g`,
            fatState: sql`excluded.fat_state`,
            fiberG: sql`excluded.fiber_g`,
            fiberState: sql`excluded.fiber_state`,
          },
        });

      // Portions have no natural key, so replace rather than upsert. Scoped to
      // the foods in this batch so a partial run never wipes the whole table.
      const foodIds = group
        .map(({ fdcId }) => idBySourceId.get(fdcId))
        .filter((id): id is string => Boolean(id));

      if (foodIds.length > 0) {
        await tx
          .delete(schema.foodPortions)
          .where(inArray(schema.foodPortions.foodId, foodIds));
      }

      const portionRows = group.flatMap(({ fdcId }) =>
        (portions.get(fdcId) ?? []).map((p, index) => ({
          foodId: idBySourceId.get(fdcId)!,
          label: p.label,
          grams: p.grams,
          isDefault: index === 0,
        })),
      );

      if (portionRows.length > 0) {
        await tx.insert(schema.foodPortions).values(portionRows);
        report.portions += portionRows.length;
      }

      report.ingested += group.length;
    });
  }

  return report;
}
