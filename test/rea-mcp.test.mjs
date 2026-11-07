import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReaInstallation, resolveBrowserExecutable } from '../src/rea/mcp-client.mjs';
import {
  inspectReaBrowserEvidence,
  detectSportsbookPlatform,
  buildProvenanceCaptureEnvelope,
} from '../src/rea/odds-inspector.mjs';
import { parseReaCliArgs } from '../scripts/rea-discover.mjs';

test('rea-mcp: resolveReaInstallation and resolveBrowserExecutable find local installation', () => {
  const install = resolveReaInstallation();
  assert.ok(install, 'resolveReaInstallation must return an object');
  assert.equal(install.ok, true, 'rea-agents must be installed');
  assert.ok(install.scriptPath.endsWith('rea.mjs'), 'scriptPath must point to rea.mjs');
  assert.ok(install.version, 'version must be present');

  const browser = resolveBrowserExecutable();
  assert.ok(browser, 'resolveBrowserExecutable must return Chrome path');
  assert.ok(browser.toLowerCase().includes('chrome.exe'), 'must find chrome.exe');
});

test('rea-mcp: detectSportsbookPlatform fingerprints all known platforms', () => {
  assert.equal(detectSportsbookPlatform('wss://eu-swarm-reverse.victorybet.ro/'), 'betconstruct-swarm');
  assert.equal(detectSportsbookPlatform('https://sport.luck.com/XSportDatastore/getPalinsestoDelGiorno'), 'exalogic-xsport');
  assert.equal(detectSportsbookPlatform('https://tbet-sofferapi.oddin-platform.com/sofferapi/api/offer/getOfferPag'), 'oddin-platform');
  assert.equal(detectSportsbookPlatform('wss://admiralbet.pl/online-api/v1/sportevents/web-notifications'), 'admiralbet-ws');
  assert.equal(detectSportsbookPlatform('https://sb2frontend-altenar2.biahosted.com/api/widget/GetUpcoming'), 'altenar-sb2');
  assert.equal(detectSportsbookPlatform('https://sportsbook-sm-distribution-api.nsoft.com/api/v1/events'), 'nsoft');
  assert.equal(detectSportsbookPlatform('https://egt-digital.com/api/sportsapi/public/v1/events'), 'egt-digital');
  assert.equal(detectSportsbookPlatform('https://micros-eagle-prod1-sb.gambling-solutions.ro/api/digitain-fetcher/v2'), 'digitain');
  assert.equal(detectSportsbookPlatform('https://efortuna.ro/feg-bff/v1/events'), 'fortuna-bff');
});

test('rea-mcp: inspectReaBrowserEvidence extracts transactions and platforms from REA events', () => {
  const reaEvidence = {
    evidence_id: 'ev_swarm_test',
    events: [
      {
        kind: 'websocket-opened',
        url: 'wss://eu-swarm-reverse.victorybet.ro/',
      },
      {
        kind: 'request',
        transaction_id: 'tx-1',
        method: 'GET',
        url: 'https://sport.luck.com/XSportDatastore/getPalinsestoDelGiorno?systemCode=LUCKY',
      },
      {
        kind: 'response',
        transaction_id: 'tx-1',
        status: 200,
      },
      {
        kind: 'network-content',
        transaction_id: 'tx-1',
        phase: 'response',
        body: {
          state: 'captured',
          content: Buffer.from('{"avs":[],"sps":[],"dts":[]}').toString('base64'),
        },
      },
    ],
  };

  const report = inspectReaBrowserEvidence(reaEvidence);
  assert.equal(report.evidenceId, 'ev_swarm_test');
  assert.equal(report.challengeDetected, false);
  assert.equal(report.httpTransactions, 1);
  assert.ok(report.detectedPlatforms.includes('betconstruct-swarm') || report.detectedPlatforms.includes('exalogic-xsport'));
  assert.equal(report.webSockets.length, 1);
  assert.equal(report.webSockets[0].platform, 'betconstruct-swarm');
});

test('rea-mcp: inspectReaBrowserEvidence detects challenge gates from REA events', () => {
  const cfChallengeEvidence = {
    evidence_id: 'ev_cf_test',
    events: [
      {
        kind: 'request',
        transaction_id: 'tx-cf',
        method: 'GET',
        url: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
      },
      {
        kind: 'response',
        transaction_id: 'tx-cf',
        status: 200,
      },
    ],
  };

  const report = inspectReaBrowserEvidence(cfChallengeEvidence);
  assert.equal(report.challengeDetected, true);
  assert.ok(report.challengeSignals.some((s) => s.includes('cloudflare')));
});

test('rea-mcp: buildProvenanceCaptureEnvelope generates verifiable provenance envelope', () => {
  const capture = buildProvenanceCaptureEnvelope({
    bookId: 'victorybet',
    evidenceId: 'ev_12345',
    endpoint: {
      method: 'WSS',
      url: 'wss://eu-swarm-reverse.victorybet.ro/',
      status: 101,
      responseSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      responseBytes: 1024,
      publicUnauthenticated: true,
      platform: 'betconstruct-swarm',
      marketFamilies: ['1X2', 'OVER_UNDER', 'BTTS', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'ASIAN_HANDICAP'],
      parsedJson: { test: 'payload' },
    },
  });

  assert.ok(capture.provenance, 'provenance block must exist');
  assert.equal(capture.provenance.book, 'victorybet');
  assert.equal(capture.provenance.reaEvidenceId, 'ev_12345');
  assert.ok(capture.provenance.capturedAt);
  assert.equal(capture.provenance.detectedPlatform, 'betconstruct-swarm');
  assert.equal(capture.provenance.responseSha256.length, 64);
  assert.deepEqual(capture.raw, { test: 'payload' });
});

test('rea-mcp: parseReaCliArgs handles CLI options', () => {
  const args = parseReaCliArgs(['discover', '--url', 'https://example.com/sport', '--book', 'testbook', '--wait-ms', '5000', '--json']);
  assert.equal(args.mode, 'discover');
  assert.equal(args.url, 'https://example.com/sport');
  assert.equal(args.book, 'testbook');
  assert.equal(args.waitMs, 5000);
  assert.equal(args.json, true);

  const doctorArgs = parseReaCliArgs(['doctor']);
  assert.equal(doctorArgs.mode, 'doctor');
});
