// Unit tests for the pure decision functions in connection-status.js
// (decideStateTransition + decideHealthBanner). These are extracted top-level
// functions, so we brace-match them out of the source and evaluate them in a
// Node context — no DOM shim needed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(join(import.meta.dirname, '..', 'public/js/connection-status.js'), 'utf8');

// Extract a top-level `function NAME(...) { ... }` by brace matching.
function extractFn(name, from = src) {
  const re = new RegExp(`function\\s+${name}\\s*\\(`);
  const m = re.exec(from);
  if (!m) throw new Error('cannot find function ' + name);
  const idx = m.index;
  let depth = 0;
  let i = from.indexOf('{', idx);
  if (i === -1) throw new Error('no open brace for ' + name);
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return from.slice(idx, i + 1);
}

const fnSrc = `${extractFn('decideStateTransition')}
${extractFn('decideHealthBanner')}
return { decideStateTransition, decideHealthBanner };`;
const { decideStateTransition, decideHealthBanner } = new Function(fnSrc)();

const T0 = 1_000_000;

describe('decideStateTransition', () => {
  it('ignores identical states (no toast, no update)', () => {
    const r = decideStateTransition('open', 'open', T0, T0 - 10_000);
    assert.equal(r.act, false);
    assert.equal(r.toast, null);
  });

  it('fires "lost" toast on open → reconnecting', () => {
    const r = decideStateTransition('open', 'reconnecting', T0, T0 - 10_000);
    assert.equal(r.act, true);
    assert.equal(r.toast, 'lost');
  });

  it('fires "reconnected" toast on reconnecting → open', () => {
    const r = decideStateTransition('reconnecting', 'open', T0, T0 - 10_000);
    assert.equal(r.act, true);
    assert.equal(r.toast, 'reconnected');
  });

  it('produces no toast for unknown → open (first contact)', () => {
    const r = decideStateTransition('unknown', 'open', T0, 0);
    assert.equal(r.act, true);
    assert.equal(r.toast, null);
  });

  it('debounces a rapid flip within the 2s window', () => {
    const first = decideStateTransition('open', 'reconnecting', T0, T0 - 10_000);
    assert.equal(first.act, true);
    // Immediate re-flip back — should be dropped (prev is now reconnecting)
    const second = decideStateTransition('reconnecting', 'open', T0, T0);
    assert.equal(second.act, false);
    assert.equal(second.toast, null);
  });

  it('allows a transition after the 2s window has elapsed', () => {
    const late = decideStateTransition('reconnecting', 'open', T0 + 3000, T0 - 10_000);
    assert.equal(late.act, true);
    assert.equal(late.toast, 'reconnected');
  });

  it('never debounces the very first transition from unknown', () => {
    const r = decideStateTransition('unknown', 'reconnecting', T0, 0);
    assert.equal(r.act, true);
  });

  it('supports a closed-open cycle beyond the window', () => {
    const a = decideStateTransition('open', 'reconnecting', T0, T0 - 10_000);
    assert.equal(a.toast, 'lost');
    const b = decideStateTransition('reconnecting', 'open', T0 + 3000, T0);
    assert.equal(b.toast, 'reconnected');
  });
});

describe('decideHealthBanner', () => {
  it('hides the banner for fresh data', () => {
    const r = decideHealthBanner({ status: 'fresh', actionableSourceCount: 3 });
    assert.equal(r.visible, false);
    assert.equal(r.className, '');
  });

  it('hides the banner when status is unknown', () => {
    const r = decideHealthBanner({ status: 'unknown' });
    assert.equal(r.visible, false);
  });

  it('hides the banner when health is undefined', () => {
    const r = decideHealthBanner(undefined);
    assert.equal(r.visible, false);
  });

  it('shows a warning banner for stale data with actionable counts', () => {
    const r = decideHealthBanner({ status: 'stale', actionableSourceCount: 2 });
    assert.equal(r.visible, true);
    assert.match(r.className, /\bvisible\b/);
    assert.ok(!r.className.includes(' info'), 'stale should NOT be info variant');
    assert.equal(r.message, 'stale (2 freshSources)');
    assert.equal(r.link, true);
  });

  it('shows an info banner for empty data with no suffix', () => {
    const r = decideHealthBanner({ status: 'empty', actionableSourceCount: 0 });
    assert.equal(r.visible, true);
    assert.ok(r.className.includes(' info'), 'empty should be info variant');
    assert.equal(r.message, 'noFreshData');
    assert.equal(r.link, true);
  });

  it('shows a warning banner for partial data (not info)', () => {
    const r = decideHealthBanner({ status: 'partial', actionableSourceCount: 5 });
    assert.equal(r.visible, true);
    assert.ok(!r.className.includes(' info'), 'partial should NOT be info variant');
    assert.equal(r.message, 'partial (5 freshSources)');
  });

  it('defaults missing health to hidden', () => {
    const r = decideHealthBanner(null);
    assert.equal(r.visible, false);
  });
});