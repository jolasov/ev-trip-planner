import {
  escapeHtml,
  formatMi,
  formatMin,
  formatPct,
  googleMapsDirUrl,
  uid,
  clamp,
  CHARGE_NETWORKS,
} from "./util.js";
import {
  geocode,
  reverseGeocode,
  fetchRoute,
  fetchChargingCandidates,
  enrichCandidates,
  getCurrentPosition,
} from "./geo.js";
import {
  DEFAULT_SETTINGS,
  validatePlan,
  buildCommittedStops,
  maxLegMiFromSoc,
  socAfterLegMi,
} from "./planner.js";
import {
  loadSettings,
  saveSettings,
  loadDraft,
  saveDraft,
  loadTrips,
  saveCommittedTrip,
  deleteTrip,
  loadCachedLocation,
  saveCachedLocation,
} from "./storage.js";

export const APP_VERSION = "1.8";
import { speechSupported, listenForSpeech } from "./voice.js";

const state = {
  view: "plan",
  settings: loadSettings(DEFAULT_SETTINGS),
  draft: loadDraft(),
  trips: loadTrips(),
  loading: false,
  error: null,
};

const $ = (sel) => document.querySelector(sel);

function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2600);
}

function setLoading(on, msg = "Working…") {
  state.loading = on;
  const el = $("#loading");
  if (el) {
    el.classList.toggle("hidden", !on);
    el.querySelector(".loading-text").textContent = msg;
  }
}

function readFormParams() {
  return {
    ...state.settings,
    startText: $("#start-input").value.trim(),
    endText: $("#end-input").value.trim(),
    startSoc: parseInt($("#start-soc").value, 10),
    fullRangeMi: parseInt($("#full-range").value, 10),
    rangeComfortMi: parseInt($("#range-comfort").value, 10),
    maxDetourMi: parseFloat($("#max-detour").value),
    chargeTargetSoc: parseInt($("#charge-target").value, 10),
    minArrivalSoc: parseInt($("#min-arrival").value, 10),
    minDestinationSoc: parseInt($("#min-dest").value, 10),
    chargeMinPerStop: parseInt($("#charge-minutes").value, 10),
    networks: Object.fromEntries(
      CHARGE_NETWORKS.map((n) => [`${n.id}`, $(`#net-${n.id}`)?.checked ?? false])
    ),
  };
}

function anyNetworkSelected(networks) {
  return CHARGE_NETWORKS.some((n) => networks[n.id]);
}

function persistSettingsFromForm() {
  const p = readFormParams();
  state.settings = {
    homeShortcut: state.settings.homeShortcut,
    vehicleName: state.settings.vehicleName,
    fullRangeMi: p.fullRangeMi,
    startSoc: p.startSoc,
    minArrivalSoc: p.minArrivalSoc,
    minDestinationSoc: p.minDestinationSoc,
    chargeTargetSoc: p.chargeTargetSoc,
    rangeComfortMi: p.rangeComfortMi,
    maxDetourMi: p.maxDetourMi,
    chargeMinPerStop: p.chargeMinPerStop,
    networks: p.networks,
  };
  saveSettings(state.settings);
}

function bindSlider(id, labelId, fmt) {
  const input = $(`#${id}`);
  const label = $(`#${labelId}`);
  if (!input || !label) return;
  const update = () => {
    label.textContent = fmt(input.value);
  };
  input.addEventListener("input", update);
  update();
}

async function resolvePlace(text, fallback) {
  if (!text) throw new Error("Start and destination are required");
  if (fallback?.lat != null) return fallback;
  return geocode(text);
}

