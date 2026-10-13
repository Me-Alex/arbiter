import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  formatTelegramMessage,
  formatWebhookPayload,
  sendTelegramAlert,
  sendWebhookAlert,
  AlertDispatcher,
} from '../src/alerts/dispatcher.mjs';

const SAMPLE_ARB_ALERT = {
  key: 'football:premier-league:arsenal-chelsea::CNOU::arb',
  type: 'arb',
  sport: 'Football',
  league: 'Premier League',
  kickoff: '2026-10-15T19:30:00.000Z',
  homeTeam: 'Arsenal & Co',
  awayTeam: 'Chelsea <FC>',
  marketKey: 'CNOU',
  live: false,
  roiPercent: 3.45,
  totalStake: 100,
  guaranteedProfit: 3.45,
  verified: 'confirmed',
  sourceIds: ['betano', 'unibet'],
  legs: [
    { sourceId: 'betano', selection: 'Over 9.5', odds: 2.10, stake: 48.78 },
    { sourceId: 'unibet', selection: 'Under 9.5', odds: 2.12, stake: 51.22 },
  ],
};

const SAMPLE_MIDDLE_ALERT = {
  key: 'basketball:nba:lakers-celtics::POINTS::middle',
  type: 'middle',
  sport: 'Basketball',
  league: 'NBA',
  kickoff: '2026-10-16T02:30:00.000Z',
  homeTeam: 'LA Lakers',
  awayTeam: 'Boston Celtics',
  marketKey: 'OVER_UNDER',
  live: true,
  roiPercent: 28.5,
  riskPercent: 4.2,
  totalStake: 100,
  legs: [
    { sourceId: 'superbet', selection: 'Over 220.5', odds: 1.95, stake: 50 },
    { sourceId: 'betano', selection: 'Under 224.5', odds: 1.95, stake: 50 },
  ],
};

test('escapeHtml: safely sanitizes HTML tags and entities', () => {
  assert.equal(escapeHtml('Arsenal <FC> & "The Gunners"'), 'Arsenal &lt;FC&gt; &amp; &quot;The Gunners&quot;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(123), '123');
});

test('formatTelegramMessage: formats rich HTML for arbitrage alert', () => {
  const msg = formatTelegramMessage(SAMPLE_ARB_ALERT);
  assert.ok(msg.includes('🚨 <b>ARBITRAGE ALERT (+3.45%)</b>'));
  assert.ok(msg.includes('Arsenal &amp; Co</b> vs <b>Chelsea &lt;FC&gt;'));
  assert.ok(msg.includes('<code>CNOU</code>'));
  assert.ok(msg.includes('[<b>betano</b>] Over 9.5 @ <b>2.10</b>'));
  assert.ok(msg.includes('[<b>unibet</b>] Under 9.5 @ <b>2.12</b>'));
  assert.ok(msg.includes('💵 <b>Total Investment:</b> €100.00'));
  assert.ok(msg.includes('📈 <b>Guaranteed Profit:</b> +€3.45'));
  assert.ok(msg.includes('✅ <i>Status:</i> <code>confirmed</code>'));
});

test('formatTelegramMessage: formats rich HTML for live middle alert', () => {
  const msg = formatTelegramMessage(SAMPLE_MIDDLE_ALERT);
  assert.ok(msg.includes('🎯 <b>MIDDLE OPPORTUNITY (+28.50%)</b>'));
  assert.ok(msg.includes('🔴 <b>LIVE IN-PLAY</b>'));
  assert.ok(msg.includes('⚠️ <i>Risk:</i> 4.2%'));
  assert.ok(msg.includes('[<b>superbet</b>] Over 220.5 @ <b>1.95</b>'));
});

test('formatWebhookPayload: produces structured JSON event payload', () => {
  const payload = formatWebhookPayload(SAMPLE_ARB_ALERT);
  assert.equal(payload.event, 'arbitrage_opportunity');
  assert.ok(payload.timestamp);
  assert.equal(payload.alert.key, SAMPLE_ARB_ALERT.key);
  assert.equal(payload.alert.roiPercent, 3.45);
  assert.equal(payload.alert.homeTeam, 'Arsenal & Co');
  assert.equal(payload.alert.legs.length, 2);
});

test('sendTelegramAlert: validates credentials and dispatches via POST', async () => {
  await assert.rejects(() => sendTelegramAlert({ chatId: '123', message: 'test' }), /botToken is required/);
  await assert.rejects(() => sendTelegramAlert({ botToken: 'tok', message: 'test' }), /chatId is required/);

  let calledUrl = '';
  let calledBody = null;
  const mockFetch = async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    };
  };

  const res = await sendTelegramAlert({
    botToken: '123456:ABC-DEF',
    chatId: '-100987654321',
    message: '<b>Hello</b>',
    fetchImpl: mockFetch,
  });

  assert.equal(res.ok, true);
  assert.equal(res.messageId, 42);
  assert.equal(calledUrl, 'https://api.telegram.org/bot123456:ABC-DEF/sendMessage');
  assert.equal(calledBody.chat_id, '-100987654321');
  assert.equal(calledBody.text, '<b>Hello</b>');
  assert.equal(calledBody.parse_mode, 'HTML');
});

