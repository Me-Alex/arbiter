import asyncio
from playwright.async_api import async_playwright
import json

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        print("Navigating to URL...")
        await page.goto("https://0sv1b7rb5285.space.mcode.io/", wait_until="networkidle", timeout=60000)
        
        print("Waiting for 40 seconds to let data load...")
        await asyncio.sleep(40)
        
        # Get KPI tiles more accurately using coordinates or specific DOM structures based on screenshot
        kpi_data = await page.evaluate('''() => {
            // Find the top section containing the KPIs
            const kpiBoxes = Array.from(document.querySelectorAll('.stat'));
            if (kpiBoxes.length > 0) {
               return kpiBoxes.map(b => b.innerText);
            }
            
            // Fallback: look for the specific headers
            const headers = ['ARBITRAGES', 'GUARANTEED PROFIT', 'MIDDLES', 'POSITIVE EV', 'CAPITAL COMMITTED'];
            const allDivs = Array.from(document.querySelectorAll('div'));
            
            return headers.map(header => {
                const headerEl = allDivs.find(d => d.textContent === header && d.children.length === 0);
                if (headerEl && headerEl.parentElement) {
                    return headerEl.parentElement.innerText;
                }
                return null;
            }).filter(Boolean);
        }''')
        print("KPI Data:", json.dumps(kpi_data))
        
        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
