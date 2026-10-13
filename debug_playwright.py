import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(locale='en-US')
        page = await context.new_page()
        
        # We need to provide a mock response for the API if it's returning HTML instead of JSON
        async def handle_route(route, request):
            if '/api/scan' in request.url and 'export' not in request.url:
                print(f"Intercepted API request: {request.url}")
                # Let it proceed normally first, we will observe its response
                await route.continue_()
            else:
                await route.continue_()
                
        await page.route("**/*", handle_route)
        
        page.on('response', lambda res: print(f"Response: {res.status} {res.url} - {res.headers.get('content-type')}"))
        page.on('console', lambda msg: print(f"Console: {msg.type} {msg.text}"))
        
        print("Navigating to the page...")
        await page.goto('https://0sv1b7rb5285.space.mcode.io/admin/arbitrage.html', timeout=60000)
        
        print("Waiting for page load and API responses...")
        await page.wait_for_timeout(10000)
        
        # See what's actually in the DOM
        visible_content = await page.evaluate('document.body.innerText')
        print("Visible content starts with:", visible_content[:200])
        
        kpis = await page.evaluate('''() => {
            const cells = Array.from(document.querySelectorAll('.rail__cell'));
            return cells.map(c => {
                const label = c.querySelector('.rail__label')?.innerText;
                const value = c.querySelector('.rail__value')?.innerText;
                return {label, value};
            });
        }''')
        print("KPIs:", kpis)
        
        await browser.close()

asyncio.run(main())