async function findRouteAndChargers() {
  persistSettingsFromForm();
  const params = readFormParams();
  state.error = null;

  if (!params.startText || !params.endText) {
    showToast("Enter start and destination");
    return;
  }
  if (!anyNetworkSelected(params.networks)) {
    showToast("Select at least one charging network");
    return;
  }

  setLoading(true, "Finding route…");
  try {
    const start = await resolvePlace(params.startText, state.draft?.start);
    setLoading(true, "Routing…");
    const end = await geocode(params.endText);
    const route = await fetchRoute([start, end]);

    setLoading(true, "Searching chargers along route…");
    const raw = await fetchChargingCandidates(route.polyline, params);
    const candidates = enrichCandidates(raw, route.polyline, params.maxDetourMi);

    state.draft = {
      id: uid(),
      start,
      end,
      route,
      candidates,
      selectedIds: [],
      params: { ...state.settings, startSoc: params.startSoc },
      createdAt: new Date().toISOString(),
    };

    revalidate();
    saveDraft(state.draft);
    render();
    const nextCount = getNextCandidates().length;
    showToast(
      `${candidates.length} chargers found · ${nextCount} option${nextCount === 1 ? "" : "s"} for stop 1`
    );
  } catch (err) {
    state.error = err.message || "Something went wrong";
    render();
    showToast(state.error);
  } finally {
    setLoading(false);
  }
}

function revalidate() {
  if (!state.draft) return;
  const selected = state.draft.candidates.filter((c) =>
    state.draft.selectedIds.includes(c.id)
  );
  state.draft.validation = validatePlan({
    start: state.draft.start,
    end: state.draft.end,
    route: state.draft.route,
    selectedStops: selected,
    params: state.draft.params,
  });
  saveDraft(state.draft);
}

function getOrderedSelected() {
  if (!state.draft) return [];
  return state.draft.selectedIds
    .map((id) => state.draft.candidates.find((c) => c.id === id))
    .filter(Boolean)
    .sort((a, b) => a.routeMi - b.routeMi);
}

function getPlanningLeg() {
  const selected = getOrderedSelected();
  const params = state.draft.params;
  let posMi = 0;
  let soc = params.startSoc;
  if (selected.length) {
    const last = selected[selected.length - 1];
    posMi = last.routeMi;
    soc = params.chargeTargetSoc;
  }
  return { posMi, soc, selected };
}

function sortCandidatesForPick(list) {
  return list.sort((a, b) => {
    const byDetour = a.detourMi - b.detourMi;
    if (Math.abs(byDetour) > 0.01) return byDetour;
    return previewArrivalForNext(a) - previewArrivalForNext(b);
  });
}

function getNextCandidates() {
  if (!state.draft) return [];
  const { posMi, soc } = getPlanningLeg();
  const params = state.draft.params;
  const maxReach = maxLegMiFromSoc(soc, params.fullRangeMi, params.rangeComfortMi);
  const minMi = posMi + 12;
  const maxMi = posMi + maxReach * 0.95;
  const picked = new Set(state.draft.selectedIds);

  const pool = state.draft.candidates
    .filter((c) => !picked.has(c.id))
    .filter((c) => c.routeMi >= minMi && c.routeMi <= maxMi);

  return sortCandidatesForPick(pool);
}

function canReachDestinationNow() {
  if (!state.draft) return false;
  const { posMi, soc } = getPlanningLeg();
  const remaining = state.draft.route.totalMi - posMi;
  const maxReach = maxLegMiFromSoc(
    soc,
    state.draft.params.fullRangeMi,
    state.draft.params.rangeComfortMi
  );
  return remaining <= maxReach * 0.95;
}

function selectNextCandidate(id) {
  if (!state.draft) return;
  const pick = state.draft.candidates.find((c) => c.id === id);
  if (!pick) return;

  const feasible = getNextCandidates();
  if (!feasible.some((c) => c.id === id)) {
    showToast("That stop is out of range for this leg");
    return;
  }

  state.draft.selectedIds.push(id);
  revalidate();
  render();
}

function undoFromStop(id) {
  if (!state.draft) return;
  const idx = state.draft.selectedIds.indexOf(id);
  if (idx < 0) return;
  state.draft.selectedIds = state.draft.selectedIds.slice(0, idx);
  revalidate();
  render();
}

function buildTripRecord() {
  const selected = getOrderedSelected();
  const stops = buildCommittedStops(state.draft.start, state.draft.end, selected);
  return {
    id: uid(),
    name: `${state.draft.start.label} → ${state.draft.end.label}`,
    stops,
    params: state.draft.params,
    summary: state.draft.validation.summary,
    committedAt: new Date().toISOString(),
  };
}

