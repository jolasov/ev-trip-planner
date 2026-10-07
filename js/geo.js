import {
  buildCumulativeDistances,
  detectNetwork,
  routeDistanceAtPoint,
  networkLabel,
} from "./util.js";

const UA = "EVTripPlanner/2.0 (personal; github.com/jolasov/ev-trip-planner)";

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

function routeBbox(polyline, bufferMi) {
  const bufferDeg = bufferMi / 69;
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const p of polyline) {
    south = Math.min(south, p.lat - bufferDeg);
    north = Math.max(north, p.lat + bufferDeg);
    west = Math.min(west, p.lon - bufferDeg);
    east = Math.max(east, p.lon + bufferDeg);
  }
  return { south, west, north, east };
}

function uidFromCoords(lat, lon) {
  return `cs-${lat.toFixed(4)}-${lon.toFixed(4)}`;
}

export async function fetchChargingCandidates(polyline, { maxDetourMi, networks }) {
  const { south, west, north, east } = routeBbox(polyline, maxDetourMi + 2);
  const query = `
[out:json][timeout:90];
(
  node["amenity"="charging_station"](${south},${west},${north},${east});
  way["amenity"="charging_station"](${south},${west},${north},${east});
);
out center tags;
`;

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: query,
  });
  if (!res.ok) throw new Error("Charging station lookup failed");
  const data = await res.json();

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

  return candidates
    .map((c) => {
      const snap = routeDistanceAtPoint(polyline, cum, c);
      return {
        ...c,
        routeMi: snap.distAlong,
        detourMi: snap.offRoute,
        mapLabel: `${c.name} (${networkLabel(c.network)})`,
      };
    })
    .filter((c) => c.detourMi <= maxDetourMi)
    .sort((a, b) => a.routeMi - b.routeMi);
}

export async function getCurrentPosition() {
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
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}
