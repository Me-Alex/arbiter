/**
 * dispatcher.mjs — automated real-time alert dispatcher for Webhooks & Telegram.
 *
 * Ingests evaluated arbitrage and middle alerts, applies per-opportunity
 * cooldowns, formats messages, and dispatches them across configured
 * external notification channels (Telegram Bot API, custom Webhooks).
 */

import { isQuietNow } from '../alert-engine.mjs';

/** HTML escape helper for Telegram HTML messages. */
export function escapeHtml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format an alert as a rich Telegram message using HTML formatting.
 *
 * @param {object} alert
 * @returns {string}
 */
export function formatTelegramMessage(alert) {
  if (!alert || typeof alert !== 'object') return '';
  const isArb = alert.type === 'arb' || !alert.type;
  const headerIcon = isArb ? '🚨' : '🎯';
  const headerTitle = isArb ? 'ARBITRAGE ALERT' : 'MIDDLE OPPORTUNITY';
  const roiSign = alert.roiPercent > 0 ? '+' : '';
  const roiFormatted = Number(alert.roiPercent || 0).toFixed(2);

  const lines = [
    `${headerIcon} <b>${headerTitle} (${roiSign}${roiFormatted}%)</b>`,
    '',
    `📌 <b>${escapeHtml(alert.sport || 'Sports')}</b>: ${escapeHtml(alert.league || 'Event')}`,
    `⚔️ <b>${escapeHtml(alert.homeTeam || 'Home')}</b> vs <b>${escapeHtml(alert.awayTeam || 'Away')}</b>`,
  ];

  if (alert.kickoff) {
    const koDate = new Date(alert.kickoff);
    const koString = !Number.isNaN(koDate.getTime()) ? koDate.toUTCString().replace(' GMT', ' UTC') : alert.kickoff;
    lines.push(`⏰ <i>Kickoff:</i> ${escapeHtml(koString)}`);
  }

  if (alert.live) {
    lines.push('🔴 <b>LIVE IN-PLAY</b>');
  }

  lines.push(`📊 <i>Market:</i> <code>${escapeHtml(alert.marketKey || 'MATCH')}</code>`);
  lines.push('');

  // Legs breakdown
  if (Array.isArray(alert.legs) && alert.legs.length > 0) {
    lines.push('💰 <b>Betting Legs:</b>');
    for (let i = 0; i < alert.legs.length; i++) {
      const leg = alert.legs[i];
      if (!leg) continue;
      const book = escapeHtml(leg.sourceId || 'Book');
      const sel = escapeHtml(leg.selection || leg.name || `Leg ${i + 1}`);
      const odds = Number(leg.odds || 0).toFixed(2);
      const stakeStr = leg.stake !== null && leg.stake !== undefined ? ` | Stake: €${Number(leg.stake).toFixed(2)}` : '';
      lines.push(`  • [<b>${book}</b>] ${sel} @ <b>${odds}</b>${stakeStr}`);
    }
    lines.push('');
  }

  // Financial summary
  if (isArb) {
    if (alert.totalStake !== null && alert.totalStake !== undefined) {
      lines.push(`💵 <b>Total Investment:</b> €${Number(alert.totalStake).toFixed(2)}`);
    }
    if (alert.guaranteedProfit !== null && alert.guaranteedProfit !== undefined) {
      lines.push(`📈 <b>Guaranteed Profit:</b> +€${Number(alert.guaranteedProfit).toFixed(2)}`);
    }
  } else {
    if (alert.riskPercent !== null && alert.riskPercent !== undefined) {
      lines.push(`⚠️ <i>Risk:</i> ${Number(alert.riskPercent).toFixed(1)}%`);
    }
  }

  if (alert.verified) {
    lines.push(`✅ <i>Status:</i> <code>${escapeHtml(alert.verified)}</code>`);
  }

  return lines.join('\n');
}

/**
 * Format an alert into a JSON webhook payload.
 *
 * @param {object} alert
 * @returns {object}
 */
export function formatWebhookPayload(alert) {
  if (!alert || typeof alert !== 'object') return null;
  return {
    event: alert.type === 'middle' ? 'middle_opportunity' : 'arbitrage_opportunity',
    timestamp: new Date().toISOString(),
    alert: {
      key: alert.key || '',
      type: alert.type || 'arb',
      roiPercent: alert.roiPercent ?? 0,
      sport: alert.sport || '',
      league: alert.league || '',
      kickoff: alert.kickoff || null,
      homeTeam: alert.homeTeam || '',
      awayTeam: alert.awayTeam || '',
      marketKey: alert.marketKey || '',
      live: Boolean(alert.live),
      totalStake: alert.totalStake ?? null,
      guaranteedProfit: alert.guaranteedProfit ?? null,
      riskPercent: alert.riskPercent ?? null,
      legs: Array.isArray(alert.legs) ? alert.legs : [],
      sourceIds: Array.isArray(alert.sourceIds) ? alert.sourceIds : [],
      verified: alert.verified || null,
    },
  };
}

/**
 * Send an alert message to a Telegram chat via Bot API.
 *
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string|number} opts.chatId
 * @param {string} opts.message
 * @param {function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, messageId?: number }>}
 */
