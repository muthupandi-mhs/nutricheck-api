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
import { join } from 'node:path';
import { ingestUsda } from './ingest-usda';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const useFixture = process.argv.includes('--fixture');
  const dir = useFixture ? join(__dirname, '..', 'fixtures') : arg('dir');

  if (!dir) {
    throw new Error(
      'Pass --dir <unzipped FoodData Central csv directory>, or --fixture for the committed subset.',
    );
  }

  const pool = createPool({ url, poolMax: 4 });
  const db = createDatabase(pool);

  console.log(`[ingest] usda from ${dir}`);
  const started = Date.now();

  try {
    const report = await ingestUsda(db, dir);
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
