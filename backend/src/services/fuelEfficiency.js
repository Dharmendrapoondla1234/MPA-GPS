// backend/src/services/fuelEfficiency.js
// Fuel efficiency calculator using vessel physics + IMO formulas.
// No external AI API needed — pure mathematical model.
"use strict";

// ── Vessel type consumption profiles (MT/day at design speed) ─────
const VESSEL_PROFILES = {
  CONTAINER:      { design_speed_kn: 20, design_fuel_mt_day: 175, cubic: 3.2 },
  TANKER:         { design_speed_kn: 14, design_fuel_mt_day:  60, cubic: 3.0 },
  CRUDE:          { design_speed_kn: 14, design_fuel_mt_day:  80, cubic: 3.0 },
  BULK:           { design_speed_kn: 13, design_fuel_mt_day:  35, cubic: 3.1 },
  "BULK CARRIER": { design_speed_kn: 13, design_fuel_mt_day:  35, cubic: 3.1 },
  LNG:            { design_speed_kn: 19, design_fuel_mt_day: 145, cubic: 3.0 },
  "GENERAL CARGO":{ design_speed_kn: 13, design_fuel_mt_day:  28, cubic: 3.0 },
  FERRY:          { design_speed_kn: 20, design_fuel_mt_day:  45, cubic: 2.8 },
  RO_RO:          { design_speed_kn: 18, design_fuel_mt_day:  60, cubic: 2.9 },
  DEFAULT:        { design_speed_kn: 13, design_fuel_mt_day:  40, cubic: 3.0 },
};

// ── IMO EEOI reference values (g CO2 / tonne-mile) by vessel type ─
const EEOI_REFERENCE = {
  CONTAINER: 11.5, TANKER: 6.5, CRUDE: 6.5, BULK: 5.5,
  "BULK CARRIER": 5.5, LNG: 8.0, "GENERAL CARGO": 9.5, DEFAULT: 8.0,
};

const CO2_PER_MT_HFO = 3.114; // metric tonnes CO2 per MT HFO
const CO2_PER_MT_MDO = 3.206;

/**
 * Calculate fuel consumption and efficiency metrics for a vessel.
 *
 * @param {object} vessel - Live vessel data from BigQuery
 * @returns {object} efficiency metrics
 */
