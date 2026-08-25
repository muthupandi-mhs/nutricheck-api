import { normalizeSearchText } from '@nutricheck/contracts';
import { inArray, schema, sql, type Database } from '@nutricheck/database';
import { readFileSync } from 'node:fs';

/**
 * Curated dish ingestion.
 *
 * The gap-filler PLAN §5 describes. USDA is US-centric and has essentially
 * nothing for South Indian food, so no amount of search tuning finds "dosai" —
 * the only fix is rows you own, with the names people actually type attached.
 */

interface CuratedFood {
  key: string;
  name: string;
  per100g: { kcal: number; proteinG: number; fiberG: number | null };
  portions: Array<{ label: string; grams: number; isDefault: boolean }>;
  aliases: Record<string, string[]>;
}

/**
 * Attaches aliases to a food that already exists, identified by its source id.
 *
 * USDA already has mango and brinjal; what it lacks is the words a Tamil
 * speaker types. Creating a duplicate row would fork the nutrition data for no
 * reason — this points the existing row at more names.
 */
interface AliasAttachment {
  sourceId: string;
  aliases: Record<string, string[]>;
}

interface CuratedFile {
  source: string;
  foods?: CuratedFood[];
  attachTo?: AliasAttachment[];
}

export interface CuratedReport {
  foods: number;
  aliases: number;
  portions: number;
}

export async function ingestCurated(
  db: Database,
  filePath: string,
): Promise<CuratedReport> {
  const file = JSON.parse(readFileSync(filePath, 'utf8')) as CuratedFile;
  const report: CuratedReport = { foods: 0, aliases: 0, portions: 0 };

  if (file.attachTo?.length) {
    report.aliases += await attachAliases(db, file.attachTo);
  }

  const foods = file.foods ?? [];
  if (foods.length === 0) return report;

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.foods)
      .values(
        foods.map((food) => ({
          source: 'curated' as const,
          sourceId: food.key,
          name: food.name,
          brand: null,
          // Generic in the sense that matters for ranking: not a branded
          // supermarket product, so it should outrank one.
          isGeneric: true,
          // Every alias is folded into search_text as well as living in its own
          // table. The table is what makes an alias editable without a
          // re-ingest; this makes a single-index query find it too.
          searchText: normalizeSearchText(
            food.name,
            ...Object.values(food.aliases).flat(),
          ),
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

    const idByKey = new Map(inserted.map((r) => [r.sourceId, r.id]));
    report.foods = inserted.length;

    await tx
      .insert(schema.foodNutrients)
      .values(
        foods.map((food) => ({
          foodId: idByKey.get(food.key)!,
          kcal: food.per100g.kcal,
          proteinG: food.per100g.proteinG,
          fiberG: food.per100g.fiberG,
          // 'imputed', not 'known'. These are estimates from typical home
          // preparation, not lab measurements, and the app renders imputed
          // fiber with a "~" — so the honesty reaches the user rather than
          // stopping at the JSON file.
          fiberState: (food.per100g.fiberG === null ? 'unknown' : 'imputed') as
            | 'unknown'
            | 'imputed',
        })),
      )
      .onConflictDoUpdate({
        target: schema.foodNutrients.foodId,
        set: {
          kcal: sql`excluded.kcal`,
          proteinG: sql`excluded.protein_g`,
          fiberG: sql`excluded.fiber_g`,
          fiberState: sql`excluded.fiber_state`,
        },
      });

    const foodIds = [...idByKey.values()];

    // Replace rather than upsert: portions and aliases have no natural key, and
    // scoping the delete to this file's foods means a partial run never wipes
    // rows belonging to another source.
    await tx.delete(schema.foodPortions).where(inArray(schema.foodPortions.foodId, foodIds));
    await tx.delete(schema.foodAliases).where(inArray(schema.foodAliases.foodId, foodIds));

    const portionRows = foods.flatMap((food) =>
      food.portions.map((p) => ({
        foodId: idByKey.get(food.key)!,
        label: p.label,
        grams: p.grams,
        isDefault: p.isDefault,
      })),
    );
    if (portionRows.length > 0) {
      await tx.insert(schema.foodPortions).values(portionRows);
      report.portions = portionRows.length;
    }

    // Normalized with the SAME function the query uses. If these diverge the
    // alias index is built over bytes the query never produces.
    const aliasRows = foods.flatMap((food) =>
      Object.entries(food.aliases).flatMap(([locale, names]) =>
        names.map((alias) => ({
          foodId: idByKey.get(food.key)!,
          alias: normalizeSearchText(alias),
          locale,
        })),
      ),
    );

    // Two locales can spell a dish identically ("chutney" as both Tanglish and
    // English); the unique index is on (food_id, alias), so dedupe first.
    const seen = new Set<string>();
    const uniqueAliases = aliasRows.filter((row) => {
      const key = `${row.foodId}:${row.alias}`;
      if (seen.has(key) || row.alias.length === 0) return false;
      seen.add(key);
      return true;
    });

    if (uniqueAliases.length > 0) {
      await tx.insert(schema.foodAliases).values(uniqueAliases);
      report.aliases = uniqueAliases.length;
    }
  });

  return report;
}

/**
 * Attach aliases to existing rows.
 *
 * A sourceId that matches nothing is reported rather than skipped: USDA
 * reissues data and ids do move, and an alias silently attached to nothing is
 * a search that quietly stops working.
 */
async function attachAliases(
  db: Database,
  attachments: AliasAttachment[],
): Promise<number> {
  const ids = attachments.map((a) => a.sourceId);
  const rows = await db
    .select({ id: schema.foods.id, sourceId: schema.foods.sourceId })
    .from(schema.foods)
    .where(inArray(schema.foods.sourceId, ids));

  const bySourceId = new Map(rows.map((r) => [r.sourceId, r.id]));
  const missing = ids.filter((id) => !bySourceId.has(id));
  if (missing.length > 0) {
    console.warn(
      `  [warn] ${missing.length} alias target(s) not in the corpus: ${missing.join(', ')}`,
    );
  }

  const values: Array<{ foodId: string; alias: string; locale: string }> = [];
  const seen = new Set<string>();

  for (const attachment of attachments) {
    const foodId = bySourceId.get(attachment.sourceId);
    if (!foodId) continue;
    for (const [locale, names] of Object.entries(attachment.aliases)) {
      for (const name of names) {
        const alias = normalizeSearchText(name);
        const key = `${foodId}:${alias}`;
        if (!alias || seen.has(key)) continue;
        seen.add(key);
        values.push({ foodId, alias, locale });
      }
    }
  }

  if (values.length === 0) return 0;

  await db
    .insert(schema.foodAliases)
    .values(values)
    .onConflictDoNothing({
      target: [schema.foodAliases.foodId, schema.foodAliases.alias],
    });

  return values.length;
}