function savePlanOnly() {
  if (!state.draft?.validation?.valid) {
    showToast("Fix plan issues before saving");
    return;
  }
  saveCommittedTrip(buildTripRecord());
  state.trips = loadTrips();
  showToast("Plan saved");
}

function commitPlan() {
  if (!state.draft?.validation?.valid) {
    showToast("Fix plan issues before committing");
    return;
  }
  const trip = buildTripRecord();
  const url = googleMapsDirUrl(trip.stops);
  if (!url) {
    showToast("Could not build Maps URL");
    return;
  }
  saveCommittedTrip(trip);
  state.trips = loadTrips();
  window.open(url, "_blank", "noopener,noreferrer");
  showToast("Plan saved · opening Google Maps");
}

async function resetFromRoad() {
  if (!state.draft) {
    showToast("Plan a trip first");
    return;
  }
  persistSettingsFromForm();

  setLoading(true, "Getting your location…");
  try {
    const pos = await getCurrentPosition();
    const loc = await reverseGeocode(pos.lat, pos.lon);
    saveCachedLocation(loc);

    const socRaw = prompt(
      "Current battery %?",
      String(state.draft.params.startSoc ?? 50)
    );
    if (socRaw == null) return;
    const startSoc = clamp(parseInt(socRaw, 10) || 50, 5, 100);

    $("#start-input").value = loc.address;
    $("#start-soc").value = String(startSoc);
    bindSlider("start-soc", "start-soc-val", formatPct);

    const endText = state.draft.end.address;
    $("#end-input").value = endText;

    state.draft = null;
    saveDraft(null);
    render();

    await findRouteAndChargers();
    showToast("Re-planned from your current location");
  } catch (err) {
    showToast(err.message || "Location reset failed");
  } finally {
    setLoading(false);
  }
}

function defaultStartAddress() {
  return state.draft?.start?.address || state.settings.homeShortcut || "";
}

async function applyLocationToStart(loc, toastMsg) {
  $("#start-input").value = loc.address;
  saveCachedLocation(loc);
  if (state.draft) {
    state.draft.start = loc;
    saveDraft(state.draft);
  }
  if (toastMsg) showToast(toastMsg);
}

async function setStartFromHere() {
  const cached = loadCachedLocation();
  if (cached?.address) {
    await applyLocationToStart(cached, null);
  }

  setLoading(true, "Updating location…");
  try {
    const pos = await getCurrentPosition({ maximumAge: 900000 });
    const loc = await reverseGeocode(pos.lat, pos.lon);
    await applyLocationToStart(loc, cached?.address ? "Location updated" : "Start set to current location");
  } catch (err) {
    if (cached?.address) showToast("Using last known location");
    else showToast(err.message || "Could not get location");
  } finally {
    setLoading(false);
  }
}

async function fillFieldFromVoice(field) {
  if (!speechSupported()) {
    showToast("Voice needs Chrome (not all iOS browsers)");
    return;
  }
  try {
    showToast("Listening…");
    const text = await listenForSpeech();
    const input = field === "start" ? $("#start-input") : $("#end-input");
    if (input) input.value = text;
    showToast("Got it");
  } catch (err) {
    showToast(err.message || "Voice failed");
  }
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goToSavedTab() {
  state.trips = loadTrips();
  state.view = "saved";
  render();
  scrollToTop();
}

function handleDeleteTrip(tripId) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return;
  if (!confirm(`Delete "${trip.name}"?`)) return;
  deleteTrip(tripId);
  state.trips = loadTrips();
  render();
  showToast("Trip deleted");
}

function updateScrollFab() {
  const fab = $("#scroll-top-btn");
  if (!fab) return;
  fab.classList.toggle("hidden", window.scrollY < 180);
}

