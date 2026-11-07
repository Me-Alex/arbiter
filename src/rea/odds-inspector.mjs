/**
 * odds-inspector.mjs — Pure Evidence analyzer for REA (`morluto/rea`) browser
 * scenarios, HAR network captures, and static JavaScript application graphs.
 *
 * Turns raw REA Evidence into actionable Arbiter scraper intelligence:
 *   1. Reassembles HTTP transactions (request + response + decoded UTF-8 JSON body)
 *      and WebSocket streams from REA `capture_browser_scenario` Evidence.
 *   2. Fingerprints known sportsbook platforms (`altenar-sb2`, `digitain`, `nsoft`,
 *      `egt-digital`, `everymatrix-odds`, `exalogic-xsport`, `fortuna-bff`, `kambi`,
 *      `pinnacle-arcadia`, `bvsportsbook`, `custom`).
 *   3. Scores candidate odds endpoints by decimal price density, fixture structure,
 *      and market-family depth (`1X2`, `OVER_UNDER`, `BTTS`, `DOUBLE_CHANCE`,
 *      `DRAW_NO_BET`, `ASIAN_HANDICAP`, `HALF_PERIOD`, `CORNERS_CARDS`).
 *   4. Audits Arbiter's zero-credential & anti-bot rules (flags session auth or
 *      challenge gates so gated endpoints are never misreported as public feeds).
 */

const CHALLENGE_URL_RE = /(?:challenges\.cloudflare\.com|cdn-cgi\/challenge-platform|turnstile|datadome|imperva|_incapsula_resource|arkoselabs|recaptcha|hcaptcha)/i;
const TELEMETRY_HOST_RE = /(?:google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|connect\.facebook|hotjar\.com|clarity\.ms|sentry\.io|segment\.com|cookiebot\.eu|onetrust\.com|appsflyer\.com|adjust\.com|newrelic\.com|datadoghq)/i;
const STATIC_ASSET_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css|mp4|webm|mp3|wav)(?:$|\?)/i;

const AUTH_HEADER_NAMES = new Set([
  'authorization',
  'x-auth-token',
  'x-session-token',
  'x-access-token',
  'proxy-authorization',
]);

/**
 * Decode a REA `browserNetworkBodySchema` object into UTF-8 text + parsed JSON (when valid).
 *
 * @param {object | null | undefined} bodyArtifact
 * @returns {{ state: string, bytes: number, sha256: string | null, mediaType: string | null, text: string | null, json: any }}
 */
export function decodeReaNetworkBody(bodyArtifact) {
  if (!bodyArtifact || typeof bodyArtifact !== 'object') {
    return { state: 'missing', bytes: 0, sha256: null, mediaType: null, text: null, json: null };
  }
  if (bodyArtifact.state !== 'captured' || typeof bodyArtifact.content !== 'string') {
    return {
      state: bodyArtifact.state || 'unavailable',
      bytes: Number(bodyArtifact.bytes || bodyArtifact.observed_bytes || 0),
      sha256: null,
      mediaType: null,
      text: null,
      json: null,
    };
  }
  const buf = Buffer.from(bodyArtifact.content, 'base64');
  const text = buf.toString('utf8');
  let json = null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      json = JSON.parse(trimmed);
    } catch {}
  }
  return {
    state: 'captured',
    bytes: buf.length,
    sha256: bodyArtifact.sha256 || null,
    mediaType: bodyArtifact.media_type || null,
    text,
    json,
  };
}

/**
 * Detect known sportsbook platform signatures from URL, headers, and WebSocket traffic.
 *
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {string}
 */
