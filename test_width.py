import asyncio
import http.server
import socketserver
import threading
import os
from playwright.async_api import async_playwright

PORT = 9986
os.chdir('public')
handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()

async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        
        for w, h in [(1920, 1080), (2560, 1440)]:
            page = await browser.new_page(viewport={'width': w, 'height': h})
            await page.goto(f'http://127.0.0.1:{PORT}/admin/arbitrage.html')
            await page.wait_for_timeout(500)
            
            before = await page.evaluate('''() => {
                const main = document.querySelector("main");
                return {
                    width: main.offsetWidth,
                    maxWidth: window.getComputedStyle(main).maxWidth,
                    rightEdge: main.getBoundingClientRect().right
                };
            }''')
            print(f'Viewport {w}x{h} BEFORE:')
            print(f'  Main width: {before["width"]}, maxWidth: {before["maxWidth"]}, rightEdge: {before["rightEdge"]} (expected {w})')
            
            # Apply fix
            await page.evaluate('''() => {
                const main = document.querySelector("main");
                main.style.maxWidth = "none";
                main.style.width = "calc(100% - var(--sidebar-w, 224px))";
            }''')
            
            after = await page.evaluate('''() => {
                const main = document.querySelector("main");
                return {
                    width: main.offsetWidth,
                    maxWidth: window.getComputedStyle(main).maxWidth,
                    rightEdge: main.getBoundingClientRect().right
                };
            }''')
            print(f'Viewport {w}x{h} AFTER:')
            print(f'  Main width: {after["width"]}, maxWidth: {after["maxWidth"]}, rightEdge: {after["rightEdge"]} (expected {w})')
            
        await browser.close()
    httpd.shutdown()

asyncio.run(test())
