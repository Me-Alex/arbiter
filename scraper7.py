import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled", "--disable-web-security"])
        context = await browser.new_context(viewport={"width": 1920, "height": 1080})
        await context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")
        page = await context.new_page()

        async def bypass_cf(page, url):
            await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            for i in range(20):
                content = await page.content()
                if "Just a moment..." not in content and "cf-browser-verification" not in content:
                    print(f"Cloudflare bypassed for {url}!")
                    break
                await page.wait_for_timeout(2000)
            await page.wait_for_timeout(5000)

        # Let's try one more time to get kingcasino to clear Cloudflare by first visiting the main site
        await bypass_cf(page, "https://kingcasino.ro/")
        
        # Then visit sport
        print("Visiting sport.kingcasino.ro...")
        await bypass_cf(page, "https://sport.kingcasino.ro/")
        
        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