function renderPlanForm() {
  const s = state.settings;
  const maxReach = maxLegMiFromSoc(
    parseInt($("#start-soc")?.value || s.startSoc, 10),
    parseInt($("#full-range")?.value || s.fullRangeMi, 10),
    parseInt($("#range-comfort")?.value || s.rangeComfortMi, 10)
  );

  return `
    <section class="card">
      <label class="field">
        <span>Start</span>
        <div class="input-action-row">
          <input id="start-input" type="text" placeholder="Address or place" value="${escapeHtml(defaultStartAddress())}" autocomplete="street-address" />
          <button type="button" class="icon-btn" id="current-btn" aria-label="Use current location" title="You are here">
            <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>
          </button>
          <button type="button" class="icon-btn" data-voice="start" aria-label="Speak start address" title="Voice input">
            <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
          </button>
        </div>
      </label>
      <label class="field">
        <span>Destination</span>
        <div class="input-action-row">
          <input id="end-input" type="text" placeholder="Where are you going?" value="${escapeHtml(state.draft?.end?.address || "")}" autocomplete="street-address" />
          <button type="button" class="icon-btn" data-voice="end" aria-label="Speak destination" title="Voice input">
            <svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
          </button>
        </div>
      </label>
    </section>

    <section class="card">
      <label class="field slider-field">
        <span>Starting charge <strong id="start-soc-val">${formatPct(s.startSoc)}</strong></span>
        <input id="start-soc" type="range" min="10" max="100" step="5" value="${s.startSoc}" />
      </label>
      <label class="field slider-field">
        <span>Full range at 100% <strong id="full-range-val">${formatMi(s.fullRangeMi)}</strong></span>
        <input id="full-range" type="range" min="150" max="320" step="5" value="${s.fullRangeMi}" />
      </label>
      <label class="field slider-field">
        <span>Range comfort (max leg) <strong id="range-comfort-val">${formatMi(s.rangeComfortMi)}</strong> · first leg ~<strong id="reach-hint">${formatMi(maxReach)}</strong></span>
        <input id="range-comfort" type="range" min="80" max="260" step="5" value="${s.rangeComfortMi}" />
      </label>
      <label class="field slider-field">
        <span>Charge to at each stop <strong id="charge-target-val">${formatPct(s.chargeTargetSoc)}</strong></span>
        <input id="charge-target" type="range" min="60" max="95" step="5" value="${s.chargeTargetSoc}" />
      </label>
      <label class="field slider-field">
        <span>Min arrival at charger <strong id="min-arrival-val">${formatPct(s.minArrivalSoc)}</strong></span>
        <input id="min-arrival" type="range" min="5" max="35" step="5" value="${s.minArrivalSoc}" />
      </label>
      <label class="field slider-field">
        <span>Min arrival at destination <strong id="min-dest-val">${formatPct(s.minDestinationSoc)}</strong></span>
        <input id="min-dest" type="range" min="5" max="30" step="5" value="${s.minDestinationSoc}" />
      </label>
    </section>

    <section class="card">
      <div class="checks">
        ${CHARGE_NETWORKS.map(
          (n) => `
        <label title="${escapeHtml(n.hint ?? "")}">
          <input id="net-${n.id}" type="checkbox" ${s.networks[n.id] ? "checked" : ""} />
          <span>${escapeHtml(n.label)}</span>
        </label>`
        ).join("")}
      </div>
      <label class="field slider-field">
        <span>Max detour off route <strong id="max-detour-val">${s.maxDetourMi} mi</strong></span>
        <input id="max-detour" type="range" min="1" max="15" step="0.5" value="${s.maxDetourMi}" />
      </label>
      <label class="field slider-field">
        <span>Charge time per stop <strong id="charge-minutes-val">${s.chargeMinPerStop} min</strong></span>
        <input id="charge-minutes" type="range" min="12" max="45" step="1" value="${s.chargeMinPerStop}" />
      </label>
    </section>

    <button id="find-btn" class="primary-btn" type="button">Find route &amp; chargers</button>
    ${state.draft ? `<button id="road-reset-btn" class="secondary-btn full-width" type="button" style="margin-top:8px">↻ Reset from current location</button>` : ""}
    ${state.error ? `<div class="error-box">${escapeHtml(state.error)}</div>` : ""}
  `;
}

