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
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
        )
        page = await context.new_page()

        async def handle_response(response):
            try:
                url = response.url
                if ("api" in url.lower() or "sport" in url.lower() or "odds" in url.lower() or "event" in url.lower() or "lineup" in url.lower() or "sb" in url.lower()) and (".svg" not in url.lower() and ".png" not in url.lower() and ".jpg" not in url.lower() and ".woff" not in url.lower() and ".css" not in url.lower() and ".js" not in url.lower()):
                    if response.request.resource_type in ["fetch", "xhr"]:
                        req = response.request
                        print(f"[NETWORK] {req.method} {url}")
                        try:
                            if req.post_data:
                                print(f"[REQ_POST_DATA] {req.post_data[:500]}")
                        except:
                            pass
                        text = await response.text()
                        if len(text) > 50:
                            print(f"[BODY_PREVIEW] {text[:500]}")
            except Exception as e:
                pass

        page.on("response", handle_response)
        
        # Winmasters uses an EveryMatrix sportsbook iframe or separate SPA usually
        print(f"Navigating to https://sport.winmasters.ro/ro/sports ...")
        await page.goto("https://sport.winmasters.ro/ro/sports", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(20000)

        # Pariuriplus might use sb.pariuriplus.ro or a similar subdomain for the sports component
        print(f"Navigating to https://pariuriplus.ro/ro/sports ...")
        await page.goto("https://pariuriplus.ro/ro/sports", wait_until="domcontentloaded", timeout=60000)
        # click on sports if it needs to trigger it
        try:
            await page.click("text=Sport", timeout=5000)
        except:
            pass
        await page.wait_for_timeout(20000)
        
        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
