// quick smoke test of the running server.
import { TextDecoder } from 'node:util';

const base = 'http://127.0.0.1:3022';

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

(async () => {
  await test('GET /api/health → ok', async () => {
    const r = await fetch(base + '/api/health');
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error('not ok');
  });

  await test('GET /api/csrf returns token', async () => {
    const r = await fetch(base + '/api/csrf');
    const j = await r.json();
    if (!j.token || j.token.length < 32) throw new Error('bad token');
  });

  await test('POST /api/scrape without CSRF → 403', async () => {
    const r = await fetch(base + '/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookIds: ['fortuna'] }),
    });
    if (r.status !== 403) throw new Error(`expected 403 got ${r.status}`);
  });

  await test('POST /api/scrape with CSRF → 202', async () => {
    const csrf = (await (await fetch(base + '/api/csrf')).json()).token;
    const r = await fetch(base + '/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-arbiter-token': csrf },
      body: JSON.stringify({ bookIds: ['fortuna'], scanOptions: { bankroll: 500 } }),
    });
    if (r.status !== 202 && r.status !== 409) throw new Error(`expected 202/409 got ${r.status}`);
    const j = await r.json();
    if (!j.state) throw new Error('no state in body');
  });

  await test('POST /api/scheduler with CSRF → 200', async () => {
    const csrf = (await (await fetch(base + '/api/csrf')).json()).token;
    const r = await fetch(base + '/api/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-arbiter-token': csrf },
      body: JSON.stringify({ enabled: false }),
    });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
  });

  await test('GET /api/scrape/state → has state', async () => {
    const r = await fetch(base + '/api/scrape/state');
    const j = await r.json();
    if (!j.state) throw new Error('no state');
  });

  await test('GET /api/scan returns latest-scan.json', async () => {
    const r = await fetch(base + '/api/scan');
    const j = await r.json();
    if (!('opportunities' in j)) throw new Error('no opportunities key');
  });

  await test('GET /api/scrapers lists 13 jobs', async () => {
    const r = await fetch(base + '/api/scrapers');
    const j = await r.json();
    if (!Array.isArray(j.jobs)) throw new Error('no jobs');
    if (j.jobs.length !== 13) throw new Error(`expected 13 jobs got ${j.jobs.length}`);
  });

  await test('GET /api/profiles has 2 entries', async () => {
    const r = await fetch(base + '/api/profiles');
    const j = await r.json();
    if (j.profiles.length !== 2) throw new Error(`expected 2 profiles got ${j.profiles.length}`);
  });

  await test('GET /api/tracker works', async () => {
    const r = await fetch(base + '/api/tracker');
    const j = await r.json();
    if (!Array.isArray(j.items)) throw new Error('no items');
  });

  await test('GET /api/alerts works', async () => {
    const r = await fetch(base + '/api/alerts');
    const j = await r.json();
    if (!j.preferences) throw new Error('no preferences');
  });

  await test('GET /admin/scrape.html serves HTML', async () => {
    const r = await fetch(base + '/admin/scrape.html');
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html')) throw new Error(`bad content-type ${ct}`);
  });

  await test('GET /css/theme.css serves CSS', async () => {
    const r = await fetch(base + '/css/theme.css');
    if (r.status !== 200) throw new Error(`status ${r.status}`);
  });

  await test('GET /api/events opens SSE', async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    try {
      const r = await fetch(base + '/api/events', { signal: ac.signal });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (!(r.headers.get('content-type') || '').includes('text/event-stream')) throw new Error('not SSE');
      // read first frame
      const reader = r.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      if (!text.includes('retry:')) throw new Error('no retry frame');
      ac.abort();
    } finally {
      clearTimeout(t);
    }
  });

  console.log('\nsmoke test complete');
})();
