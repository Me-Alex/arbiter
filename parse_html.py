from bs4 import BeautifulSoup
import json

def parse_html():
    with open("page_content.html", "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")
        
    # Find KPI rail values
    kpis = soup.select('.kpi-value')
    if not kpis:
        # Fallback to look for numbers in typical KPI structures
        kpis = soup.select('.kpi-card h3, .kpi-number, [data-testid="kpi-value"]')
        
    kpi_texts = [kpi.get_text(strip=True) for kpi in kpis]
    
    # Find masthead subtitle
    subtitle = soup.select_one('.masthead-subtitle, header p, .page-subtitle')
    subtitle_text = subtitle.get_text(strip=True) if subtitle else "Not found"
    
    # Find cards
    arbitrage_cards = soup.select('.arbitrage-card, .signal-card[data-type="arbitrage"]')
    middle_cards = soup.select('.middle-card, .signal-card[data-type="middle"]')
    
    # Generic fallback if specific classes aren't used
    all_cards = soup.select('.card, .signal')
    
    results = {
        "kpi_values": kpi_texts,
        "masthead_subtitle": subtitle_text,
        "arbitrage_cards_count": len(arbitrage_cards),
        "middle_cards_count": len(middle_cards),
        "total_generic_cards": len(all_cards)
    }
    
    print(json.dumps(results, indent=2))

if __name__ == "__main__":
    parse_html()