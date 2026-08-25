import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';

/**
 * Fetch and unpack the pinned USDA releases.
 *
 * The design deliberately made the ingest take a local directory, because FDC
 * filenames carry a release date and a hardcoded URL rots. That is still true —
 * so the URLs live in usda-sources.json with a checksum beside each, and this
 * downloader is a convenience over that manifest rather than a replacement for
 * pointing --dir at whatever you already have.
 */

interface Release {
  name: string;
  description: string;
  url: string;
  sha256: string;
  approxRows: number;
}

export interface FetchedRelease {
  name: string;
  /** Directory containing food.csv, nutrient.csv and friends. */
  dir: string;
  cached: boolean;
}

export async function fetchUsdaReleases(
  cacheDir: string,
  manifestPath: string,
): Promise<FetchedRelease[]> {
  const { releases } = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    releases: Release[];
  };

  mkdirSync(cacheDir, { recursive: true });
  const out: FetchedRelease[] = [];

  for (const release of releases) {
    const zipName = release.url.split('/').pop()!;
    const zipPath = join(cacheDir, zipName);
    const extractDir = join(cacheDir, release.name);

    let cached = false;

    if (existsSync(zipPath) && (await sha256Of(zipPath)) === release.sha256) {
      cached = true;
      console.log(`  ${release.name}: cached (${mb(zipPath)})`);
    } else {
      console.log(`  ${release.name}: downloading ${zipName}`);
      await download(release.url, zipPath);

      const actual = await sha256Of(zipPath);
      if (actual !== release.sha256) {
        // Hard failure, not a warning. FDC replaces the file behind a URL, and
        // silently ingesting a different release is how nutrition data drifts
        // with nobody noticing.
        throw new Error(
          `checksum mismatch for ${zipName}\n` +
            `  expected ${release.sha256}\n` +
            `  actual   ${actual}\n` +
            'The release behind this URL has changed. Verify it at ' +
            'https://fdc.nal.usda.gov/download-datasets.html and update ' +
            'usda-sources.json deliberately.',
        );
      }
      console.log(`  ${release.name}: verified (${mb(zipPath)})`);
    }

    if (!existsSync(extractDir)) {
      new AdmZip(zipPath).extractAllTo(extractDir, true);
    }

    out.push({ name: release.name, dir: findCsvDir(extractDir), cached });
  }

  return out;
}

/**
 * The archives nest their CSVs one directory deep, under a folder named after
 * the release. Walk to wherever food.csv actually is rather than assuming a
 * layout that differs between releases.
 */
function findCsvDir(root: string): string {
  if (existsSync(join(root, 'food.csv'))) return root;

  for (const entry of readdirSync(root)) {
    const child = join(root, entry);
    if (statSync(child).isDirectory()) {
      const found = findCsvDir(child);
      if (found) return found;
    }
  }

  throw new Error(`no food.csv found under ${root}`);
}

async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function mb(path: string): string {
  return `${(statSync(path).size / 1048576).toFixed(1)} MB`;
}
