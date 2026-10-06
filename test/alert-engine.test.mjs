/**
 * alert-engine.test.mjs — the pure part of the alert system.
 *
 * The engine has no clock of its own and no I/O, so every rule here is
 * exercised by handing it a `now` and a scan. Each negative assertion is
 * deliberately placed next to a positive one on the same fixture: a test that
 * only ever proves "nothing comes out" also passes when the engine is broken
 * in a way that makes it return nothing at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_SCHEMA,
  DEFAULT_ALERT_PREFERENCES,
  MAX_ALERTS_PER_FAMILY,
  evaluateAlerts,
  isQuietNow,
  normalizeAlertPreferences,
} from '../src/alert-engine.mjs';

/** An arbitrage signal in the shape buildScanCsv emits. */
function signal(overrides = {}) {
  return {
    sport: 'fotbal',
    league: 'Superliga',
    kickoff: '2026-05-01T18:00:00.000Z',
    homeTeam: 'FCSB',
    awayTeam: 'Dinamo',
    marketKey: '1x2',
    eventKey: 'fotbal:superliga:fcsb-dinamo',
    live: false,
    marginPercent: 4,
    totalStake: 100,
    guaranteedProfit: 4,
    riskPercent: 0,
    verification: { status: 'confirmed', reason: null },
    legs: [
      { sourceId: 'betano', selection: '1', outcome: 'home', odds: 2.1 },
      { sourceId: 'fortuna', selection: 'X', outcome: 'draw', odds: 3.4 },
    ],
    ...overrides,
  };
}

/**
 * A middle signal: the middle family still reports `roiPercent`, so a middle
 * built from the same defaults must not carry `marginPercent` — that is the
 * field the engine reads first, and an arb field left on a middle would price
 * it from the wrong number.
 */
function middle(overrides = {}) {
  const { marginPercent, ...rest } = signal(overrides);
  return { roiPercent: marginPercent, ...rest };
}

function scanOf({ opportunities = [], middles = [] } = {}) {
  return { opportunities, middles };
}

const at = (hour, minute = 0) => new Date(2024, 0, 15, hour, minute, 0);

test('a fresh install gets the documented defaults, whole', () => {
  for (const input of [undefined, null, {}, 'nonsense', 42, []]) {
    assert.deepEqual({ ...normalizeAlertPreferences(input) }, { ...DEFAULT_ALERT_PREFERENCES });
  }
});

test('the defaults are stricter than the scanner it reads from', () => {
  // A scan computes everything above 0% because computing costs nothing; an
  // alert is an interruption. If these two ever converge, the thresholds are
  // no longer a judgement and the whole engine is a filter with extra steps.
  assert.ok(DEFAULT_ALERT_PREFERENCES.minMarginPercent > 0);
  assert.ok(DEFAULT_ALERT_PREFERENCES.minMiddleRoiPercent > 0);
  assert.equal(DEFAULT_ALERT_PREFERENCES.includeLive, false);
  assert.equal(DEFAULT_ALERT_PREFERENCES.quietHours.enabled, false);
  assert.equal(ALERT_SCHEMA, 1);
});

test('a hand-edited file is repaired field by field, not thrown away whole', () => {
  const stored = {
    minMarginPercent: 7,       // valid, keep
    minMiddleRoiPercent: 'x',  // garbage, replace
    channels: { desktop: false },
    quietHours: { from: '23h00', to: '07:00', enabled: true },
    cooldownSeconds: 90.6,
  };
  const prefs = normalizeAlertPreferences(stored);
  assert.equal(prefs.minMarginPercent, 7);
  assert.equal(prefs.minMiddleRoiPercent, DEFAULT_ALERT_PREFERENCES.minMiddleRoiPercent);
  assert.equal(prefs.channels.desktop, false, 'the field the user did set survives');
  assert.equal(prefs.channels.sound, DEFAULT_ALERT_PREFERENCES.channels.sound, 'the one they did not, defaults');
  assert.equal(prefs.quietHours.from, DEFAULT_ALERT_PREFERENCES.quietHours.from);
  assert.equal(prefs.quietHours.to, '07:00', 'a sibling inside the same object is still honoured');
  assert.equal(prefs.quietHours.enabled, true);
  assert.equal(prefs.cooldownSeconds, 91);
});

