import asyncio
from playwright.async_api import async_playwright
import json

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        errors = []
        page.on("console", lambda msg: errors.append(f"CONSOLE {msg.type}: {msg.text}") if msg.type == "error" else None)
        page.on("pageerror", lambda err: errors.append(f"PAGE ERROR: {err}"))
        
        print("Navigating to URL...")
        await page.goto("https://0sv1b7rb5285.space.mcode.io/", wait_until="networkidle", timeout=60000)
        
        print("Waiting for 40 seconds to let data load...")
        await asyncio.sleep(40)
        
        # Get KPI tiles
        kpi_data = []
        # The tiles seem to have a label and a value.
        # Let's just grab all the text in the top section
        
        # We need a robust way to get text. Let's dump the DOM of the top part.
        kpi_section = await page.evaluate('''() => {
            const tiles = Array.from(document.querySelectorAll('div')).filter(d => 
                d.textContent.includes('ARBITRAGES') || 
                d.textContent.includes('GUARANTEED PROFIT') ||
                d.textContent.includes('MIDDLES') ||
                d.textContent.includes('POSITIVE EV') ||
                d.textContent.includes('CAPITAL COMMITTED')
            );
            return tiles.map(t => t.innerText);
        }''')
        print("KPI Section raw text:", json.dumps(kpi_section))
        
        
        # Get first card details
        cards_html = await page.evaluate('''() => {
            const cards = Array.from(document.querySelectorAll('div')).filter(d => d.textContent.includes('GUARANTEED ARBITRAGE'));
            return cards.map(c => c.innerHTML);
        }''')
        # actually, let's get the specific text
        card_text = await page.evaluate('''() => {
            // Find the cards container
            const allDivs = Array.from(document.querySelectorAll('div'));
            const cardContainers = allDivs.filter(div => {
                return div.textContent.includes('Croatia v Cehia') && div.style && div.style.borderRadius;
            });
            return cardContainers.map(c => c.innerText);
        }''')
        
        first_card_html = await page.evaluate('''() => {
            // we see the cards in the screenshot. let's just grab all text from the page
            return document.body.innerText;
        }''')
        
        # Find exact elements for first card legs
        first_card = await page.evaluate('''() => {
            // Looking at the screenshot, the cards are at the bottom.
            // Let's find the first card "Croatia v Cehia"
            const cards = Array.from(document.querySelectorAll('div')).filter(d => d.textContent.includes('Croatia v Cehia') && d.textContent.includes('Profit'));
            
            // let's try a different approach, get all tables or structured divs inside the card
            if (cards.length > 0) {
               return cards[cards.length - 1].innerText; // The most specific one
            }
            return "Not found";
        }''')
        
        print("First Card Text:", json.dumps(first_card))
        
        # scroll down and screenshot again to see the full cards
        await page.mouse.wheel(0, 1000)
        await asyncio.sleep(2)
        await page.screenshot(path="screenshot2.png")
        print("Screenshot 2 saved")
        
        
        # Change bankroll
        try:
             await page.evaluate('''() => {
                 // find the input with value 1000
                 const inputs = Array.from(document.querySelectorAll('input'));
                 const bankrollInput = inputs.find(i => i.value === '1000' || i.placeholder === '1000' || i.id === 'f-bankroll');
                 if (bankrollInput) {
                     bankrollInput.value = '2500';
                     bankrollInput.dispatchEvent(new Event('input', { bubbles: true }));
                     bankrollInput.dispatchEvent(new Event('change', { bubbles: true }));
                 }
             }''')
             await asyncio.sleep(2) # wait for re-render
             
             await page.screenshot(path="screenshot3.png")
             print("Screenshot 3 saved after bankroll change")
             
             first_card_after = await page.evaluate('''() => {
                const cards = Array.from(document.querySelectorAll('div')).filter(d => d.textContent.includes('Croatia v Cehia') && d.textContent.includes('Profit'));
                if (cards.length > 0) {
                   return cards[cards.length - 1].innerText;
                }
                return "Not found";
            }''')
             print("First Card Text After Bankroll:", json.dumps(first_card_after))
             
        except Exception as e:
            print(f"Error changing bankroll: {e}")

        # Check for NaN, undefined, etc.
        body_text = await page.evaluate("document.body.innerText")
        anomalies = []
        for word in ["NaN", "undefined", "[object Object]", "Infinity"]:
            if word in body_text:
                anomalies.append(word)
        print("Anomalies found:", anomalies)
        
        print("Console/Page Errors:", json.dumps(errors))
        

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
