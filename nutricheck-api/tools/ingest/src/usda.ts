import { parse } from 'csv-parse';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

/**
 * USDA FoodData Central bulk CSV reader.
 *
 * Deliberately reads a LOCAL directory rather than fetching a URL: the FDC
 * download filenames carry a release date and change every few months, so a
 * hardcoded URL is a 404 waiting to happen. The operator downloads the release
 * they want from https://fdc.nal.usda.gov/download-datasets.html and points
 * this at the unzipped directory.
 */

/** FDC `nutrient_nbr` values. Stable across releases; the surrogate `id` is not. */
export const NUTRIENT_NBR = {
  protein: '203',
  energyKcal: '208',
  fiber: '291',
} as const;

export interface UsdaFoodRow {
  fdc_id: string;
  data_type: string;
  description: string;
}

export interface UsdaNutrientRow {
  id: string;
  unit_name: string;
  nutrient_nbr: string;
}

export interface UsdaFoodNutrientRow {
  fdc_id: string;
  nutrient_id: string;
  amount: string;
}

export interface UsdaPortionRow {
  fdc_id: string;
  amount: string;
  measure_unit_id: string;
  portion_description: string;
  modifier: string;
  gram_weight: string;
}

async function* readCsv<T>(dir: string, file: string): AsyncGenerator<T> {
  const stream = createReadStream(join(dir, file)).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      // FDC ships rows with trailing empty columns; without this a single
      // malformed line aborts an otherwise good multi-hundred-megabyte import.
      relax_column_count: true,
      trim: true,
    }),
  );
  for await (const record of stream) yield record as T;
}

/**
 * Resolve the three nutrient surrogate ids we care about by their stable
 * `nutrient_nbr`, and reject anything not reported in the unit we expect.
 *
 * Hardcoding 1003/1008/1079 works today and is exactly the kind of thing that
 * silently ingests garbage after a schema revision.
 */
export async function resolveNutrientIds(dir: string): Promise<{
  protein: string;
  energyKcal: string;
  fiber: string;
}> {
  const wanted = new Map<string, { nbr: string; unit: string }>([
    ['protein', { nbr: NUTRIENT_NBR.protein, unit: 'G' }],
    ['energyKcal', { nbr: NUTRIENT_NBR.energyKcal, unit: 'KCAL' }],
    ['fiber', { nbr: NUTRIENT_NBR.fiber, unit: 'G' }],
  ]);

  const found = new Map<string, string>();

  for await (const row of readCsv<UsdaNutrientRow>(dir, 'nutrient.csv')) {
    for (const [key, spec] of wanted) {
      if (found.has(key)) continue;
      if (row.nutrient_nbr === spec.nbr && row.unit_name.toUpperCase() === spec.unit) {
        found.set(key, row.id);
      }
    }
  }

  const missing = [...wanted.keys()].filter((k) => !found.has(k));
  if (missing.length > 0) {
    throw new Error(
      `nutrient.csv is missing expected nutrients: ${missing.join(', ')}. ` +
        'Check that this is a FoodData Central release and not a partial export.',
    );
  }

  return {
    protein: found.get('protein')!,
    energyKcal: found.get('energyKcal')!,
    fiber: found.get('fiber')!,
  };
}

export { readCsv };
