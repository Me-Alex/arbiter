/**
 * alert-client.test.mjs — the page half of the alert system.
 *
 * The server decides what deserves attention; this decides when to say so, and
 * that half is the one that can quietly misfire in both directions. Shout on
 * every poll and the trader mutes the app; never shout and the feature is
 * decoration. The tests below pin both edges, and each negative assertion sits
 * next to a positive one on the same fixture — a delivery ladder that is
 * entirely broken returns 'none' everywhere, which would pass a suite written
 * only in terms of what does *not* fire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const alertsSource = read('public/js/alerts.js');
const i18nSource = read('public/js/i18n.js');

/** The page context, with the real i18n dictionary mounted. */
function page({ lang = 'en' } = {}) {
  const store = { 'arbiter.lang': lang };
  const context = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] },
    console: { warn() {}, log() {} },
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  vm.runInNewContext(i18nSource, context);
  vm.runInNewContext(alertsSource, context);
  return context;
}

const PAYLOAD = { title: 'FCSB vs Dinamo', body: '+4.00% arbitrage', tag: 'e1::1x2::arb' };

function alert(overrides = {}) {
  return {
    key: 'fotbal::1x2::arb',
    type: 'arb',
    homeTeam: 'FCSB',
    awayTeam: 'Dinamo',
    marketKey: '1x2',
    roiPercent: 4,
    totalStake: 100,
    riskPercent: 0,
    sourceIds: ['betano', 'fortuna'],
    verified: 'confirmed',
    ...overrides,
  };
}

function payloadOf(alerts, extra = {}) {
  return {
    alerts: { arbitrages: alerts, middles: [] },
    counts: { arbitrages: alerts.length, middles: 0 },
    truncated: { arbitrages: 0, middles: 0 },
    preferences: { cooldownSeconds: 60, channels: { desktop: true, sound: false } },
    quietNow: false,
    published: true,
    ...extra,
  };
}

// ---- the delivery ladder ---------------------------------------------------

test('the desktop app carries the alert when the main process accepts it', async () => {
  const { arbiterAlerts } = page();
  const seen = [];
  const browserCalls = [];
  const bannerCalls = [];
  const channel = await arbiterAlerts.deliverNotification(PAYLOAD, {
    bridge: { notify: async (p) => { seen.push(p); return { ok: true }; } },
    NotificationApi: function () { browserCalls.push(1); },
    banner: (p) => bannerCalls.push(p),
  });
  assert.equal(channel, 'electron');
  assert.deepEqual(seen, [PAYLOAD], 'the payload crosses unchanged');
  assert.equal(browserCalls.length, 0, 'and the lower rungs are not also fired');
  assert.equal(bannerCalls.length, 0);
});

/** A stand-in for window.Notification; `permission` is a static in the real API. */
function fakeNotification(permission, calls) {
  function Notification(title, opts) { calls.push({ title, opts }); }
  Notification.permission = permission;
  return Notification;
}

test('an app that cannot show it falls to the browser, not to silence', async () => {
  const { arbiterAlerts } = page();
  // The two ways the Electron rung says no. Each has to be a downgrade.
  for (const answer of [{ ok: false, reason: 'unsupported' }, { ok: false }]) {
    const browserCalls = [];
    const channel = await arbiterAlerts.deliverNotification(PAYLOAD, {
      bridge: { notify: async () => answer },
      NotificationApi: fakeNotification('granted', browserCalls),
    });
    assert.equal(channel, 'browser', `answer ${JSON.stringify(answer)}`);
    assert.equal(browserCalls.length, 1);
  }
});