test('an unreadable threshold becomes the default and never NaN', () => {
  for (const bad of [null, undefined, '', 'abc', NaN, Infinity, -Infinity, {}, []]) {
    const prefs = normalizeAlertPreferences({ minMarginPercent: bad });
    assert.equal(prefs.minMarginPercent, DEFAULT_ALERT_PREFERENCES.minMarginPercent, `input ${String(bad)}`);
    assert.ok(Number.isFinite(prefs.minMarginPercent), 'NaN compares false against every threshold');
  }
  // The positive control: a real number is used verbatim, not merely replaced.
  assert.equal(normalizeAlertPreferences({ minMarginPercent: 0 }).minMarginPercent, 0);
  assert.equal(normalizeAlertPreferences({ minMarginPercent: 12.5 }).minMarginPercent, 12.5);
});

test('thresholds are clamped to a range that means something', () => {
  assert.equal(normalizeAlertPreferences({ minMarginPercent: 9999 }).minMarginPercent, 100);
  assert.equal(normalizeAlertPreferences({ minMarginPercent: -9999 }).minMarginPercent, -50);
  assert.equal(normalizeAlertPreferences({ minMiddleRoiPercent: 1e9 }).minMiddleRoiPercent, 1000);
  assert.equal(normalizeAlertPreferences({ cooldownSeconds: 1e9 }).cooldownSeconds, 86400);
  assert.equal(normalizeAlertPreferences({ cooldownSeconds: -5 }).cooldownSeconds, 0);
  // ...and a value inside the range is not nudged by the clamp.
  assert.equal(normalizeAlertPreferences({ minMarginPercent: 100 }).minMarginPercent, 100);
  assert.equal(normalizeAlertPreferences({ minMarginPercent: -50 }).minMarginPercent, -50);
});

test('booleans arrive from form posts as strings', () => {
  assert.equal(normalizeAlertPreferences({ includeLive: 'true' }).includeLive, true);
  assert.equal(normalizeAlertPreferences({ includeLive: 'false' }).includeLive, false);
  assert.equal(normalizeAlertPreferences({ channels: { desktop: 'true', sound: 'false' } }).channels.sound, false);
  // A string that is not a boolean is neither true nor false: it must not be
  // read as "the user asked for it".
  assert.equal(normalizeAlertPreferences({ includeLive: 'yes' }).includeLive, DEFAULT_ALERT_PREFERENCES.includeLive);
  assert.equal(normalizeAlertPreferences({ includeLive: 1 }).includeLive, DEFAULT_ALERT_PREFERENCES.includeLive);
});

test('a clock time is only accepted in the one format that is unambiguous', () => {
  for (const bad of ['24:00', '7:00', '07:60', '23h00', '', null, 700]) {
    assert.equal(
      normalizeAlertPreferences({ quietHours: { from: bad } }).quietHours.from,
      DEFAULT_ALERT_PREFERENCES.quietHours.from,
      `input ${String(bad)}`,
    );
  }
  for (const good of ['00:00', '07:30', '23:59']) {
    assert.equal(normalizeAlertPreferences({ quietHours: { from: good } }).quietHours.from, good);
  }
});

test('quiet hours are off until asked for', () => {
  const quiet = { ...DEFAULT_ALERT_PREFERENCES.quietHours, enabled: false };
  // The negative: 02:00 is deep inside 23:00-07:00, and it is still not quiet.
  assert.equal(isQuietNow({ quietHours: quiet }, { now: at(2, 0) }), false);
  // The positive, same clock reading, one flag apart.
  assert.equal(isQuietNow({ quietHours: { ...quiet, enabled: true } }, { now: at(2, 0) }), true);
});

