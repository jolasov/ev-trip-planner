const STORAGE_KEY = "ev-trip-planner-trips-v1";

const DEFAULT_TRIP = {
  id: "kettering-ballston-oct-2026",
  name: "Kettering → Ballston (Oct 2026)",
  notes: "Conservative EA plan — long-range Ioniq 5. Target ~30% min arrival at each charger.",
  stops: [
    {
      id: "s1",
      label: "Home",
      address: "4800 Bofield Dr, Kettering, OH 45440",
      type: "start",
      network: null,
      notes: "Leave at 100% if possible",
    },
    {
      id: "s2",
      label: "EA @ Walmart Cambridge",
      address: "61205 Southgate Rd, Cambridge, OH 43725",
      type: "charge",
      network: "ea",
      notes: "Charge to 88–90%. ~165 mi from home.",
    },
    {
      id: "s3",
      label: "EA @ Sheetz Bedford",
      address: "4378 Business 220, Bedford, PA 15522",
      type: "charge",
      network: "ea",
      notes: "85% SOC cap at this site. Charge to 80–85%.",
    },
    {
      id: "s4",
      label: "EA @ Walmart Frederick",
      address: "7400 Guilford Dr, Frederick, MD 21704",
      type: "charge",
      network: "ea",
      notes: "Final charge before DC beltway. Charge to 75–85%.",
    },
    {
      id: "s5",
      label: "Comfort Inn Ballston",
      address: "1211 N Glebe Rd, Arlington, VA 22201",
      type: "destination",
      network: null,
      notes: "Arlington, VA — ~5 min walk to Ballston Metro",
    },
  ],
  createdAt: "2026-10-07T15:35:00.000Z",
  updatedAt: "2026-10-07T15:35:00.000Z",
};

const state = {
  view: "list",
  trips: [],
  activeTripId: null,
  editingStopId: null,
};

const $ = (sel) => document.querySelector(sel);

const els = {
  main: $("#main"),
  pageTitle: $("#page-title"),
  pageSubtitle: $("#page-subtitle"),
  backBtn: $("#back-btn"),
  bottomNav: $("#bottom-nav"),
  mapsBtn: $("#maps-btn"),
  returnMapsBtn: $("#return-maps-btn"),
  copyLinkBtn: $("#copy-link-btn"),
  toast: $("#toast"),
  stopDialog: $("#stop-dialog"),
  stopForm: $("#stop-form"),
  stopDialogTitle: $("#stop-dialog-title"),
  stopLabel: $("#stop-label"),
  stopAddress: $("#stop-address"),
  stopType: $("#stop-type"),
  stopNetwork: $("#stop-network"),
  stopNotes: $("#stop-notes"),
  networkLabel: $("#network-label"),
  stopCancel: $("#stop-cancel"),
};

function uid() {
  return crypto.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadTrips() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [structuredClone(DEFAULT_TRIP)];
    const trips = JSON.parse(raw);
    return Array.isArray(trips) && trips.length ? trips : [structuredClone(DEFAULT_TRIP)];
  } catch {
    return [structuredClone(DEFAULT_TRIP)];
  }
}

function saveTrips() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.trips));
}

function getActiveTrip() {
  return state.trips.find((t) => t.id === state.activeTripId) ?? null;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => els.toast.classList.add("hidden"), 2200);
}

function encodeAddress(address) {
  return encodeURIComponent(address.trim());
}

function buildGoogleMapsUrl(stops, { reverse = false } = {}) {
  const ordered = reverse ? [...stops].reverse() : [...stops];
  const addresses = ordered.map((s) => s.address.trim()).filter(Boolean);
  if (addresses.length < 2) return null;

  const path = addresses.map(encodeAddress).join("/");
  return `https://www.google.com/maps/dir/${path}`;
}

