// services/intelligence/efficiencyScorer.js
// Scores vessel operational efficiency based on speed deviation, idle time,
// route inefficiency, and destination-based opportunity detection.
"use strict";

const logger = require("../../utils/logger");

// Singapore port LOCODE and common name variants
const SINGAPORE_MARKERS = ["SGSIN", "SGS", "SINGAPORE", "SG"];

/**
 * Score a vessel's efficiency (0–100, lower = less efficient = more opportunity).
 *
 * Inputs (from BigQuery live tracking row):
 *   speed            - current speed in knots
 *   vessel_type      - vessel category
 *   next_port_destination
 *   location_to      - current port / destination
 *   minutes_since_last_ping
 *   is_stale         - whether position data is stale
 *   port_time_hours  - hours spent in port
 *   hours_in_port_so_far
 *
 * Returns:
 * {
 *   score: 0-100,          // overall efficiency (100 = fully efficient)
 *   factors: {...},        // component scores
 *   is_opportunity: bool,  // true when score < 40 and dest = Singapore
 *   opportunity_reason: string
 * }
 */
function scoreVesselEfficiency(vessel) {
  if (!vessel) return null;

  const factors = {};
  let total = 0;
  let weight = 0;

  // ── 1. Speed efficiency ──────────────────────────────────────────
  // Vessels in transit should be doing 8–15 kn; <5 kn while not in port = idle
  const speed = Number(vessel.speed ?? vessel.speed_kn ?? 0);
  const status = (vessel.vessel_status || vessel.status_label || "").toLowerCase();
  const isInPort = status.includes("port") || status.includes("anchor")
                 || status.includes("moored") || status.includes("berth");

  let speedScore = 100;
  if (!isInPort) {
    if      (speed === 0)    speedScore = 0;   // dead stop at sea
    else if (speed < 3)      speedScore = 20;  // nearly stationary
    else if (speed < 6)      speedScore = 50;  // very slow
    else if (speed < 8)      speedScore = 70;  // below typical transit
    else if (speed <= 16)    speedScore = 100; // normal transit
    else if (speed <= 20)    speedScore = 90;  // fast but OK
    else                     speedScore = 75;  // excessive speed (fuel waste)
  }
  factors.speed_score = speedScore;
  total += speedScore * 0.35;
  weight += 0.35;

  // ── 2. Data freshness / availability ────────────────────────────
  const minsAgo   = Number(vessel.minutes_since_last_ping ?? 0);
  const isStale   = vessel.is_stale === true || minsAgo > 120;
  const freshScore = isStale
    ? Math.max(0, 100 - Math.min(100, (minsAgo - 120) / 12))
    : 100;
  factors.data_freshness_score = Math.round(freshScore);
  total += freshScore * 0.15;
  weight += 0.15;

  // ── 3. Port idle time ────────────────────────────────────────────
  const portHours = Number(vessel.port_time_hours ?? vessel.hours_in_port_so_far ?? 0);
  let portScore = 100;
  if (portHours > 0) {
    if      (portHours < 24)  portScore = 100;
    else if (portHours < 48)  portScore = 85;
    else if (portHours < 96)  portScore = 65;
    else if (portHours < 168) portScore = 40;  // > 1 week
    else                      portScore = 15;  // > 2 weeks — very idle
  }
  factors.port_idle_score = portScore;
  total += portScore * 0.30;
  weight += 0.30;

  // ── 4. Route clarity ────────────────────────────────────────────
  const hasDestination = !!(vessel.next_port_destination || vessel.destination);
  const routeScore = hasDestination ? 100 : 50;
  factors.route_score = routeScore;
  total += routeScore * 0.20;
  weight += 0.20;

  const score = weight > 0 ? Math.round(total / weight) : 50;

  // ── Opportunity detection ────────────────────────────────────────
  const dest = (vessel.next_port_destination || vessel.destination || vessel.location_to || "")
    .toUpperCase().trim();
  const isSingaporeBound = SINGAPORE_MARKERS.some(m => dest.includes(m));

  const isOpportunity = score < 40 && isSingaporeBound;
  let opportunityReason = null;
  if (isOpportunity) {
    const reasons = [];
    if (speedScore < 50)  reasons.push("vessel is near-idle");
    if (portScore < 50)   reasons.push(`extended port stay (${Math.round(portHours)}h)`);
    if (!hasDestination)  reasons.push("no declared destination");
    opportunityReason = `Low efficiency (${score}%) Singapore-bound vessel — ${reasons.join(", ")}`;
  }

  logger.debug(`[efficiency] IMO ${vessel.imo_number}: score=${score} spd=${speedScore} port=${portScore} sg=${isSingaporeBound}`);

  return {
    score,
    grade: score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D",
    factors,
    is_opportunity: isOpportunity,
    opportunity_reason: opportunityReason,
    singapore_bound: isSingaporeBound,
  };
}

module.exports = { scoreVesselEfficiency };