export function detectSportsbookPlatform(url, headers = {}) {
  const lowerUrl = String(url || '').toLowerCase();
  if (/biahosted\.com\/api\/widget\/|altenar/i.test(lowerUrl)) return 'altenar-sb2';
  if (/sportsbook-sm-distribution-api\.nsoft\.com/i.test(lowerUrl)) return 'nsoft';
  if (/egt-digital\.com\/api\/sportsapi\/public/i.test(lowerUrl) || headers['x-platform-device']) return 'egt-digital';
  if (/digitain|getsystemcardsbysportid|gambling-solutions\.ro\/api\/digitain/i.test(lowerUrl)) return 'digitain';
  if (/everymatrix|realtimedealer|oddsmatrix|\/v2$/i.test(lowerUrl) && /^wss?:/i.test(lowerUrl)) return 'everymatrix-odds';
  if (/xsport|exalogic/i.test(lowerUrl)) return 'exalogic-xsport';
  if (/arcadia\.pinnacle\.com/i.test(lowerUrl)) return 'pinnacle-arcadia';
  if (/kambi\.com|offering-api\.kambicdn/i.test(lowerUrl)) return 'kambi';
  if (/betvictor|bvsportsbook/i.test(lowerUrl)) return 'bvsportsbook';
  if (/efortuna|fortuna.*\/api\/offer/i.test(lowerUrl)) return 'fortuna-bff';
  if (/swarm-reverse|eu-swarm|\.bcua\.io\//i.test(lowerUrl)) return 'betconstruct-swarm';
  if (/oddin-platform\.com|sofferapi\/api\/offer/i.test(lowerUrl)) return 'oddin-platform';
  if (/sportevents\/web-notifications|\/online-api\/v1\/offer\/unified/i.test(lowerUrl)) return 'admiralbet-ws';
  return 'custom';
}

/**
 * Walk a parsed JSON value up to a bounded node count to measure sportsbook
 * odds density, fixture fields, and market families.
 *
 * @param {any} root
 * @param {{ maxNodes?: number }} [opts]
 */
export function scoreJsonOddsPayload(root, opts = {}) {
  const maxNodes = Number(opts.maxNodes ?? 15_000);
  if (!root || typeof root !== 'object') {
    return {
      isOddsFeed: false,
      score: 0,
      decimalPriceCount: 0,
      fixtureHintCount: 0,
      kickoffHintCount: 0,
      marketFamilies: [],
      sampleStrings: [],
    };
  }

  let visited = 0;
  let decimalPriceCount = 0;
  let fixtureHintCount = 0;
  let kickoffHintCount = 0;
  const families = new Set();
  const sampleStrings = [];

  const PRICE_KEY_RE = /^(?:odds?|price|f|val|value|k|coef|coefficient|rate|decimal|factor|back|lay|american)$/i;
  const FIXTURE_KEY_RE = /^(?:home|away|hometeam|awayteam|ht|at|eht|eat|participants?|competitors?|teams?|team1name|team2name|opponent)/i;
  const KICKOFF_KEY_RE = /^(?:kickoff|startdate|starttime|matchdatetime|commencetime|eventdate|scheduled|cutofftime)$/i;

  const stack = [root];
  while (stack.length > 0 && visited < maxNodes) {
    const node = stack.pop();
    visited += 1;
    if (!node || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        const item = node[i];
        if (item && typeof item === 'object') stack.push(item);
      }
      continue;
    }

    for (const [k, v] of Object.entries(node)) {
      if (FIXTURE_KEY_RE.test(k)) fixtureHintCount += 1;
      if (KICKOFF_KEY_RE.test(k)) kickoffHintCount += 1;

      if (typeof v === 'number') {
        if (PRICE_KEY_RE.test(k) && v > 1.001 && v <= 500) {
          decimalPriceCount += 1;
        } else if (PRICE_KEY_RE.test(k) && Math.abs(v) >= 100 && Math.abs(v) <= 25000 && Number.isInteger(v)) {
          // American odds representation (e.g. Pinnacle Arcadia `-110`, `+145`)
          decimalPriceCount += 1;
        }
      } else if (typeof v === 'string') {
        if (PRICE_KEY_RE.test(k)) {
          const num = Number(v);
          if (Number.isFinite(num) && num > 1.001 && num <= 500) decimalPriceCount += 1;
        }
        if (v.length >= 2 && v.length <= 90) {
          classifyMarketText(v, families);
          if (sampleStrings.length < 12 && /(?:1x2|over|under|peste|sub|handicap|moneyline|ambele|both teams|double chance|sansa dubla|draw no bet)/i.test(v)) {
            if (!sampleStrings.includes(v)) sampleStrings.push(v);
          }
        }
      } else if (v && typeof v === 'object') {
        stack.push(v);
      }
    }
  }

  let score = 0;
  if (decimalPriceCount >= 3) score += Math.min(50, decimalPriceCount * 2);
  if (fixtureHintCount >= 2) score += Math.min(30, fixtureHintCount * 3);
  if (kickoffHintCount >= 1) score += Math.min(10, kickoffHintCount * 2);
  score += families.size * 8;

  const isOddsFeed = decimalPriceCount >= 3 && (fixtureHintCount >= 1 || families.size >= 1);
  return {
    isOddsFeed,
    score,
    decimalPriceCount,
    fixtureHintCount,
    kickoffHintCount,
    marketFamilies: [...families].sort(),
    sampleStrings,
  };
}

