/** Parses a duration string like '15m' or '30d' (see config.schema.ts) into seconds. */
export function ttlToSeconds(ttl: string): number {
  const unit = ttl.slice(-1);
  const amount = Number(ttl.slice(0, -1));
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return amount * multiplier;
}