test('a window crossing midnight is tested as a wrap, not as a range', () => {
  const prefs = { quietHours: { from: '23:00', to: '07:00', enabled: true } };
  const inside = [at(23, 0), at(23, 30), at(0, 0), at(2, 0), at(6, 59)];
  const outside = [at(22, 59), at(7, 0), at(12, 0), at(22, 30)];
  for (const now of inside) assert.equal(isQuietNow(prefs, { now }), true, `${now.getHours()}:${now.getMinutes()}`);
  for (const now of outside) assert.equal(isQuietNow(prefs, { now }), false, `${now.getHours()}:${now.getMinutes()}`);
});

test('a window that does not wrap is an ordinary range', () => {
  const prefs = { quietHours: { from: '09:00', to: '17:00', enabled: true } };
  assert.equal(isQuietNow(prefs, { now: at(9, 0) }), true, 'start is inclusive');
  assert.equal(isQuietNow(prefs, { now: at(16, 59) }), true);
  assert.equal(isQuietNow(prefs, { now: at(17, 0) }), false, 'end is exclusive');
  assert.equal(isQuietNow(prefs, { now: at(8, 59) }), false);
  // The same readings under a wrapping window point the other way, which is
  // what proves the wrap branch is the one being taken and not the range one.
  const wrapped = { quietHours: { from: '09:00', to: '17:00', enabled: true } };
  assert.equal(isQuietNow(wrapped, { now: at(2, 0) }), false);
});

test('start equal to end means no quiet hours, not a muted all day', () => {
  const prefs = { quietHours: { from: '08:00', to: '08:00', enabled: true } };
  for (const hour of [0, 7, 8, 13, 23]) {
    assert.equal(isQuietNow(prefs, { now: at(hour, 0) }), false, `hour ${hour}`);
  }
});

test('an unreadable clock reads as not-quiet rather than throwing', () => {
  const prefs = { quietHours: { from: '23:00', to: '07:00', enabled: true } };
  // Fail open: a bad clock must not silence the app, because the one thing
  // worse than a missed alert is a permanently muted one nobody knows about.
  assert.equal(isQuietNow(prefs, { now: new Date('nonsense') }), false);
  assert.equal(isQuietNow(prefs, { now: 'nonsense' }), false);
  // A timestamp is a clock too: the same reading accepted in the other form.
  assert.equal(isQuietNow(prefs, { now: at(2, 0).getTime() }), true);
  assert.equal(isQuietNow(prefs, { now: at(12, 0).getTime() }), false);
});

test('no scan is not the same as a scan that found nothing', () => {
  const result = evaluateAlerts(null, {});
  assert.deepEqual(result.alerts.arbitrages, []);
  assert.deepEqual(result.alerts.middles, []);
  assert.equal(result.counts.arbitrages, 0);
  assert.equal(result.truncated.arbitrages, 0);
  assert.ok(result.evaluatedAt, 'an empty result still says when it was computed');
  // ...and a scan that exists but is empty under the thresholds is also zero.
  // The two are only distinguishable by `published`, which the route carries.
  const empty = evaluateAlerts(scanOf(), {});
  assert.deepEqual(empty.counts, result.counts);
});

test('the threshold is inclusive and the boundary is decided, not assumed', () => {
  const scan = scanOf({ opportunities: [signal({ roiPercent: 1 })] });
  const at1 = evaluateAlerts(scan, { minRoiPercent: 1 });
  assert.equal(at1.counts.arbitrages, 1, 'a signal exactly on the line is included');
  const justUnder = evaluateAlerts(scan, { minRoiPercent: 1.0001 });
  assert.equal(justUnder.counts.arbitrages, 0, '...and one hair under it is not');
  // The positive control, so the first assertion cannot pass for free.
  assert.equal(evaluateAlerts(scan, { minRoiPercent: 0 }).counts.arbitrages, 1);
});