function classifyMarketText(text, families) {
  const s = text.trim();
  if (/^(?:1x2|match\s*(?:result|odds|winner)|rezultat\s*final|castigator\s*meci|moneyline|s_0_0)$/i.test(s)) {
    families.add('MATCH_ODDS');
  }
  if (/\b(?:over\s*\/?\s*under|peste\s*\/?\s*sub|total\s*(?:goluri|goals|points|puncte|games|game-uri)|powy[żz]ej|poni[żz]ej)\b/i.test(s)) {
    families.add('OVER_UNDER');
  }
  if (/\b(?:both\s*teams?\s*to\s*score|ambele\s*echipe\s*(?:marcheaz[aă]|înscriu)|gg\s*\/?\s*ng|btts|obie\s*dru[żz]yny)\b/i.test(s)) {
    families.add('BTTS');
  }
  if (/\b(?:double\s*chance|[sș]ans[aă]\s*dubl[aă]|dubl[aă]\s*[sș]ans[aă]|podw[óo]jna\s*szansa)\b/i.test(s)) {
    families.add('DOUBLE_CHANCE');
  }
  if (/\b(?:draw\s*no\s*bet|f[aă]r[aă]\s*egal|niciun\s*pariu\s*pe\s*egal|dnb|zak[łl]ad\s*bez\s*remisu)\b/i.test(s)) {
    families.add('DRAW_NO_BET');
  }
  if (/\b(?:asian\s*handicap|handicap|spread)\b/i.test(s)) {
    families.add('ASIAN_HANDICAP');
  }
  if (/\b(?:1st\s*half|2nd\s*half|first\s*half|prima\s*repriz[aă]|repriz[aă]\s*[12]|1\.?\s*po[łl]owa|set\s*[1-5]|quarter\s*[1-4])\b/i.test(s)) {
    families.add('PERIOD_MARKETS');
  }
  if (/\b(?:corners?|cornere|cards?|cartona[sș]e)\b/i.test(s)) {
    families.add('CORNERS_CARDS');
  }
}

function unwrapReaUrl(rawUrl) {
  if (!rawUrl) return '';
  if (typeof rawUrl === 'string') return rawUrl;
  if (typeof rawUrl === 'object' && typeof rawUrl.url === 'string') return rawUrl.url;
  return '';
}

function headersMapFromRea(headersArtifact) {
  const out = {};
  if (!headersArtifact || headersArtifact.state !== 'captured') return out;
  const list = Array.isArray(headersArtifact.items)
    ? headersArtifact.items
    : Array.isArray(headersArtifact.headers)
      ? headersArtifact.headers
      : Array.isArray(headersArtifact.entries)
        ? headersArtifact.entries
        : [];
  for (const item of list) {
    if (item && typeof item.name === 'string' && typeof item.value === 'string') {
      out[item.name.toLowerCase()] = item.value;
    }
  }
  return out;
}

