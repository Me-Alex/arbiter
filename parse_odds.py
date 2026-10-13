import json

with open('pariuriplus_odds.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

for item in data[:3]:
    print(f"Name: {item.get('N')}")
    print(f"Length of S array: {len(item.get('S', []))}")
    print(json.dumps(item.get('S', []), indent=2, ensure_ascii=False))
    print('-' * 40)
