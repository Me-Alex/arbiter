import asyncio
import http.server
import socketserver
import threading
import os
from playwright.async_api import async_playwright

PORT = 9987
os.chdir('public')
handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()

async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 375, 'height': 667})
        await page.goto(f'http://127.0.0.1:{PORT}/admin/arbitrage.html')
        await page.wait_for_timeout(500)
        
        sw1 = await page.evaluate('document.documentElement.scrollWidth')
        cw1 = await page.evaluate('document.documentElement.clientWidth')
        print(f'Before fix on mobile: scrollWidth={sw1}, clientWidth={cw1}, overflow={sw1 > cw1}')
        
        await page.evaluate('''() => {
            const seg = document.querySelector('.segmented');
            if (seg) {
                seg.style.maxWidth = '100%';
                seg.style.overflowX = 'auto';
            }
        }''')
        
        sw2 = await page.evaluate('document.documentElement.scrollWidth')
        cw2 = await page.evaluate('document.documentElement.clientWidth')
        print(f'After segmented fix: scrollWidth={sw2}, clientWidth={cw2}, overflow={sw2 > cw2}')
        
        await browser.close()
    httpd.shutdown()

asyncio.run(test())
