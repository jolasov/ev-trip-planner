import {
  escapeHtml,
  formatMi,
  formatMin,
  formatPct,
  googleMapsDirUrl,
  uid,
  clamp,
  CHARGE_NETWORKS,
  networkShort,
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
  autoSelectStops,
  validatePlan,
  buildCommittedStops,
  maxLegMiFromSoc,
} from "./planner.js";
import {
  loadSettings,
  saveSettings,
  loadDraft,
  saveDraft,
  loadTrips,
  saveCommittedTrip,
} from "./storage.js";

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

    const auto = autoSelectStops(candidates, route.totalMi, params);
    const selectedIds = new Set(auto.map((s) => s.id));

    state.draft = {
      id: uid(),
      start,
      end,
      route,
      candidates,
      selectedIds: [...selectedIds],
      params: { ...state.settings, startSoc: params.startSoc },
      createdAt: new Date().toISOString(),
    };

    revalidate();
    saveDraft(state.draft);
    render();
    showToast(`${candidates.length} chargers found · ${auto.length} auto-selected`);
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

function toggleCandidate(id) {
  if (!state.draft) return;
  const set = new Set(state.draft.selectedIds);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  state.draft.selectedIds = [...set];
  revalidate();
  renderResults();
  updateBottomNav();
}

function commitPlan() {
  if (!state.draft?.validation?.valid) {
    showToast("Fix plan issues before committing");
    return;
  }
  const selected = state.draft.candidates
    .filter((c) => state.draft.selectedIds.includes(c.id))
    .sort((a, b) => a.routeMi - b.routeMi);

  const stops = buildCommittedStops(state.draft.start, state.draft.end, selected);
  const url = googleMapsDirUrl(stops);
  if (!url) {
    showToast("Could not build Maps URL");
    return;
  }

  const trip = {
    id: uid(),
    name: `${state.draft.start.label} → ${state.draft.end.label}`,
    stops,
    params: state.draft.params,
    summary: state.draft.validation.summary,
    committedAt: new Date().toISOString(),
  };
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

function applyHomeShortcut() {
  $("#start-input").value = state.settings.homeShortcut;
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
      <h2 class="card-title">Route</h2>
      <label class="field">
        <span>Start</span>
        <div class="input-row">
          <input id="start-input" type="text" placeholder="Address or place" value="${escapeHtml(state.draft?.start?.address || "")}" autocomplete="street-address" />
          <button type="button" class="chip-btn" id="home-btn">Home</button>
        </div>
      </label>
      <label class="field">
        <span>Destination</span>
        <input id="end-input" type="text" placeholder="Where are you going?" value="${escapeHtml(state.draft?.end?.address || "")}" autocomplete="street-address" />
      </label>
    </section>

    <section class="card">
      <h2 class="card-title">Battery & range</h2>
      <label class="field slider-field">
        <span>Starting charge <strong id="start-soc-val">${formatPct(s.startSoc)}</strong></span>
        <input id="start-soc" type="range" min="10" max="100" step="5" value="${s.startSoc}" />
      </label>
      <label class="field slider-field">
        <span>Real-world full range (100%) <strong id="full-range-val">${formatMi(s.fullRangeMi)}</strong></span>
        <input id="full-range" type="range" min="150" max="320" step="5" value="${s.fullRangeMi}" />
      </label>
      <label class="field slider-field">
        <span>Range comfort (max leg) <strong id="range-comfort-val">${formatMi(s.rangeComfortMi)}</strong></span>
        <input id="range-comfort" type="range" min="80" max="260" step="5" value="${s.rangeComfortMi}" />
      </label>
      <p class="field-hint">First leg max ~<strong id="reach-hint">${formatMi(maxReach)}</strong> at current settings.</p>
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
      <h2 class="card-title">Charging preferences</h2>
      <div class="checks">
        ${CHARGE_NETWORKS.map(
          (n) => `
        <label>
          <input id="net-${n.id}" type="checkbox" ${s.networks[n.id] ? "checked" : ""} />
          <span>${escapeHtml(n.label)}${n.hint ? `<span class="network-hint">${escapeHtml(n.hint)}</span>` : ""}</span>
        </label>`
        ).join("")}
      </div>
      <label class="field slider-field">
        <span>Max detour off route <strong id="max-detour-val">${s.maxDetourMi} mi</strong></span>
        <input id="max-detour" type="range" min="1" max="15" step="0.5" value="${s.maxDetourMi}" />
      </label>
      <label class="field slider-field">
        <span>Est. charge time per stop <strong id="charge-minutes-val">${s.chargeMinPerStop} min</strong></span>
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
  const { candidates, selectedIds, validation, route } = state.draft;
  const v = validation;

  const candidateRows = candidates
    .map((c) => {
      const on = selectedIds.includes(c.id);
      const arrivalPreview = previewArrivalSoc(c);
      return `
        <label class="candidate ${on ? "selected" : ""}">
          <input type="checkbox" data-id="${c.id}" ${on ? "checked" : ""} />
          <div class="candidate-body">
            <strong>${escapeHtml(c.name)}</strong>
            <span class="badge badge-${c.network}">${escapeHtml(networkShort(c.network))}</span>
            <p>Mile ${Math.round(c.routeMi)} on route · ${c.detourMi.toFixed(1)} mi detour${arrivalPreview != null ? ` · arrive ~${formatPct(arrivalPreview)}` : ""}</p>
          </div>
        </label>`;
    })
    .join("");

  const timeline = v.timeline
    .map((row) => {
      const info =
        row.kind === "charge"
          ? `${formatMi(row.legMi)} → arrive ${formatPct(row.arrivalSoc)} · +${row.chargeMin}m charge`
          : `${formatMi(row.legMi)} → arrive ${formatPct(row.arrivalSoc)}`;
      const title = row.kind === "charge" ? row.stop.name : state.draft.end.label;
      return `<li class="${row.arrivalSoc < (row.kind === "charge" ? state.draft.params.minArrivalSoc : state.draft.params.minDestinationSoc) ? "warn" : ""}"><strong>${escapeHtml(title)}</strong><span>${info}</span></li>`;
    })
    .join("");

  const issues = v.issues.length
    ? `<ul class="issues">${v.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
    : `<p class="ok-msg">Plan looks reachable with selected stops.</p>`;

  return `
    <section class="card results">
      <h2 class="card-title">Route summary</h2>
      <div class="stats">
        <div><span>Distance</span><strong>${formatMi(route.totalMi)}</strong></div>
        <div><span>Drive</span><strong>${formatMin(v.summary.driveMin)}</strong></div>
        <div><span>Charging</span><strong>${formatMin(v.summary.chargeMin)}</strong></div>
        <div><span>Total est.</span><strong>${formatMin(v.summary.totalMin)}</strong></div>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">Timeline & guardrails</h2>
      <ul class="timeline">${timeline}</ul>
      ${issues}
    </section>

    <section class="card">
      <h2 class="card-title">Charging stops (${selectedIds.length} selected)</h2>
      <p class="field-hint">Toggle stops — invalid plans can't be committed.</p>
      <div class="candidate-list">${candidateRows || "<p class='field-hint'>No stations matched your filters along this route.</p>"}</div>
    </section>
  `;
}

function previewArrivalSoc(candidate) {
  if (!state.draft?.validation) return null;
  const row = state.draft.validation.timeline.find(
    (t) => t.kind === "charge" && t.stop.id === candidate.id
  );
  return row?.arrivalSoc ?? null;
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
    </article>`
    )
    .join("");
}

