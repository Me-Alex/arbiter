import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        console_logs = []
        page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: console_logs.append(f"[pageerror] {err}"))
        
        network_errors = []
        page.on("response", lambda response: network_errors.append(f"{response.status} {response.url}") if not response.ok else None)
        
        requests = []
        page.on("request", lambda req: requests.append(req.url) if "/api/scan" in req.url else None)
        page.on("response", lambda res: console_logs.append(f"[api/scan response] {res.status} {res.url}") if "/api/scan" in res.url else None)

        print("Navigating...")
        try:
            await page.goto("https://p9i0pcmdgw40.space.mcode.io", timeout=60000)
        except Exception as e:
            print(f"Goto error: {e}")

        print("Waiting up to 45 seconds for API call to settle...")
        await page.wait_for_timeout(45000)
        
        print("Taking screenshot...")
        await page.screenshot(path="E:\\AI Folder Projects\\arbiter\\deployed_check.png", full_page=True)
        
        print("Extracting HTML...")
        html_content = await page.content()
        with open("E:\\AI Folder Projects\\arbiter\\page_html.html", "w", encoding="utf-8") as f:
            f.write(html_content)
        
        # Get all text as a fallback
        text_content = await page.evaluate('document.body.innerText')
        with open("E:\\AI Folder Projects\\arbiter\\page_text.txt", "w", encoding="utf-8") as f:
            f.write(text_content)
        
        print("---CONSOLE LOGS---")
        for log in console_logs:
            print(log)
            
        print("---NETWORK ERRORS---")
        for log in network_errors:
            print(log)
            
        print("---API SCAN REQUESTS---")
        for req in requests:
            print(f"Requested: {req}")
            
        print("Done.")
        
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())