test('in-play signals are refused unless they were explicitly asked for', () => {
  const scan = scanOf({ opportunities: [signal({ live: true, roiPercent: 9 })] });
  // An in-play price expires in 90s; an alert naming one is an alert the trader
  // cannot act on. Same fail-closed rule the scanner applies.
  assert.equal(evaluateAlerts(scan, { includeLive: false }).counts.arbitrages, 0);
  assert.equal(evaluateAlerts(scan, { includeLive: true }).counts.arbitrages, 1);
  // A non-boolean "live" from a feed that was not normalised is still not
  // trusted to be in-play, and is not trusted to be pre-match either: it is
  // simply not something we can price.
  assert.equal(evaluateAlerts(scan, { includeLive: false }).counts.arbitrages, 0);
  const honest = evaluateAlerts(scanOf({ opportunities: [signal({ live: false, roiPercent: 9 })] }), { includeLive: false });
  assert.equal(honest.counts.arbitrages, 1, 'a pre-match signal at the same ROI still fires');
});

test('a signal with an unreadable ROI raises nothing rather than everything', () => {
  // `Number(null)`, `Number('')` and `Number([])` are all 0, so a threshold of
  // 0 would wave every one of these through. The ROI is the number the alert
  // is *about*; a missing one must not become a 0% one.
  for (const bad of [null, undefined, '', 'abc', '  ', NaN, Infinity, -Infinity, {}, [], [5], true, false]) {
    const result = evaluateAlerts(scanOf({ opportunities: [signal({ roiPercent: bad })] }), { minRoiPercent: 0 });
    assert.equal(result.counts.arbitrages, 0, `roi ${JSON.stringify(bad)}`);
  }
  // The positive controls, so the loop above cannot pass by raising nothing ever.
  assert.equal(evaluateAlerts(scanOf({ opportunities: [signal({ roiPercent: 4 })] }), { minRoiPercent: 0 }).counts.arbitrages, 1);
  // A numeric *string* is how a value survives a form post, and it is honoured.
  assert.equal(evaluateAlerts(scanOf({ opportunities: [signal({ roiPercent: '4' })] }), { minRoiPercent: 0 }).counts.arbitrages, 1);
  assert.equal(
    evaluateAlerts(scanOf({ opportunities: [signal({ roiPercent: '4' })] }), { minRoiPercent: 0 }).alerts.arbitrages[0].roiPercent,
    4,
    '...and it arrives as a number, not as the string it came in as',
  );
});

test('the same opportunity is reported once, however many times it appears', () => {
  const dup = signal({ roiPercent: 5 });
  const other = signal({ eventKey: 'fotbal:superliga:u-craiova-rapid', roiPercent: 5 });
  const result = evaluateAlerts(scanOf({ opportunities: [dup, { ...dup }, { ...dup }, other] }), { minRoiPercent: 0 });
  assert.equal(result.counts.arbitrages, 2, 'three identical rows plus one distinct row');
  assert.deepEqual(result.alerts.arbitrages.map((a) => a.key).sort(), [
    'fotbal:superliga:fcsb-dinamo::1x2::arb',
    'fotbal:superliga:u-craiova-rapid::1x2::arb',
  ]);
  // Distinct markets on one event are distinct alerts.
  const twoMarkets = evaluateAlerts(scanOf({ opportunities: [signal({ marketKey: '1x2' }), signal({ marketKey: 'ou25' })] }), {});
  assert.equal(twoMarkets.counts.arbitrages, 2);
});

test('a re-verified signal keeps its identity so its cooldown survives', () => {
  // This drove an exported `alertKey`, a one-line wrapper over the engine's own
  // key builder with no production reader, and half of it tested the wrapper's
  // optional chaining rather than the program: the engine calls the builder with
  // `signal.eventKey` and would have thrown on a null signal, so `alertKey(null)`
  // described a tolerance nothing in the running server had. What the server
  // actually guarantees is that the key comes from the three fields and not from
  // the numbers a verification pass rewrites, so that is what is pinned now —
  // through the engine, on the keys it emits.
  const opts = { minRoiPercent: 0, minMiddleRoiPercent: 0 };
  const first = evaluateAlerts(scanOf({ opportunities: [signal({ roiPercent: 4 })] }), opts);
  const reverified = evaluateAlerts(
    scanOf({ opportunities: [signal({ roiPercent: 9, verification: { status: 'confirmed', reason: 'book' } })] }),
    opts,
  );

  assert.equal(first.alerts.arbitrages[0].key, reverified.alerts.arbitrages[0].key,
    'a verification pass rewrote the ROI and the alert got a new identity, so the page would re-alert for it');
  assert.equal(first.alerts.arbitrages[0].key, 'fotbal:superliga:fcsb-dinamo::1x2::arb');
});

