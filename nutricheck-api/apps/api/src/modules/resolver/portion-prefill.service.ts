import { Inject, Injectable } from '@nestjs/common';
import type { QuantityType } from '@nutricheck/contracts';
import { and, desc, eq, isNull, or, schema, type Database } from '@nutricheck/database';
import { DATABASE } from '../../infrastructure/database/database.tokens';

export interface KnownUnit {
  label: string;
  grams: number;
  /** Null when the unit applies to any food ("my bowl"). */
  foodId: string | null;
  nCorrections: number;
}

/**
 * Personal units, loaded BEFORE the model sees the phrase.
 *
 * With photo parked this is promoted from mitigation to mechanism: it is the
 * primary way a vague unit becomes a number. Prefilling means the parse prompt
 * already knows "their bowl = 210 g" and the resolver does not have to patch a
 * guess afterwards.
 */
@Injectable()
export class PortionPrefillService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async knownUnits(userId: string): Promise<KnownUnit[]> {
    const rows = await this.db
      .select()
      .from(schema.userPortions)
      .where(eq(schema.userPortions.userId, userId))
      .orderBy(desc(schema.userPortions.nCorrections));

    return rows.map((row) => ({
      label: row.unitLabel,
      grams: row.grams,
      foodId: row.foodId,
      nCorrections: row.nCorrections,
    }));
  }

  /**
   * Resolve a personal unit to grams.
   *
   * A food-specific measurement wins over a generic one: someone whose "bowl"
   * is 210 g of dal may well use a different bowl for cereal, and the more
   * specific record is the better evidence.
   *
   * Returns null when the unit has never been measured — the caller must then
   * ask rather than guess. That null is the whole point of this function.
   */
  async resolve(
    userId: string,
    label: string,
    foodId: string | null,
  ): Promise<{ grams: number; learned: true } | null> {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return null;

    const rows = await this.db
      .select()
      .from(schema.userPortions)
      .where(
        and(
          eq(schema.userPortions.userId, userId),
          eq(schema.userPortions.unitLabel, normalized),
          foodId
            ? or(
                eq(schema.userPortions.foodId, foodId),
                isNull(schema.userPortions.foodId),
              )
            : isNull(schema.userPortions.foodId),
        ),
      );

    if (rows.length === 0) return null;

    // Prefer the food-specific row when both exist.
    const specific = rows.find((r) => r.foodId === foodId);
    const chosen = specific ?? rows[0]!;
    return { grams: chosen.grams, learned: true };
  }
}

/**
 * A plausible range for an unlearned personal unit.
 *
 * Shown ONLY here — a range on "180 g chicken" is noise, a range on a bowl
 * nobody has measured is honesty. Deliberately wide: the point is to signal
 * uncertainty and invite a correction, not to pretend at precision.
 */
export function rangeForUnit(label: string): [number, number] | null {
  const ranges: Record<string, [number, number]> = {
    bowl: [150, 350],
    plate: [200, 450],
    handful: [20, 50],
    glass: [200, 350],
    cup: [180, 260],
    piece: [30, 120],
    slice: [20, 60],
    serving: [100, 300],
    portion: [100, 300],
    scoop: [25, 60],
    large: [1, 1],
    small: [1, 1],
  };
  return ranges[label.trim().toLowerCase()] ?? null;
}

export const PERSONAL_UNIT_TYPES: ReadonlySet<QuantityType> = new Set([
  'personal_unit',
]);