function updateBottomNav() {
  const nav = $("#bottom-nav");
  if (!nav) return;
  const show = state.view === "plan" && state.draft;
  nav.classList.toggle("hidden", !show);
  if (!show) return;

  const commit = $("#commit-btn");
  const valid = state.draft.validation?.valid;
  commit.disabled = !valid;
  commit.textContent = valid ? "Commit plan → Google Maps" : "Fix plan to commit";
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

  $("#home-btn")?.addEventListener("click", applyHomeShortcut);
  $("#find-btn")?.addEventListener("click", findRouteAndChargers);
  $("#road-reset-btn")?.addEventListener("click", resetFromRoad);

  document.querySelectorAll(".candidate input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => toggleCandidate(cb.dataset.id));
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
}

function init() {
  if (!state.draft && !$("#start-input")) {
    // pre-fill home on first load only in form render
  }

  $("#tab-plan").addEventListener("click", () => {
    state.view = "plan";
    render();
  });
  $("#tab-saved").addEventListener("click", () => {
    state.trips = loadTrips();
    state.view = "saved";
    render();
  });

  $("#commit-btn").addEventListener("click", commitPlan);
  $("#copy-btn")?.addEventListener("click", () => {
    if (!state.draft?.validation?.valid) return;
    const selected = state.draft.candidates.filter((c) =>
      state.draft.selectedIds.includes(c.id)
    );
    const url = googleMapsDirUrl(
      buildCommittedStops(state.draft.start, state.draft.end, selected)
    );
    navigator.clipboard?.writeText(url);
    showToast("Link copied");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  render();
  if (!state.draft?.start?.address) applyHomeShortcut();
}

init();
