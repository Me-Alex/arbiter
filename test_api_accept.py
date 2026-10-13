import requests

headers = {
    'Accept': 'application/json, text/plain, */*'
}
response = requests.get('https://0sv1b7rb5285.space.mcode.io/api/scan', headers=headers)
print(f"Status: {response.status_code}")
print(f"Content-Type: {response.headers.get('content-type')}")
print("Length:", len(response.text))
print(response.text[:200])
