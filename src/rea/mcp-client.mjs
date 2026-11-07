/**
 * mcp-client.mjs — First-class Model Context Protocol (MCP) stdio client for
 * `morluto/rea` (`rea-agents`, Reverse Engineer Anything) installed on this PC.
 *
 * Arbiter uses REA exclusively for public, zero-credential sportsbook endpoint
 * discovery, HAR/SAZ capture inspection, and inert JavaScript bundle analysis:
 *   - No credentials, session cookies, or challenge-bypass tools are ever used.
 *   - Every retained network response body and script carries REA's SHA-256
 *     provenance digest so candidate scrapers are anchored in measured wire data.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Locate the installed `rea-agents` MCP entrypoint (`scripts/rea.mjs`) on the
 * current machine without downloading packages or mutating global config.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ ok: boolean, scriptPath: string | null, packageRoot: string | null, version: string | null, nodeVersion: string }}
 */
export function resolveReaInstallation(opts = {}) {
  const env = opts.env || process.env;
  const candidates = [];

  if (env.REA_MCP_SCRIPT) {
    candidates.push(resolve(env.REA_MCP_SCRIPT));
  }
  if (env.APPDATA) {
    candidates.push(join(env.APPDATA, 'npm', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'));
  }
  if (env.HOME) {
    candidates.push(
      join(env.HOME, '.npm-global', 'lib', 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'),
      '/usr/local/lib/node_modules/rea-agents/scripts/rea.mjs',
      '/usr/lib/node_modules/rea-agents/scripts/rea.mjs',
    );
  }

  for (const scriptPath of candidates) {
    if (scriptPath && existsSync(scriptPath)) {
      const packageRoot = resolve(scriptPath, '..', '..');
      const pkgPath = join(packageRoot, 'package.json');
      let version = null;
      if (existsSync(pkgPath)) {
        try {
          version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || null;
        } catch {}
      }
      return {
        ok: true,
        scriptPath,
        packageRoot,
        version,
        nodeVersion: process.versions.node,
      };
    }
  }

  // Fallback: query `npm root -g` if REA was installed under a custom prefix.
  try {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const globalRoot = execFileSync(npmCmd, ['root', '-g'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (globalRoot) {
      const scriptPath = join(globalRoot, 'rea-agents', 'scripts', 'rea.mjs');
      if (existsSync(scriptPath)) {
        const packageRoot = resolve(scriptPath, '..', '..');
        const pkgPath = join(packageRoot, 'package.json');
        const version = existsSync(pkgPath)
          ? (JSON.parse(readFileSync(pkgPath, 'utf8')).version || null)
          : null;
        return {
          ok: true,
          scriptPath,
          packageRoot,
          version,
          nodeVersion: process.versions.node,
        };
      }
    }
  } catch {}

  return {
    ok: false,
    scriptPath: null,
    packageRoot: null,
    version: null,
    nodeVersion: process.versions.node,
  };
}

/**
 * Resolve a local Chrome/Edge/Chromium binary for REA's `capture_browser_scenario`
 * launch mode (which requires an explicit absolute `executable_path`).
 *
 * @param {{ env?: NodeJS.ProcessEnv, explicitPath?: string }} [opts]
 * @returns {string | null}
 */
export function resolveBrowserExecutable(opts = {}) {
  const env = opts.env || process.env;
  const candidates = [
    opts.explicitPath,
    env.REA_BROWSER_EXECUTABLE,
    env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

/**
 * Split a URL string into REA's strict `browserScenarioUrlSchema` (`{ url, query }`)
 * while preserving ordinary URL query strings safely and stripping credentials.
 *
 * @param {string} rawUrl
 * @returns {{ url: string, query: Array<{ name: string, value: { source: 'literal', value: string } }> }}
 */
export function buildReaScenarioUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`REA browser scenario requires http(s) URL, got ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Arbiter REA integration refuses URLs containing inline credentials');
  }
  return {
    url: parsed.toString(),
    query: [],
  };
}

/**
 * Unwrap an MCP `tools/call` result envelope into structured JSON or text.
 *
 * @param {object} mcpResult
 * @returns {{ isError: boolean, data: any, rawText: string }}
 */
export function parseMcpToolResult(mcpResult) {
  const isError = Boolean(mcpResult?.isError);
  if (mcpResult?.structuredContent !== undefined) {
    return {
      isError,
      data: mcpResult.structuredContent,
      rawText: JSON.stringify(mcpResult.structuredContent),
    };
  }
  const blocks = Array.isArray(mcpResult?.content) ? mcpResult.content : [];
  const textBlocks = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text);
  const rawText = textBlocks.join('\n').trim();
  if (!rawText) {
    return { isError, data: mcpResult ?? null, rawText: '' };
  }
  try {
    return { isError, data: JSON.parse(rawText), rawText };
  } catch {
    return { isError, data: rawText, rawText };
  }
}

/**
 * Stdio JSON-RPC client for the local `rea-agents` MCP server.
 */
export class ReaMcpClient {
  /**
   * @param {{
   *   scriptPath?: string,
   *   nodeExecutable?: string,
   *   env?: NodeJS.ProcessEnv,
   *   defaultTimeoutMs?: number,
   *   spawnImpl?: typeof spawn,
   * }} [opts]
   */
  constructor(opts = {}) {
    const resolved = opts.scriptPath
      ? { ok: true, scriptPath: resolve(opts.scriptPath) }
      : resolveReaInstallation({ env: opts.env });
    if (!resolved.ok || !resolved.scriptPath) {
      throw new Error(
        'rea-agents MCP server not found on this PC. Install globally (`npm i -g rea-agents`) or set REA_MCP_SCRIPT.',
      );
    }
    this.scriptPath = resolved.scriptPath;
    this.nodeExecutable = opts.nodeExecutable || process.execPath;
    this.env = {
      REA_MCP_MAX_RESPONSE_BYTES: String(128 * 1024 * 1024),
      ...(opts.env || process.env),
    };
    this.defaultTimeoutMs = Number(opts.defaultTimeoutMs ?? 90_000);
    this.spawnImpl = opts.spawnImpl || spawn;

    this._proc = null;
    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuf = '';
    this._stderrChunks = [];
    this._serverInfo = null;
    this._connected = false;
  }

  async connect() {
    if (this._connected && this._proc) return this._serverInfo;

    this._proc = this.spawnImpl(this.nodeExecutable, [this.scriptPath, 'mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      windowsHide: true,
    });

    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._proc.stderr.on('data', (chunk) => {
      if (this._stderrChunks.length < 50) {
        this._stderrChunks.push(chunk.toString('utf8'));
      }
    });
    this._proc.on('exit', (code, signal) => {
      this._connected = false;
      const detail = this._stderrChunks.join('').trim();
      const err = new Error(
        `REA MCP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${detail ? `: ${detail.slice(0, 400)}` : ''}`,
      );
      for (const [, entry] of this._pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this._pending.clear();
    });

    const initResult = await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'arbiter-rea-client', version: '1.0.0' },
      },
      20_000,
    );

    this._sendNotification('notifications/initialized', {});
    this._serverInfo = initResult?.serverInfo || null;
    this._connected = true;
    return this._serverInfo;
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk.toString('utf8');
    const lines = this._stdoutBuf.split('\n');
    this._stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && this._pending.has(msg.id)) {
        const entry = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const err = new Error(`REA MCP error (${msg.error.code}): ${msg.error.message}`);
          err.code = msg.error.code;
          err.data = msg.error.data;
          entry.reject(err);
        } else {
          entry.resolve(msg.result);
        }
      }
    }
  }

  _sendNotification(method, params) {
    if (!this._proc || !this._proc.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    this._proc.stdin.write(`${payload}\n`);
  }

  request(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    if (!this._proc || !this._proc.stdin.writable) {
      return Promise.reject(new Error('REA MCP server is not connected'));
    }
    const id = this._nextId++;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        rejectReq(new Error(`REA MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this._proc.stdin.write(`${payload}\n`);
    });
  }

  async listTools() {
    await this.connect();
    const res = await this.request('tools/list', {}, 20_000);
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name, args = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    await this.connect();
    const raw = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return parseMcpToolResult(raw);
  }

  /**
   * Capture public network & WebSocket traffic for a target URL using REA's
   * `capture_browser_scenario` MCP tool with high-capacity JSON body retention.
   *
   * @param {{
   *   url: string,
   *   waitMs?: number,
   *   headless?: boolean,
   *   executablePath?: string,
   *   locale?: string,
   *   timezone?: string,
   *   actions?: object[],
   *   maxBodyBytes?: number,
   *   timeoutMs?: number,
   * }} opts
   */
  async capturePublicSportsbook(opts) {
    const executablePath = resolveBrowserExecutable({
      env: this.env,
      explicitPath: opts.executablePath,
    });
    if (!executablePath) {
      throw new Error('No local Chrome/Edge/Chromium executable found for REA browser scenario capture');
    }

    const waitMs = Math.max(1_000, Number(opts.waitMs ?? 8_000));
    const maxBodyBytes = Math.max(64 * 1024, Number(opts.maxBodyBytes ?? 16 * 1024 * 1024));
    const actions = Array.isArray(opts.actions) && opts.actions.length > 0
      ? opts.actions
      : [
        {
          step_id: 'settle_feed_network',
          action: 'wait_for_timeout',
          duration_ms: waitMs,
        },
      ];

    const scenario = {
      browser: {
        mode: 'launch',
        executable_path: executablePath,
        headless: opts.headless !== false,
      },
      start_url: buildReaScenarioUrl(opts.url),
      environment: {
        viewport: { width: 1440, height: 900, device_scale_factor: 1 },
        locale: opts.locale || 'ro-RO',
        timezone: opts.timezone || 'Europe/Bucharest',
        color_scheme: 'dark',
        reduced_motion: 'reduce',
        service_workers: 'block',
      },
      actions,
      capture: {
        after_each_step: [],
        at_end: ['url', 'accessibility'],
        events: ['network', 'websockets', 'console', 'page-errors'],
        network: {
          request_body: true,
          response_body: true,
          header_values: true,
        },
        limits: {
          max_events: 20_000,
          max_event_allocation_bytes: 32 * 1024 * 1024,
          max_total_event_allocation_bytes: 128 * 1024 * 1024,
          max_network_transactions: 2_048,
          max_network_body_bytes: maxBodyBytes,
          max_network_body_allocation_bytes: 96 * 1024 * 1024,
          max_network_header_allocation_bytes: 8 * 1024 * 1024,
          max_network_metadata_allocation_bytes: 8 * 1024 * 1024,
        },
      },
      command_timeout_ms: Math.max(20_000, waitMs + 20_000),
    };

    return this.callTool('capture_browser_scenario', scenario, {
      timeoutMs: Number(opts.timeoutMs ?? waitMs + 45_000),
    });
  }

  /**
   * Inspect a saved HAR / SAZ / mitmproxy / qlog capture via REA MCP.
   */
  async inspectNetworkCapture(capturePath, format = 'har', opts = {}) {
    return this.callTool(
      'inspect_web_network_capture',
      {
        capture_path: resolve(capturePath),
        format,
        ...(opts.detail ? { detail: opts.detail } : {}),
        ...(opts.recordOrdinals ? { record_ordinals: opts.recordOrdinals } : {}),
      },
      { timeoutMs: Number(opts.timeoutMs ?? 60_000) },
    );
  }

  /**
   * Statically analyze an extracted JavaScript application or bundle directory via REA MCP.
   */
  async analyzeJavascriptDirectory(directoryPath, opts = {}) {
    return this.callTool(
      'analyze_javascript_application',
      {
        application_path: resolve(directoryPath),
        ...(opts.detail ? { detail: opts.detail } : {}),
      },
      { timeoutMs: Number(opts.timeoutMs ?? 90_000) },
    );
  }

  async close() {
    if (!this._proc) return;
    const proc = this._proc;
    this._proc = null;
    this._connected = false;
    try {
      proc.stdin.end();
    } catch {}
    await new Promise((resolveClose) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        resolveClose();
      }, 2_000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolveClose();
      });
    });
  }
}
