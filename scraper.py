import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()

        async def handle_response(response):
            try:
                url = response.url
                if "gettopevents" in url.lower() or "odds" in url.lower() or "events" in url.lower() or "widget" in url.lower() or "getcontrolstree" in url.lower():
                    if response.request.resource_type in ["fetch", "xhr", "document"]:
                        req = response.request
                        print(f"[NETWORK] {req.method} {url}")
                        text = await response.text()
                        print(f"[BODY_PREVIEW] {text[:800]}")
            except Exception as e:
                pass

        page.on("response", handle_response)
        
        sites = [
            "https://sport.kingcasino.ro/",
            "https://www.winmasters.ro/",
            "https://pariuriplus.ro/"
        ]
        
        for site in sites:
            try:
                print(f"Navigating to {site} ...")
                await page.goto(site, wait_until="domcontentloaded", timeout=60000)
                await page.wait_for_timeout(15000)
                content = await page.content()
                print(f"[HTML_SNIPPET {site}] {content[:500]}")
            except Exception as e:
                print(f"Error on {site}: {e}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
