import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/pages/scrape.js', import.meta.url), 'utf8');
function harness() {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', dataset: {}, checked: false });
    return nodes.get(id);
  } };
  const context = vm.createContext({ document });
  vm.runInContext(source.slice(0, source.indexOf("$('run-btn').addEventListener")), context);
  return { nodes, run: (code) => vm.runInContext(code, context) };
}

test('pending, running and skipped jobs are not failures', () => {
  const { run } = harness();
  for (const status of ['pending', 'running', 'skipped', 'cancelled']) {
    assert.equal(run(`isFailedJob({status: '${status}', valid: false})`), false);
  }
  for (const status of ['failed', 'timeout', 'locked', 'unknown']) {
    assert.equal(run(`isFailedJob({status: '${status}'})`), true);
  }
});

test('empty selection, launch in flight and cancelling block run', () => {
  const { run, nodes } = harness();
  run('updateRunControls()');
  assert.equal(nodes.get('run-btn').disabled, true);
  run("selectedIds.add('book'); updateRunControls()");
  assert.equal(nodes.get('run-btn').disabled, false);
  run("lastState = {status: 'running'}; updateRunControls()");
  assert.equal(nodes.get('cancel-btn').disabled, false);
  run("lastState = {status: 'cancelling'}; updateRunControls()");
  assert.equal(nodes.get('run-btn').disabled, true);
  assert.equal(nodes.get('cancel-btn').disabled, true);
  run("lastState = {status: 'completed'}; launchPending = true; updateRunControls()");
  assert.equal(nodes.get('run-btn').disabled, true);
});

test('profile applies supplied defaults without changing selection or manual event cap', () => {
  const { run, nodes } = harness();
  run("$('profile').value = 'review'; $('max-events').value = '100'; $('max-events').dataset.userSet = '1'; selectedIds.add('book'); profiles = [{id:'review', defaults:{bankroll:500,minRoiPercent:1,maxMiddleRiskPercent:10,minMiddleRoiPercent:30,includeLive:true,includePast:true}}]; applyProfile()");
  assert.equal(nodes.get('bankroll').value, 500);
  assert.equal(nodes.get('inc-live').checked, true);
  assert.equal(nodes.get('max-events').value, '100');
  assert.equal(run('selectedIds.size'), 1);
});

test('source checkbox selectors exclude group toggles and layout preserves unique hooks', () => {
  assert.doesNotMatch(source, /#bookmaker-list input:checked|list\.querySelectorAll\('input\[type=checkbox\]/);
  const html = readFileSync(new URL('../public/admin/scrape.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(html.indexOf('scrape-workspace') < html.indexOf('scrape-kpis'));
  for (const id of ['run-btn', 'cancel-btn', 'bookmaker-list', 'job-rows', 'profile']) assert.ok(ids.includes(id));
});
