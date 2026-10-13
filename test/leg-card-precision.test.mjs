// renderLeg must print the stake and the net it was actually given.
//
// The card shows a stake, an odds and a net profit in one block, so all three
// are on screen together and the reader can test stake x (odds - 1) = net. At
// whole units that test failed on the real payload: 1,889 of 2,003 legs with a
// payout printed a stake that was not the real one, and 6 legs missed the net
// by up to 3.31 RON. The worst case printed "Miză 688 @ 1.45 / +313" for a leg
// staked 688.32 paying 312.91 -- 688 x 0.45 is 309.60.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFn } from './helpers/extract-fn.mjs';
import { patternsSrc, fnSrc as predicateSrc } from './helpers/event-url-gate.mjs';

const modalSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/pages/event-detail-modal.js'), 'utf8');
const fmtSrc = readFileSync(join(import.meta.dirname, '..', 'public/js/format.js'), 'utf8');

const gl = globalThis;
gl.BOOK_PALETTE = [{ color: '#fff', bg: '#333', border: '#555' }];
gl.paletteFor = () => gl.BOOK_PALETTE[0];
gl.fmtOdds = eval(`(${extractFn('fmtOdds', fmtSrc)})`);
gl.fmtStake = eval(`(${extractFn('fmtStake', fmtSrc)})`);
gl.fmtMoney = eval(`(${extractFn('fmtMoney', fmtSrc)})`);
gl.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const build = (withMoney) => eval(`(function() {
  ${patternsSrc}
  ${predicateSrc}
  const helpers = {
    paletteFor: (id) => globalThis.paletteFor(id),
    fmtStake: (n) => globalThis.fmtStake(n),
    ${withMoney ? 'fmtMoney: (n) => globalThis.fmtMoney(n),' : ''}
    fmtOdds: (n) => globalThis.fmtOdds(n),
    escapeHtml: (s) => globalThis.escapeHtml(s),
  };
  return (${extractFn('renderLeg', modalSrc)});
})()`);

const renderLeg = build(true);
const renderLegNoMoney = build(false);
const t = (k) => (k === 'stake' ? 'Miză' : k);

const assert = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ': ' + m); if (!c) process.exitCode = 1; };

// The leg the probe found worst: real stake 688.32, payout 1001.23, net 312.91.
const leg = { sourceId: 'baumbet', selection: 'Over', odds: 1.45, stake: 688.32, payout: 1001.23 };
const html = renderLeg(leg, t, 0);

assert(html.includes(`Miză ${gl.fmtMoney(688.32)}`), `stake printed exactly (${gl.fmtMoney(688.32)})`);
assert(!html.includes(`Miză ${gl.fmtStake(688.32)} `), 'stake not rounded to whole units');
assert(html.includes(`+${gl.fmtMoney(312.91)}`), `net printed exactly (+${gl.fmtMoney(312.91)})`);

const stakeShown = Number((html.match(/Miză ([\d,]+\.\d{2})/) || [])[1]?.replace(/,/g, ''));
const netShown = Number((html.match(/\+([\d,]+\.\d{2}) RON/) || [])[1]?.replace(/,/g, ''));
assert(stakeShown === 688.32, `stake readable back off the card (${stakeShown})`);
assert(netShown === 312.91, `net readable back off the card (${netShown})`);

// Every leg of the real published payload must print its own stake.
const scan = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data/latest-scan.json'), 'utf8'));
const legs = [];
for (const group of ['opportunities', 'middles']) {
  for (const row of scan[group] || []) for (const l of row.legs || []) if (Number.isFinite(l.payout) && l.payout > 0) legs.push(l);
}
let wrong = 0, wrongNet = 0;
for (const l of legs) {
  const h = renderLeg({ ...l, eventUrl: null }, t, 0);
  if (!h.includes(`Miză ${gl.fmtMoney(l.stake)}`)) wrong++;
  const net = Math.round((l.payout - Number(l.stake) + Number.EPSILON) * 100) / 100;
  if (!h.includes(`+${gl.fmtMoney(net)}`)) wrongNet++;
}
assert(wrong === 0, `all ${legs.length} published legs print their real stake (${wrong} wrong)`);
assert(wrongNet === 0, `all ${legs.length} published legs print their real net (${wrongNet} wrong)`);

// A leg with no payout still renders, and still keeps cents on the stake.
const noPayout = renderLeg({ sourceId: 'favbet', selection: 'Yes', odds: 2.84, stake: 352.11 }, t, 0);
assert(noPayout.includes(`Miză ${gl.fmtMoney(352.11)}`), 'payoutless leg still prints the stake exactly');
assert(noPayout.includes(gl.fmtOdds(2.84)), 'payoutless leg shows odds instead of profit');

// The fmtMoney guard must still hold for harnesses that do not provide it.
const legacy = renderLegNoMoney({ sourceId: 'favbet', selection: 'Yes', odds: 2.84, stake: 352.11 }, t, 0);
assert(legacy.includes(`Miză ${gl.fmtStake(352.11)}`), 'without fmtMoney it degrades to whole units rather than throwing');
assert(!legacy.includes('undefined'), 'without fmtMoney it does not print undefined');

console.log('\nAll checks complete.');