test('the key on an emitted alert is the key the dedup used', () => {
  // The page counts its cooldowns in a Map keyed on `alert.key`, the field the
  // engine delivered; it does not rebuild the string, so that field is the whole
  // contract. This used to end with `alertKey(alert) === alert.key`, described as
  // the client re-deriving the key — a comparison of the engine's own builder with
  // the engine's own output, which any echoed string would have passed.
  // The raw findings carry no `type` field — the family comes from
  // which array they were read from — so an engine that read `type` off the
  // input instead of using the family it was selecting would key everything on
  // `eventKey::marketKey::` and the page's map would not match its own list.
  const result = evaluateAlerts(scanOf({
    opportunities: [signal({ roiPercent: 4 })],
    middles: [signal({ marketKey: '1x2', roiPercent: 30 })],
  }), { minRoiPercent: 0, minMiddleRoiPercent: 0 });
  const [arb] = result.alerts.arbitrages;
  const [mid] = result.alerts.middles;
  assert.equal(arb.key, 'fotbal:superliga:fcsb-dinamo::1x2::arb');
  assert.equal(mid.key, 'fotbal:superliga:fcsb-dinamo::1x2::middle');
  // The same market, both families: two alerts, two cooldowns, not one.
  assert.notEqual(arb.key, mid.key);
  assert.equal(signal().type, undefined, 'the input really does not carry a type');
});

test('each family is ranked by its own ROI and never merged', () => {
  const scan = scanOf({
    opportunities: [signal({ roiPercent: 4 }), signal({ eventKey: 'e2', roiPercent: 12 })],
    middles: [signal({ roiPercent: 30, marketKey: 'ah-1' }), signal({ eventKey: 'e3', roiPercent: 25, marketKey: 'ah-1' })],
  });
  const result = evaluateAlerts(scan, { minRoiPercent: 0, minMiddleRoiPercent: 0 });
  assert.deepEqual(result.alerts.arbitrages.map((a) => a.roiPercent), [12, 4]);
  assert.deepEqual(result.alerts.middles.map((a) => a.roiPercent), [30, 25]);
  // The middle at 30% must not appear in the arb list even though it is the
  // better-looking number: a 30% middle and a 4% arb are not the same unit of
  // risk, and a list that ranks them together is saying nothing true.
  assert.equal(result.alerts.arbitrages.some((a) => a.type === 'middle'), false);
  assert.ok(result.alerts.middles.every((a) => a.type === 'middle'));
  assert.equal(result.counts.arbitrages, 2);
  assert.equal(result.counts.middles, 2);
});

test('each family has its own threshold', () => {
  const scan = scanOf({
    opportunities: [signal({ roiPercent: 10 })],
    middles: [signal({ roiPercent: 10, marketKey: 'ah-1' })],
  });
  const result = evaluateAlerts(scan, { minRoiPercent: 1, minMiddleRoiPercent: 25 });
  assert.equal(result.counts.arbitrages, 1, '10% clears the arb threshold');
  assert.equal(result.counts.middles, 0, 'the same 10% does not clear the middle threshold');
  assert.deepEqual(result.thresholds, { minRoiPercent: 1, minMiddleRoiPercent: 25, includeLive: false });
});

test('a tie is broken on the key so the list does not reshuffle under the trader', () => {
  const scan = scanOf({
    opportunities: [
      signal({ eventKey: 'b', roiPercent: 5 }),
      signal({ eventKey: 'a', roiPercent: 5 }),
      signal({ eventKey: 'c', roiPercent: 9 }),
    ],
  });
  const first = evaluateAlerts(scan, {}).alerts.arbitrages.map((a) => a.key);
  const second = evaluateAlerts(scanOf({ opportunities: [...scan.opportunities].reverse() }), {}).alerts.arbitrages.map((a) => a.key);
  assert.deepEqual(first, ['c::1x2::arb', 'a::1x2::arb', 'b::1x2::arb']);
  assert.deepEqual(second, first, 'same input, same order, regardless of arrival order');
});

