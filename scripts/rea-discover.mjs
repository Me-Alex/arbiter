/**
 * rea-discover.mjs — Arbiter operator & agent CLI for `morluto/rea` (`rea-agents`)
 * MCP reverse-engineering of public sportsbook odds feeds.
 *
 * Modes:
 *   npm run rea:doctor
 *   npm run rea:discover -- --url https://sport.winmasters.ro --book winmasters [--wait-ms 9000] [--save data/endpoints/captures/...]
 *   npm run rea:har -- --file path/to/capture.har [--format har|saz]
 *   npm run rea:bundle -- --dir path/to/extracted-js
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReaMcpClient,
  resolveReaInstallation,
  resolveBrowserExecutable,
  buildReaScenarioUrl,
  parseMcpToolResult,
} from '../src/rea/mcp-client.mjs';
import {
  inspectReaBrowserEvidence,
  inspectReaJavaScriptEvidence,
  buildProvenanceCaptureEnvelope,
  decodeReaNetworkBody,
  detectSportsbookPlatform,
  scoreJsonOddsPayload,
} from '../src/rea/odds-inspector.mjs';

const USAGE = `Usage:
  npm run rea:doctor
  npm run rea:discover -- --url <https://...> [--book <id>] [--wait-ms <ms>] [--save <file.json>] [--json]
  npm run rea:har      -- --file <capture.har> [--format har|saz] [--json]
  npm run rea:bundle   -- --dir <js-dir> [--json]
`;

export function parseReaCliArgs(argv) {
  const out = {
    mode: 'doctor',
    url: null,
    book: null,
    file: null,
    dir: null,
    format: 'har',
    waitMs: 9_000,
    save: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'doctor' || arg === 'discover' || arg === 'har' || arg === 'bundle') {
      out.mode = arg;
      continue;
    }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '-h' || arg === '--help') { out.help = true; continue; }

    const val = argv[i + 1];
    if (val === undefined) throw new Error(`${arg} requires a value`);
    i += 1;
    switch (arg) {
      case '--mode': out.mode = val; break;
      case '--url': out.url = buildReaScenarioUrl(val).url; break;
      case '--book': out.book = val; break;
      case '--file': out.file = resolve(val); break;
      case '--dir': out.dir = resolve(val); break;
      case '--format': out.format = val; break;
      case '--wait-ms': out.waitMs = Number(val); break;
      case '--save': out.save = resolve(val); break;
      default: throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return out;
}

export async function runReaDoctor() {
  const install = resolveReaInstallation();
  const browserExecutable = resolveBrowserExecutable();
  if (!install.ok) {
    return {
      ok: false,
      install,
      browserExecutable,
      mcpConnected: false,
      toolCount: 0,
      webTools: [],
    };
  }

  const client = new ReaMcpClient({ scriptPath: install.scriptPath });
  try {
    const serverInfo = await client.connect();
    const tools = await client.listTools();
    const webTools = tools
      .map((t) => t.name)
      .filter((n) => /browser|web|javascript|capture|environment/i.test(n))
      .sort();
    return {
      ok: Boolean(browserExecutable && tools.length > 0),
      install,
      browserExecutable,
      mcpConnected: true,
      serverInfo,
      toolCount: tools.length,
      webTools,
    };
  } finally {
    await client.close();
  }
}

export async function runReaDiscover(opts) {
  if (!opts.url) throw new Error('--url is required for discover mode');
  const install = resolveReaInstallation();
  const client = new ReaMcpClient({ scriptPath: install.scriptPath || undefined });
  try {
    const res = await client.capturePublicSportsbook({
      url: opts.url,
      waitMs: opts.waitMs,
    });
    if (res.isError) {
      const partial = inspectReaBrowserEvidence(res.data);
      return {
        ok: false,
        error: res.data?.error?.message || res.data,
        url: opts.url,
        httpTransactions: partial.httpTransactions,
        failedRequests: partial.failedRequests,
        detectedPlatforms: partial.detectedPlatforms,
      };
    }
    const summary = inspectReaBrowserEvidence(res.data);
    const bestOddsEndpoint = summary.candidateEndpoints.find((ep) => ep.isOddsFeed && ep.publicUnauthenticated)
      || summary.candidateEndpoints[0]
      || null;

    if (opts.save && bestOddsEndpoint && bestOddsEndpoint.parsedJson !== undefined) {
      const envelope = buildProvenanceCaptureEnvelope({
        bookId: opts.book || 'unknown',
        endpoint: bestOddsEndpoint,
        evidenceId: summary.evidenceId,
        reaVersion: install.version ? `rea-agents@${install.version}` : 'rea-agents',
      });
      await writeFile(opts.save, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    }

    // Strip bulky parsedJson before returning CLI summary
    const compactCandidates = summary.candidateEndpoints.slice(0, 25).map(({ parsedJson: _raw, ...rest }) => rest);
    return {
      ok: true,
      reaVersion: install.version,
      evidenceId: summary.evidenceId,
      finalUrl: summary.finalUrl,
      challengeDetected: summary.challengeDetected,
      challengeSignals: summary.challengeSignals,
      detectedPlatforms: summary.detectedPlatforms,
      httpTransactions: summary.httpTransactions,
      failedRequests: summary.failedRequests,
      webSockets: summary.webSockets,
      candidateEndpoints: compactCandidates,
      savedCapturePath: opts.save && bestOddsEndpoint?.parsedJson !== undefined ? opts.save : null,
    };
  } finally {
    await client.close();
  }
}

export async function runReaHarInspect(opts) {
  if (!opts.file) throw new Error('--file is required for har mode');
  const client = new ReaMcpClient();
  try {
    const raw = await client.inspectNetworkCapture(opts.file, opts.format || 'har', { detail: 'summary' });
    const parsed = parseMcpToolResult({ structuredContent: raw.data, isError: raw.isError });
    const records = parsed.data?.normalized_result?.records || parsed.data?.records || [];
    const analyzed = records.map((rec) => {
      const url = rec.url || rec.request?.url || '';
      const decoded = rec.response_body ? decodeReaNetworkBody(rec.response_body) : null;
      const bodyScore = decoded?.json ? scoreJsonOddsPayload(decoded.json) : null;
      return {
        ordinal: rec.ordinal ?? null,
        method: rec.method || rec.request?.method || 'GET',
        url,
        status: rec.status ?? rec.response?.status ?? null,
        platform: detectSportsbookPlatform(url),
        ...(bodyScore ? { isOddsFeed: bodyScore.isOddsFeed, marketFamilies: bodyScore.marketFamilies } : {}),
      };
    });
    return {
      ok: !raw.isError,
      evidenceId: parsed.data?.evidence_id || null,
      recordCount: records.length,
      records: analyzed.slice(0, 40),
    };
  } finally {
    await client.close();
  }
}

export async function runReaBundleInspect(opts) {
  if (!opts.dir) throw new Error('--dir is required for bundle mode');
  const client = new ReaMcpClient();
  try {
    const res = await client.analyzeJavascriptDirectory(opts.dir, { detail: 'summary' });
    if (res.isError) return { ok: false, error: res.data };
    return {
      ok: true,
      ...inspectReaJavaScriptEvidence(res.data),
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const opts = parseReaCliArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  let report;
  if (opts.mode === 'doctor') report = await runReaDoctor();
  else if (opts.mode === 'discover') report = await runReaDiscover(opts);
  else if (opts.mode === 'har') report = await runReaHarInspect(opts);
  else if (opts.mode === 'bundle') report = await runReaBundleInspect(opts);
  else throw new Error(`Unsupported mode: ${opts.mode}`);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (opts.mode === 'doctor') {
    console.log(`REA MCP Doctor — ${report.ok ? 'READY' : 'INCOMPLETE'}`);
    console.log(`  rea-agents version : ${report.install.version || 'not found'} (${report.install.scriptPath || 'missing'})`);
    console.log(`  Node.js runtime    : v${report.install.nodeVersion}`);
    console.log(`  Browser executable : ${report.browserExecutable || 'missing'}`);
    console.log(`  MCP stdio tools    : ${report.toolCount} total (${report.webTools.length} web/JS/capture tools)`);
    return;
  }

  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[rea-discover] ${err.message}`);
    process.exitCode = 1;
  });
}
