/**
 * server.mjs — the single entrypoint (`npm start`, and Electron's child
 * process).
 *
 * This file only wires the services together and hands every HTTP request to
 * the router in router.mjs. It used to carry a second, hand-maintained copy of
 * the whole route table, which drifted from the router's: the monolith was
 * missing the CSV export and the sport list, while the router had no verify
 * endpoint at all. Two copies of a route table means every fix lands twice and
 * one of them is always stale, so there is now one.
 *
 * Responsibilities kept here: process-wide paths, service construction, the
 * HTTP server, and graceful shutdown. Everything a request touches lives in
 * router.mjs and the service modules it delegates to.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCsp } from './shared/security.mjs';
import { sanitizeLogLine } from './shared/sanitize.mjs';
import { installShutdown } from './shared/graceful-shutdown.mjs';

import { buildRouter } from './router.mjs';
import { StateBroadcaster } from './state-broadcaster.mjs';
import { ScrapeOrchestrator } from './scrape-orchestrator.mjs';
import { TrackerService } from './tracker-service.mjs';
import { SchedulerService } from './scheduler-service.mjs';
import { CronService } from './cron-service.mjs';
import * as ScanService from './scan-service.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = process.env.ARBITER_DATA_DIR || join(ROOT, 'data');
const PUBLIC_DIR = join(ROOT, 'public');
const CONFIG_PATH = join(ROOT, 'config', 'scrapers.json');
const PROFILES_PATH = join(ROOT, 'config', 'scan-profiles.json');
const PORT = Number(process.env.PORT || 3022);
const HOST = process.env.HOST || '127.0.0.1';

const logger = (level, msg) => {
  const ts = new Date().toISOString();
  const safe = sanitizeLogLine(msg);
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${ts}] [${level}] ${safe}`);
};

// ---- bootstrap -------------------------------------------------------------

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(join(DATA_DIR, 'workspace'), { recursive: true });
await fs.mkdir(join(DATA_DIR, 'staging'), { recursive: true });
await fs.mkdir(join(DATA_DIR, 'backups'), { recursive: true });

const broadcaster = new StateBroadcaster();
broadcaster.start();

const orchestrator = new ScrapeOrchestrator({
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  broadcaster,
  logger,
});
await orchestrator.restoreState();

const tracker = new TrackerService({ dataDir: DATA_DIR, logger });
const scheduler = new SchedulerService({
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  orchestrator,
  logger,
});
await scheduler.loadState();

const cronService = new CronService({ logger });
cronService.start();

const ctx = {
  dataDir: DATA_DIR,
  publicDir: PUBLIC_DIR,
  configPath: CONFIG_PATH,
  profilesPath: PROFILES_PATH,
  orchestrator,
  scheduler,
  tracker,
  broadcaster,
  scanService: ScanService,
  cronService,
  logger,
};

const router = buildRouter(ctx);

// ---- HTTP server -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // Applied here rather than per-handler so static files and CSV downloads get
  // it too; sendJson in router.mjs sets its own for API responses.
  res.setHeader('Content-Security-Policy', buildCsp());
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  await router(req, res, url);
});

server.listen(PORT, HOST, () => {
  logger('info', `Arbitrage dashboard: http://${HOST}:${PORT}/admin/scrape`);
  logger('info', `Health probe:       http://${HOST}:${PORT}/api/health`);
});

server.on('error', (err) => {
  console.error('server error', err);
  process.exit(1);
});

// graceful shutdown — drains in-flight requests and stops background services
installShutdown({
  server,
  logger,
  tasks: [
    async () => { await scheduler.disable(); },
    () => broadcaster.stop(),
    () => cronService.stop(),
  ],
});

export { server, ctx, router };

// allow `node --test` import to skip listen():
if (process.env.ARBITER_NO_LISTEN === '1') {
  server.close();
}
