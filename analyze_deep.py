import asyncio
from playwright.async_api import async_playwright
import json
import sys

async def analyze_site(url, out_file):
    print(f"Analyzing {url} with deeper interaction...")
    xhr_urls = []
    html_content = ""
    
    async def handle_response(response):
        try:
            req_url = response.url
            if response.request.resource_type in ["xhr", "fetch"]:
                xhr_urls.append(req_url)
        except Exception:
            pass

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        page = await context.new_page()
        page.on("response", handle_response)
        
        try:
            await page.goto(url, wait_until="networkidle", timeout=60000)
            await page.wait_for_timeout(10000)
            
            # Click around to trigger sportsbook APIs if they are hidden behind tabs
            # Look for common sports links
            sports_links = await page.locator("text=/Pariuri sportive/i | text=/Sports/i | text=/Sport/i").all()
            if sports_links:
                for link in sports_links[:2]:
                    try:
                        await link.click(timeout=3000)
                        await page.wait_for_timeout(5000)
                    except Exception:
                        pass
                        
            # Scroll down to trigger lazy load APIs
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(5000)
            
            html_content = await page.content()
            
        except Exception as e:
            print(f"Error: {e}")
            
        await browser.close()
        
        filtered_xhr = [u for u in xhr_urls if "cloudflare" not in u and "google-analytics" not in u]
        
        result = {
            "xhr_urls": list(set(filtered_xhr))
        }
        
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=4)
        print(f"Saved to {out_file}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)
    asyncio.run(analyze_site(sys.argv[1], sys.argv[2]))