function renderResults() {
  if (!state.draft) return "";
  const { validation, route } = state.draft;
  const v = validation;
  const selected = getOrderedSelected();
  const nextCandidates = getNextCandidates();
  const legNum = selected.length + 1;
  const reachDest = canReachDestinationNow();

  const chainRows = selected.length
    ? selected
        .map(
          (c, i) => `
        <div class="chain-item">
          <span class="chain-num">${i + 1}</span>
          <div class="chain-body">
            <strong>${escapeHtml(c.name)}</strong>
            <p>Mile ${Math.round(c.routeMi)} · ${c.detourMi.toFixed(1)} mi off route</p>
          </div>
          <button type="button" class="chain-undo" data-undo="${c.id}" aria-label="Remove stop">✕</button>
        </div>`
        )
        .join("")
    : `<p class="muted-inline">No stops chosen yet — pick below.</p>`;

  const nextRows = nextCandidates.length
    ? nextCandidates
        .map((c) => {
          const preview = previewArrivalForNext(c);
          return `
        <button type="button" class="candidate-pick" data-pick="${c.id}">
          <strong>${escapeHtml(c.name)}</strong>
          <p>Mile ${Math.round(c.routeMi)} · ${c.detourMi.toFixed(1)} mi off route · arrive ~${formatPct(preview)}</p>
        </button>`;
        })
        .join("")
    : `<p class="muted-inline">${reachDest ? "No more stops needed — you can reach destination." : "No feasible stops in range. Undo a stop or replan with different settings."}</p>`;

  const timeline = v.timeline
    .map((row) => {
      const info =
        row.kind === "charge"
          ? `${formatMi(row.legMi)} → ${formatPct(row.arrivalSoc)} · +${row.chargeMin}m`
          : `${formatMi(row.legMi)} → ${formatPct(row.arrivalSoc)}`;
      const title = row.kind === "charge" ? row.stop.name : state.draft.end.label;
      return `<li class="${row.arrivalSoc < (row.kind === "charge" ? state.draft.params.minArrivalSoc : state.draft.params.minDestinationSoc) ? "warn" : ""}"><strong>${escapeHtml(title)}</strong><span>${info}</span></li>`;
    })
    .join("");

  const issues = v.issues.length
    ? `<ul class="issues">${v.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
    : `<p class="ok-msg">Plan looks reachable.</p>`;

  return `
    <section class="card results">
      <div class="stats">
        <div><span>Distance</span><strong>${formatMi(route.totalMi)}</strong></div>
        <div><span>Drive</span><strong>${formatMin(v.summary.driveMin)}</strong></div>
        <div><span>Charging</span><strong>${formatMin(v.summary.chargeMin)}</strong></div>
        <div><span>Total</span><strong>${formatMin(v.summary.totalMin)}</strong></div>
      </div>
    </section>

    <section class="card">
      <ul class="timeline">${timeline}</ul>
      ${issues}
    </section>

    <section class="card">
      <div class="chain-list">${chainRows}</div>
    </section>

    <section class="card">
      <p class="leg-label">Stop ${legNum}${reachDest && !nextCandidates.length ? " — ready to finish" : ""}</p>
      <div class="candidate-list">${nextRows}</div>
    </section>
  `;
}

function previewArrivalForNext(candidate) {
  const { posMi, soc } = getPlanningLeg();
  const legMi = candidate.routeMi - posMi;
  return socAfterLegMi(soc, legMi, state.draft.params.fullRangeMi);
}

function renderSaved() {
  if (!state.trips.length) {
    return `<div class="empty">No committed trips yet. Plan a route and tap Commit.</div>`;
  }
  return state.trips
    .map(
      (t) => `
    <article class="card trip-saved">
      <h3>${escapeHtml(t.name)}</h3>
      <p>${formatMi(t.summary?.totalMi ?? 0)} · ${formatMin(t.summary?.totalMin ?? 0)} est. · ${t.stops.filter((s) => s.type === "charge").length} charges</p>
      <p class="muted">${new Date(t.committedAt).toLocaleString()}</p>
      <div class="row-actions">
        <button class="primary-btn" data-open="${t.id}">Open in Maps</button>
        <button class="secondary-btn" data-return="${t.id}">Return → Maps</button>
      </div>
      <button class="delete-btn" type="button" data-delete="${t.id}">Delete</button>
    </article>`
    )
    .join("");
}

function updateBottomNav() {
  const nav = $("#bottom-nav");
  const planActions = $("#plan-actions");
  if (!nav) return;

  if (state.view === "plan") {
    nav.classList.remove("hidden");
    const hasDraft = !!state.draft;
    planActions?.classList.toggle("hidden", !hasDraft);
    if (hasDraft) {
      const commit = $("#commit-btn");
      const saveBtn = $("#save-plan-btn");
      const valid = state.draft.validation?.valid;
      commit.disabled = !valid;
      saveBtn.disabled = !valid;
      commit.textContent = valid ? "Maps" : "Fix plan";
    }
  } else {
    nav.classList.add("hidden");
  }
}

function render() {
  const main = $("#main");

  if (state.view === "plan") {
    main.innerHTML = renderPlanForm() + renderResults();
    bindPlanEvents();
  } else {
    main.innerHTML = renderSaved();
    bindSavedEvents();
  }

  updateBottomNav();
  $("#tab-plan").classList.toggle("active", state.view === "plan");
  $("#tab-saved").classList.toggle("active", state.view === "saved");
}

function bindPlanEvents() {
  bindSlider("start-soc", "start-soc-val", formatPct);
  bindSlider("full-range", "full-range-val", formatMi);
  bindSlider("range-comfort", "range-comfort-val", formatMi);
  bindSlider("charge-target", "charge-target-val", formatPct);
  bindSlider("min-arrival", "min-arrival-val", formatPct);
  bindSlider("min-dest", "min-dest-val", formatPct);
  bindSlider("max-detour", "max-detour-val", (v) => `${v} mi`);
  bindSlider("charge-minutes", "charge-minutes-val", (v) => `${v} min`);
  updateReachHint();

  ["start-soc", "full-range", "range-comfort"].forEach((id) => {
    $(`#${id}`)?.addEventListener("input", updateReachHint);
  });

  $("#current-btn")?.addEventListener("click", setStartFromHere);
  $("#find-btn")?.addEventListener("click", findRouteAndChargers);
  $("#road-reset-btn")?.addEventListener("click", resetFromRoad);

  document.querySelectorAll("[data-voice]").forEach((btn) => {
    btn.addEventListener("click", () => fillFieldFromVoice(btn.dataset.voice));
  });

  document.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => selectNextCandidate(btn.dataset.pick));
  });
  document.querySelectorAll("[data-undo]").forEach((btn) => {
    btn.addEventListener("click", () => undoFromStop(btn.dataset.undo));
  });
}

