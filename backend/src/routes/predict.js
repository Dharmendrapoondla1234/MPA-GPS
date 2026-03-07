// backend/src/routes/predict.js
// Ship Route Prediction AI
// Uses pure BigQuery: historical AIS patterns + vessel trajectory analysis
// Predicts: next port, ETA, and likely route waypoints
"use strict";

const express = require("express");
const router = express.Router();
const logger = require("../utils/logger");
const { BigQuery } = require("@google-cloud/bigquery");

const PROJECT = process.env.BIGQUERY_PROJECT_ID || "photons-377606";
const DATASET = process.env.BIGQUERY_DATASET || "MPA";
const FULL_TABLE = `\`${PROJECT}.${DATASET}.MPA_Master_Vessels\``;
const SNAPSHOT_TABLE = `\`${PROJECT}.${DATASET}.View_MPA_VesselPositionsSnapshot\``;
const BQ_LOCATION = process.env.BIGQUERY_LOCATION || "asia-southeast1";

let bigquery;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    bigquery = new BigQuery({
      credentials: creds,
      projectId: creds.project_id,
      location: BQ_LOCATION,
    });
  } catch (e) {
    logger.error("BQ credentials error:", e.message);
  }
} else {
  bigquery = new BigQuery({ projectId: PROJECT, location: BQ_LOCATION });
}

// Simple in-memory cache for predictions (5 min TTL)
const predCache = new Map();
function getCached(key) {
  const c = predCache.get(key);
  if (c && Date.now() - c.ts < 300_000) return c.data;
  return null;
}
function setCache(key, data) {
  predCache.set(key, { data, ts: Date.now() });
}

// Known major ports with coordinates for route generation
const KNOWN_PORTS = [
  { name: "Singapore", lat: 1.264, lng: 103.82, region: "SG" },
  { name: "Port Klang", lat: 3.0, lng: 101.39, region: "MY" },
  { name: "Johor Bahru", lat: 1.458, lng: 103.757, region: "MY" },
  { name: "Batam", lat: 1.107, lng: 104.03, region: "ID" },
  { name: "Tanjung Pelepas", lat: 1.363, lng: 103.553, region: "MY" },
  { name: "Karimun", lat: 1.04, lng: 103.44, region: "ID" },
  { name: "Dumai", lat: 1.67, lng: 101.45, region: "ID" },
  { name: "Palembang", lat: -2.916, lng: 104.745, region: "ID" },
  { name: "Jakarta", lat: -6.1, lng: 106.88, region: "ID" },
  { name: "Belawan", lat: 3.794, lng: 98.682, region: "ID" },
  { name: "Penang", lat: 5.414, lng: 100.329, region: "MY" },
  { name: "Port Dickson", lat: 2.527, lng: 101.795, region: "MY" },
  { name: "Bangkok", lat: 13.759, lng: 100.502, region: "TH" },
  { name: "Ho Chi Minh", lat: 10.782, lng: 106.7, region: "VN" },
  { name: "Hong Kong", lat: 22.302, lng: 114.177, region: "HK" },
  { name: "Shanghai", lat: 31.225, lng: 121.47, region: "CN" },
  { name: "Colombo", lat: 6.93, lng: 79.858, region: "LK" },
  { name: "Mumbai", lat: 19.076, lng: 72.878, region: "IN" },
  { name: "Busan", lat: 35.102, lng: 129.032, region: "KR" },
  { name: "Osaka", lat: 34.668, lng: 135.5, region: "JP" },
];

// Haversine distance in NM
function distNM(lat1, lng1, lat2, lng2) {
  const R = 3440.065,
    r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r,
    dLng = (lng2 - lng1) * r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bearing from point A to point B (degrees)
function bearing(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const dLng = (lng2 - lng1) * r;
  const y = Math.sin(dLng) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Project a point given lat/lng, bearing, distance(NM)
function projectPoint(lat, lng, bearingDeg, distNautical) {
  const R = 3440.065,
    r = Math.PI / 180;
  const d = distNautical / R;
  const b = bearingDeg * r;
  const lat2 = Math.asin(
    Math.sin(lat * r) * Math.cos(d) +
      Math.cos(lat * r) * Math.sin(d) * Math.cos(b),
  );
  const lng2 =
    lng * r +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat * r),
      Math.cos(d) - Math.sin(lat * r) * Math.sin(lat2),
    );
  return { lat: lat2 / r, lng: lng2 / r };
}

