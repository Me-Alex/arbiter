import urllib.request
import json

def fetch_digitain_odds():
    url = "https://sport.winmasters.ro/b73f1f2d-e2da-48b0-a29c-16088b5a6b4f/prematch/gettopevents?sportId=1&count=5&countryCode=RO&langId=42&partnerId=3000235"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json"
    })
    
    try:
        response = urllib.request.urlopen(req)
        print("WINMASTERS DIGITAIN SUCCESS:", response.read().decode("utf-8")[:300])
    except Exception as e:
        print("WINMASTERS DIGITAIN ERROR:", e)

    url2 = "https://sport.kingcasino.ro/60110724-301d-4b7d-9255-0ef71c533840/prematch/gettopevents?sportId=1&count=5&countryCode=RO&langId=42&partnerId=3000245"
    req2 = urllib.request.Request(url2, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json"
    })
    
    try:
        response2 = urllib.request.urlopen(req2)
        print("KINGCASINO DIGITAIN SUCCESS:", response2.read().decode("utf-8")[:300])
    except Exception as e:
        print("KINGCASINO DIGITAIN ERROR:", e)

fetch_digitain_odds()