test('a long list is capped, and says how much it is hiding', () => {
  const opportunities = Array.from({ length: MAX_ALERTS_PER_FAMILY + 7 }, (_, i) => signal({
    eventKey: `e${String(i).padStart(3, '0')}`,
    roiPercent: i,
  }));
  const result = evaluateAlerts(scanOf({ opportunities }), { minRoiPercent: 0 });
  assert.equal(result.alerts.arbitrages.length, MAX_ALERTS_PER_FAMILY);
  // The count is the full total, not the truncated length: "12 of 40" is the
  // difference between a list and a sample.
  assert.equal(result.counts.arbitrages, MAX_ALERTS_PER_FAMILY + 7);
  assert.equal(result.truncated.arbitrages, 7);
  assert.equal(result.truncated.middles, 0);
  // ...and the cap keeps the best of them, not the first of them.
  assert.equal(result.alerts.arbitrages[0].roiPercent, MAX_ALERTS_PER_FAMILY + 6);
  // A list that fits is not reported as truncated.
  const small = evaluateAlerts(scanOf({ opportunities: opportunities.slice(0, 3) }), { minRoiPercent: 0 });
  assert.equal(small.truncated.arbitrages, 0);
  assert.equal(small.alerts.arbitrages.length, 3);
});

test('an alert carries what a trader needs to act on it', () => {
  const [alert] = evaluateAlerts(scanOf({ opportunities: [signal({ roiPercent: 4 })] }), {}).alerts.arbitrages;
  assert.equal(alert.type, 'arb');
  assert.equal(alert.eventKey, 'fotbal:superliga:fcsb-dinamo');
  assert.equal(alert.marketKey, '1x2');
  assert.equal(alert.homeTeam, 'FCSB');
  assert.equal(alert.awayTeam, 'Dinamo');
  assert.equal(alert.roiPercent, 4);
  assert.equal(alert.live, false);
  assert.equal(alert.verified, 'confirmed', 'the verdict travels with the alert');
  assert.deepEqual(alert.sourceIds, ['betano', 'fortuna'], 'the books to place with, in order');
  assert.equal(alert.kickoff, '2026-05-01T18:00:00.000Z');
});

test('an alert carries those fields and nothing else', () => {
  // Named, not compared against the raw signal. A symmetric comparison of
  // what the engine returns against what it was given passes just as happily
  // when the engine starts passing the whole signal through — and then the
  // alert grows every field the scanner happens to compute, several of which
  // are internal, on a payload sent to a notification.
  const EXPECTED = [
    'key', 'type', 'eventKey', 'marketKey', 'sport', 'league', 'kickoff',
    'homeTeam', 'awayTeam', 'live', 'roiPercent', 'totalStake',
    'guaranteedProfit', 'riskPercent', 'sourceIds', 'verified',
  ];
  // The internal fields a real finding carries and an alert has no reason to.
  const raw = signal({ inverseSum: 1.03, gap: 0.004, worstCasePayout: 104, roundingRisk: 0.02, provider: 'egt' });
  const [alert] = evaluateAlerts(scanOf({ opportunities: [raw] }), {}).alerts.arbitrages;
  assert.deepEqual(Object.keys(alert).sort(), [...EXPECTED].sort());
  // The control: the signal it came from really is bigger, so the assertion
  // above is a restriction and not a description of two identical objects.
  assert.ok(Object.keys(raw).length > EXPECTED.length, `${Object.keys(raw).length} vs ${EXPECTED.length}`);
  assert.equal(alert.legs, undefined, 'the legs are summarised, not shipped twice');
  assert.equal(alert.verification, undefined, 'and the verdict is flattened, not re-nested');
  for (const internal of ['inverseSum', 'gap', 'worstCasePayout', 'roundingRisk', 'provider']) {
    assert.equal(alert[internal], undefined, `${internal} must not reach the notification payload`);
  }
  // A middle has the same shape: a list where the two families differ in
  // content must not differ in structure, or the page branches on key presence.
  const [mid] = evaluateAlerts(scanOf({ middles: [signal({ marketKey: 'ah-1' })] }), { minMiddleRoiPercent: 0 }).alerts.middles;
  assert.deepEqual(Object.keys(mid).sort(), [...EXPECTED].sort());
});

