import requests
import json

response = requests.get('https://0sv1b7rb5285.space.mcode.io/api/scan')
print(f"Status Code: {response.status_code}")
print("Headers:")
for k, v in response.headers.items():
    print(f"  {k}: {v}")
print("\nBody (first 500 chars):")
print(response.text[:500])