function updateReachHint() {
  const el = $("#reach-hint");
  if (!el) return;
  const p = readFormParams();
  el.textContent = formatMi(
    maxLegMiFromSoc(p.startSoc, p.fullRangeMi, p.rangeComfortMi)
  );
}

function bindSavedEvents() {
  document.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trip = state.trips.find((t) => t.id === btn.dataset.open);
      const url = googleMapsDirUrl(trip?.stops ?? []);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
  });
  document.querySelectorAll("[data-return]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trip = state.trips.find((t) => t.id === btn.dataset.return);
      const url = googleMapsDirUrl([...(trip?.stops ?? [])].reverse());
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
  });
  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteTrip(btn.dataset.delete));
  });
}

function init() {
  if (!state.draft && !$("#start-input")) {
    // pre-fill home on first load only in form render
  }

  $("#tab-plan").addEventListener("click", () => {
    state.view = "plan";
    render();
    scrollToTop();
  });
  $("#tab-saved").addEventListener("click", () => goToSavedTab());

  $("#commit-btn").addEventListener("click", commitPlan);
  $("#save-plan-btn").addEventListener("click", savePlanOnly);
  $("#goto-saved-btn")?.addEventListener("click", goToSavedTab);
  $("#scroll-top-nav")?.addEventListener("click", scrollToTop);
  $("#scroll-top-btn")?.addEventListener("click", scrollToTop);
  window.addEventListener("scroll", updateScrollFab, { passive: true });

  render();
  renderVersionBadge();
  registerServiceWorker();
}

function renderVersionBadge() {
  const el = $("#app-version");
  if (el) el.textContent = `v${APP_VERSION}`;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js?v=8");
    await reg.update();
    if (reg.waiting) {
      showToast("Update ready — close and reopen the app");
    }
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          showToast("Updated — reopen for latest version");
        }
      });
    });
  } catch {
    /* offline or unsupported */
  }
}

init();
