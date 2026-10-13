import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

/**
 * What a bookmaker chip's dot actually paints, per job status.
 *
 * `statusDotClass` (scrape.js:165) is the only place on this page that turns a
 * backend job status into a dot, and until this test existed nothing checked
 * that the class it writes reached the screen. It did not: two rules in
 * scrape.css scoped to `.sl-sources .chip` decided the dot's `background` on
 * their own, at a specificity above `.dot.live` / `.dot.busy` / `.dot.error`
 * in theme.css. Measured in chromium against the shipped stylesheets, a
 * validated book whose job had failed, timed out or resolved to no scraper
 * painted the same green as one that worked, and `error` â€” which carries no
 * animation either â€” was pixel-identical to "no job at all". `running` was
 * legible only as a pulse.
 *
 * A cascade is not checkable by reading selectors, so this reads
 * `getComputedStyle`. Three conditions have to hold for any number below to
 * mean anything, and each is asserted rather than assumed:
 *
 *   - the forced class held on the element, because the page polls
 *     /api/scrape/state and rewrites these dots from it between two round-trips
 *   - transitions were switched off for the read, because a computed style
 *     taken while one is running reports the *starting* colour, not the
 *     resolved one â€” that alone made `dot error` read as `--text-dim`
 *   - both chip branches were exercised, because `validatedIds` is fed from
 *     `validatedJobs` (scrape.js:715) and a fixture that only sets each job's
 *     own `validationStatus` puts every chip in the `.green` branch and leaves
 *     the `:not(.green)` rule unrun
 */
test('a bookmaker dot paints the job status the backend sent, on every chip', async (t) => {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = new URL('../public' + pathname, import.meta.url);
      const body = await readFile(file);
      res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript'
        : pathname.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() { this.listeners = {}; }
      addEventListener() {}
      close() {}
    };
  });
  const jobs = [
    { id: 'betano', name: 'Betano', enabled: true, validationStatus: 'validated' },
    { id: 'exotic', name: 'Exotic', enabled: true, validationStatus: 'experimental' },
  ];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === '/api/csrf') data = { token: 'test-token' };
    else if (path === '/api/scrapers') data = { jobs, enabledJobs: jobs, validatedJobs: [jobs[0]] };
    else if (path === '/api/profiles') data = { profiles: [] };
    else if (path === '/api/sports') data = { sports: [] };
    else if (path === '/api/scrape/state') data = { state: { status: 'idle', jobs: [] } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/admin/scrape.html`);
  await page.locator('#bookmaker-list input[data-source]').first().waitFor();

  // Set, verify and read in one evaluate, with transitions off.
  const paintWith = (cls) => page.evaluate((want) => {
    const dots = [...document.querySelectorAll('#bookmaker-list .dot')];
    for (const dot of dots) { dot.style.transition = 'none'; dot.className = 'dot ' + want; }
    void document.body.offsetWidth;
    const out = {};
    for (const chip of document.querySelectorAll('#bookmaker-list label.chip')) {
      const dot = chip.querySelector('.dot');
      const cs = window.getComputedStyle(dot);
      out[chip.dataset.name] = {
        chipClass: chip.className.trim(),
        dotClass: dot.className.trim(),
        bg: cs.backgroundColor,
        animation: cs.animationName,
      };
    }
    for (const dot of dots) dot.style.removeProperty('transition');
    return out;
  }, cls);

  const idleness = await paintWith('');
  for (const chip of Object.values(idleness)) {
    assert.equal(chip.dotClass, 'dot', 'the no-job class is in place before anything is forced');
  }
  assert.ok(idleness.betano.chipClass.includes('green'), 'one chip is validated');
  assert.ok(!idleness.exotic.chipClass.includes('green'), 'and one is not, so :not(.green) runs');
  assert.notEqual(idleness.betano.bg, idleness.exotic.bg,
    'with no job status the dot still reports validation, so the fix did not simply delete that');

  // Named by token, not by a literal rgb triple, so that editing a colour in
  // design-tokens.css moves both sides together and this stays about the rule
  // that picks the token rather than about the token's value.
  const token = (name) => page.evaluate((v) => {
    const el = document.createElement('span');
    el.style.background = `var(${v})`;
    document.body.appendChild(el);
    const bg = window.getComputedStyle(el).backgroundColor;
    el.remove();
    return bg;
  }, name);
  const okColor = await token('--sl-ok');
  const idleColor = await token('--sl-idle');
  assert.notEqual(okColor, idleColor, 'the two tokens differ, so naming them is not vacuous');
  assert.equal(idleness.betano.bg, okColor, 'a validated book with no job status is the ok colour');
  assert.equal(idleness.exotic.bg, idleColor, 'and an unvalidated one is the idle colour');

  const isolated = await page.evaluate(() => {
    const el = document.createElement('span');
    el.className = 'dot error';
    document.body.appendChild(el);
    const bg = window.getComputedStyle(el).backgroundColor;
    el.remove();
    return bg;
  });
  assert.notEqual(isolated, idleness.betano.bg,
    'a bare `dot error` outside .sl-sources paints something the chip does not, so the rule itself is live');

  const painted = {};
  for (const state of ['live', 'busy', 'error']) painted[state] = await paintWith(state);
  for (const [state, chips] of Object.entries(painted)) {
    for (const [name, chip] of Object.entries(chips)) {
      assert.equal(chip.dotClass, `dot ${state}`, `${name} took the ${state} class`);
      assert.equal(chip.bg, chips.betano.bg,
        `${state} paints the same colour on a validated and an experimental book`);
    }
  }

  // The regression itself: failure and work in flight used to be the validated
  // green, which is also what "nothing ran here" paints.
  for (const state of ['busy', 'error']) {
    for (const name of ['betano', 'exotic']) {
      assert.notEqual(painted[state][name].bg, idleness[name].bg,
        `${name}: ${state} is not painted as if no job had ever run`);
    }
  }
  assert.notEqual(painted.error.betano.bg, painted.busy.betano.bg, 'error and running differ');
  assert.notEqual(painted.error.betano.bg, painted.live.betano.bg, 'error and ok differ');
  assert.equal(painted.error.betano.bg, isolated,
    'error carries theme.css\'s own red, so the meaning did not drift with the selector');

  // `updateChipStatus` (scrape.js:456) acknowledges a change by adding `pop`
  // and dropping it 500ms later. It had no rule in any stylesheet, so the
  // acknowledgement was written and then never drawn. Measured here because a
  // class with no stylesheet is invisible to every other control here.
  const popped = await page.evaluate(() => {
    const dot = document.querySelector('#bookmaker-list .dot');
    dot.style.transition = 'none';
    dot.className = 'dot pop';
    void dot.offsetWidth;
    const animation = window.getComputedStyle(dot).animationName;
    const duration = window.getComputedStyle(dot).animationDuration;
    dot.className = 'dot';
    dot.style.removeProperty('transition');
    return { animation, duration };
  });
  assert.equal(popped.animation, 'sl-dot-pop', 'the status-change acknowledgement is drawn');
  assert.equal(popped.duration, '0.5s', 'and lasts as long as the code keeps the class');

  // theme.css still owns the motion: restating `background` here must not have
  // cost `live` and `busy` the pulse, which is all `running` had left before.
  for (const state of ['live', 'busy']) {
    for (const name of ['betano', 'exotic']) {
      assert.equal(painted[state][name].animation, 'ping', `${name}: ${state} still pulses`);
    }
  }
});