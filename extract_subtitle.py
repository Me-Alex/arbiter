import re
from bs4 import BeautifulSoup

def clean_subtitle():
    with open("page_content.html", "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")
        
    # Find the specific node with "captured 2h ago"
    text_nodes = soup.find_all(string=re.compile("captured.*ago"))
    for node in text_nodes:
        print(f"Exact match node text: {node.strip()}")
        parent = node.parent
        print(f"Parent full text: {parent.get_text(strip=True)}")

if __name__ == "__main__":
    clean_subtitle()