export async function sendTelegramAlert({
  botToken,
  chatId,
  message,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  const token = String(botToken || '').trim();
  const chat = String(chatId || '').trim();
  if (!token) throw new Error('Telegram botToken is required');
  if (!chat) throw new Error('Telegram chatId is required');
  if (!message || typeof message !== 'string') throw new Error('Message text is required');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chat,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Telegram API HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json().catch(() => ({}));
  return { ok: true, messageId: data?.result?.message_id };
}

/**
 * Send an alert payload to a webhook HTTP endpoint.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.payload
 * @param {object} [opts.headers]
 * @param {function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function sendWebhookAlert({
  url,
  payload,
  headers = {},
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('Webhook URL is required');
  if (!payload || typeof payload !== 'object') throw new Error('Webhook payload is required');

  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Webhook HTTP ${response.status}`);
  }

  return { ok: true, status: response.status };
}

/**
 * AlertDispatcher orchestrates multi-channel notifications with cooldown deduplication.
 */
export class AlertDispatcher {
  constructor(config = {}) {
    this.telegram = {
      enabled: Boolean(config.telegram?.enabled),
      botToken: String(config.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
      chatId: String(config.telegram?.chatId || process.env.TELEGRAM_CHAT_ID || '').trim(),
    };
    this.webhook = {
      enabled: Boolean(config.webhook?.enabled),
      url: String(config.webhook?.url || process.env.ALERT_WEBHOOK_URL || '').trim(),
      headers: config.webhook?.headers && typeof config.webhook.headers === 'object' ? config.webhook.headers : {},
    };
    this.cooldownMs = Math.max(0, Number(config.cooldownSeconds ?? 60)) * 1000;
    this.quietHours = config.quietHours || null;
    this.fetchImpl = config.fetchImpl || fetch;
    this.cooldowns = new Map();
  }

  /**
   * Check whether an alert key is currently suppressed under active cooldown.
   *
   * @param {string} key
   * @param {number} [nowMs]
   * @returns {boolean}
   */
  isSuppressed(key, nowMs = Date.now()) {
    if (!key) return false;
    const lastSent = this.cooldowns.get(key);
    if (!lastSent) return false;
    return nowMs - lastSent < this.cooldownMs;
  }

  /**
   * Dispatch a list of evaluated alerts across configured channels.
   *
   * @param {object[]} alerts
   * @param {object} [opts]
   * @param {number} [opts.now]
   * @param {function} [opts.fetchImpl]
   * @returns {Promise<{ dispatchedCount: number, suppressedCount: number, quietSuppressed: boolean, errors: Array<{ key: string, channel: string, error: string }> }>}
   */
  async dispatch(alerts, { now = Date.now(), fetchImpl = this.fetchImpl } = {}) {
    const list = Array.isArray(alerts) ? alerts : [];
    const nowMs = typeof now === 'number' ? now : new Date(now).getTime();

    // Check quiet hours if configured
    if (this.quietHours && isQuietNow({ quietHours: this.quietHours }, { now: new Date(nowMs) })) {
      return {
        dispatchedCount: 0,
        suppressedCount: list.length,
        quietSuppressed: true,
        errors: [],
      };
    }

    const hasTelegram = this.telegram.enabled && Boolean(this.telegram.botToken && this.telegram.chatId);
    const hasWebhook = this.webhook.enabled && Boolean(this.webhook.url);

    if (!hasTelegram && !hasWebhook) {
      return {
        dispatchedCount: 0,
        suppressedCount: 0,
        quietSuppressed: false,
        errors: [],
      };
    }

    let dispatchedCount = 0;
    let suppressedCount = 0;
    const errors = [];

    for (const alert of list) {
      if (!alert) continue;
      const key = alert.key || `${alert.eventKey || ''}::${alert.marketKey || ''}::${alert.type || 'arb'}`;

      if (this.isSuppressed(key, nowMs)) {
        suppressedCount += 1;
        continue;
      }

      let sentAny = false;

      // 1. Telegram channel
      if (hasTelegram) {
        try {
          const message = formatTelegramMessage(alert);
          await sendTelegramAlert({
            botToken: this.telegram.botToken,
            chatId: this.telegram.chatId,
            message,
            fetchImpl,
          });
          sentAny = true;
        } catch (err) {
          errors.push({ key, channel: 'telegram', error: err.message });
        }
      }

      // 2. Webhook channel
      if (hasWebhook) {
        try {
          const payload = formatWebhookPayload(alert);
          await sendWebhookAlert({
            url: this.webhook.url,
            payload,
            headers: this.webhook.headers,
            fetchImpl,
          });
          sentAny = true;
        } catch (err) {
          errors.push({ key, channel: 'webhook', error: err.message });
        }
      }

      if (sentAny) {
        this.cooldowns.set(key, nowMs);
        dispatchedCount += 1;
      }
    }

    return {
      dispatchedCount,
      suppressedCount,
      quietSuppressed: false,
      errors,
    };
  }

  /** Clear all stored cooldown timestamps. */
  clearCooldowns() {
    this.cooldowns.clear();
  }
}
