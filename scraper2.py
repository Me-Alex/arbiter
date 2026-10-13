import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        # Important: use an empty user_agent to get the default headed user agent, or set a highly authentic one
        # Avoid headless: True since it easily trips Cloudflare
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()

        async def handle_response(response):
            try:
                url = response.url
                if "gettopevents" in url.lower() or "odds" in url.lower() or "events" in url.lower() or "widget" in url.lower() or "getcontrolstree" in url.lower() or "sports" in url.lower() or "api" in url.lower():
                    if response.request.resource_type in ["fetch", "xhr"]:
                        req = response.request
                        print(f"[NETWORK] {req.method} {url}")
                        text = await response.text()
                        print(f"[BODY_PREVIEW] {text[:500]}")
            except Exception as e:
                pass

        page.on("response", handle_response)
        
        sites = [
            "https://sport.kingcasino.ro/",
            "https://www.winmasters.ro/ro/sports",
            "https://pariuriplus.ro/ro/sports"
        ]
        
        for site in sites:
            try:
                print(f"Navigating to {site} ...")
                await page.goto(site, wait_until="domcontentloaded", timeout=60000)
                # Wait up to 30 seconds to bypass CF
                await page.wait_for_timeout(30000)
                content = await page.content()
                print(f"[HTML_SNIPPET {site}] {content[:200]}")
            except Exception as e:
                print(f"Error on {site}: {e}")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