/**
 * Inspect REA `capture_browser_scenario` Evidence and return ranked sportsbook
 * odds endpoints, WebSocket feeds, challenge diagnostics, and platform detection.
 *
 * @param {object} reaEvidence
 * @returns {{
 *   evidenceId: string | null,
 *   finalUrl: string | null,
 *   challengeDetected: boolean,
 *   challengeSignals: string[],
 *   detectedPlatforms: string[],
 *   httpTransactions: number,
 *   failedRequests: Array<{ url: string, resourceType: string, failure: string }>,
 *   candidateEndpoints: Array<object>,
 *   webSockets: Array<object>,
 * }}
 */
export function inspectReaBrowserEvidence(reaEvidence) {
  const root = reaEvidence?.normalized_result
    || reaEvidence?.error?.details?.partial_observation
    || reaEvidence?.details?.partial_observation
    || reaEvidence?.result
    || reaEvidence
    || {};
  const evidenceId = reaEvidence?.evidence_id || root?.evidence_id || null;
  const events = Array.isArray(root?.events?.items)
    ? root.events.items
    : Array.isArray(root?.capture?.events?.items)
      ? root.capture.events.items
      : Array.isArray(root?.events)
        ? root.events
        : [];

  const steps = Array.isArray(root?.steps) ? root.steps : [];
  const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
  const finalUrl = unwrapReaUrl(lastStep?.artifacts?.url?.value)
    || unwrapReaUrl(lastStep?.after_url)
    || unwrapReaUrl(root?.final?.url?.value)
    || unwrapReaUrl(root?.url)
    || null;

  const txMap = new Map();
  const wsMap = new Map();
  const failedRequests = [];
  const challengeSignals = new Set();

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const evUrl = unwrapReaUrl(ev.url);

    if (evUrl && CHALLENGE_URL_RE.test(evUrl)) {
      challengeSignals.add(`challenge-url:${evUrl.slice(0, 120)}`);
    }

    if (ev.kind === 'request' && ev.transaction_id) {
      txMap.set(ev.transaction_id, {
        transactionId: ev.transaction_id,
        method: ev.method || 'GET',
        url: evUrl,
        resourceType: ev.resource_type || 'other',
        requestHeaderNames: Array.isArray(ev.header_names) ? ev.header_names.map((h) => h.toLowerCase()) : [],
        requestHeaders: {},
        responseHeaders: {},
        status: null,
        requestBody: null,
        responseBody: null,
      });
    } else if (ev.kind === 'request-failed') {
      if (evUrl && failedRequests.length < 25) {
        failedRequests.push({
          url: evUrl,
          resourceType: ev.resource_type || 'other',
          failure: ev.failure || 'unknown',
        });
      }
    } else if (ev.kind === 'response' && ev.transaction_id) {
      const tx = txMap.get(ev.transaction_id) || {
        transactionId: ev.transaction_id,
        method: ev.method || 'GET',
        url: evUrl,
        resourceType: ev.resource_type || 'other',
        requestHeaderNames: [],
        requestHeaders: {},
        responseHeaders: {},
        status: null,
        requestBody: null,
        responseBody: null,
      };
      if (!tx.url && evUrl) tx.url = evUrl;
      tx.status = ev.status ?? null;
      if (ev.status === 403 || ev.status === 429 || ev.status === 503) {
        if (Array.isArray(ev.header_names) && ev.header_names.some((h) => /^cf-mitigated$/i.test(h))) {
          challengeSignals.add(`cf-mitigated:${tx.status}:${tx.url.slice(0, 100)}`);
        }
      }
      txMap.set(ev.transaction_id, tx);
    } else if (ev.kind === 'network-content' && ev.transaction_id) {
      const tx = txMap.get(ev.transaction_id);
      if (!tx) continue;
      if (ev.phase === 'request') {
        tx.requestHeaders = headersMapFromRea(ev.headers);
        tx.requestBody = decodeReaNetworkBody(ev.body);
      } else if (ev.phase === 'response') {
        tx.responseHeaders = headersMapFromRea(ev.headers);
        tx.responseBody = decodeReaNetworkBody(ev.body);
      }
    } else if (ev.kind === 'websocket-opened' && evUrl) {
      if (!wsMap.has(evUrl)) {
        wsMap.set(evUrl, {
          url: evUrl,
          platform: detectSportsbookPlatform(evUrl),
          framesSent: 0,
          framesReceived: 0,
          bytesReceived: 0,
          sampleFrames: [],
        });
      }
    } else if ((ev.kind === 'websocket-frame-sent' || ev.kind === 'websocket-frame-received') && evUrl) {
      if (!wsMap.has(evUrl)) {
        wsMap.set(evUrl, {
          url: evUrl,
          platform: detectSportsbookPlatform(evUrl),
          framesSent: 0,
          framesReceived: 0,
          bytesReceived: 0,
          sampleFrames: [],
        });
      }
      const ws = wsMap.get(evUrl);
      if (ev.kind === 'websocket-frame-sent') ws.framesSent += 1;
      else {
        ws.framesReceived += 1;
        ws.bytesReceived += Number(ev.payload_bytes || 0);
      }
      const frameText = typeof ev.payload_text === 'string'
        ? ev.payload_text
        : typeof ev.payload_utf8 === 'string'
          ? ev.payload_utf8
          : typeof ev.text === 'string'
            ? ev.text
            : null;
      if (frameText && ws.sampleFrames.length < 8) {
        ws.sampleFrames.push({
          direction: ev.kind === 'websocket-frame-sent' ? 'sent' : 'received',
          preview: frameText.slice(0, 350),
        });
      }
    }
  }

  const candidateEndpoints = [];
  const platforms = new Set();

  for (const tx of txMap.values()) {
    if (!tx.url || STATIC_ASSET_RE.test(tx.url)) continue;
    let host = '';
    try {
      host = new URL(tx.url).hostname;
    } catch {}
    if (host && TELEMETRY_HOST_RE.test(host)) continue;

    const platform = detectSportsbookPlatform(tx.url, tx.requestHeaders);
    if (platform !== 'custom') platforms.add(platform);

    const hasSessionAuth = tx.requestHeaderNames.some((h) => AUTH_HEADER_NAMES.has(h))
      || Object.keys(tx.requestHeaders).some((h) => AUTH_HEADER_NAMES.has(h));

    const tenantHeaders = {};
    for (const [hk, hv] of Object.entries(tx.requestHeaders)) {
      if (/^(?:x-api-key|x-platform-device|x-platform-lang|x-platform-tz|x-device-uuid|x-brand|x-operator|accept-language)$/i.test(hk)) {
        tenantHeaders[hk] = hv;
      }
    }

    const bodyScore = tx.responseBody?.json
      ? scoreJsonOddsPayload(tx.responseBody.json)
      : {
        isOddsFeed: false,
        score: 0,
        decimalPriceCount: 0,
        fixtureHintCount: 0,
        kickoffHintCount: 0,
        marketFamilies: [],
        sampleStrings: [],
      };

    const urlLooksLikeSportsApi = /(?:sport|odds|match|event|fixture|market|offer|league|tournament|arcadia|sb2frontend|digitain|nsoft)/i.test(tx.url);
    if (!bodyScore.isOddsFeed && !urlLooksLikeSportsApi) continue;

    candidateEndpoints.push({
      method: tx.method,
      url: tx.url,
      status: tx.status,
      platform,
      publicUnauthenticated: !hasSessionAuth,
      tenantHeaders,
      responseBytes: tx.responseBody?.bytes || 0,
      responseSha256: tx.responseBody?.sha256 || null,
      bodyState: tx.responseBody?.state || 'none',
      isOddsFeed: bodyScore.isOddsFeed,
      score: bodyScore.score + (platform !== 'custom' ? 20 : 0) + (!hasSessionAuth ? 5 : -25),
      decimalPriceCount: bodyScore.decimalPriceCount,
      fixtureHintCount: bodyScore.fixtureHintCount,
      marketFamilies: bodyScore.marketFamilies,
      sampleStrings: bodyScore.sampleStrings,
      parsedJson: bodyScore.isOddsFeed ? tx.responseBody?.json : undefined,
    });
  }

  for (const ws of wsMap.values()) {
    if (ws.platform !== 'custom') platforms.add(ws.platform);
  }

  candidateEndpoints.sort((a, b) => b.score - a.score || b.decimalPriceCount - a.decimalPriceCount);

  return {
    evidenceId,
    finalUrl,
    challengeDetected: challengeSignals.size > 0,
    challengeSignals: [...challengeSignals],
    detectedPlatforms: [...platforms].sort(),
    httpTransactions: txMap.size,
    failedRequests,
    candidateEndpoints,
    webSockets: [...wsMap.values()],
  };
}

