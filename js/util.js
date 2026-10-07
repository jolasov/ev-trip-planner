export function uid() {
  return crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function formatMi(n) {
  return `${Math.round(n)} mi`;
}

export function formatMin(n) {
  const m = Math.round(n);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function formatPct(n) {
  return `${Math.round(n)}%`;
}

const R = 3958.7613;

export function haversineMi(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function pointToSegmentDistanceMi(p, a, b) {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  if (dx === 0 && dy === 0) return haversineMi(p, a);
  const t = clamp(((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy), 0, 1);
  const proj = { lat: a.lat + t * dy, lon: a.lon + t * dx };
  return haversineMi(p, proj);
}

export function distanceToPolylineMi(point, polyline) {
  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    min = Math.min(min, pointToSegmentDistanceMi(point, polyline[i], polyline[i + 1]));
  }
  return min;
}

export function buildCumulativeDistances(polyline) {
  const cum = [0];
  for (let i = 1; i < polyline.length; i++) {
    cum.push(cum[i - 1] + haversineMi(polyline[i - 1], polyline[i]));
  }
  return cum;
}

export function routeDistanceAtPoint(polyline, cumDist, point) {
  let best = { distAlong: 0, offRoute: Infinity };
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const off = pointToSegmentDistanceMi(point, a, b);
    if (off < best.offRoute) {
      const dx = b.lon - a.lon;
      const dy = b.lat - a.lat;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? clamp(((point.lon - a.lon) * dx + (point.lat - a.lat) * dy) / len2, 0, 1) : 0;
      best = { distAlong: cumDist[i] + t * (cumDist[i + 1] - cumDist[i]), offRoute: off };
    }
  }
  return best;
}

export const CHARGE_NETWORKS = [
  { id: "ea", label: "Electrify America", short: "EA", defaultOn: true },
  { id: "chargepoint", label: "ChargePoint", short: "CP", defaultOn: true },
  { id: "evgo", label: "EVgo", short: "EVgo", defaultOn: false },
  {
    id: "tesla",
    label: "Tesla Supercharger",
    short: "Tesla",
    defaultOn: false,
    hint: "CCS adapter required on Ioniq 5",
  },
  { id: "bppulse", label: "BP Pulse", short: "BP Pulse", defaultOn: false },
];

export function defaultNetworkPrefs() {
  return Object.fromEntries(CHARGE_NETWORKS.map((n) => [n.id, n.defaultOn]));
}

export function detectNetwork(tags = {}) {
  const blob = [tags.operator, tags.brand, tags.network, tags.name, tags["operator:wikidata"]]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/electrify\s*america|\bea\b/.test(blob)) return "ea";
  if (/chargepoint|\bcp\b/.test(blob)) return "chargepoint";
  if (/evgo/.test(blob)) return "evgo";
  if (/tesla|supercharger/.test(blob)) return "tesla";
  if (/bp\s*pulse|bppulse|bp\s*pulse/.test(blob)) return "bppulse";
  return null;
}

export function networkLabel(code) {
  const hit = CHARGE_NETWORKS.find((n) => n.id === code);
  return hit?.label ?? code;
}

export function networkShort(code) {
  const hit = CHARGE_NETWORKS.find((n) => n.id === code);
  return hit?.short ?? code;
}

export function googleMapsDirUrl(stops) {
  const pts = stops.map((s) => encodeURIComponent(s.address || `${s.lat},${s.lon}`));
  if (pts.length < 2) return null;
  return `https://www.google.com/maps/dir/${pts.join("/")}`;
}
