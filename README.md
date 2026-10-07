# EV Trip Planner

Personal mobile web app for **conservative EV road-trip planning** — set your real-world range, pick charging networks, choose stops with guardrails, then **commit to Google Maps**.

**Live:** [https://jolasov.github.io/ev-trip-planner/](https://jolasov.github.io/ev-trip-planner/)

## Features

### Plan from scratch (nothing pre-loaded)
- **Home** shortcut defaults start to `4800 Bofield Dr, Kettering, OH` — change anytime
- Any start / destination
- **Starting battery %**, real-world full range, range-comfort slider
- **Network filters:** Electrify America, ChargePoint, Other (OpenStreetMap)
- **Max detour** off the driving route for each candidate charger
- Finds chargers along your route, shows **mile marker + detour distance**
- **Auto-selects** a conservative stop sequence; toggle stops manually
- **Timeline** with estimated arrival SOC at each leg
- **Guardrails:** won't let you commit a plan that violates your minimum SOC rules
- **Total time estimate:** driving + charging

### On the road
- **Reset from current location** — GPS start + enter current battery %, re-route to destination

### Commit
- Saves trip locally
- Opens full multi-stop route in **Google Maps**
- **Saved** tab for past trips + return → Maps

## Phone install

Open the live URL → **Add to Home Screen** (Safari) or **Install app** (Chrome).

## Data sources (free, no API keys)

- **Routing:** OSRM
- **Geocoding:** OpenStreetMap Nominatim
- **Chargers:** OpenStreetMap via Overpass

Station coverage depends on OSM data quality. Always verify chargers in the Electrify America / ChargePoint app before committing.

## Local development

Static site — open `index.html` or serve the folder with any static server. ES modules require http(s), not `file://`.

## Repo

```powershell
cd C:\Users\janka\Projects\ev-trip-planner
git pull
```

Changes push to GitHub Pages automatically on `main`.
