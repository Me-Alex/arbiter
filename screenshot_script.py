import asyncio
from playwright.async_api import async_playwright
import os

async def main():
    async with async_playwright() as p:
        # Launch browser
        browser = await p.chromium.launch()
        page = await browser.new_page()
        
        # Track console errors
        errors = []
        page.on("pageerror", lambda err: errors.append(f"PageError: {err.message}"))
        page.on("console", lambda msg: errors.append(f"ConsoleError: {msg.text}") if msg.type == "error" else None)
        
        print("Navigating to http://127.0.0.1:3022/admin/arbitrage.html ...")
        await page.goto("http://127.0.0.1:3022/admin/arbitrage.html")
        
        # Wait for data to load and render
        print("Waiting 10 seconds for API data to populate...")
        await page.wait_for_timeout(10000)
        
        # Define paths
        full_path = os.path.abspath("full_page_screenshot.png")
        view_path = os.path.abspath("viewport_screenshot.png")
        
        # Take screenshots
        await page.screenshot(path=full_path, full_page=True)
        await page.screenshot(path=view_path, full_page=False)
        
        print(f"Full-page screenshot URL/Path: {full_path}")
        print(f"Viewport screenshot URL/Path: {view_path}")
        
        print("--- CONSOLE ERRORS ---")
        if not errors:
            print("No console errors detected.")
        for e in errors:
            print(e)
        print("----------------------")
        
        # Save HTML for analysis
        html = await page.content()
        with open("page_content.html", "w", encoding="utf-8") as f:
            f.write(html)
            
        print("HTML content saved to page_content.html")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())