function calculateFuelEfficiency(vessel) {
  if (!vessel) return null;

  const vtype = (vessel.vessel_type || "DEFAULT").toUpperCase();
  const profile = VESSEL_PROFILES[vtype] || VESSEL_PROFILES.DEFAULT;
  const eeoi_ref = EEOI_REFERENCE[vtype] || EEOI_REFERENCE.DEFAULT;

  const speed    = Math.max(0, parseFloat(vessel.speed || 0));
  const grt      = Math.max(1000, parseFloat(vessel.gross_tonnage || 10000));
  const dwt      = Math.max(1000, parseFloat(vessel.deadweight || 8000));
  const length   = parseFloat(vessel.vessel_length || 150);

  // ── Fuel consumption model (Admiralty coefficient) ───────────────
  // FC ∝ (speed / design_speed)^cubic × design_FC
  const speedRatio = speed > 0 ? speed / profile.design_speed_kn : 0;
  const fuelMtDay  = speed > 0
    ? Math.round(profile.design_fuel_mt_day * Math.pow(speedRatio, profile.cubic) * 10) / 10
    : 0;

  // ── At-berth consumption (aux engines, hotel load) ─────────────
  const berthFuelMtDay = grt > 100000 ? 3.5 : grt > 50000 ? 2.2 : grt > 10000 ? 1.2 : 0.6;

  const isMoving  = speed > 0.5;
  const portHours = parseFloat(vessel.port_time_hours || vessel.hours_in_port_so_far || 0);
  const fuelRate  = isMoving ? fuelMtDay : berthFuelMtDay;

  // ── CO2 emissions (assume HFO for main engine, MDO for aux) ──────
  const co2Day    = isMoving
    ? fuelMtDay * CO2_PER_MT_HFO
    : berthFuelMtDay * CO2_PER_MT_MDO;

  // ── EEOI: g CO2 / (tonne × mile) ─────────────────────────────────
  // Uses transport work = DWT × speed(nm/h) × 24
  const transportWorkPerDay = dwt * speed * 24; // tonne-miles/day
  const eeoi = transportWorkPerDay > 0
    ? Math.round((co2Day * 1_000_000 / transportWorkPerDay) * 10) / 10
    : null;

  // ── CII: Carbon Intensity Indicator (g CO2 / GT·NM) ─────────────
  // Annual estimate from current operating profile
  const nmPerYear   = speed * 24 * 365 * 0.65; // 65% sea time
  const co2Year     = co2Day * 365;
  const cii         = nmPerYear > 0 && grt > 0
    ? Math.round((co2Year * 1_000_000) / (grt * nmPerYear) * 10) / 10
    : null;

  // ── CII Rating: IMO thresholds (simplified) ───────────────────────
  function getCIIRating(ciiValue, type) {
    if (!ciiValue) return "N/A";
    // Reference values approx per vessel type (g CO2/GT·NM)
    const refs = {
      CONTAINER: { A: 5, B: 7, C: 9, D: 12 },
      TANKER:    { A: 3, B: 4, C: 5.5, D: 7 },
      BULK:      { A: 2.5, B: 3.5, C: 4.5, D: 6 },
      "BULK CARRIER": { A: 2.5, B: 3.5, C: 4.5, D: 6 },
      DEFAULT:   { A: 4, B: 6, C: 8, D: 11 },
    };
    const r = refs[type] || refs.DEFAULT;
    if (ciiValue <= r.A) return "A";
    if (ciiValue <= r.B) return "B";
    if (ciiValue <= r.C) return "C";
    if (ciiValue <= r.D) return "D";
    return "E";
  }

  const ciiRating = getCIIRating(cii, vtype);

  // ── Efficiency score (0–100) ──────────────────────────────────────
  // Compare current EEOI to reference; lower = better
  let efficiencyScore = 100;
  if (eeoi && eeoi_ref) {
    const ratio = eeoi / eeoi_ref;
    if (ratio <= 0.8)      efficiencyScore = 95;
    else if (ratio <= 1.0) efficiencyScore = 80;
    else if (ratio <= 1.3) efficiencyScore = 60;
    else if (ratio <= 1.6) efficiencyScore = 40;
    else if (ratio <= 2.0) efficiencyScore = 20;
    else                   efficiencyScore = 10;
  } else if (!isMoving && portHours > 48) {
    efficiencyScore = Math.max(20, 80 - portHours);
  } else if (!isMoving) {
    efficiencyScore = 70; // at berth — short stay OK
  }

  // Speed efficiency: penalise excessive speed
  let speedGrade = "optimal";
  if (speed === 0 && !isMoving) speedGrade = "berthed";
  else if (speed < 5)  speedGrade = "slow";
  else if (speed < 8)  speedGrade = "below-optimal";
  else if (speed <= 16) speedGrade = "optimal";
  else if (speed <= 20) speedGrade = "high";
  else                  speedGrade = "excessive";

  // ── Geo-fence alert zones around Singapore ────────────────────────
  const lat = parseFloat(vessel.latitude_degrees || 0);
  const lng = parseFloat(vessel.longitude_degrees || 0);
  const distFromSgNm = haversineNm(lat, lng, 1.3521, 103.8198);
  const inSgZone     = distFromSgNm < 50;
  const inApproach   = distFromSgNm >= 50 && distFromSgNm < 150;

  return {
    vessel_name:   vessel.vessel_name,
    imo_number:    vessel.imo_number,
    vessel_type:   vessel.vessel_type,
    current_speed_kn: speed,
    // Fuel
    fuel_consumption_mt_day:     fuelRate,
    main_engine_fuel_mt_day:     isMoving ? fuelMtDay : 0,
    aux_engine_fuel_mt_day:      isMoving ? berthFuelMtDay * 0.3 : berthFuelMtDay,
    design_speed_kn:             profile.design_speed_kn,
    design_fuel_mt_day:          profile.design_fuel_mt_day,
    fuel_saving_vs_design_pct:   speed > 0
      ? Math.round((1 - speedRatio ** profile.cubic) * 100)
      : 100,
    // Emissions
    co2_emissions_mt_day:         Math.round(co2Day * 100) / 100,
    eeoi_g_co2_per_tonne_mile:    eeoi,
    eeoi_reference:               eeoi_ref,
    cii_g_co2_per_gt_nm:          cii,
    cii_rating:                   ciiRating,
    // Scores
    efficiency_score:             efficiencyScore,
    speed_grade:                  speedGrade,
    // Geo
    distance_from_singapore_nm:   Math.round(distFromSgNm),
    in_singapore_zone:            inSgZone,
    in_approach_zone:             inApproach,
    // Contextual
    is_moving:                    isMoving,
    port_hours_so_far:            portHours,
    // Fuel cost estimate (IFO380 ~$400/MT)
    est_fuel_cost_usd_day:        Math.round(fuelRate * 400),
  };
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // NM
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Calculate fleet-wide efficiency summary for multiple vessels.
 */
function calculateFleetEfficiency(vessels) {
  if (!vessels?.length) return null;
  const results = vessels.map(calculateFuelEfficiency).filter(Boolean);
  const moving  = results.filter(r => r.is_moving);
  const berthed = results.filter(r => !r.is_moving);

  const totalFuelDay  = results.reduce((s, r) => s + (r.fuel_consumption_mt_day || 0), 0);
  const totalCo2Day   = results.reduce((s, r) => s + (r.co2_emissions_mt_day || 0), 0);
  const avgEfficiency = results.reduce((s, r) => s + (r.efficiency_score || 0), 0) / results.length;

  const ciiCounts = { A:0, B:0, C:0, D:0, E:0, "N/A":0 };
  for (const r of results) ciiCounts[r.cii_rating] = (ciiCounts[r.cii_rating] || 0) + 1;

  return {
    fleet_size:              results.length,
    vessels_moving:          moving.length,
    vessels_berthed:         berthed.length,
    total_fuel_mt_day:       Math.round(totalFuelDay),
    total_co2_mt_day:        Math.round(totalCo2Day * 100) / 100,
    avg_efficiency_score:    Math.round(avgEfficiency),
    est_total_fuel_cost_usd_day: Math.round(totalFuelDay * 400),
    cii_distribution:        ciiCounts,
    low_efficiency_vessels:  results.filter(r => r.efficiency_score < 50).length,
  };
}

module.exports = { calculateFuelEfficiency, calculateFleetEfficiency };