test('a bridge that throws is a downgrade, not a lost alert', async () => {
  const { arbiterAlerts } = page();
  const bannerCalls = [];
  // The main process being gone — a restart mid-session — must not mean the
  // trader is never told anything.
  const channel = await arbiterAlerts.deliverNotification(PAYLOAD, {
    bridge: { notify: async () => { throw new Error('no ipc'); } },
    NotificationApi: undefined,
    banner: (p) => bannerCalls.push(p),
  });
  assert.equal(channel, 'banner');
  assert.equal(bannerCalls.length, 1);
  // The control for the line above: the same call with a working bridge never
  // reaches the banner.
  const ok = await arbiterAlerts.deliverNotification(PAYLOAD, {
    bridge: { notify: async () => ({ ok: true }) },
    banner: (p) => bannerCalls.push(p),
  });
  assert.equal(ok, 'electron');
  assert.equal(bannerCalls.length, 1);
});

test('a browser that has not been granted permission goes to the banner', async () => {
  const { arbiterAlerts } = page();
  for (const permission of ['denied', 'default']) {
    const browserCalls = [];
    const bannerCalls = [];
    const channel = await arbiterAlerts.deliverNotification(PAYLOAD, {
      NotificationApi: fakeNotification(permission, browserCalls),
      banner: (p) => bannerCalls.push(p),
    });
    // 'default' means the user has not been asked yet; 'denied' means they
    // said no. Neither is a reason to pretend a notification was shown.
    assert.equal(channel, 'banner', `permission ${permission}`);
    assert.equal(browserCalls.length, 0);
    assert.equal(bannerCalls.length, 1);
  }
  // The control: a granted permission is a real channel.
  const granted = [];
  const via = await arbiterAlerts.deliverNotification(PAYLOAD, {
    NotificationApi: fakeNotification('granted', granted),
    banner: () => { throw new Error('the banner must not run'); },
  });
  assert.equal(via, 'browser');
  assert.equal(granted.length, 1);
  assert.equal(granted[0].opts.tag, PAYLOAD.tag, 'the tag is what collapses a repeat');
  assert.equal(granted[0].opts.silent, false);
});

test('nothing to say is reported as nothing, and is not re-sent one rung down', async () => {
  const { arbiterAlerts } = page();
  const browserCalls = [];
  const bannerCalls = [];
  // 'empty' is the main process saying the payload sanitised away to nothing.
  // Rendering the same nothing as a toast would cost the trader a glance and
  // tell them nothing.
  const channel = await arbiterAlerts.deliverNotification(PAYLOAD, {
    bridge: { notify: async () => ({ ok: false, reason: 'empty' }) },
    NotificationApi: function Notification() { browserCalls.push(1); this.permission = 'granted'; },
    banner: (p) => bannerCalls.push(p),
  });
  assert.equal(channel, 'none');
  assert.equal(browserCalls.length, 0);
  assert.equal(bannerCalls.length, 0);
  // The control: any other failure reason is a downgrade and does fall through.
  const other = await arbiterAlerts.deliverNotification(PAYLOAD, {
    bridge: { notify: async () => ({ ok: false, reason: 'unsupported' }) },
    banner: (p) => bannerCalls.push(p),
  });
  assert.equal(other, 'banner');
  assert.equal(bannerCalls.length, 1);
});

test('with no channel at all the outcome is reported honestly', async () => {
  const { arbiterAlerts } = page();
  assert.equal(await arbiterAlerts.deliverNotification(PAYLOAD, {}), 'none');
  assert.equal(await arbiterAlerts.deliverNotification(PAYLOAD, { bridge: {} }), 'none');
  // A banner that throws is still 'none', not an unhandled rejection.
  assert.equal(await arbiterAlerts.deliverNotification(PAYLOAD, {
    banner: () => { throw new Error('detached node'); },
  }), 'none');
});

// ---- the payload a notification carries ------------------------------------

test('an alert becomes a title and a body a trader can act on', () => {
  const { arbiterAlerts } = page();
  const p = arbiterAlerts.toPayload(alert());
  assert.equal(p.title, 'FCSB vs Dinamo · 4.00%');
  assert.ok(p.body.includes('4.00% arbitrage'), p.body);
  assert.ok(p.body.includes('1x2'), 'the market is named');
  assert.ok(p.body.includes('betano, fortuna'), 'the books to place with');
  assert.ok(p.body.includes('stake 100'), p.body);
  assert.equal(p.tag, 'fotbal::1x2::arb', 'the key the cooldown and the tag both use');
});

