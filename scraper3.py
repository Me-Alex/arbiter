import asyncio
from playwright.async_api import async_playwright
import time

async def bypass_cf(page, url):
    print(f"Navigating to {url}")
    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    
    # Wait for cloudflare to clear
    for i in range(30):
        content = await page.content()
        if "Just a moment..." not in content and "cf-browser-verification" not in content:
            print("Cloudflare bypassed!")
            break
        await page.wait_for_timeout(2000)
        
    await page.wait_for_timeout(10000) # give time for page logic and network reqs
    
    html = await page.content()
    # Check for team names or odds decimal in DOM (simple check)
    if "Real Madrid" in html or "Barcelona" in html or "odds" in html.lower() or "class=\"odds" in html.lower() or "span" in html:
        print(f"{url} rendered full HTML length: {len(html)}")
    else:
        print(f"{url} rendered HTML length: {len(html)}")

async def run():
    async with async_playwright() as p:
        # Launch using an actual chrome instance or different user-agent args
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
            device_scale_factor=1,
            is_mobile=False,
            has_touch=False
        )
        page = await context.new_page()

        # Execute evasions
        await page.add_init_script("""
            Object.defineProperty(navigator, "webdriver", {get: () => undefined});
        """)

        async def handle_response(response):
            try:
                url = response.url
                if "gettopevents" in url.lower() or "sports" in url.lower() or "api" in url.lower():
                    if response.request.resource_type in ["fetch", "xhr"]:
                        req = response.request
                        print(f"[NETWORK] {req.method} {url}")
                        try:
                            # Try get postData
                            if req.post_data:
                                print(f"[REQ_POST_DATA] {req.post_data[:300]}")
                        except:
                            pass
                        text = await response.text()
                        if len(text) > 50:
                            print(f"[BODY_PREVIEW] {text[:300]}")
            except Exception as e:
                pass

        page.on("response", handle_response)
        
        await bypass_cf(page, "https://sport.kingcasino.ro/")
        await bypass_cf(page, "https://www.winmasters.ro/")
        await bypass_cf(page, "https://pariuriplus.ro/")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run())
