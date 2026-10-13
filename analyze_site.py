import asyncio
from playwright.async_api import async_playwright
import json
import sys

async def analyze_site(url, out_file):
    print(f"Analyzing {url}...")
    xhr_urls = []
    
    async def handle_response(response):
        try:
            req_url = response.url
            if response.request.resource_type in ["xhr", "fetch"]:
                xhr_urls.append(req_url)
        except Exception:
            pass

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
            java_script_enabled=True
        )
        
        # Add evasion script
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
            window.navigator.chrome = {
                runtime: {}
            };
        """)
        
        page = await context.new_page()
        page.on("response", handle_response)
        
        try:
            print("Navigating...")
            await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            print("Waiting for cloudflare challenge...")
            await page.wait_for_timeout(15000)
            
            # If still on challenge page, try waiting for a specific element of the real site
            # or just wait longer
            if "Just a moment" in await page.title():
                print("Still on challenge page, waiting more...")
                await page.wait_for_timeout(20000)
                
        except Exception as e:
            print(f"Error loading {url}: {e}")
            
        try:
            content = await page.content()
            title = await page.title()
            print(f"Final Title: {title}")
        except Exception as e:
            content = str(e)
            title = "Error getting content"
            
        await browser.close()
        
        # Filter out cloudflare URLs
        filtered_xhr_urls = [u for u in xhr_urls if "challenges.cloudflare.com" not in u and "cdn-cgi/challenge-platform" not in u]
        
        result = {
            "title": title,
            "html_snippet": content[:1500] if content else "",
            "xhr_urls": list(set(filtered_xhr_urls))
        }
        
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=4)
        print(f"Done. Saved to {out_file}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python script.py <url> <out_file>")
        sys.exit(1)
    asyncio.run(analyze_site(sys.argv[1], sys.argv[2]))
