import { clamp, formatMi, formatMin, formatPct, defaultNetworkPrefs } from "./util.js";

export const DEFAULT_SETTINGS = {
  homeShortcut: "4800 Bofield Dr, Kettering, OH 45440",
  vehicleName: "Ioniq 5 Long Range",
  fullRangeMi: 240,
  startSoc: 100,
  minArrivalSoc: 15,
  minDestinationSoc: 10,
  chargeTargetSoc: 85,
  rangeComfortMi: 160,
  maxDetourMi: 5,
  chargeMinPerStop: 22,
  networks: defaultNetworkPrefs(),
};

export function socAfterLegMi(soc, legMi, fullRangeMi) {
  return soc - (legMi / fullRangeMi) * 100;
}

export function maxLegMiFromSoc(soc, fullRangeMi, rangeComfortMi) {
  const physics = (soc / 100) * fullRangeMi * 0.92;
  return Math.min(physics, rangeComfortMi);
}

export function autoSelectStops(candidates, routeTotalMi, params) {
  const selected = [];
  let posMi = 0;
  let soc = params.startSoc;

  const sorted = [...candidates].sort((a, b) => a.routeMi - b.routeMi);

  while (posMi < routeTotalMi - 5) {
    const reach = maxLegMiFromSoc(soc, params.fullRangeMi, params.rangeComfortMi);
    const remaining = routeTotalMi - posMi;

    if (remaining <= reach * 0.95) break;

    const ideal = posMi + Math.min(params.rangeComfortMi, reach * 0.85);
    const minMi = posMi + 20;
    const maxMi = posMi + reach * 0.9;

    const pool = sorted.filter((c) => c.routeMi >= minMi && c.routeMi <= maxMi);
    if (!pool.length) break;

    pool.sort((a, b) => {
      const scoreA = Math.abs(a.routeMi - ideal) + a.detourMi * 3 + networkPenalty(a.network, params);
      const scoreB = Math.abs(b.routeMi - ideal) + b.detourMi * 3 + networkPenalty(b.network, params);
      return scoreA - scoreB;
    });

    const pick = pool[0];
    if (selected.some((s) => s.id === pick.id)) break;

    selected.push(pick);
    posMi = pick.routeMi;
    soc = params.chargeTargetSoc;
  }

  return selected;
}

function networkPenalty(network, params) {
  return params.networks[network] ? 0 : 10;
}

export function validatePlan({ start, end, route, selectedStops, params }) {
  const stops = [...selectedStops].sort((a, b) => a.routeMi - b.routeMi);
  const timeline = [];
  let soc = params.startSoc;
  let prevMi = 0;
  const issues = [];

  for (const stop of stops) {
    const legMi = stop.routeMi - prevMi;
    const arrivalSoc = socAfterLegMi(soc, legMi, params.fullRangeMi);

    timeline.push({
      kind: "charge",
      stop,
      legMi,
      arrivalSoc,
      departSoc: params.chargeTargetSoc,
      chargeMin: params.chargeMinPerStop,
    });

    if (arrivalSoc < params.minArrivalSoc) {
      issues.push(
        `Arrive at ${stop.name} at ${formatPct(arrivalSoc)} — below your ${formatPct(params.minArrivalSoc)} minimum. Add an earlier stop or charge longer before this leg.`
      );
    }
    if (legMi > params.rangeComfortMi + 5) {
      issues.push(
        `${formatMi(legMi)} to ${stop.name} exceeds your ${formatMi(params.rangeComfortMi)} comfort range.`
      );
    }

    soc = params.chargeTargetSoc;
    prevMi = stop.routeMi;
  }

  const finalLegMi = route.totalMi - prevMi;
  const destArrivalSoc = socAfterLegMi(soc, finalLegMi, params.fullRangeMi);

  timeline.push({
    kind: "destination",
    stop: end,
    legMi: finalLegMi,
    arrivalSoc: destArrivalSoc,
  });

  if (destArrivalSoc < params.minDestinationSoc) {
    issues.push(
      `Arrive at destination at ${formatPct(destArrivalSoc)} — below your ${formatPct(params.minDestinationSoc)} minimum. Add another charging stop.`
    );
  }
  if (finalLegMi > maxLegMiFromSoc(soc, params.fullRangeMi, params.rangeComfortMi) + 5) {
    issues.push(`Final ${formatMi(finalLegMi)} leg is beyond comfortable range from your last stop.`);
  }

  const driveMin = route.driveMin + stops.reduce((s, st) => s + (st.detourMi / 55) * 60, 0);
  const chargeMin = stops.length * params.chargeMinPerStop;

  return {
    valid: issues.length === 0,
    issues,
    timeline,
    summary: {
      totalMi: route.totalMi,
      driveMin,
      chargeMin,
      totalMin: driveMin + chargeMin,
      stopCount: stops.length,
    },
  };
}

export function buildCommittedStops(start, end, selectedStops) {
  const ordered = [...selectedStops].sort((a, b) => a.routeMi - b.routeMi);
  return [
    { ...start, type: "start" },
    ...ordered.map((s) => ({
      label: s.mapLabel || s.name,
      address: s.address,
      lat: s.lat,
      lon: s.lon,
      type: "charge",
      network: s.network,
    })),
    { ...end, type: "destination" },
  ];
}

export function filterStopsAhead(selectedStops, routeMiProgress) {
  return selectedStops.filter((s) => s.routeMi > routeMiProgress + 2);
}

export function formatTimelineRow(row) {
  if (row.kind === "charge") {
    return {
      title: row.stop.name,
      meta: `${formatMi(row.legMi)} · arrive ${formatPct(row.arrivalSoc)} · +${row.chargeMin} min charge`,
      warn: row.arrivalSoc < 15,
    };
  }
  return {
    title: "Destination",
    meta: `${formatMi(row.legMi)} · arrive ${formatPct(row.arrivalSoc)}`,
    warn: row.arrivalSoc < 10,
  };
}

export function estimateChargeMinutes(socFrom, socTo) {
  const delta = clamp(socTo - socFrom, 0, 80);
  return Math.round(12 + delta * 0.35);
}
