import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        print("Navigating to the page...")
        await page.goto('https://0sv1b7rb5285.space.mcode.io/admin/arbitrage.html', timeout=60000)
        
        # Wait a bit for the background fetch to complete
        print("Waiting 15 seconds for data to load...")
        await page.wait_for_timeout(15000)
        
        await page.screenshot(path='arbitrage_screenshot_2.png')
        print("Screenshot saved to arbitrage_screenshot_2.png")
        
        kpis = await page.evaluate('''() => {
            const cells = Array.from(document.querySelectorAll('.rail__cell'));
            return cells.map(c => {
                const label = c.querySelector('.rail__label')?.innerText;
                const value = c.querySelector('.rail__value')?.innerText;
                return {label, value};
            });
        }''')
        print("--- KPIs ---")
        for kpi in kpis:
            print(f"Label: {kpi['label']}, Value: {kpi['value']}")
        
        first_arb = await page.evaluate('''() => {
            const card = document.querySelector('#arb-grid .card');
            if (!card) return null;
            
            const marketKey = card.querySelector('.px-1\\\\.5')?.innerText;
            const eventName = card.querySelector('a')?.innerText;
            
            const statBlocks = Array.from(card.querySelectorAll('.grid.grid-cols-2 > div'));
            const stats = statBlocks.map(block => {
                const label = block.querySelector('.text-xs.text-\\\\[var\\\\(--edge-textMuted\\\\)\\\\]')?.innerText;
                const value = block.querySelector('.text-sm.font-semibold')?.innerText;
                return {label, value};
            });
            
            const legs = Array.from(card.querySelectorAll('.space-y-1 > div')).map(leg => {
                const bookSelection = leg.querySelector('.text-xs.text-\\\\[var\\\\(--edge-text\\\\)\\\\]')?.innerText;
                const oddsStake = leg.querySelector('.text-xs.whitespace-nowrap')?.innerText;
                return {bookSelection, oddsStake};
            });
            
            return {marketKey, eventName, stats, legs};
        }''')
        print("--- FIRST ARBITRAGE CARD ---")
        print(first_arb)
        
        bankroll_val = await page.locator('#f-bankroll').input_value()
        print(f"Current bankroll: {bankroll_val}")
        
        await page.locator('#f-bankroll').fill('2500')
        await page.locator('#f-bankroll').evaluate('node => node.dispatchEvent(new Event("input"))')
        
        await page.wait_for_timeout(2000)
        
        re_first_arb = await page.evaluate('''() => {
            const card = document.querySelector('#arb-grid .card');
            if (!card) return null;
            const legs = Array.from(card.querySelectorAll('.space-y-1 > div')).map(leg => {
                const oddsStake = leg.querySelector('.text-xs.whitespace-nowrap')?.innerText;
                return oddsStake;
            });
            return legs;
        }''')
        print("--- FIRST ARBITRAGE CARD AFTER REPLAN ---")
        print(re_first_arb)
        
        bad_texts = await page.evaluate('''() => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node;
            const bad = [];
            const regex = /NaN|undefined|\\\\[object Object\\\\]|Infinity/;
            while (node = walker.nextNode()) {
                if (regex.test(node.nodeValue)) {
                    bad.push(node.nodeValue.trim());
                }
            }
            return bad;
        }''')
        print("--- BAD TEXTS ---")
        print(bad_texts)
        
        masthead_sub = await page.evaluate('document.getElementById("masthead-sub")?.innerText')
        print("--- MASTHEAD SUBTITLE ---")
        print(masthead_sub)
        
        await browser.close()

asyncio.run(main())
