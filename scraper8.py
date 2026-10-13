import asyncio
from playwright.async_api import async_playwright
import json

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled", "--disable-web-security"])
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        await context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
        page = await context.new_page()
        
        async def handle_response(response):
            if "getsportsshowedintoppage" in response.url or "geteventsbygroupid" in response.url or "gettopevents" in response.url:
                try:
                    text = await response.text()
                    print(f"URL: {response.url[:100]}")
                    print(f"Body start: {text[:100]}")
                except:
                    pass

        page.on("response", handle_response)
        
        await page.goto("https://sport.winmasters.ro/ro/sports", wait_until="domcontentloaded", timeout=60000)
        for i in range(15):
            content = await page.content()
            if "Just a moment..." not in content and "cf-browser-verification" not in content:
                print("Cloudflare bypassed for winmasters!")
                break
            await page.wait_for_timeout(2000)
            
        await page.wait_for_timeout(10000)
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