function buildGoogleMapsApiUrl(stops, { reverse = false } = {}) {
  const ordered = reverse ? [...stops].reverse() : [...stops];
  const addresses = ordered.map((s) => s.address.trim()).filter(Boolean);
  if (addresses.length < 2) return null;

  const origin = addresses[0];
  const destination = addresses[addresses.length - 1];
  const waypoints = addresses.slice(1, -1);

  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
    travelmode: "driving",
  });
  if (waypoints.length) params.set("waypoints", waypoints.join("|"));

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function openGoogleMaps(stops, { reverse = false } = {}) {
  const url = buildGoogleMapsUrl(stops, { reverse });
  if (!url) {
    showToast("Add at least a start and destination");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function copyGoogleMapsLink(stops, { reverse = false } = {}) {
  const url = buildGoogleMapsUrl(stops, { reverse });
  if (!url) {
    showToast("Add at least a start and destination");
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast(reverse ? "Return trip link copied" : "Google Maps link copied");
  } catch {
    showToast("Could not copy — try Open in Google Maps");
  }
}

function createReturnTrip(trip) {
  const reversedStops = [...trip.stops].reverse().map((stop, index, arr) => {
    let type = stop.type;
    if (index === 0) type = "start";
    else if (index === arr.length - 1) type = "destination";
    else if (stop.type === "start" || stop.type === "destination") type = "waypoint";
    return { ...stop, id: uid(), type };
  });

  return {
    id: uid(),
    name: `${trip.name} (return)`,
    notes: trip.notes ? `Return leg — ${trip.notes}` : "Return leg",
    stops: reversedStops,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function typeLabel(type) {
  return (
    {
      start: "Start",
      charge: "Charge",
      waypoint: "Waypoint",
      destination: "Destination",
    }[type] ?? "Stop"
  );
}

function networkLabel(network) {
  return (
    {
      ea: "Electrify America",
      chargepoint: "ChargePoint",
      other: "Other network",
    }[network] ?? null
  );
}

function summarizeTrip(trip) {
  const start = trip.stops.find((s) => s.type === "start") ?? trip.stops[0];
  const end =
    trip.stops.find((s) => s.type === "destination") ?? trip.stops[trip.stops.length - 1];
  const charges = trip.stops.filter((s) => s.type === "charge").length;
  return `${start?.label ?? "Start"} → ${end?.label ?? "End"} · ${trip.stops.length} stops · ${charges} charge${charges === 1 ? "" : "s"}`;
}

function renderList() {
  state.view = "list";
  els.pageTitle.textContent = "EV Trip Planner";
  els.pageSubtitle.textContent = "Plan stops · Open in Google Maps";
  els.backBtn.classList.add("hidden");
  els.bottomNav.classList.add("hidden");

  const cards = state.trips
    .map(
      (trip) => `
      <article class="trip-card" data-trip-id="${trip.id}">
        <h3>${escapeHtml(trip.name)}</h3>
        <p>${escapeHtml(summarizeTrip(trip))}</p>
        <div class="trip-card-actions">
          <button class="primary-btn" data-action="edit">Edit</button>
          <button class="secondary-btn" data-action="maps">Maps</button>
        </div>
      </article>`
    )
    .join("");

  els.main.innerHTML = `
    <p class="section-title">Your trips</p>
    ${cards || `<div class="empty-state">No trips yet.</div>`}
    <button id="new-trip-btn" class="primary-btn" type="button" style="margin-top:8px">+ New trip</button>
    <div class="hint-box">
      <strong>On your phone:</strong> open this page in Safari/Chrome, tap Share → <strong>Add to Home Screen</strong> for a quick app icon. Trips save on this device automatically.
    </div>
  `;

  $("#new-trip-btn").addEventListener("click", createBlankTrip);

  els.main.querySelectorAll(".trip-card").forEach((card) => {
    const tripId = card.dataset.tripId;
    card.querySelector('[data-action="edit"]').addEventListener("click", () => openTrip(tripId));
    card.querySelector('[data-action="maps"]').addEventListener("click", () => {
      const trip = state.trips.find((t) => t.id === tripId);
      if (trip) openGoogleMaps(trip.stops);
    });
  });
}

function renderEditor() {
  const trip = getActiveTrip();
  if (!trip) return renderList();

  state.view = "editor";
  els.pageTitle.textContent = trip.name || "Untitled trip";
  els.pageSubtitle.textContent = `${trip.stops.length} stops`;
  els.backBtn.classList.remove("hidden");
  els.bottomNav.classList.remove("hidden");

  const stopItems = trip.stops
    .map(
      (stop, index) => `
      <article class="stop-item" data-stop-id="${stop.id}">
        <div class="stop-index">${index + 1}</div>
        <div class="stop-body">
          <h4>${escapeHtml(stop.label)}</h4>
          <p>${escapeHtml(stop.address)}</p>
          ${stop.notes ? `<p style="margin-top:6px">${escapeHtml(stop.notes)}</p>` : ""}
          <div class="stop-meta">
            <span class="badge badge-${stop.type}">${typeLabel(stop.type)}</span>
            ${stop.network ? `<span class="badge badge-${stop.network}">${networkLabel(stop.network)}</span>` : ""}
          </div>
        </div>
        <div class="stop-controls">
          <button type="button" data-move="up" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-move="down" aria-label="Move down" ${index === trip.stops.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="edit" aria-label="Edit">✎</button>
          <button type="button" class="delete-btn" data-action="delete" aria-label="Delete">✕</button>
        </div>
      </article>`
    )
    .join("");

  els.main.innerHTML = `
    <input class="trip-name-input" id="trip-name" value="${escapeAttr(trip.name)}" placeholder="Trip name" />
    <p class="section-title">Stops in order</p>
    <div class="stop-list">${stopItems}</div>
    <button id="add-stop-btn" class="secondary-btn" type="button" style="width:100%;margin-top:12px">+ Add stop</button>
    <div class="hint-box">
      <strong>Return trip:</strong> use the bottom bar to open the reversed route in Google Maps, or save it as a new trip to edit.
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button id="save-return-btn" class="chip-btn" type="button">Save return as new trip</button>
        <button id="delete-trip-btn" class="chip-btn" type="button" style="color:var(--danger)">Delete trip</button>
      </div>
    </div>
  `;

  $("#trip-name").addEventListener("input", (e) => {
    trip.name = e.target.value;
    trip.updatedAt = new Date().toISOString();
    els.pageTitle.textContent = trip.name || "Untitled trip";
    saveTrips();
  });

  $("#add-stop-btn").addEventListener("click", () => openStopDialog());
  $("#save-return-btn").addEventListener("click", () => {
    const returnTrip = createReturnTrip(trip);
    state.trips.unshift(returnTrip);
    saveTrips();
    openTrip(returnTrip.id);
    showToast("Return trip saved — edit anytime");
  });
  $("#delete-trip-btn").addEventListener("click", () => {
    if (!confirm(`Delete "${trip.name}"?`)) return;
    state.trips = state.trips.filter((t) => t.id !== trip.id);
    saveTrips();
    state.activeTripId = null;
    renderList();
  });

  els.main.querySelectorAll(".stop-item").forEach((item) => {
    const stopId = item.dataset.stopId;
    item.querySelector('[data-move="up"]')?.addEventListener("click", () => moveStop(stopId, -1));
    item.querySelector('[data-move="down"]')?.addEventListener("click", () => moveStop(stopId, 1));
    item.querySelector('[data-action="edit"]').addEventListener("click", () => openStopDialog(stopId));
    item.querySelector('[data-action="delete"]').addEventListener("click", () => deleteStop(stopId));
  });
}

function render() {
  if (state.view === "editor") renderEditor();
  else renderList();
}

function openTrip(tripId) {
  state.activeTripId = tripId;
  renderEditor();
}

function createBlankTrip() {
  const trip = {
    id: uid(),
    name: "New trip",
    notes: "",
    stops: [
      {
        id: uid(),
        label: "Start",
        address: "",
        type: "start",
        network: null,
        notes: "",
      },
      {
        id: uid(),
        label: "Destination",
        address: "",
        type: "destination",
        network: null,
        notes: "",
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.trips.unshift(trip);
  saveTrips();
  openTrip(trip.id);
}

function moveStop(stopId, direction) {
  const trip = getActiveTrip();
  if (!trip) return;
  const index = trip.stops.findIndex((s) => s.id === stopId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= trip.stops.length) return;
  const [item] = trip.stops.splice(index, 1);
  trip.stops.splice(next, 0, item);
  trip.updatedAt = new Date().toISOString();
  saveTrips();
  renderEditor();
}

function deleteStop(stopId) {
  const trip = getActiveTrip();
  if (!trip || trip.stops.length <= 2) {
    showToast("Keep at least 2 stops");
    return;
  }
  trip.stops = trip.stops.filter((s) => s.id !== stopId);
  trip.updatedAt = new Date().toISOString();
  saveTrips();
  renderEditor();
}

function openStopDialog(stopId = null) {
  const trip = getActiveTrip();
  if (!trip) return;

  state.editingStopId = stopId;
  const stop = stopId ? trip.stops.find((s) => s.id === stopId) : null;

  els.stopDialogTitle.textContent = stop ? "Edit stop" : "Add stop";
  els.stopLabel.value = stop?.label ?? "";
  els.stopAddress.value = stop?.address ?? "";
  els.stopType.value = stop?.type ?? "waypoint";
  els.stopNetwork.value = stop?.network ?? "";
  els.stopNotes.value = stop?.notes ?? "";
  toggleNetworkField();

  els.stopDialog.showModal();
  els.stopLabel.focus();
}

function toggleNetworkField() {
  const isCharge = els.stopType.value === "charge";
  els.networkLabel.classList.toggle("hidden", !isCharge);
}

function saveStopFromDialog() {
  const trip = getActiveTrip();
  if (!trip) return;

  const data = {
    label: els.stopLabel.value.trim(),
    address: els.stopAddress.value.trim(),
    type: els.stopType.value,
    network: els.stopType.value === "charge" ? els.stopNetwork.value || null : null,
    notes: els.stopNotes.value.trim(),
  };

  if (state.editingStopId) {
    const stop = trip.stops.find((s) => s.id === state.editingStopId);
    if (stop) Object.assign(stop, data);
  } else {
    trip.stops.push({ id: uid(), ...data });
  }

  trip.updatedAt = new Date().toISOString();
  saveTrips();
  state.editingStopId = null;
  renderEditor();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(str) {
  return escapeHtml(str).replaceAll("'", "&#39;");
}

function bindGlobalEvents() {
  els.backBtn.addEventListener("click", () => {
    state.activeTripId = null;
    renderList();
  });

  els.mapsBtn.addEventListener("click", () => {
    const trip = getActiveTrip();
    if (trip) openGoogleMaps(trip.stops);
  });

  els.returnMapsBtn.addEventListener("click", () => {
    const trip = getActiveTrip();
    if (trip) openGoogleMaps(trip.stops, { reverse: true });
  });

  els.copyLinkBtn.addEventListener("click", () => {
    const trip = getActiveTrip();
    if (trip) copyGoogleMapsLink(trip.stops);
  });

  els.stopType.addEventListener("change", toggleNetworkField);

  els.stopCancel.addEventListener("click", () => {
    state.editingStopId = null;
    els.stopDialog.close();
  });

  els.stopForm.addEventListener("submit", (e) => {
    e.preventDefault();
    saveStopFromDialog();
    els.stopDialog.close();
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function init() {
  state.trips = loadTrips();
  bindGlobalEvents();
  registerServiceWorker();
  renderList();
}

init();