// ── GET /api/predict/:imo ─────────────────────────────────────
router.get("/:imo", async (req, res, next) => {
  try {
    const { imo } = req.params;
    if (!imo || isNaN(imo))
      return res.status(400).json({ success: false, error: "Invalid IMO" });

    const cacheKey = `pred_${imo}`;
    const cached = getCached(cacheKey);
    if (cached) {
      logger.info(`[PREDICT] cache hit for IMO ${imo}`);
      return res.json({ success: true, cached: true, ...cached });
    }

    // ── 1. Fetch current vessel state ─────────────────────────
    const [currentRows] = await bigquery.query({
      query: `
        SELECT vessel_name, imo_number, mmsi_number, flag, vessel_type,
               latitude_degrees, longitude_degrees, speed, heading, course,
               last_port_departed, next_port_destination, voyage_purpose,
               last_departed_time, last_arrived_time, declared_arrival_time,
               vessel_length, deadweight, gross_tonnage
        FROM ${FULL_TABLE}
        WHERE imo_number = ${parseInt(imo)}
        LIMIT 1
      `,
      location: BQ_LOCATION,
    });

    if (!currentRows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Vessel not found" });
    }
    const vessel = currentRows[0];

    // ── 2. Fetch recent AIS history (72h) ─────────────────────
    const [histRows] = await bigquery.query({
      query: `
        SELECT latitude_degrees, longitude_degrees, speed, heading, course,
               effective_timestamp
        FROM ${SNAPSHOT_TABLE}
        WHERE imo_number = ${parseInt(imo)}
          AND effective_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 72 HOUR)
          AND latitude_degrees IS NOT NULL AND longitude_degrees IS NOT NULL
        ORDER BY effective_timestamp ASC
        LIMIT 500
      `,
      location: BQ_LOCATION,
    });

    // ── 3. Fetch historical port calls for this vessel (pattern analysis) ──
    const [portHistRows] = await bigquery
      .query({
        query: `
        SELECT next_port_destination, last_port_departed,
               COUNT(*) as frequency,
               AVG(speed) as avg_speed
        FROM ${FULL_TABLE}
        WHERE imo_number = ${parseInt(imo)}
           OR (vessel_type = '${(vessel.vessel_type || "").replace(/'/g, "")}' 
               AND flag = '${(vessel.flag || "").replace(/'/g, "")}')
        GROUP BY next_port_destination, last_port_departed
        ORDER BY frequency DESC
        LIMIT 20
      `,
        location: BQ_LOCATION,
      })
      .catch(() => [[]]);

    // ── 4. PREDICTION LOGIC ───────────────────────────────────
    const curLat = Number(vessel.latitude_degrees || 0);
    const curLng = Number(vessel.longitude_degrees || 0);
    const curSpd = Number(vessel.speed || 0);
    const curHdg = Number(vessel.heading || vessel.course || 0);

    // Declared destination (most reliable if available)
    const declaredDest = vessel.next_port_destination
      ? String(
          vessel.next_port_destination.value || vessel.next_port_destination,
        ).trim()
      : null;

    // ── Trajectory extrapolation: project current heading ────
    // Use last 6 AIS points to compute average heading/speed
    const recentPts = histRows.slice(-6);
    let avgHdg = curHdg,
      avgSpd = curSpd;
    if (recentPts.length >= 2) {
      const hdgs = recentPts
        .map((p) => Number(p.heading || p.course || 0))
        .filter((h) => h > 0);
      const spds = recentPts
        .map((p) => Number(p.speed || 0))
        .filter((s) => s > 0.5);
      if (hdgs.length) avgHdg = hdgs.reduce((a, b) => a + b, 0) / hdgs.length;
      if (spds.length) avgSpd = spds.reduce((a, b) => a + b, 0) / spds.length;
    }

    // ── Find nearest port in heading direction ────────────────
    // Score ports by: (1) heading alignment, (2) distance, (3) historical frequency
    const portScores = KNOWN_PORTS.map((port) => {
      const d = distNM(curLat, curLng, port.lat, port.lng);
      const b = bearing(curLat, curLng, port.lat, port.lng);

      // Heading alignment score (0-1, 1=perfect)
      let hdgDiff = Math.abs(b - avgHdg);
      if (hdgDiff > 180) hdgDiff = 360 - hdgDiff;
      const hdgScore = Math.max(0, 1 - hdgDiff / 90); // within 90°

      // Distance score (prefer 50-1000 NM range)
      const distScore =
        d < 5 ? 0 : d < 50 ? 0.3 : d < 500 ? 1.0 : d < 1500 ? 0.6 : 0.2;

      // Historical frequency boost
      const histMatch =
        portHistRows[0]?.filter((r) => {
          const dest = String(
            r.next_port_destination?.value || r.next_port_destination || "",
          ).toLowerCase();
          return (
            dest.includes(port.name.toLowerCase()) ||
            port.name.toLowerCase().includes(dest.substring(0, 5))
          );
        }).length || 0;
      const histScore = Math.min(histMatch * 0.3, 0.9);

      // Declared destination match
      const isDecl =
        declaredDest &&
        (declaredDest.toLowerCase().includes(port.name.toLowerCase()) ||
          port.name
            .toLowerCase()
            .includes(declaredDest.toLowerCase().substring(0, 5)));
      const declScore = isDecl ? 2.0 : 0;

      const totalScore = hdgScore * 1.5 + distScore + histScore + declScore;

      // ETA calculation
      const etaHours = avgSpd > 0.5 ? d / avgSpd : null;
      const etaDate = etaHours
        ? new Date(Date.now() + etaHours * 3600000)
        : null;

      return {
        port: port.name,
        region: port.region,
        lat: port.lat,
        lng: port.lng,
        distance_nm: Math.round(d),
        bearing_deg: Math.round(b),
        heading_alignment: Math.round(hdgScore * 100),
        score: totalScore,
        eta_hours: etaHours ? Math.round(etaHours * 10) / 10 : null,
        eta_iso: etaDate ? etaDate.toISOString() : null,
        eta_label: etaHours ? formatETA(etaHours) : "Unknown",
        is_declared: isDecl,
        confidence: Math.min(Math.round(totalScore * 25), 99),
      };
    })
      .filter((p) => p.distance_nm > 5)
      .sort((a, b) => b.score - a.score);

    const topPrediction = portScores[0];
    const alternatives = portScores.slice(1, 4);

    // ── 5. Generate route waypoints (great circle + current position) ──
    const routeWaypoints = [];
    if (topPrediction) {
      const totalDist = topPrediction.distance_nm;
      const steps = Math.min(Math.ceil(totalDist / 80), 12); // waypoint every ~80 NM, max 12

      // Start from current position
      routeWaypoints.push({
        lat: curLat,
        lng: curLng,
        label: "Current Position",
        type: "current",
      });

      // Interpolate waypoints along great circle
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        // Simple linear interpolation for short distances
        const wLat = curLat + (topPrediction.lat - curLat) * t;
        const wLng = curLng + (topPrediction.lng - curLng) * t;
        const etaH = topPrediction.eta_hours
          ? topPrediction.eta_hours * t
          : null;
        routeWaypoints.push({
          lat: wLat,
          lng: wLng,
          label: `Waypoint ${i}`,
          type: "waypoint",
          eta_hours_from_now: etaH ? Math.round(etaH * 10) / 10 : null,
        });
      }

      routeWaypoints.push({
        lat: topPrediction.lat,
        lng: topPrediction.lng,
        label: topPrediction.port,
        type: "destination",
        eta_label: topPrediction.eta_label,
      });
    }

    // ── 6. Assemble response ──────────────────────────────────
    const avgSpdKmh = Math.round(avgSpd * 1.852 * 10) / 10;

    const result = {
      vessel: {
        name: vessel.vessel_name,
        imo: Number(vessel.imo_number),
        type: vessel.vessel_type,
        flag: vessel.flag,
        lat: curLat,
        lng: curLng,
        speed_kn: Math.round(avgSpd * 10) / 10,
        speed_kmh: avgSpdKmh,
        heading: Math.round(avgHdg),
        last_port: vessel.last_port_departed
          ? String(vessel.last_port_departed.value || vessel.last_port_departed)
          : null,
        declared_dest: declaredDest,
      },
      prediction: topPrediction
        ? {
            destination: topPrediction.port,
            destination_lat: topPrediction.lat,
            destination_lng: topPrediction.lng,
            eta_hours: topPrediction.eta_hours,
            eta_label: topPrediction.eta_label,
            eta_iso: topPrediction.eta_iso,
            distance_nm: topPrediction.distance_nm,
            confidence: topPrediction.confidence,
            bearing_deg: topPrediction.bearing_deg,
            is_declared: topPrediction.is_declared,
            method: topPrediction.is_declared
              ? "Declared destination + heading alignment"
              : histRows.length > 10
                ? "AIS trajectory extrapolation + port proximity"
                : "Heading-based port proximity scoring",
          }
        : null,
      alternatives,
      route_waypoints: routeWaypoints,
      analysis: {
        history_points: histRows.length,
        avg_speed_kn: Math.round(avgSpd * 10) / 10,
        avg_heading_deg: Math.round(avgHdg),
        trajectory_hours: 72,
        ports_evaluated: KNOWN_PORTS.length,
      },
    };

    setCache(cacheKey, result);
    logger.info(
      `[PREDICT] IMO ${imo} → ${topPrediction?.port} (${topPrediction?.confidence}% confidence)`,
    );
    res.json({ success: true, cached: false, ...result });
  } catch (err) {
    logger.error("[PREDICT]", err.message);
    next(err);
  }
});

function formatETA(hours) {
  if (!hours || hours < 0) return "Unknown";
  if (hours < 1) return `~${Math.round(hours * 60)} min`;
  if (hours < 24) return `~${hours.toFixed(1)} hrs`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return rem > 0 ? `~${days}d ${rem}h` : `~${days} days`;
}

module.exports = router;
