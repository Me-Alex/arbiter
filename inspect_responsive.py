import asyncio
import http.server
import socketserver
import threading
import os
import sys
from playwright.async_api import async_playwright

PORT = 9988
os.chdir('public')
handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()

async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        
        viewports = [
            ('desktop_1920', 1920, 1080),
            ('laptop_1366', 1366, 768),
            ('tablet_768', 768, 1024),
            ('mobile_375', 375, 667)
        ]
        
        for name, width, height in viewports:
            page = await browser.new_page(viewport={'width': width, 'height': height})
            await page.goto(f'http://127.0.0.1:{PORT}/admin/arbitrage.html')
            await page.wait_for_timeout(1000)
            
            res = await page.evaluate('''() => {
                const main = document.querySelector("main");
                const body = document.body;
                const sidebar = document.querySelector(".sidebar");
                const app = document.querySelector(".app");
                const controls = document.querySelector("section.card");
                const masthead = document.querySelector(".masthead");
                const rail = document.querySelector(".rail");
                return {
                    bodyWidth: body ? body.offsetWidth : 0,
                    mainWidth: main ? main.offsetWidth : 0,
                    mainMaxWidth: main ? window.getComputedStyle(main).maxWidth : "none",
                    mainMarginLeft: main ? window.getComputedStyle(main).marginLeft : "0",
                    sidebarWidth: sidebar ? sidebar.offsetWidth : 0,
                    sidebarVisible: sidebar ? window.getComputedStyle(sidebar).visibility : "none",
                    appWidth: app ? app.offsetWidth : 0,
                    scrollWidth: document.documentElement.scrollWidth,
                    clientWidth: document.documentElement.clientWidth,
                    mastheadWidth: masthead ? masthead.offsetWidth : 0,
                    railWidth: rail ? rail.offsetWidth : 0,
                    controlsWidth: controls ? controls.offsetWidth : 0,
                };
            }''')
            
            print(f"=== {name} ({width}x{height}) ===")
            for k, v in res.items():
                print(f"  {k}: {v}")
            overflow = res["scrollWidth"] > res["clientWidth"]
            print(f"  Horizontal overflow: {overflow}")
            
            await page.screenshot(path=f'../test_{name}.png', full_page=True)

        await browser.close()
    httpd.shutdown()

asyncio.run(test())
