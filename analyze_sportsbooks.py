import asyncio
from playwright.async_api import async_playwright
import json

async def analyze_site(url):
    print(f"Analyzing {url}...")
    xhr_urls = []
    
    async def handle_response(response):
        try:
            req_url = response.url
            if response.request.resource_type in ["xhr", "fetch"]:
                xhr_urls.append(req_url)
        except Exception as e:
            pass

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()
        page.on("response", handle_response)
        
        try:
            await page.goto(url, wait_until="networkidle", timeout=30000)
            # wait a bit for dynamic content
            await page.wait_for_timeout(10000)
        except Exception as e:
            print(f"Error loading {url}: {e}")
            
        content = await page.content()
        title = await page.title()
        
        await browser.close()
        
        return {
            "title": title,
            "html_length": len(content),
            "xhr_urls": xhr_urls
        }

async def main():
    sites = [
        "https://winmasters.ro",
        "https://pariuriplus.ro",
        "https://kingcasino.ro",
        "https://betfair.ro"
    ]
    
    results = {}
    for site in sites:
        res = await analyze_site(site)
        results[site] = res
        
    with open("E:/AI Folder Projects/arbiter/sportsbook_analysis.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=4)
        
    print("Analysis saved to sportsbook_analysis.json")

if __name__ == "__main__":
    asyncio.run(main())
