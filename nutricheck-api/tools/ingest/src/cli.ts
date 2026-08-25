/**
 * Corpus ingestion CLI.
 *
 *   npm run ingest -w @nutricheck/ingest -- --fixture
 *   npm run ingest -w @nutricheck/ingest -- --dir /path/to/FoodData_Central_csv
 *
 * The USDA release is a several-hundred-megabyte download whose filename
 * carries a release date, so this takes a local directory rather than a URL
 * that would rot. Get one from
 * https://fdc.nal.usda.gov/download-datasets.html and unzip it.
 */
import { createDatabase, createPool } from '@nutricheck/database';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchUsdaReleases } from './fetch-usda';
import { ingestCurated } from './ingest-curated';
import { ingestUsda } from './ingest-usda';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const curated = process.argv.includes('--curated');
  const download = process.argv.includes('--download');
  const useFixture = process.argv.includes('--fixture');
  const dir = useFixture ? join(__dirname, '..', 'fixtures') : arg('dir');

  if (!curated && !download && !dir) {
    throw new Error(
      'Pass --download to fetch the pinned USDA releases, --dir <unzipped ' +
        'FoodData Central csv directory> for one you already have, --fixture ' +
        'for the committed test subset, or --curated for the dish tables.',
    );
  }

  const pool = createPool({ url, poolMax: 4 });
  const db = createDatabase(pool);

  const started = Date.now();

  try {
    if (download) {
      // Pinned by URL AND checksum in usda-sources.json. A mismatch is fatal:
      // FDC replaces the file behind a URL, and quietly ingesting a different
      // release is how nutrition data drifts with nobody noticing.
      console.log('[ingest] fetching pinned USDA releases');
      const releases = await fetchUsdaReleases(
        join(__dirname, '..', '..', '..', '.usda'),
        join(__dirname, '..', 'usda-sources.json'),
      );

      for (const release of releases) {
        console.log(`[ingest] usda:${release.name}`);
        const r = await ingestUsda(db, release.dir);
        console.log(
          `  ${r.ingested} ingested, ${r.portions} portions, ` +
            `${r.fiberKnown} fiber known / ${r.fiberUnknown} unknown`,
        );
      }
      return;
    }

    if (curated) {
      // Every .json in curated/ is loaded. Adding a region is dropping in a
      // file, not editing this list — a hardcoded array is how a new file gets
      // written and then silently never ingested.
      const dir = join(__dirname, '..', 'curated');
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();

      if (files.length === 0) throw new Error(`no curated files in ${dir}`);

      const total = { foods: 0, aliases: 0, portions: 0 };
      for (const file of files) {
        const r = await ingestCurated(db, join(dir, file));
        total.foods += r.foods;
        total.aliases += r.aliases;
        total.portions += r.portions;
        console.log(
          `  ${file.padEnd(24)} ${String(r.foods).padStart(3)} foods  ${String(r.aliases).padStart(4)} aliases  ${String(r.portions).padStart(3)} portions`,
        );
      }
      console.log(
        `[ingest] curated total — ${total.foods} foods, ${total.aliases} aliases, ${total.portions} portions`,
      );
      return;
    }

    console.log(`[ingest] usda from ${dir}`);
    const report = await ingestUsda(db, dir!);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`[ingest] done in ${seconds}s`);
    console.log(`  read              ${report.read}`);
    console.log(`  ingested          ${report.ingested}`);
    console.log(`  portions          ${report.portions}`);
    console.log(`  fiber known       ${report.fiberKnown}`);
    console.log(`  fiber unknown     ${report.fiberUnknown}`);
    console.log(`  skipped: no macros ${report.skippedNoMacros}`);

    // Never let a silent skip look like a clean run. If a whole data_type was
    // dropped, that is a corpus-coverage decision someone should see.
    for (const [type, count] of Object.entries(report.skippedUnknownType)) {
      console.log(`  skipped: data_type=${type} ${count}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[ingest] failed:', error);
  process.exitCode = 1;
});
