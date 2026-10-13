import asyncio
import http.server
import socketserver
import threading
import os
from playwright.async_api import async_playwright

PORT = 9989
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
        await page.wait_for_timeout(1000)
        
        overflowing = await page.evaluate('''() => {
            const docWidth = document.documentElement.clientWidth;
            const elements = document.querySelectorAll('*');
            const bad = [];
            elements.forEach(el => {
                const rect = el.getBoundingClientRect();
                if (rect.right > docWidth + 1 || rect.width > docWidth + 1) {
                    bad.push({
                        tag: el.tagName,
                        id: el.id,
                        className: el.className,
                        width: Math.round(rect.width),
                        right: Math.round(rect.right),
                        text: (el.innerText || '').slice(0, 30)
                    });
                }
            });
            return bad;
        }''')
        
        print("Overflowing elements on 375px mobile:")
        for item in overflowing[:30]:
            print(item)
            
        await browser.close()
    httpd.shutdown()

asyncio.run(test())
