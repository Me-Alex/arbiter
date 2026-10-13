import asyncio
from playwright.async_api import async_playwright
import json

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-web-security"
            ]
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
        )
        await context.add_init_script("""
            Object.defineProperty(navigator, "webdriver", {get: () => undefined});
        """)
        
        page = await context.new_page()

        async def handle_response(response):
            try:
                url = response.url
                if "getsystemcardsbysportid" in url.lower() or "gettopsportslist" in url.lower() or "getsportsbysystemtabid" in url.lower():
                    if response.request.resource_type in ["fetch", "xhr"]:
                        req = response.request
                        print(f"[NETWORK] {req.method} {url}")
                        text = await response.text()
                        with open("pariuriplus_odds.json", "w", encoding="utf-8") as f:
                            f.write(text)
                        print(f"[SAVED] Saved to pariuriplus_odds.json")
            except Exception as e:
                pass

        page.on("response", handle_response)
        
        print("Visiting winmasters first to get cloudflare clearance...")
        await page.goto("https://sport.winmasters.ro/ro/sports", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(5000)
        
        print("Visiting pariuriplus.ro/ro/sports...")
        await page.goto("https://pariuriplus.ro/ro/sports", wait_until="domcontentloaded", timeout=60000)
        
        for i in range(15):
            content = await page.content()
            if "Just a moment..." not in content and "cf-browser-verification" not in content:
                print("Cloudflare bypassed!")
                break
            await page.wait_for_timeout(2000)
            
        await page.wait_for_timeout(5000)
        
        try:
            print("Clicking Sport tab to trigger Digitain load...")
            await page.click("text=Sport", timeout=5000)
        except:
            print("Could not click Sport tab")
            
        await page.wait_for_timeout(10000)
        
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
