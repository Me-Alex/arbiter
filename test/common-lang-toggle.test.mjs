// The header language button, and the pages it was dead on.
//
// `<button data-lang-toggle>` is in the markup of ai, analytics, scanner and
// scrape, styled by theme.css as a normal control, and visible at every
// breakpoint. Nothing bound it. Only login.html loads pages/login.js, and that
// is the single place in the tree that ever bound this selector — so on the
// other four pages the button rendered, took keyboard focus, and did nothing.
// The sidebar switcher that does work is injected by app.js inside a drawer
// that is closed on a phone, so on a small screen it was the only language
// control and it was the inert one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const commonSource = read('public/js/pages/common.js');

/** A button we can actually press. */
function button(dataset = {}) {
  const listeners = new Map();
  return {
    dataset,
    textContent: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    click() { (listeners.get('click') || (() => { throw new Error('the button had no click handler'); }))(); },
    hasHandler: (type) => listeners.has(type),
  };
}

function mount({ buttons = [], lang = 'ro', readyState = 'complete', hasI18n = true } = {}) {
  const reloaded = { count: 0 };
  let currentLang = lang;
  const context = {
    document: {
      readyState,
      documentElement: { dataset: {}, lang: currentLang },
      addEventListener() {},
      querySelectorAll: (sel) => (sel === '[data-lang-toggle]' ? buttons : []),
      getElementById: () => null,
      body: { appendChild() {} },
    },
    localStorage: { getItem: () => null, setItem() {} },
    console,
    setTimeout,
    clearTimeout,
    location: { reload() { reloaded.count += 1; } },
  };
  context.window = context;
  if (hasI18n) {
    context.arbiterI18n = {
      get lang() { return currentLang; },
      t: (key) => ({ language: 'Limbă', live: 'Live' })[key] || key,
      setLang(next) { currentLang = next; },
    };
  }
  vm.runInNewContext(commonSource, context);
  return { context, reloaded };
}

test('the header language button is bound and switches language', () => {
  const btn = button();
  const { reloaded } = mount({ buttons: [btn] });

  assert.ok(btn.hasHandler('click'), 'a click handler is attached — this is the whole defect');
  btn.click();
  assert.equal(reloaded.count, 1, 'the page reloads so fetched content is rebuilt in the new language');
});

test('the button names the language it switches to, not the one already active', () => {
  const ro = button();
  mount({ buttons: [ro], lang: 'ro' });
  assert.equal(ro.textContent, 'EN', 'from Romanian the button offers English');

  const en = button();
  mount({ buttons: [en], lang: 'en' });
  assert.equal(en.textContent, 'RO', 'from English it offers Romanian');

  // The static markup shipped a hardcoded "RO" on every page, which named the
  // language most of them were already showing.
  const labelled = button();
  mount({ buttons: [labelled], lang: 'ro' });
  assert.equal(labelled.getAttribute('aria-label'), 'Limbă', 'and it is labelled for a screen reader');
});

test('pressing it twice is not a second switch', () => {
  // The page is reloading, so in a normal browser the second press cannot
  // land. It can land in the frame before the reload starts, and a local
  // server on a loaded machine is slow enough for a double-click to get
  // through — which would flip the language and flip it straight back.
  const btn = button();
  const { reloaded } = mount({ buttons: [btn] });
  btn.click();
  assert.equal(btn.disabled, true, 'the button disables itself before the reload');
  btn.click();
  assert.equal(reloaded.count, 1);
});

test('a page with no button is not an error', () => {
  assert.doesNotThrow(() => mount({ buttons: [] }));
});

test('the module still exports what the admin pages call', () => {
  // common.js is loaded ahead of four page scripts that call these on boot.
  // Wiring the button must not have disturbed the module's public surface.
  const { context } = mount({ buttons: [] });
  for (const name of ['escapeHtml', 'createDropdown', 'createChip', 'applyDesignTokens', 'showToast']) {
    assert.equal(typeof context[name], 'function', `${name} is still exported`);
  }
  assert.equal(typeof context.arbiterToast.show, 'function');
  assert.equal(typeof context.arbiterFormat.count, 'function');
  assert.equal(context.escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
});

test('the button survives being wired before the dictionary exists', () => {
  // Script order on the admin pages puts i18n.js first, so this should not
  // happen — but a bare guard costs nothing and a throw here would take the
  // whole page's script with it.
  assert.doesNotThrow(() => mount({ buttons: [button()], hasI18n: false }));
});