test('sendTelegramAlert: handles HTTP failure from Telegram API', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => 'Unauthorized: invalid token',
  });

  await assert.rejects(
    () => sendTelegramAlert({
      botToken: 'bad_token',
      chatId: '123',
      message: 'test',
      fetchImpl: mockFetch,
    }),
    /Telegram API HTTP 401: Unauthorized/
  );
});

test('sendWebhookAlert: sends JSON payload to webhook URL', async () => {
  let calledUrl = '';
  let calledOpts = null;
  const mockFetch = async (url, opts) => {
    calledUrl = url;
    calledOpts = opts;
    return { ok: true, status: 200 };
  };

  const res = await sendWebhookAlert({
    url: 'https://example.com/alerts',
    payload: { hello: 'world' },
    headers: { 'X-Custom-Auth': 'secret' },
    fetchImpl: mockFetch,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(calledUrl, 'https://example.com/alerts');
  assert.equal(calledOpts.method, 'POST');
  assert.equal(calledOpts.headers['Content-Type'], 'application/json');
  assert.equal(calledOpts.headers['X-Custom-Auth'], 'secret');
  assert.deepEqual(JSON.parse(calledOpts.body), { hello: 'world' });
});

test('AlertDispatcher: orchestrates multi-channel dispatch with cooldown and suppression', async () => {
  const dispatched = [];
  const mockFetch = async (url, opts) => {
    dispatched.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    };
  };

  const dispatcher = new AlertDispatcher({
    telegram: { enabled: true, botToken: 'mock_token', chatId: '12345' },
    webhook: { enabled: true, url: 'https://webhook.site/test' },
    cooldownSeconds: 60,
    fetchImpl: mockFetch,
  });

  // 1. First dispatch: both channels fire
  const t0 = 1000000;
  const res1 = await dispatcher.dispatch([SAMPLE_ARB_ALERT], { now: t0 });
  assert.equal(res1.dispatchedCount, 1);
  assert.equal(res1.suppressedCount, 0);
  assert.equal(res1.errors.length, 0);
  assert.equal(dispatched.length, 2, 'Telegram + Webhook both called');

  // 2. Immediate second dispatch on same key: suppressed by cooldown
  dispatched.length = 0;
  const res2 = await dispatcher.dispatch([SAMPLE_ARB_ALERT], { now: t0 + 10000 }); // +10s
  assert.equal(res2.dispatchedCount, 0);
  assert.equal(res2.suppressedCount, 1);
  assert.equal(dispatched.length, 0);

  // 3. Dispatch after cooldown window (60s): fires again
  const res3 = await dispatcher.dispatch([SAMPLE_ARB_ALERT], { now: t0 + 65000 }); // +65s
  assert.equal(res3.dispatchedCount, 1);
  assert.equal(res3.suppressedCount, 0);
  assert.equal(dispatched.length, 2);
});

test('AlertDispatcher: respects quiet hours when active', async () => {
  let called = false;
  const mockFetch = async () => {
    called = true;
    return { ok: true, status: 200 };
  };

  const dispatcher = new AlertDispatcher({
    telegram: { enabled: true, botToken: 'tok', chatId: 'chat' },
    quietHours: { from: '22:00', to: '08:00', enabled: true },
    fetchImpl: mockFetch,
  });

  // 23:30 is during quiet hours
  const quietTime = new Date('2026-10-15T23:30:00Z').getTime();
  const res = await dispatcher.dispatch([SAMPLE_ARB_ALERT], { now: quietTime });
  assert.equal(res.quietSuppressed, true);
  assert.equal(res.dispatchedCount, 0);
  assert.equal(called, false);
});
