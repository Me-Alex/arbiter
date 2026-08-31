/**
 * server-modular.mjs — alternative entrypoint that wires together the six
 * service modules (router, scrape-orchestrator, scan-service, scheduler,
 * tracker, state-broadcaster).
 *
 * Functionally identical to server.mjs. The split exists so each module is
 * independently testable and so the monolith stays under ~300 lines per file.
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';

import { buildRouter } from './router.mjs';
import { StateBroadcaster } from './state-broadcaster.mjs';
import { ScrapeOrchestrator } from './scrape-orchestrator.mjs';
import { SchedulerService } from './scheduler-service.mjs';
import { TrackerService } from './tracker-service.mjs';
import * as ScanService from './scan-service.mjs';
import { CronService } from './cron-service.mjs';
import { sanitizeLogLine } from './shared/sanitize.mjs';
import { buildCsp } from './shared/security.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = process.env.ARBITER_DATA_DIR || join(ROOT, 'data');
const PUBLIC_DIR = join(ROOT, 'public');
const CONFIG_PATH = join(ROOT, 'config', 'scrapers.json');
const PROFILES_PATH = join(ROOT, 'config', 'scan-profiles.json');
const PORT = Number(process.env.PORT || 3023);
const HOST = process.env.HOST || '127.0.0.1';

const logger = (level, msg) => {
  const ts = new Date().toISOString();
  const safe = sanitizeLogLine(msg);
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](`[${ts}] [${level}] ${safe}`);
};

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

const scheduler = new SchedulerService({
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  orchestrator,
  logger,
});
await scheduler.loadState();

const tracker = new TrackerService({ dataDir: DATA_DIR, logger });

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

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', buildCsp());
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  await router(req, res, url);
});

server.listen(PORT, HOST, () => {
  logger('info', `Arbitrage dashboard (modular): http://${HOST}:${PORT}/admin/scrape`);
});

if (process.env.ARBITER_NO_LISTEN === '1') server.close();

export { server, ctx };
