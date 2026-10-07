# EV Trip Planner

A personal, mobile-first web app for planning EV road trips with charging stops — then sending the route to **Google Maps** with one tap. Includes **return trip** support.

Your Kettering → Ballston trip is pre-loaded.

## Features

- Add, edit, reorder, and delete stops
- Tag charging stops (Electrify America, ChargePoint)
- **Open in Google Maps** — full route with all waypoints
- **Return trip → Maps** — reversed route without losing your outbound plan
- **Save return as new trip** — edit the drive home separately
- Trips persist in your browser (`localStorage`) — works offline after first load

## Use on your phone

### Option A — GitHub Pages (recommended)

1. Push this repo to GitHub (see below).
2. In the repo: **Settings → Pages → Build from branch → `main` / root**.
3. Open the Pages URL on your phone (e.g. `https://YOUR_USER.github.io/ev-trip-planner/`).
4. **Safari:** Share → **Add to Home Screen**
5. **Chrome:** Menu → **Install app** or **Add to Home screen**

### Option B — Open the file locally

On your PC, double-click `index.html` to use it in a browser. For your phone, GitHub Pages (Option A) is easier.

## Push to GitHub

```powershell
cd C:\Users\janka\Projects\ev-trip-planner
git add -A
git commit -m "Add EV trip planner personal app"
gh repo create ev-trip-planner --public --source=. --push
```

If the repo name is taken, pick another (e.g. `jean-ev-trips`).

## Edit with Cursor on your phone

Open the project in Cursor (same GitHub repo). Edit `app.js` to change defaults, or adjust stops in the app UI while traveling.

## Google Maps behavior

- **Open in Google Maps** builds a multi-stop driving route from your stop list in order.
- On mobile, this should hand off to the Google Maps app.
- **Return trip → Maps** reverses all stops (home becomes destination, etc.).

## Project files

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `app.js` | Trip logic, Google Maps links, storage |
| `styles.css` | Mobile UI |
| `manifest.json` | Install-to-home-screen metadata |
| `sw.js` | Offline cache for road-trip dead zones |
