const TRIPS_KEY = "ev-trip-planner-trips-v2";
const SETTINGS_KEY = "ev-trip-planner-settings-v3";
const DRAFT_KEY = "ev-trip-planner-draft-v2";
const LOCATION_KEY = "ev-trip-planner-last-location-v1";

export function loadSettings(defaults) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaults };
    const saved = JSON.parse(raw);
    return {
      ...defaults,
      ...saved,
      networks: { ...defaults.networks, ...(saved.networks ?? {}) },
    };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveDraft(draft) {
  if (!draft) {
    localStorage.removeItem(DRAFT_KEY);
    return;
  }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function loadTrips() {
  try {
    const raw = localStorage.getItem(TRIPS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveTrips(trips) {
  localStorage.setItem(TRIPS_KEY, JSON.stringify(trips));
}

export function saveCommittedTrip(trip) {
  const trips = loadTrips();
  trips.unshift(trip);
  saveTrips(trips.slice(0, 30));
}

export function deleteTrip(tripId) {
  saveTrips(loadTrips().filter((t) => t.id !== tripId));
}

export function loadCachedLocation() {
  try {
    const raw = localStorage.getItem(LOCATION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveCachedLocation(loc) {
  localStorage.setItem(
    LOCATION_KEY,
    JSON.stringify({ ...loc, savedAt: new Date().toISOString() })
  );
}
