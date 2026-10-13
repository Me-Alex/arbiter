import AltenarPublic from '../src/scrapers/altenar-public.mjs';

async function testAltenar() {
  const scraper = new AltenarPublic('casinoly', { maxEvents: 5 });
  console.log('Scraper created:', scraper.id, scraper.name);
  const raw = await scraper.fetchRaw();
  console.log('Fetched raw events count:', raw.events?.length);
  const events = scraper.extractEvents(raw);
  console.log('Extracted events count:', events.length);
  if (events.length > 0) {
    const e = events[0];
    console.log('Sample event:', e.sport, e.homeTeam, 'vs', e.awayTeam);
    console.log('Markets count:', e.markets?.length);
    console.log('First market:', e.markets?.[0]?.name, e.markets?.[0]?.selections);
  }
}

testAltenar().catch(console.error);
