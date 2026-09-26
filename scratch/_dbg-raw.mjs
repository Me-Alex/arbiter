import { instantiate } from '../src/scrapers/index.mjs';
const id = process.argv[2] || 'excelbet';
const s = instantiate(id, { dataDir: './data-market-run', runId: 'dbg', maxEvents: 5, logger: () => {} });
const raw = await s.fetchRaw();
const payloads = raw?.payloads;
const arr = Array.isArray(payloads) ? payloads : payloads?.flat?.() ?? payloads?.values?.();
if (!arr) { console.log('payloads shape:', payloads ? Object.keys(payloads) : 'none'); process.exit(0); }
const list = Array.isArray(arr) ? arr : [...arr];
for (const p of list.slice(0, 8)) {
  console.log('PAYLOAD id=', p?.id, ' nEvents=', (p?.events ?? []).length);
  for (const e of (p?.events ?? []).slice(0, 3)) {
    const scs = e?.scs ?? [];
    console.log(`  -- event ${e?.id} scs=${scs.length}`);
    for (const m of scs) {
      const eqs = m?.eqs ?? [];
      console.log(`     t=${m?.t} d=${JSON.stringify(m?.d ?? '')} eqs=${eqs.map((o) => `${o.ce}:${o.q}`).join(',')}`);
    }
  }
}
