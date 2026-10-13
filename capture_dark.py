import os
import time
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = context.new_page()
        
        print("Navigating to http://127.0.0.1:3022/admin/arbitrage.html...")
        page.goto('http://127.0.0.1:3022/admin/arbitrage.html')
        
        print("Waiting 15 seconds for ~23MB KPI data to load...")
        page.wait_for_timeout(15000)
        
        print("Attempting to set dark theme...")
        try:
            # Try finding the data-theme-choice element and selecting 'dark'
            dropdown = page.locator('[data-theme-choice]')
            if dropdown.count() > 0:
                print("Found [data-theme-choice] element.")
                dropdown.first.select_option('dark')
                page.wait_for_timeout(2000)
            else:
                print("Could not find [data-theme-choice].")
        except Exception as e:
            print("Select failed:", e)
            
        print("Setting localStorage and forcing attributes just in case...")
        page.evaluate('''() => {
            localStorage.setItem("theme", "dark");
            localStorage.setItem("data-theme", "dark");
            localStorage.setItem("color-theme", "dark");
            document.documentElement.setAttribute("data-theme", "dark");
            document.documentElement.setAttribute("data-bs-theme", "dark");
        }''')
        
        page.wait_for_timeout(3000)
        
        # Check background color to see if we need a reload
        bg = page.evaluate('window.getComputedStyle(document.body).backgroundColor')
        print(f"Body background color is: {bg}")
        # Typical light backgrounds contain high RGB values like 255
        if '255, 255, 255' in bg or '248, 249, 250' in bg:
            print("Background still seems light. Reloading page to apply localStorage...")
            page.reload()
            print("Waiting another 15 seconds for KPI data to reload...")
            page.wait_for_timeout(15000)
            
            # Re-apply attributes just in case it doesn't read localStorage correctly
            page.evaluate('''() => {
                document.documentElement.setAttribute("data-theme", "dark");
                document.documentElement.setAttribute("data-bs-theme", "dark");
            }''')
            page.wait_for_timeout(2000)
            
        print("Capturing viewport screenshot (dark_top.png)...")
        page.screenshot(path=r'E:\AI Folder Projects\arbiter\dark_top.png')
        
        print("Capturing full page screenshot (dark_full.png)...")
        page.screenshot(path=r'E:\AI Folder Projects\arbiter\dark_full.png', full_page=True)
        
        browser.close()
        print("Done!")

if __name__ == '__main__':
    run()