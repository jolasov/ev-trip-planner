import {
  buildCumulativeDistances,
  detectNetwork,
  routeDistanceAtPoint,
  networkLabel,
  haversineMi,
} from "./util.js";

const UA = "EVTripPlanner/2.0 (personal; github.com/jolasov/ev-trip-planner)";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");

  const res = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": UA } });
  if (!res.ok) throw new Error("Geocoding failed");
  const data = await res.json();
  if (!data.length) throw new Error(`Could not find: ${query}`);
  const hit = data[0];
  return {
    label: hit.display_name.split(",").slice(0, 2).join(", "),
    address: hit.display_name,
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
  };
}

export async function reverseGeocode(lat, lon) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lon);
  url.searchParams.set("format", "json");

  const res = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": UA } });
  if (!res.ok) throw new Error("Reverse geocoding failed");
  const hit = await res.json();
  return {
    label: "Current location",
    address: hit.display_name,
    lat,
    lon,
  };
}

export async function fetchRoute(waypoints) {
  const coordStr = waypoints.map((w) => `${w.lon},${w.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Routing failed");
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.[0]) throw new Error("No driving route found");

  const route = data.routes[0];
  const polyline = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  return {
    polyline,
    totalMi: route.distance / 1609.344,
    driveMin: route.duration / 60,
  };
}

function uidFromCoords(lat, lon) {
  return `cs-${lat.toFixed(3)}-${lon.toFixed(3)}`;
}

function normalizeStationName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function dedupeStations(stations) {
  const kept = [];

  for (const station of stations) {
    const duplicate = kept.find((existing) => {
      const dist = haversineMi(existing, station);
      if (dist < 0.35) return true;
      const a = normalizeStationName(existing.name);
      const b = normalizeStationName(station.name);
      return a && a === b && dist < 1.5;
    });

    if (!duplicate) {
      kept.push(station);
      continue;
    }

    if (station.detourMi != null && station.detourMi < duplicate.detourMi) {
      Object.assign(duplicate, station, { id: duplicate.id });
    }
  }

  return kept;
}

function pointAtDistance(polyline, cum, targetMi) {
  if (targetMi <= 0) return polyline[0];
  const total = cum[cum.length - 1];
  if (targetMi >= total) return polyline[polyline.length - 1];

  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= targetMi) {
      const span = cum[i] - cum[i - 1];
      const t = span > 0 ? (targetMi - cum[i - 1]) / span : 0;
      return {
        lat: polyline[i - 1].lat + t * (polyline[i].lat - polyline[i - 1].lat),
        lon: polyline[i - 1].lon + t * (polyline[i].lon - polyline[i - 1].lon),
      };
    }
  }
  return polyline[polyline.length - 1];
}

function sampleRoutePoints(polyline, intervalMi = 40) {
  const cum = buildCumulativeDistances(polyline);
  const total = cum[cum.length - 1];
  const points = [polyline[0]];

  for (let d = intervalMi; d < total; d += intervalMi) {
    points.push(pointAtDistance(polyline, cum, d));
  }

  const last = polyline[polyline.length - 1];
  const prev = points[points.length - 1];
  if (haversineMi(prev, last) > 5) points.push(last);

  return points;
}

function buildOverpassQuery(samplePoints, radiusM) {
  const aroundClauses = samplePoints
    .map(
      (p) => `
  node["amenity"="charging_station"](around:${radiusM},${p.lat},${p.lon});
  way["amenity"="charging_station"](around:${radiusM},${p.lat},${p.lon});`
    )
    .join("");

  return `[out:json][timeout:60];(${aroundClauses});out center tags;`;
}

async function queryOverpass(query) {
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (data.remark && !data.elements?.length) {
        lastErr = new Error(data.remark);
        continue;
      }
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Charging station lookup failed");
}

export async function fetchChargingCandidates(polyline, { maxDetourMi, networks }) {
  const radiusM = Math.round(Math.max(maxDetourMi + 2, 5) * 1609.34);
  const samplePoints = sampleRoutePoints(polyline, 40);
  const query = buildOverpassQuery(samplePoints, radiusM);
  const data = await queryOverpass(query);

  const enabled = new Set(
    Object.entries(networks)
      .filter(([, on]) => on)
      .map(([k]) => k)
  );

  const seen = new Set();
  const candidates = [];

  for (const el of data.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const tags = el.tags ?? {};
    const network = detectNetwork(tags);
    if (!network || !enabled.has(network)) continue;

    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = tags.name || tags.operator || tags.brand || tags.network || "Charging station";

    candidates.push({
      id: uidFromCoords(lat, lon),
      name,
      lat,
      lon,
      network,
      address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      osmTags: tags,
    });
  }

  return candidates;
}

export function enrichCandidates(candidates, polyline, maxDetourMi) {
  const cum = buildCumulativeDistances(polyline);

  const enriched = candidates
    .map((c) => {
      const snap = routeDistanceAtPoint(polyline, cum, c);
      return {
        ...c,
        id: uidFromCoords(c.lat, c.lon),
        routeMi: snap.distAlong,
        detourMi: snap.offRoute,
        mapLabel: `${c.name} (${networkLabel(c.network)})`,
      };
    })
    .filter((c) => c.detourMi <= maxDetourMi);

  return dedupeStations(enriched).sort((a, b) => a.routeMi - b.routeMi);
}

export async function getCurrentPosition({ maximumAge = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        }),
      (err) => reject(new Error(err.message || "Could not get location")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge }
    );
  });
}
