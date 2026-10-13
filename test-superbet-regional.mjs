async function testSuperbet(domain, locale) {
  try {
    const url = `https://${domain}/v2/${locale}/events/by-date?currentDate=${new Date().toISOString().slice(0, 10)}`;
    console.log('Testing:', url);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    console.log(domain, 'Status:', res.status);
    const data = await res.json();
    console.log(domain, 'Events count:', data.data?.length || 0);
  } catch (e) {
    console.log(domain, 'Error:', e.message);
  }
}

async function main() {
  await testSuperbet('production-superbet-offer-pl.freetls.fastly.net', 'pl-PL');
  await testSuperbet('production-superbet-offer-rs.freetls.fastly.net', 'sr-RS');
  await testSuperbet('production-superbet-offer-ro.freetls.fastly.net', 'ro-RO');
}
main();
