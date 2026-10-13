import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-web-security"
            ]
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
        )
        page = await context.new_page()

        await page.add_init_script("""
            Object.defineProperty(navigator, "webdriver", {get: () => undefined});
        """)

        async def handle_response(response):
            try:
                url = response.url
                # Broader match: pariuriplus uses a similar digitain/everymatrix endpoint usually
                if ("api" in url.lower() or "sport" in url.lower() or "odds" in url.lower() or "event" in url.lower()) and (".svg" not in url.lower() and ".png" not in url.lower() and ".jpg" not in url.lower() and ".woff" not in url.lower()):
                    if response.request.resource_type in ["fetch", "xhr"]:
                        req = response.request
                        print(f"[NETWORK] {req.method} {url}")
                        text = await response.text()
                        if len(text) > 50:
                            print(f"[BODY_PREVIEW] {text[:400]}")
            except Exception as e:
                pass

        page.on("response", handle_response)
        
        # Go straight to the sports page
        print(f"Navigating to https://pariuriplus.ro/ro/sports ...")
        await page.goto("https://pariuriplus.ro/ro/sports", wait_until="domcontentloaded", timeout=60000)
        
        # Wait for cloudflare to clear
        for i in range(30):
            content = await page.content()
            if "Just a moment..." not in content and "cf-browser-verification" not in content:
                print("Cloudflare bypassed!")
                break
            await page.wait_for_timeout(2000)
            
        await page.wait_for_timeout(10000)
        
        # Also let us check digitain shape for sport.kingcasino.ro that we missed last time
        print(f"Navigating to https://sport.kingcasino.ro/ ...")
        await page.goto("https://sport.kingcasino.ro/", wait_until="domcontentloaded", timeout=60000)
        for i in range(30):
            content = await page.content()
            if "Just a moment..." not in content and "cf-browser-verification" not in content:
                print("Cloudflare bypassed for kingcasino!")
                break
            await page.wait_for_timeout(2000)
        await page.wait_for_timeout(10000)

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