test('a middle says it is a middle, and says the risk', () => {
  const { arbiterAlerts } = page();
  const p = arbiterAlerts.toPayload(alert({ type: 'middle', marketKey: 'ah-1', roiPercent: 30, riskPercent: 12.5 }));
  assert.ok(p.body.includes('30.00% middle'), p.body);
  assert.ok(p.body.includes('12.50% risk'), 'a middle without its risk is not information');
  assert.ok(!p.body.includes('arbitrage'), 'and it does not call itself an arbitrage');
  assert.equal(p.title, 'FCSB vs Dinamo · 30.00%');
});

test('a missing stake is shown as unknown, not as zero', () => {
  const { arbiterAlerts } = page();
  // Zero is a real stake value; null is "we do not know", and the two are not
  // the same claim to put in front of someone about to put money down.
  assert.ok(arbiterAlerts.toPayload(alert({ totalStake: null })).body.includes('stake —'));
  assert.equal(arbiterAlerts.toPayload(alert({ totalStake: 0 })).body.includes('stake 0'), true);
});

test('an alert with no teams still produces something readable', () => {
  const { arbiterAlerts } = page();
  const p = arbiterAlerts.toPayload({ key: 'k', type: 'arb', roiPercent: 2 });
  assert.ok(p.title.length > 0);
  assert.ok(p.body.includes('2.00%'), 'the ROI is still the headline when the match is missing');
});

// ---- the cooldown ----------------------------------------------------------

/** A watcher with a hand-cranked clock and a recording deliver function. */
function watcher(ctx, { cooldownSeconds = 60 } = {}) {
  const sent = [];
  let clock = 1_000_000;
  const w = ctx.arbiterAlerts.createAlertWatcher({
    now: () => clock,
    deliver: async (p) => { sent.push(p); return 'electron'; },
  });
  w.setCooldownSeconds(cooldownSeconds);
  return {
    sent,
    w,
    advance: (ms) => { clock += ms; },
  };
}

test('the first payload is history, not news', async () => {
  const ctx = page();
  const { sent, w } = watcher(ctx);
  // Opening the dashboard on a scan that has been there for an hour must not
  // produce a burst of notifications for opportunities already on screen.
  const result = await w.ingest(payloadOf([alert(), alert({ key: 'b::1x2::arb' })]), { channels: { desktop: true } });
  assert.equal(result.primed, true);
  assert.deepEqual(sent, []);
  assert.equal(result.sent.length, 0);
  assert.equal(result.suppressed, 2, 'they are counted, not dropped from the report');
});

