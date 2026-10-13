import json
from bs4 import BeautifulSoup

def extract_final_report():
    with open("page_content.html", "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")
        
    # Get subtitle
    subtitle = soup.select_one('.masthead-subtitle, header p, .page-subtitle, [class*="subtitle"], [class*="masthead"]')
    subtitle_text = subtitle.get_text(strip=True) if subtitle else "Not found"
    
    # We saw these values in the console output matching the KPIs:
    # Label/Context: Bankroll -> Value: 1,000
    # Label/Context: Arbitrages -> Value: 2
    # Label/Context: Guaranteed Profit -> Value: +45.28
    # Label/Context: Middles -> Value: 6,186
    # Label/Context: Positive EV -> Value: 19,773
    
    # The actual cards found were:
    # Arbitrage: 1 (But the KPI says 2? Let's check card counts based on data attributes if possible)
    arb_cards = soup.select('[data-type="arbitrage"], .arbitrage-card, .arb-card, [class*="ArbCard"]')
    mid_cards = soup.select('[data-type="middle"], .middle-card, .mid-card, [class*="MiddleCard"]')
    
    # Let's count cards by header text
    all_cards = soup.select('article, .card, [class*="card"]')
    actual_arb_count = 0
    actual_mid_count = 0
    
    for c in all_cards:
        t = c.get_text().lower()
        # look for badges or specific text indicating the type
        if 'arbitrage' in t or 'arb ' in t or '>arb<' in t:
            actual_arb_count += 1
        elif 'middle' in t or '>mid<' in t:
            actual_mid_count += 1
            
    print(f"Subtitle text: {subtitle_text}")
    print(f"Total cards evaluated: {len(all_cards)}")

if __name__ == "__main__":
    extract_final_report()