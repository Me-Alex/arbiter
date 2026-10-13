# Final Report: Romanian Bookmakers Arbitrage Feed Investigation

## 1. sport.kingcasino.ro

* **Renders real odds (DOM)?**: UNCONFIRMED (Failed to load)
* **Concrete example**: N/A
* **Endpoint URL**: `https://sport.kingcasino.ro/60110724-301d-4b7d-9255-0ef71c533840/prematch/gettopevents?filter=%7B%7D&cultureName=ro-RO&partnerId=3000245&langId=42`
* **Method**: GET
* **Params/Body**: `filter={}`, `cultureName=ro-RO`, `partnerId=3000245`, `langId=42`
* **JSON Shape**: N/A (Likely encrypted `{"payload":"..."}` similar to winmasters/pariuriplus)
* **Confidence**: INFERRED from user context and other Digitain deployments.
* **Notes**: The site is protected by a Cloudflare interstitial that could not be bypassed using automated means (Playwright with stealth plugins). Direct HTTP requests to the odds API return a 403 Forbidden.

## 2. winmasters.ro

* **Renders real odds (DOM)?**: YES
* **Concrete example**: N/A (Payloads are encrypted base64 strings, requiring client-side WASM decryption)
* **Endpoint URL**: `https://sport.winmasters.ro/b73f1f2d-e2da-48b0-a29c-16088b5a6b4f/prematch/gettopevents`
* **Method**: GET
* **Params/Body**: `sportId=1`, `stakeTypes=...`, `count=10`, `countryCode=RO`, `langId=42`, `partnerId=3000235`
* **JSON Shape**: `{"payload": "<encrypted/base64 blob>"}`
* **Confidence**: OBSERVED
* **Notes**: The sportsbook is powered by Digitain, not EveryMatrix as hypothesized. The EveryMatrix endpoints (`/siteapi/*`) serve CMS and UI components only. The actual odds data is encrypted and decrypted in-browser.

## 3. pariuriplus.ro

* **Renders real odds (DOM)?**: YES
* **Concrete example**: Corvinul 1921 Hunedoara - Voluntari (1: 3.05, X: 2.83, 2: 2.46)
* **Endpoint URL**: `https://sport.pariuriplus.ro/d2d48a66-a582-45cc-919d-c0ed8da3a853/account/getsystemcardsbysportid`
* **Method**: GET
* **Params/Body**: `sportId=1`, `tabId=687`, `langId=42`, `partnerId=3000237`, `countryCode=RO`
* **JSON Shape**: Array of event objects.
    * **Team Names**: `HT`/`EHT` (Home Team), `AT`/`EAT` (Away Team), `N`/`EN` (Event Name)
    * **Start Time**: `D` (ISO-8601 UTC string)
    * **Outcome Odds**: Contained within the `S` (Stakes) array. Each selection object has `N`/`EN` (e.g., "1", "X", "2") and `F` (Decimal odds).
* **Confidence**: OBSERVED (Plaintext JSON captured)
* **Notes**: Similar to winmasters, the sportsbook is powered by Digitain. While most odds endpoints return encrypted payloads, certain endpoints like `getsystemcardsbysportid` return plaintext JSON containing real odds data.

## Summary

The investigation revealed that both winmasters.ro and pariuriplus.ro utilize Digitain for their sportsbooks, served via `sport.` subdomains, while employing EveryMatrix for their CMS/Lobby. Obtaining odds data programmatically is challenging due to Cloudflare protection and client-side payload encryption (WASM). However, specific Digitain endpoints (like `getsystemcardsbysportid` on pariuriplus) were found to return plaintext odds data. kingcasino.ro's Cloudflare protection could not be bypassed to confirm its specific endpoints or payload format.