/**
 * Extract API URL templates and market constants from REA's static JavaScript
 * application Evidence (`analyze_javascript_application` / `analyze_web_bundle`).
 *
 * @param {object} jsEvidence
 * @returns {{ evidenceId: string | null, moduleCount: number, discoveredUrls: string[], discoveredPlatforms: string[] }}
 */
export function inspectReaJavaScriptEvidence(jsEvidence) {
  const evidenceId = jsEvidence?.evidence_id || null;
  const serialized = JSON.stringify(jsEvidence || {});
  const urlMatches = serialized.match(/(?:https?|wss?):\/\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]{8,180}/g) || [];

  const cleaned = new Set();
  const platforms = new Set();
  for (const raw of urlMatches) {
    const url = raw.replace(/[\\",')\]}]+$/, '');
    if (STATIC_ASSET_RE.test(url)) continue;
    try {
      const host = new URL(url).hostname;
      if (TELEMETRY_HOST_RE.test(host) || /(?:w3\.org|reactjs\.org|mozilla\.org|github\.com|npmjs\.com)/i.test(host)) {
        continue;
      }
    } catch {
      continue;
    }
    cleaned.add(url);
    const p = detectSportsbookPlatform(url);
    if (p !== 'custom') platforms.add(p);
  }

  const graphModules = jsEvidence?.normalized_result?.modules
    || jsEvidence?.graph?.modules
    || [];

  return {
    evidenceId,
    moduleCount: Array.isArray(graphModules) ? graphModules.length : 0,
    discoveredUrls: [...cleaned].sort(),
    discoveredPlatforms: [...platforms].sort(),
  };
}

/**
 * Build a provenance-stamped capture envelope matching `data/endpoints/captures/*.json`.
 *
 * @param {{
 *   bookId: string,
 *   endpoint: object,
 *   evidenceId: string | null,
 *   reaVersion: string | null,
 * }} opts
 */
export function buildProvenanceCaptureEnvelope(opts) {
  return {
    provenance: {
      book: opts.bookId,
      capturedAt: new Date().toISOString(),
      tool: `morluto/rea MCP (${opts.reaVersion || 'rea-agents'})`,
      reaEvidenceId: opts.evidenceId || null,
      method: opts.endpoint.method || 'GET',
      url: opts.endpoint.url,
      status: opts.endpoint.status ?? 200,
      responseSha256: opts.endpoint.responseSha256 || null,
      responseBytes: opts.endpoint.responseBytes || 0,
      publicUnauthenticated: Boolean(opts.endpoint.publicUnauthenticated),
      tenantHeaders: opts.endpoint.tenantHeaders || {},
      detectedPlatform: opts.endpoint.platform || 'custom',
      marketFamilies: opts.endpoint.marketFamilies || [],
    },
    raw: opts.endpoint.parsedJson ?? null,
  };
}