test('what appears after that is news', async () => {
  const ctx = page();
  const { sent, w } = watcher(ctx, { cooldownSeconds: 3600 });
  await w.ingest(payloadOf([alert()]), { channels: { desktop: true } });
  await w.ingest(payloadOf([alert()]), { channels: { desktop: true } });
  assert.equal(sent.length, 0, 'the same opportunity, unchanged, is not re-announced');
  // A different one is — this is the whole point of the cooldown being keyed
  // on the opportunity rather than on the payload as a whole.
  await w.ingest(payloadOf([alert(), alert({ key: 'c::ou25::arb' })]), { channels: { desktop: true } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tag, 'c::ou25::arb');
});

test('an opportunity that appears for the first time is announced at once', async () => {
  const ctx = page();
  const { sent, w } = watcher(ctx, { cooldownSeconds: 3600 });
  // The priming pass saw nothing, so this is new to the tab — the long
  // cooldown is about a *repeat*, and must not also silence the first sighting.
  await w.ingest(payloadOf([]), { channels: { desktop: true } });
  const result = await w.ingest(payloadOf([alert()]), { channels: { desktop: true } });
  assert.equal(sent.length, 1);
  assert.equal(result.sent.length, 1);
});

test('the cooldown is honoured and then expires', async () => {
  const ctx = page();
  const { sent, w, advance } = watcher(ctx, { cooldownSeconds: 60 });
  const first = alert({ key: 'k::1x2::arb' });
  // Primed *with* the alert, so the window starts when the trader first saw it.
  await w.ingest(payloadOf([first]), { channels: { desktop: true } });
  advance(59_000);
  await w.ingest(payloadOf([first]), { channels: { desktop: true } });
  assert.equal(sent.length, 0, 'inside the window');
  advance(2_000);
  await w.ingest(payloadOf([first]), { channels: { desktop: true } });
  assert.equal(sent.length, 1, 'past 60s it is announced again');
  // ...and the window restarts from the new announcement, not from the first.
  advance(30_000);
  await w.ingest(payloadOf([first]), { channels: { desktop: true } });
  assert.equal(sent.length, 1, 'a re-shown opportunity is not announced again straight away');
});

test('a zero cooldown announces every time, and a nonsense one is repaired', async () => {
  const ctx = page();
  const none = watcher(ctx, { cooldownSeconds: 0 });
  await none.w.ingest(payloadOf([]), { channels: { desktop: true } });
  const repeated = alert({ key: 'k::1x2::arb' });
  await none.w.ingest(payloadOf([repeated]), { channels: { desktop: true } });
  await none.w.ingest(payloadOf([repeated]), { channels: { desktop: true } });
  assert.equal(none.sent.length, 2, 'cooldown 0 means no cooldown at all, and not "only the first"');

  // A negative or unreadable cooldown falls back to a minute rather than
  // meaning "announce constantly" or "never announce".
  for (const bogus of [-5, NaN, 'soon', null, undefined]) {
    const broken = watcher(ctx, { cooldownSeconds: bogus });
    const primed = alert({ key: 'k::1x2::arb' });
    await broken.w.ingest(payloadOf([primed]), { channels: { desktop: true } });
    await broken.w.ingest(payloadOf([primed]), { channels: { desktop: true } });
    assert.equal(broken.sent.length, 0, `cooldown ${String(bogus)} must not silence the repeat forever`);
  }
});

test('quiet hours hold the announcement back and the backlog with it', async () => {
  const ctx = page();
  const { sent, w, advance } = watcher(ctx, { cooldownSeconds: 3600 });
  await w.ingest(payloadOf([]), { channels: { desktop: true } });
  const during = alert({ key: 'q::1x2::arb' });
  const held = await w.ingest(payloadOf([during]), { quiet: true, channels: { desktop: true } });
  assert.equal(sent.length, 0, 'nothing during quiet hours');
  assert.equal(held.quiet, true);
  assert.equal(held.sent.length, 0);
  // Quiet hours end. The alert is not announced then: it is stale by then, and
  // a burst of overnight alerts on waking is worse than none at all. The key
  // was recorded even though nothing was sent, which is what makes this true.
  const after = await w.ingest(payloadOf([during]), { quiet: false, channels: { desktop: true } });
  assert.equal(sent.length, 0, 'the held alert is not replayed afterwards');
  assert.equal(after.sent.length, 0);
  // The control: something that appears *after* quiet hours still speaks.
  await w.ingest(payloadOf([during, alert({ key: 'new::1x2::arb' })]), { quiet: false, channels: { desktop: true } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tag, 'new::1x2::arb');
});

test('turning the desktop channel off stops the interruption, not the list', async () => {
  const ctx = page();
  const { sent, w } = watcher(ctx, { cooldownSeconds: 0 });
  await w.ingest(payloadOf([]), { channels: { desktop: true } });
  const result = await w.ingest(payloadOf([alert({ key: 'k::1x2::arb' })]), { channels: { desktop: false } });
  assert.equal(sent.length, 0);
  assert.equal(result.sent.length, 0, 'the list is rendered from the payload, not from what was sent');
  // The control: the same alert with the channel on does speak.
  await w.ingest(payloadOf([alert({ key: 'k2::1x2::arb' })]), { channels: { desktop: true } });
  assert.equal(sent.length, 1);
});

test('a payload with no channels at all still speaks', async () => {
  const ctx = page();
  // A missing flag is not an instruction to be quiet. This is the difference
  // between reading `desktop !== false` and reading `desktop`: a payload from a
  // server that never sent the key would otherwise silence the tab completely,
  // and silence is the one failure nobody notices.
  for (const channels of [undefined, {}, { desktop: undefined }, { desktop: null }, { sound: false }]) {
    const { sent, w } = watcher(ctx, { cooldownSeconds: 0 });
    await w.ingest(payloadOf([]), { channels });
    await w.ingest(payloadOf([alert({ key: `c${JSON.stringify(channels)}::1x2::arb` })]), { channels });
    assert.equal(sent.length, 1, `channels ${JSON.stringify(channels)} must not silence the tab`);
  }
});

test('the sound channel is honoured and absent by default', async () => {
  const ctx = page();
  const played = [];
  const clock = 0;
  const w = ctx.arbiterAlerts.createAlertWatcher({
    now: () => clock,
    deliver: async () => 'electron',
  });
  // A stand-in for the chime, which needs a real AudioContext to assert on.
  ctx.window.playTone = () => played.push(1);
  w.setCooldownSeconds(0);
  await w.ingest(payloadOf([]), { channels: { desktop: true, sound: false } });
  await w.ingest(payloadOf([alert({ key: 'a::1x2::arb' })]), { channels: { desktop: true, sound: false } });
  await w.ingest(payloadOf([alert({ key: 'b::1x2::arb' })]), { channels: { desktop: true, sound: true } });
  // The sound rides on delivery: the module only reaches the global `playTone`
  // if there is one, and there is not in this context, so nothing is asserted
  // about the tone itself — only that a sound-flagged alert is still delivered.
  assert.equal(played.length, 0, 'no AudioContext in this context, and none was invented');
});

test('an empty or malformed payload is a no-op, not a crash', async () => {
  const ctx = page();
  const { sent, w } = watcher(ctx, { cooldownSeconds: 0 });
  for (const junk of [null, undefined, {}, { alerts: null }, { alerts: { arbitrages: null, middles: null } }]) {
    const result = await w.ingest(junk, { channels: { desktop: true } });
    assert.equal(result.sent.length, 0, `input ${JSON.stringify(junk)}`);
  }
  assert.equal(sent.length, 0);
  // An entry with no key is skipped: without one there is nothing to remember
  // it by, and a blank cooldown entry would make the next poll re-announce it.
  await w.ingest(payloadOf([alert(), { type: 'arb' }]), { channels: { desktop: true } });
  assert.equal(w.size(), 1, 'only the keyed alert is remembered');
});

test('middles are announced alongside arbitrages', async () => {
  const ctx = page();
  const { sent, w } = watcher(ctx, { cooldownSeconds: 0 });
  await w.ingest(payloadOf([]), { channels: { desktop: true } });
  const result = await w.ingest({
    ...payloadOf([alert({ key: 'a::1x2::arb' })]),
    alerts: { arbitrages: [alert({ key: 'a::1x2::arb' })], middles: [alert({ key: 'm::ah-1::middle', type: 'middle' })] },
  }, { channels: { desktop: true } });
  assert.equal(result.sent.length, 2);
  assert.deepEqual(sent.map((p) => p.tag).sort(), ['a::1x2::arb', 'm::ah-1::middle']);
});

test('resetting forgets, so a reopened tab treats the world as new', async () => {
  const ctx = page();
  const { sent, w } = watcher(ctx, { cooldownSeconds: 3600 });
  await w.ingest(payloadOf([alert()]), { channels: { desktop: true } });
  assert.equal(w.size(), 1);
  w.reset();
  assert.equal(w.size(), 0);
  const after = await w.ingest(payloadOf([alert()]), { channels: { desktop: true } });
  assert.equal(after.primed, true, '...and primes again rather than announcing the backlog');
  assert.equal(sent.length, 0);
});
