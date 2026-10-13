// build-snapshot.mjs - produce the static deployable in dist/.
//
// The local app is a loopback server that computes the scan per request. A
// static host cannot do that, so dist/ is a snapshot: the real assets, a real
// capture of the real scan, and one shim that makes the page read the capture.
//
// This used to be done by hand, which is how dist/ came to disagree with the
// app it was built from: the arbitrage page had grown a "Window" tile in
// public/js/pages/arbitrage.js and dist/ was still serving the file from
// before it. A hand-copied directory has no way to say it is stale. So the
// rules live here instead:
//
//   1. dist mirrors public/ exactly - every file, copied fresh, stale copies
//      removed, so an asset that leaves public/ also leaves dist/.
//   2. dist/index.html is public/admin/arbitrage.html plus the snapshot script.
//      The terminal is the page worth landing on, and it is generated from the
//      app's own file rather than retyped, so the two cannot drift.
//   3. dist/api/scan.json holds the exact bytes the running server returned for
//      /api/scan. Both that name and the extensionless one are written, because
//      a static host rewrites any /api/* path it cannot resolve to index.html -
//      the page was fetching its own HTML back and rendering an empty terminal.
//
// dist/snapshot.js is left alone. It is not an asset: it is the only thing that
// knows the host is static, and it must never reach public/ and the real app.
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const DIST_DIR = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3022);
const BASE = process.env.ARBITER_BASE_URL || `http://127.0.0.1:${PORT}`;

/** Everything dist/ owns, mirrored from public/. snapshot.js and api/ are not in it. */
const MIRRORED = ['admin', 'css', 'js', 'event.html', 'favicon.svg'];

/** The page the deployed root shows: the terminal, straight from the app's own file. */
const ROOT_PAGE = join('admin', 'arbitrage.html');

const SHIM_SRC = '<script src="/snapshot.js"></script>';
const SHIM_TAG = [
  '  <!-- snapshot build: serves the captured scan from /api/scan.json. Not in public/. -->',
  `  ${SHIM_SRC}`,
].join('\n');

async function main() {
  await mkdir(DIST_DIR, { recursive: true });

  for (const entry of MIRRORED) {
    await rm(join(DIST_DIR, entry), { recursive: true, force: true });
  }
  for (const entry of MIRRORED) {
    const from = join(PUBLIC_DIR, entry);
    if (!(await exists(from))) continue;
    await cp(from, join(DIST_DIR, entry), { recursive: true });
  }

  const page = await readFile(join(PUBLIC_DIR, ROOT_PAGE), 'utf8');
  // Guard the injection rather than trusting it: a page that somehow already
  // carries the shim would get a second copy, and two copies of a fetch patch
  // is one too many wrappers around every request.
  const rooted = page.includes(SHIM_SRC)
    ? page
    : page.replace(/<\/body>/i, `${SHIM_TAG}\n</body>`);
  if (rooted === page && !page.includes(SHIM_SRC)) {
    throw new Error('build-snapshot: no </body> to anchor the shim in');
  }
  await writeFile(join(DIST_DIR, 'index.html'), rooted, 'utf8');

  await mkdir(join(DIST_DIR, 'api'), { recursive: true });
  const response = await fetch(`${BASE}/api/scan`);
  if (!response.ok) throw new Error(`build-snapshot: /api/scan returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  for (const name of ['scan.json', 'scan']) {
    await pipeline(Readable.from([bytes]), createWriteStream(join(DIST_DIR, 'api', name)));
  }

  const scan = JSON.parse(bytes.toString('utf8'));
  const summary = {
    root: `${ROOT_PAGE} + snapshot shim`,
    mirrored: MIRRORED,
    apiBytes: bytes.length,
    scrapedAt: scan.scrapedAt,
    eventCount: scan.eventCount,
    opportunities: scan.opportunities?.length ?? 0,
    middles: scan.middles?.length ?? 0,
    positiveEv: scan.positiveEv?.length ?? 0,
    lowHold: scan.lowHold?.length ?? 0,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await main();