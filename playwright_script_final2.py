import asyncio
import sys
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(locale='en-US')
        page = await context.new_page()
        
        page.on('console', lambda msg: print(f"Console: {msg.type} {msg.text}"))
        
        print("Navigating to the page...")
        await page.goto('https://0sv1b7rb5285.space.mcode.io/admin/arbitrage.html', timeout=60000)
        
        print("Waiting for page load and API responses...")
        
        # Wait up to 60 seconds for the first card to appear
        try:
            await page.wait_for_selector('#arb-grid .card', timeout=60000)
            print("Arbitrage cards loaded successfully.")
            # Give it an extra second to render everything completely
            await page.wait_for_timeout(1000)
        except:
            print("Timeout waiting for arbitrage cards to load. Capturing whatever is there.")
            
        await page.screenshot(path='arbitrage_screenshot_final2.png')
        print("Screenshot saved to arbitrage_screenshot_final2.png")
        
        with open('output_final2.txt', 'w', encoding='utf-8') as f:
            # 1. Does the page render with visible content?
            visible_content = await page.evaluate('document.body.innerText')
            
            f.write("--- 1. RENDER & ERRORS ---\n")
            f.write("Visible content starts with:\n")
            f.write(visible_content[:200] + "\n\n")
            
            error_text = await page.evaluate('''() => {
                const el = document.querySelector('.edge-empty');
                return el ? el.innerText : 'No explicit error element found.';
            }''')
            f.write(f"Error text (if any): {error_text}\n\n")
            
            # 2. KPIs
            kpis = await page.evaluate('''() => {
                const cells = Array.from(document.querySelectorAll('.rail__cell'));
                return cells.map(c => {
                    const label = c.querySelector('.rail__label')?.innerText;
                    const value = c.querySelector('.rail__value')?.innerText;
                    return {label, value};
                });
            }''')
            f.write("--- 2. KPIs ---\n")
            for kpi in kpis:
                f.write(f"Label: {kpi['label']} | Value: {kpi['value']}\n")
            f.write("\n")
            
            # 3. First Arbitrage Card
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
            f.write("--- 3. FIRST ARBITRAGE CARD ---\n")
            f.write(str(first_arb) + "\n\n")
            
            # 4. Bankroll
            if first_arb is not None:
                bankroll_val = await page.locator('#f-bankroll').input_value()
                f.write(f"--- 4. BANKROLL ---\n")
                f.write(f"Initial bankroll: {bankroll_val}\n")
                
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
                f.write("Leg stakes after setting bankroll to 2500:\n")
                f.write(str(re_first_arb) + "\n\n")
            else:
                f.write("--- 4. BANKROLL ---\n")
                f.write("Skipped - No first arbitrage card found.\n\n")
            
            # 5. Bad texts
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
            f.write("--- 5. BAD TEXTS ---\n")
            f.write(str(bad_texts) + "\n\n")
            
            # 6. Masthead Subtitle
            masthead_sub = await page.evaluate('document.getElementById("masthead-sub")?.innerText')
            f.write("--- 6. MASTHEAD SUBTITLE ---\n")
            f.write(str(masthead_sub) + "\n")

        await browser.close()

asyncio.run(main())
