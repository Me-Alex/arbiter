from bs4 import BeautifulSoup
import json
import re

def parse_html_deep():
    with open("page_content.html", "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")
        
    # More robust KPI extraction
    kpi_texts = []
    # Look for KPI-like structures: a label followed by a value, or vice-versa
    # A common structure is a div/li containing a label (e.g. "Total Opportunities") and a number value
    # Let's just find the header section and grab its text, then we can do regex if needed
    
    # Try looking for an element containing text like "Total Opportunities", "Avg EV", etc.
    header = soup.select_one('header, .rail, .top-bar, .kpis, #kpis')
    
    # If the user mentioned 5 KPI values, let's find the large text numbers
    # Usually KPIs are in h1-h4 tags or divs with specific classes
    # Let's just try to find 5 distinct numbers in the upper part of the page
    
    # Find cards more specifically
    # Often arbitrage/middle are differentiated by text or badges inside the card
    arbitrage_count = 0
    middle_count = 0
    
    cards = soup.select('.card, [class*="card"], [class*="Item"], article')
    
    for card in cards:
        text = card.get_text().lower()
        if 'arbitrage' in text or 'arb' in text:
            arbitrage_count += 1
        if 'middle' in text:
            middle_count += 1
            
    print(f"Cards found matching 'arbitrage': {arbitrage_count}")
    print(f"Cards found matching 'middle': {middle_count}")
    
    # Let's print out the first few elements that look like they hold numbers to find the KPIs
    print("--- POTENTIAL KPIS ---")
    elements_with_numbers = soup.find_all(string=re.compile(r'^[0-9.,%+\-]+$'))
    for elem in elements_with_numbers:
        parent = elem.parent
        # Look for a label nearby
        label = ""
        for sibling in parent.previous_siblings:
            if sibling.name and sibling.get_text(strip=True):
                label = sibling.get_text(strip=True)
                break
        if not label:
            for sibling in parent.next_siblings:
                if sibling.name and sibling.get_text(strip=True):
                    label = sibling.get_text(strip=True)
                    break
                    
        if label or len(elem.strip()) > 0:
            print(f"Label/Context: {label} -> Value: {elem.strip()}")

if __name__ == "__main__":
    parse_html_deep()