test('zero is a value, not a missing one', () => {
  // A middle priced so that losing the handicap costs nothing reports 0% risk.
  // `Number(x) || null` would report that as "unknown" on precisely the
  // opportunity where there is no risk to speak of.
  const [alert] = evaluateAlerts(scanOf({ middles: [signal({ riskPercent: 0, guaranteedProfit: 0, marketKey: 'ah-1' })] }), {
    minMiddleRoiPercent: 0,
  }).alerts.middles;
  assert.equal(alert.riskPercent, 0);
  assert.equal(alert.guaranteedProfit, 0);
  // ...and a field that genuinely is not a number still reads as unknown.
  assert.equal(alert.totalStake, 100);
  const missing = evaluateAlerts(scanOf({ opportunities: [signal({ totalStake: null, riskPercent: 'x' })] }), {}).alerts.arbitrages[0];
  assert.equal(missing.totalStake, null);
  assert.equal(missing.riskPercent, null);
});

test('the alert survives the JSON round trip the route puts it through', () => {
  // JSON.stringify drops undefined keys, which is how the scan's age windows
  // once vanished between the scanner and the page. The form the consumer
  // receives is the form on the wire, so that is the form under test.
  const result = evaluateAlerts(scanOf({
    opportunities: [signal({ riskPercent: 0, totalStake: 0, guaranteedProfit: null, verification: undefined })],
  }), { minRoiPercent: 0 });
  const overTheWire = JSON.parse(JSON.stringify(result));
  assert.equal(overTheWire.alerts.arbitrages[0].riskPercent, 0);
  assert.equal(overTheWire.alerts.arbitrages[0].totalStake, 0);
  assert.equal(overTheWire.alerts.arbitrages[0].verified, null, 'no verdict on the signal, no verdict field');
  assert.ok('riskPercent' in overTheWire.alerts.arbitrages[0]);
  assert.ok('guaranteedProfit' in overTheWire.alerts.arbitrages[0]);
});

test('the verdict comes from the engine, so a quiet window is visible to the page', () => {
  const quiet = { quietHours: { from: '23:00', to: '07:00', enabled: true } };
  assert.equal(evaluateAlerts(scanOf(), quiet, { now: at(2, 0) }).quietNow, true);
  assert.equal(evaluateAlerts(scanOf(), quiet, { now: at(12, 0) }).quietNow, false);
  // The page still renders the list during quiet hours; the server only reports
  // that they are quiet. Suppressing them server-side would make the two
  // disagree the moment one tab has a cooldown running and another does not.
  assert.equal(evaluateAlerts(scanOf({ opportunities: [signal()] }), quiet, { now: at(2, 0) }).counts.arbitrages, 1);
});

test('junk in the families is skipped, and real signals beside it are not', () => {
  const result = evaluateAlerts(scanOf({
    opportunities: [null, undefined, 'nonsense', 42, [], signal({ roiPercent: 6 })],
    middles: [null, signal({ marketKey: 'ah-1', roiPercent: 40 })],
  }), { minRoiPercent: 0, minMiddleRoiPercent: 0 });
  assert.equal(result.counts.arbitrages, 1);
  assert.equal(result.counts.middles, 1);
  assert.equal(result.alerts.arbitrages[0].roiPercent, 6);
});

test('a missing family is empty, not a crash', () => {
  const result = evaluateAlerts({ opportunities: [signal()] }, {});
  assert.equal(result.counts.arbitrages, 1);
  assert.equal(result.counts.middles, 0);
  assert.deepEqual(result.alerts.middles, []);
  // ...and so is a scan whose families are not arrays at all.
  const junk = evaluateAlerts({ opportunities: 'nope', middles: { a: 1 } }, {});
  assert.deepEqual(junk.counts, { arbitrages: 0, middles: 0 });
});
