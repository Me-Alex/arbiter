import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(locale='en-US')
        page = await context.new_page()
        
        # We need to provide a mock response for the API if it's returning HTML instead of JSON
        async def handle_route(route, request):
            if 'scan' in request.url and 'js' not in request.url and 'css' not in request.url:
                print(f"Intercepted request: {request.url}")
                await route.continue_()
            else:
                await route.continue_()
                
        await page.route("**/*", handle_route)
        
        page.on('response', lambda res: print(f"Response: {res.status} {res.url} - {res.headers.get('content-type')}"))
        page.on('console', lambda msg: print(f"Console: {msg.type} {msg.text}"))
        
        print("Navigating to the page...")
        await page.goto('https://0sv1b7rb5285.space.mcode.io/admin/arbitrage.html', timeout=60000)
        
        print("Waiting 15s...")
        await page.wait_for_timeout(15000)
        
        await browser.close()

asyncio.run(main())
